import { createHash, randomBytes } from 'node:crypto';

import {
  ASSIGNED_TRIP_STATUSES,
  TERMINAL_TRIP_STATUSES,
  type ShareCreated,
  type ShareInfo,
  type ShareView,
} from '@yatri/types';

import { env } from '../../config/env';
import { pool } from '../../config/database';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { buildSnapshot, loadMeta } from '../tracking/tracking.service';
import { recordTripEvent } from '../trips/trip-events.service';
import { requirePassenger } from '../trips/access';
import { getTrip } from '../trips/trips.repository';
import { approvedVehicleOf } from '../vehicles/vehicle-lookup';

/**
 * Trip sharing with a trusted contact. A share is a secret link to ONE ride, created by that ride's
 * passenger; it shows what the passenger's own live view shows about the driver and the trip, and
 * nothing else. Rules, all here:
 *  - only the ride's passenger, only once a driver is assigned and until the ride ends;
 *  - the secret is 32 random bytes and only its hash is stored — it cannot be read back or guessed;
 *  - a link stops when the passenger stops it, when the sharing period ends, and when the ride ends
 *    (it then shows the outcome for SHARE_ENDED_GRACE_MINUTES and no location, then nothing);
 *  - starting and stopping are ride events, so both people and the notification system hear of them.
 */

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

const ACTIVE_SQL = 'stopped_at IS NULL AND expires_at > now()';

export type SharePurpose = 'TRIP' | 'SOS';

/**
 * Create a link to a ride. The CALLER has already established who may (a passenger sharing their own
 * ride, or the SOS service acting for someone in an emergency). A TRIP share counts toward the
 * per-ride limit and announces itself to both people; an SOS share does neither — the other person on
 * the ride must never learn that an emergency alert went out.
 */
export async function issueShare(
  tripId: string,
  createdBy: string,
  purpose: SharePurpose,
): Promise<ShareCreated> {
  const trip = await getTrip(tripId);
  if (!trip) throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
  if (!trip.driver_id || !ASSIGNED_TRIP_STATUSES.includes(trip.status)) {
    throw new HttpError(
      409,
      'SHARE_NOT_AVAILABLE',
      'You can share a trip once a driver is assigned, until the ride ends.',
    );
  }
  const token = randomBytes(32).toString('base64url');
  const client = await pool.connect();
  let shareId: string;
  let expiresAt: Date;
  try {
    await client.query('BEGIN');
    // The ride row lock serialises concurrent creations so the per-ride limit cannot be raced past.
    await client.query('SELECT 1 FROM trips WHERE id = $1 FOR UPDATE', [tripId]);
    if (purpose === 'TRIP') {
      const count = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM trip_shares
         WHERE trip_id = $1 AND purpose = 'TRIP' AND ${ACTIVE_SQL}`,
        [tripId],
      );
      if (Number(count.rows[0]?.n ?? 0) >= env.SHARE_MAX_PER_TRIP) {
        await client.query('ROLLBACK');
        throw new HttpError(
          409,
          'SHARE_LIMIT',
          `You can share a trip with up to ${env.SHARE_MAX_PER_TRIP} people at once. Stop one to add another.`,
        );
      }
    }
    const ins = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO trip_shares (trip_id, created_by, token_hash, expires_at, purpose)
       VALUES ($1, $2, $3, now() + ($4::float * interval '1 hour'), $5) RETURNING id, expires_at`,
      [tripId, createdBy, hashToken(token), env.SHARE_DURATION_HOURS, purpose],
    );
    await client.query('COMMIT');
    shareId = (ins.rows[0] as { id: string }).id;
    expiresAt = (ins.rows[0] as { expires_at: Date }).expires_at;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  if (purpose === 'TRIP') {
    await recordTripEvent({
      tripId,
      type: 'TRIP_SHARE_STARTED',
      actorId: createdBy,
      dedupeKey: `shs:${shareId}`,
    });
  }
  return {
    shareId,
    url: `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}/share/${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/** A passenger shares their own ride with someone they trust. */
export async function createShare(tripId: string, userId: string): Promise<ShareCreated> {
  await requirePassenger(tripId, userId);
  return issueShare(tripId, userId, 'TRIP');
}

export async function listShares(tripId: string, userId: string): Promise<ShareInfo[]> {
  await requirePassenger(tripId, userId);
  const r = await query<{
    id: string;
    created_at: Date;
    expires_at: Date;
    active: boolean;
  }>(
    `SELECT id, created_at, expires_at, (${ACTIVE_SQL}) AS active
     FROM trip_shares WHERE trip_id = $1 AND purpose = 'TRIP' ORDER BY created_at DESC`,
    [tripId],
  );
  return r.rows.map((s) => ({
    id: s.id,
    createdAt: s.created_at.toISOString(),
    expiresAt: s.expires_at.toISOString(),
    active: s.active,
  }));
}

/** Stop one link now. Stopping twice is harmless. */
export async function stopShare(tripId: string, shareId: string, userId: string): Promise<void> {
  await requirePassenger(tripId, userId);
  const exists = await query(
    "SELECT 1 FROM trip_shares WHERE id = $1 AND trip_id = $2 AND purpose = 'TRIP'",
    [shareId, tripId],
  );
  if (!exists.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Share not found.');
  const r = await query(
    `UPDATE trip_shares SET stopped_at = now(), stopped_reason = 'PASSENGER'
     WHERE id = $1 AND trip_id = $2 AND stopped_at IS NULL`,
    [shareId, tripId],
  );
  if (r.rowCount) {
    await recordTripEvent({
      tripId,
      type: 'TRIP_SHARE_STOPPED',
      actorId: userId,
      payload: { reason: 'PASSENGER' },
      dedupeKey: `shx:${shareId}`,
    });
  }
}

/** The ride is over: every link stops sharing (they keep showing the outcome briefly). */
export async function endSharesForTrip(tripId: string): Promise<void> {
  const r = await query<{ purpose: string }>(
    `UPDATE trip_shares SET stopped_at = now(), stopped_reason = 'RIDE_ENDED'
     WHERE trip_id = $1 AND stopped_at IS NULL RETURNING purpose`,
    [tripId],
  );
  if (r.rows.some((row) => row.purpose === 'TRIP')) {
    await recordTripEvent({
      tripId,
      type: 'TRIP_SHARE_STOPPED',
      payload: { reason: 'RIDE_ENDED' },
      dedupeKey: 'shs-end',
    });
  }
}

/** Links whose sharing period ran out while the ride is still going. Safe on every instance. */
export async function expireDueShares(): Promise<number> {
  const r = await query<{ id: string; trip_id: string; purpose: string }>(
    `UPDATE trip_shares SET stopped_at = now(), stopped_reason = 'EXPIRED'
     WHERE stopped_at IS NULL AND expires_at <= now() RETURNING id, trip_id, purpose`,
  );
  for (const s of r.rows.filter((row) => row.purpose === 'TRIP')) {
    await recordTripEvent({
      tripId: s.trip_id,
      type: 'TRIP_SHARE_STOPPED',
      payload: { reason: 'EXPIRED' },
      dedupeKey: `shx:${s.id}`,
    });
  }
  return r.rows.length;
}

// ---------------------------------------------------------------- what the link holder sees

const firstName = (full: string | null) => full?.trim().split(/\s+/)[0] || null;

/**
 * The view for a token, or null for anything that is not a working link — unknown, malformed,
 * stopped by the passenger, past its period, or an ended ride past its grace. Callers give every
 * one of those the same answer, so a link cannot be probed.
 */
export async function shareViewForToken(token: string): Promise<ShareView | null> {
  const r = await query<{
    trip_id: string;
    expires_at: Date;
    stopped_reason: string | null;
  }>(
    `SELECT trip_id, expires_at, stopped_reason FROM trip_shares
     WHERE token_hash = $1 AND expires_at > now()
       AND (stopped_at IS NULL OR stopped_reason = 'RIDE_ENDED')`,
    [hashToken(token)],
  );
  const share = r.rows[0];
  if (!share) return null;
  const trip = await getTrip(share.trip_id);
  if (!trip) return null;

  const ended = TERMINAL_TRIP_STATUSES.includes(trip.status);
  if (ended) {
    const graceMs = env.SHARE_ENDED_GRACE_MINUTES * 60_000;
    const endedAt = (trip.ended_at ?? trip.created_at).getTime();
    if (Date.now() >= endedAt + graceMs) return null;
  }

  const nowIso = new Date().toISOString();
  const base: ShareView = {
    status: trip.status,
    ended,
    driver: null,
    location: null,
    pickup: { name: trip.pickup_name ?? trip.pickup_address },
    destination: { name: trip.dest_name ?? trip.dest_address, address: trip.dest_address },
    distanceMeters: null,
    distanceTo: null,
    etaSeconds: null,
    waitingSeconds: null,
    expiresAt: share.expires_at.toISOString(),
    updatedAt: nowIso,
  };
  if (ended || !trip.driver_id) return base;

  // Driver: first name and vehicle only.
  const [driver, vehicle, meta] = await Promise.all([
    query<{ full_name: string | null }>('SELECT full_name FROM users WHERE id = $1', [
      trip.driver_id,
    ]),
    approvedVehicleOf(trip.driver_id),
    loadMeta(trip.id),
  ]);
  base.driver = {
    firstName: firstName(driver.rows[0]?.full_name ?? null),
    vehicle: vehicle?.description ?? null,
    registration: vehicle?.registrationNumber ?? null,
  };

  // Live figures come from the SAME snapshot the passenger sees — no second calculation.
  if (meta) {
    const s = await buildSnapshot(meta, 'PASSENGER');
    if (s.driver) {
      base.location = {
        latitude: s.driver.latitude,
        longitude: s.driver.longitude,
        placeName: s.driver.placeName,
        freshness: s.driver.freshness,
      };
    }
    if (s.driverArrival) {
      base.distanceMeters = s.driverArrival.distanceMeters;
      base.distanceTo = 'pickup';
      base.etaSeconds = s.driverArrival.etaSeconds;
    } else if (s.trip) {
      base.distanceMeters = s.trip.distanceRemainingMeters;
      base.distanceTo = 'destination';
      base.etaSeconds = s.trip.etaSeconds;
    }
    base.waitingSeconds = s.waiting?.driver?.seconds ?? null;
  }
  return base;
}
