import type {
  DriverAvailabilityState,
  DriverAvailabilityStatus,
  DriverLocationSample,
  LocationFreshness,
} from '@yatri/types';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { publishDriverChange } from '../realtime/bus';
import { trackingConfig } from '../tracking/tracking.config';
import { evaluateFix, type Fix } from '../tracking/tracking.rules';
import { canTransition, CAN_START_ONLINE, locationFreshness } from './availability.machine';
import {
  casTransition,
  getOrCreateAvailability,
  listOnlineDrivers,
  listStuckTransitions,
  recordAvailabilityEvent,
  type AvailabilityRow,
} from './availability.repository';
import { evaluateDriverEligibility } from './eligibility';
import { detectFlags, recordFlags } from './location-flags';
import {
  claimPersistSlot,
  clearLiveFix,
  getLiveFix,
  getNotifiedFreshness,
  getStateMirror,
  setLiveFix,
  setNotifiedFreshness,
  setStateMirror,
  touchSeen,
} from './presence.state';

/** Every threshold comes from configuration; nothing else in the codebase hard-codes them. */
export const availabilityConfig = () => ({
  freshSeconds: env.DRIVER_LOCATION_FRESH_SECONDS,
  staleTimeoutSeconds: env.DRIVER_STALE_TIMEOUT_SECONDS,
  onlineMaxAccuracyMeters: env.DRIVER_ONLINE_MAX_ACCURACY_METERS,
  persistSeconds: env.DRIVER_LOCATION_PERSIST_SECONDS,
  transitionTimeoutSeconds: env.DRIVER_TRANSITION_TIMEOUT_SECONDS,
  intervals: {
    idle: env.DRIVER_UPDATE_INTERVAL_IDLE_MS,
    enRoute: env.DRIVER_UPDATE_INTERVAL_EN_ROUTE_MS,
    onTrip: env.DRIVER_UPDATE_INTERVAL_ON_TRIP_MS,
  },
});

function toFix(s: DriverLocationSample): Fix {
  return {
    latitude: s.latitude,
    longitude: s.longitude,
    accuracyMeters: s.accuracyMeters ?? null,
    deviceTimeMs: s.deviceTimeMs,
  };
}

async function setState(driverId: string, state: DriverAvailabilityState) {
  await setStateMirror(driverId, state);
  await publishDriverChange(driverId);
}

// ---------------------------------------------------------------- status

export async function getStatus(
  driverId: string,
  nowMs = Date.now(),
): Promise<DriverAvailabilityStatus> {
  const cfg = availabilityConfig();
  const row = await getOrCreateAvailability(driverId);
  const live = await getLiveFix(driverId);
  const last = live?.fix.receivedAtMs ?? null;
  const freshness: LocationFreshness = locationFreshness(last, nowMs, cfg.freshSeconds);
  const onShift = row.state === 'ONLINE' || row.state === 'GOING_ONLINE';
  return {
    state: row.state,
    reason: row.offline_reason,
    onlineSince: row.online_since?.toISOString() ?? null,
    locationFreshness: freshness,
    lastLocationAt: last ? new Date(last).toISOString() : null,
    lastLocationAgeSeconds: last ? Math.max(0, Math.round((nowMs - last) / 1000)) : null,
    accuracyMeters: live?.fix.accuracyMeters ?? null,
    // Eligibility is only interesting (and only worth the queries) while the driver is off shift.
    eligibility: onShift
      ? { eligible: true, reasons: [] }
      : await evaluateDriverEligibility(driverId),
    updateIntervalsMs: cfg.intervals,
    freshWithinSeconds: cfg.freshSeconds,
    onlineMaxAccuracyMeters: cfg.onlineMaxAccuracyMeters,
  };
}

/** Current availability state, from the Redis mirror when present (no DB hit on the hot path). */
async function currentState(driverId: string): Promise<DriverAvailabilityState> {
  const mirrored = await getStateMirror(driverId);
  if (mirrored) return mirrored;
  const row = await getOrCreateAvailability(driverId);
  await setStateMirror(driverId, row.state);
  return row.state;
}

// ---------------------------------------------------------------- location

export type IngestResult =
  | { accepted: true; receivedAt: string; freshness: LocationFreshness }
  | { accepted: false; reason: string };

/** Validate + store one location for an ONLINE driver. The driver id always comes from the authenticated session. */
export async function ingestLocation(
  driverId: string,
  sample: DriverLocationSample,
  nowMs = Date.now(),
): Promise<IngestResult> {
  await touchSeen(driverId, nowMs);
  if ((await currentState(driverId)) !== 'ONLINE') return { accepted: false, reason: 'not_online' };

  const prev = (await getLiveFix(driverId))?.fix ?? null;
  const decision = evaluateFix(prev, toFix(sample), nowMs, trackingConfig());

  const flags = detectFlags({
    mockLocation: sample.mockLocation,
    speedMps: sample.speedMps,
    accuracyMeters: sample.accuracyMeters,
    rejected: decision.accept ? null : decision.reason,
  });
  if (flags.length > 0) {
    await recordFlags(driverId, flags, {
      latitude: sample.latitude,
      longitude: sample.longitude,
      accuracyMeters: sample.accuracyMeters ?? null,
      speedMps: sample.speedMps ?? null,
      rejected: decision.accept ? null : decision.reason,
    });
  }

  if (!decision.accept) {
    // Remember a pending jump candidate so a genuinely relocated device is eventually accepted.
    if (decision.next && prev) {
      const cur = await getLiveFix(driverId);
      if (cur) await setLiveFix(driverId, { ...cur, fix: decision.next });
    }
    return { accepted: false, reason: decision.reason };
  }

  await storeAccepted(driverId, sample, decision.next, nowMs);
  return {
    accepted: true,
    receivedAt: new Date(nowMs).toISOString(),
    freshness: 'fresh',
  };
}

async function storeAccepted(
  driverId: string,
  sample: DriverLocationSample,
  fix: import('../tracking/tracking.rules').StoredFix,
  nowMs: number,
  forcePersist = false,
) {
  const heading = sample.headingDegrees ?? null;
  const speed = sample.speedMps ?? null;
  await setLiveFix(driverId, { fix, headingDegrees: heading, speedMps: speed });
  // Postgres gets a throttled snapshot (operations + future matching index), never every point.
  if (forcePersist || (await claimPersistSlot(driverId, availabilityConfig().persistSeconds))) {
    await query(
      `INSERT INTO driver_last_locations
         (driver_id, latitude, longitude, accuracy_meters, heading_degrees, speed_mps, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
       ON CONFLICT (driver_id) DO UPDATE SET
         latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
         accuracy_meters = EXCLUDED.accuracy_meters, heading_degrees = EXCLUDED.heading_degrees,
         speed_mps = EXCLUDED.speed_mps, recorded_at = EXCLUDED.recorded_at`,
      [driverId, fix.latitude, fix.longitude, fix.accuracyMeters, heading, speed, nowMs],
    );
  }
}

// ---------------------------------------------------------------- go online / offline

export async function goOnline(
  driverId: string,
  sample: DriverLocationSample,
  nowMs = Date.now(),
): Promise<DriverAvailabilityStatus> {
  const cfg = availabilityConfig();

  // 1. The opening fix must be genuine, recent and accurate enough — else the driver stays offline.
  const first = evaluateFix(null, toFix(sample), nowMs, trackingConfig());
  if (!first.accept) {
    throw new HttpError(
      422,
      first.reason === 'stale' || first.reason === 'clock_skew'
        ? 'STALE_LOCATION'
        : 'INVALID_LOCATION',
      first.reason === 'stale' || first.reason === 'clock_skew'
        ? 'Your location reading is out of date. Wait for a fresh GPS fix and try again.'
        : 'Your location reading was not usable. Try again in an open area.',
    );
  }
  if (
    sample.accuracyMeters === undefined ||
    sample.accuracyMeters === null ||
    sample.accuracyMeters > cfg.onlineMaxAccuracyMeters
  ) {
    throw new HttpError(
      422,
      'WEAK_GPS_ACCURACY',
      `GPS accuracy is too weak to go online (needs ${cfg.onlineMaxAccuracyMeters} meters or better). Move to an open area and try again.`,
    );
  }

  const row = await getOrCreateAvailability(driverId);
  await touchSeen(driverId, nowMs);

  // 2. Repeated requests are safe: already online -> just refresh the location.
  if (row.state === 'ONLINE') {
    await storeAccepted(driverId, sample, first.next, nowMs, true);
    return getStatus(driverId, nowMs);
  }
  if (row.state === 'GOING_ONLINE' || row.state === 'GOING_OFFLINE') {
    throw new HttpError(
      409,
      'AVAILABILITY_CHANGE_IN_PROGRESS',
      'Your availability is already changing. Please wait a moment.',
    );
  }

  // 3. The server decides eligibility, from the database, every time.
  const eligibility = await evaluateDriverEligibility(driverId);
  if (!eligibility.eligible) {
    await recordAvailabilityEvent({
      driverId,
      eventType: 'GO_ONLINE_REFUSED',
      reason: eligibility.reasons.join(' | ').slice(0, 500),
    });
    throw new HttpError(403, 'NOT_ELIGIBLE', 'You cannot go online yet.').withDetails({
      reasons: eligibility.reasons,
    });
  }

  // 4. Claim the transition atomically; a concurrent identical request loses cleanly.
  const claimed = await casTransition(driverId, CAN_START_ONLINE, 'GOING_ONLINE');
  if (!claimed) {
    const now = await getOrCreateAvailability(driverId);
    if (now.state === 'ONLINE') return getStatus(driverId, nowMs);
    throw new HttpError(
      409,
      'AVAILABILITY_CHANGE_IN_PROGRESS',
      'Your availability is already changing.',
    );
  }
  await setState(driverId, 'GOING_ONLINE');

  let online: AvailabilityRow | null = null;
  try {
    await storeAccepted(driverId, sample, first.next, nowMs, true);
    online = await casTransition(driverId, ['GOING_ONLINE'], 'ONLINE');
  } catch (err) {
    await casTransition(driverId, ['GOING_ONLINE'], 'OFFLINE', { reason: 'ONLINE_FAILED' });
    await setState(driverId, 'OFFLINE');
    await clearLiveFix(driverId);
    throw err;
  }
  if (!online) {
    // Someone (an offline request, an admin suspension) changed the state while we were working.
    await clearLiveFix(driverId);
    const now = await getOrCreateAvailability(driverId);
    await setState(driverId, now.state);
    throw new HttpError(
      409,
      'AVAILABILITY_CHANGED',
      'Your availability changed while going online.',
    );
  }
  await setState(driverId, 'ONLINE');
  return getStatus(driverId, nowMs);
}

export async function goOffline(
  driverId: string,
  reason = 'DRIVER_REQUEST',
  nowMs = Date.now(),
): Promise<DriverAvailabilityStatus> {
  const row = await getOrCreateAvailability(driverId);

  if (row.state === 'OFFLINE' || row.state === 'SUSPENDED') return getStatus(driverId, nowMs);
  if (row.state === 'UNAVAILABLE') {
    await casTransition(driverId, ['UNAVAILABLE'], 'OFFLINE', { reason });
    await setState(driverId, 'OFFLINE');
    return getStatus(driverId, nowMs);
  }

  // ONLINE, GOING_ONLINE (cancelling a pending online) or GOING_OFFLINE (finish it).
  const leaving = await casTransition(driverId, ['ONLINE', 'GOING_ONLINE'], 'GOING_OFFLINE', {
    reason,
  });
  if (leaving) await setState(driverId, 'GOING_OFFLINE');

  // Stop being visible: drop the live fix and the stored location (privacy: nothing kept off-shift).
  await clearLiveFix(driverId);
  await query('DELETE FROM driver_last_locations WHERE driver_id = $1', [driverId]);
  await casTransition(driverId, ['GOING_OFFLINE'], 'OFFLINE', { reason });
  await setState(driverId, 'OFFLINE');
  return getStatus(driverId, nowMs);
}

/** Admin suspension (or account deactivation): the driver is removed from availability immediately. */
export async function forceSuspend(
  driverId: string,
  actorId: string | null,
  reason = 'ACCOUNT_SUSPENDED',
) {
  const row = await getOrCreateAvailability(driverId);
  if (row.state === 'SUSPENDED') return;
  if (!canTransition(row.state, 'SUSPENDED')) return;
  await casTransition(
    driverId,
    ['OFFLINE', 'GOING_ONLINE', 'ONLINE', 'GOING_OFFLINE', 'UNAVAILABLE'],
    'SUSPENDED',
    { reason, actorId },
  );
  await clearLiveFix(driverId);
  await query('DELETE FROM driver_last_locations WHERE driver_id = $1', [driverId]);
  await setState(driverId, 'SUSPENDED');
}

// ---------------------------------------------------------------- stale handling

export interface SweepResult {
  markedUnavailable: string[];
  rolledBack: string[];
  notifiedStale: string[];
}

/**
 * Housekeeping, safe to run on every API instance (every write is a guarded transition):
 *  - a driver ONLINE with a location older than the freshness threshold is STALE:
 *    unmatchable (see isMatchable) and told about it;
 *  - silent for longer than the stale timeout -> UNAVAILABLE (never "online forever");
 *  - a GOING_ONLINE / GOING_OFFLINE that never completed is rolled back.
 */
export async function sweepDrivers(nowMs = Date.now()): Promise<SweepResult> {
  const cfg = availabilityConfig();
  const out: SweepResult = { markedUnavailable: [], rolledBack: [], notifiedStale: [] };

  for (const stuck of await listStuckTransitions(cfg.transitionTimeoutSeconds)) {
    const moved = await casTransition(stuck.driver_id, [stuck.state], 'OFFLINE', {
      reason: 'TRANSITION_TIMEOUT',
    });
    if (moved) {
      await clearLiveFix(stuck.driver_id);
      await setState(stuck.driver_id, 'OFFLINE');
      out.rolledBack.push(stuck.driver_id);
    }
  }

  for (const d of await listOnlineDrivers()) {
    const live = await getLiveFix(d.driver_id);
    // With no live fix yet, measure silence from when they went online.
    const lastMs = live?.fix.receivedAtMs ?? d.state_changed_at.getTime();
    const ageSec = (nowMs - lastMs) / 1000;

    if (ageSec > cfg.staleTimeoutSeconds) {
      const moved = await casTransition(d.driver_id, ['ONLINE'], 'UNAVAILABLE', {
        reason: 'STALE_LOCATION',
      });
      if (moved) {
        await clearLiveFix(d.driver_id);
        await query('DELETE FROM driver_last_locations WHERE driver_id = $1', [d.driver_id]);
        await setState(d.driver_id, 'UNAVAILABLE');
        out.markedUnavailable.push(d.driver_id);
      }
    } else if (ageSec > cfg.freshSeconds) {
      if ((await getNotifiedFreshness(d.driver_id)) !== 'stale') {
        await setNotifiedFreshness(d.driver_id, 'stale');
        await publishDriverChange(d.driver_id); // the driver's client shows "location update delayed"
        out.notifiedStale.push(d.driver_id);
      }
    } else if ((await getNotifiedFreshness(d.driver_id)) === 'stale') {
      await setNotifiedFreshness(d.driver_id, 'fresh');
    }
  }
  return out;
}
