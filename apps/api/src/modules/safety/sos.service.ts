import { isoOrNull } from '../../lib/dates';
import {
  ASSIGNED_TRIP_STATUSES,
  describeSosStatus,
  isNullIsland,
  sosStatesLeadingTo,
  type AdminSosDetail,
  type AdminSosRow,
  type SosInfo,
  type SosLocationSource,
  type SosRequestBody,
  type SosStatus,
  type TripRole,
} from '@yatri/types';

import { env } from '../../config/env';
import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { getSmsProvider } from '../auth/sms';
import { publishToUser } from '../realtime/bus';
import { issueShare } from '../sharing/sharing.service';
import { getDriverFix } from '../tracking/tracking.service';
import { requireParticipant } from '../trips/access';
import { getTrip } from '../trips/trips.repository';
import { approvedVehicleOf } from '../vehicles/vehicle-lookup';
import { contactsForSos } from './emergency-contacts.service';
import { notifySafetyTeam } from './safety-team';
import { log } from '../../lib/logger';

/**
 * SOS. A person on an active ride raises an alert; it is recorded at once, with the position at that
 * moment, and the right people are told — and ONLY the right people:
 *  - the safety team (a notification; the details are behind their permission and the audit);
 *  - the person's own emergency contacts (a text with a link to follow the trip, nothing else);
 *  - the person's own other devices (realtime).
 * The OTHER person on the ride is never told. They may be the reason for the alert, so an SOS is not a
 * ride event, and its share link is created quietly.
 *
 * An emergency must never be refused for want of a detail: location and contacts are best effort, every
 * step after the record is written can fail without failing the alert, and pressing twice (or on two
 * phones at once) yields the same single alert.
 */

interface SosRow {
  id: string;
  trip_id: string;
  user_id: string;
  role: TripRole;
  status: SosStatus;
  latitude: string | null;
  longitude: string | null;
  accuracy_meters: number | null;
  location_source: SosLocationSource;
  location_at: Date | null;
  contacts_notified: number;
  created_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  cancelled_at: Date | null;
}

const COLS = `id, trip_id, user_id, role, status, latitude, longitude, accuracy_meters, location_source,
  location_at, contacts_notified, created_at, acknowledged_at, resolved_at, resolution_note, cancelled_at`;

export const toSosInfo = (r: SosRow): SosInfo => ({
  id: r.id,
  tripId: r.trip_id,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  locationRecorded: r.latitude !== null,
  contactsNotified: r.contacts_notified,
  emergencyNumber: env.EMERGENCY_SERVICES_NUMBER,
});

const firstName = (full: string | null) => full?.trim().split(/\s+/)[0] || null;

// ---------------------------------------------------------------- raising an alert

interface Located {
  latitude: number | null;
  longitude: number | null;
  accuracyMeters: number | null;
  source: SosLocationSource;
  at: Date | null;
}

const validFix = (
  b: SosRequestBody,
): b is SosRequestBody & { latitude: number; longitude: number } =>
  typeof b.latitude === 'number' &&
  typeof b.longitude === 'number' &&
  Number.isFinite(b.latitude) &&
  Number.isFinite(b.longitude) &&
  Math.abs(b.latitude) <= 90 &&
  Math.abs(b.longitude) <= 180 &&
  !isNullIsland({ latitude: b.latitude, longitude: b.longitude });

/**
 * Where the person is. The driver's position is what the server's own feed says (never a coordinate in
 * the request). A passenger's phone is the only source of THEIR position, so their device fix is used
 * when it is sane; otherwise, once they are with the driver, the driver's feed is a fair stand-in. With
 * neither, the alert is still raised — without a position.
 */
async function locate(
  tripId: string,
  role: TripRole,
  status: string,
  body: SosRequestBody,
): Promise<Located> {
  if (role === 'PASSENGER' && validFix(body)) {
    return {
      latitude: body.latitude,
      longitude: body.longitude,
      accuracyMeters:
        typeof body.accuracyMeters === 'number' && body.accuracyMeters >= 0
          ? body.accuracyMeters
          : null,
      source: 'DEVICE',
      at: new Date(),
    };
  }
  const withDriver = role === 'DRIVER' || status === 'DRIVER_ARRIVED' || status === 'IN_PROGRESS';
  if (withDriver) {
    const fix = await getDriverFix(tripId).catch(() => null);
    if (fix) {
      return {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracyMeters: null,
        source: 'DRIVER_FEED',
        at: new Date(fix.receivedAtMs),
      };
    }
  }
  return { latitude: null, longitude: null, accuracyMeters: null, source: 'NONE', at: null };
}

export async function triggerSos(
  tripId: string,
  userId: string,
  body: SosRequestBody,
): Promise<{ sos: SosInfo; created: boolean }> {
  const { trip, role } = await requireParticipant(tripId, userId);
  if (!trip.driver_id || !ASSIGNED_TRIP_STATUSES.includes(trip.status)) {
    throw new HttpError(
      409,
      'SOS_NOT_AVAILABLE',
      `Emergency alerts work during a ride, once a driver is assigned. If you are in danger, call ${env.EMERGENCY_SERVICES_NUMBER}.`,
    );
  }
  const where = await locate(tripId, role, trip.status, body);
  // The partial unique index decides: only one open alert per person per ride, however many presses.
  const ins = await query<SosRow>(
    `INSERT INTO sos_events
       (trip_id, user_id, role, latitude, longitude, accuracy_meters, location_source, location_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (trip_id, user_id) WHERE status IN ('ACTIVE', 'ACKNOWLEDGED') DO NOTHING
     RETURNING ${COLS}`,
    [
      tripId,
      userId,
      role,
      where.latitude,
      where.longitude,
      where.accuracyMeters,
      where.source,
      where.at,
    ],
  );
  const row = ins.rows[0];
  if (!row) {
    const existing = await query<SosRow>(
      `SELECT ${COLS} FROM sos_events
       WHERE trip_id = $1 AND user_id = $2 AND status IN ('ACTIVE', 'ACKNOWLEDGED')`,
      [tripId, userId],
    );
    return { sos: toSosInfo(existing.rows[0] as SosRow), created: false };
  }

  // Everything below is best effort: the alert already exists.
  const step = (label: string, fn: () => Promise<unknown>) =>
    fn().catch((err) => log.error(`SOS ${label} failed`, err));
  await step('audit', () =>
    recordAudit({
      actorId: userId,
      actorRole: role,
      action: 'SOS_TRIGGERED',
      subjectType: 'sos',
      subjectIds: [row.id],
      detail: { role, locationSource: where.source },
    }),
  );
  // The safety team first, then the texts: a slow text vendor must never delay the people who can act.
  await step('safety team', () =>
    notifySafetyTeam({
      type: 'SOS_TRIGGERED',
      body: 'An SOS alert needs attention.',
      metadata: { sosId: row.id, tripId },
    }),
  );
  await step('contacts', () => tellEmergencyContacts(row, trip.id, userId));
  const fresh = await query<SosRow>(`SELECT ${COLS} FROM sos_events WHERE id = $1`, [row.id]);
  const info = toSosInfo(fresh.rows[0] as SosRow);
  await step('devices', () => publishToUser(userId, { type: 'sos_state', sos: info }));
  return { sos: info, created: true };
}

/** A text to each emergency contact with a link that follows the trip — nothing else about it. */
async function tellEmergencyContacts(row: SosRow, tripId: string, userId: string): Promise<void> {
  const contacts = await contactsForSos(userId);
  if (contacts.length === 0) return;
  const share = await issueShare(tripId, userId, 'SOS'); // quiet: the other person is not told
  const who = await query<{ full_name: string | null }>(
    'SELECT full_name FROM users WHERE id = $1',
    [userId],
  );
  const name = firstName(who.rows[0]?.full_name ?? null) ?? 'Someone';
  // All at once: one stalled text must not hold up the others.
  const results = await Promise.all(
    contacts.map((c) =>
      getSmsProvider()
        .send({
          toPhoneNumber: c.phoneNumber,
          body: `${name} may need help during a Yatri ride. Follow the trip here: ${share.url} If you cannot reach ${name}, call ${env.EMERGENCY_SERVICES_NUMBER}.`,
        })
        .then(() => true)
        .catch((err) => {
          // The provider's message can hold the number; log only what failed.
          log.error('SOS text failed', err instanceof Error ? err.name : 'error');
          return false;
        }),
    ),
  );
  const sent = results.filter(Boolean).length;
  await query('UPDATE sos_events SET contacts_notified = $2 WHERE id = $1', [row.id, sent]);
}

// ---------------------------------------------------------------- moving an alert on

type Actor = { id: string; role: 'ADMIN' | TripRole };

/**
 * The one way an alert changes state: the table in @yatri/types decides what is legal, a guarded
 * UPDATE makes it atomic, so two people acting at once cannot both win.
 */
export async function transitionSos(
  sosId: string,
  to: Exclude<SosStatus, 'ACTIVE'>,
  actor: Actor,
  note?: string,
): Promise<SosRow> {
  // Every placeholder is referenced whichever way it goes (Postgres cannot type an unused one).
  const sets =
    to === 'ACKNOWLEDGED'
      ? 'acknowledged_by = $4::uuid, acknowledged_at = now()'
      : to === 'RESOLVED'
        ? 'resolved_by = $4::uuid, resolved_at = now(), resolution_note = $5::text'
        : 'cancelled_at = now()';
  const values: unknown[] = [sosId, to, sosStatesLeadingTo(to)];
  if (to === 'ACKNOWLEDGED') values.push(actor.id);
  if (to === 'RESOLVED') values.push(actor.id, note ?? null);
  const r = await query<SosRow>(
    `UPDATE sos_events SET status = $2, ${sets}
     WHERE id = $1 AND status = ANY($3::text[]) RETURNING ${COLS}`,
    values,
  );
  const row = r.rows[0];
  if (!row) {
    const exists = await query('SELECT 1 FROM sos_events WHERE id = $1', [sosId]);
    if (!exists.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Alert not found.');
    throw new HttpError(409, 'SOS_STATE_CONFLICT', 'This alert has already moved on.');
  }
  await recordAudit({
    actorId: actor.id,
    actorRole: actor.role,
    action: `SOS_${to}`,
    subjectType: 'sos',
    subjectIds: [sosId],
    detail: { hasNote: !!note },
  });
  const info = toSosInfo(row);
  // The person who raised it hears about every change, on every device — and only they do.
  await publishToUser(row.user_id, { type: 'sos_state', sos: info }).catch(() => undefined);
  if (actor.role === 'ADMIN') {
    await notify({
      userId: row.user_id,
      type: 'SOS_UPDATE',
      title: 'Yatri safety',
      body: describeSosStatus(info),
      metadata: { sosId, tripId: row.trip_id },
    }).catch(() => undefined);
  } else {
    // The alert has already changed state; telling the team is best effort and must not turn "I am safe" into an error.
    await notifySafetyTeam({
      type: 'SOS_CANCELLED',
      body: 'A person says they are safe and cancelled their SOS alert.',
      metadata: { sosId, tripId: row.trip_id },
    }).catch((err) => log.error('SOS cancel notice failed', err));
  }
  return row;
}

/** "I am safe": the person cancels their own open alert for this ride. */
export async function cancelMySos(tripId: string, userId: string): Promise<SosInfo> {
  const { role } = await requireParticipant(tripId, userId);
  const open = await query<{ id: string }>(
    `SELECT id FROM sos_events
     WHERE trip_id = $1 AND user_id = $2 AND status IN ('ACTIVE', 'ACKNOWLEDGED')`,
    [tripId, userId],
  );
  const id = open.rows[0]?.id;
  if (!id) throw new HttpError(404, 'NOT_FOUND', 'You have no open emergency alert on this ride.');
  return toSosInfo(await transitionSos(id, 'CANCELLED', { id: userId, role }));
}

/** The person's latest alert on this ride, so a reopened app shows the truth. */
export async function getMySos(tripId: string, userId: string): Promise<SosInfo | null> {
  await requireParticipant(tripId, userId);
  const r = await query<SosRow>(
    `SELECT ${COLS} FROM sos_events WHERE trip_id = $1 AND user_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [tripId, userId],
  );
  return r.rows[0] ? toSosInfo(r.rows[0]) : null;
}

// ---------------------------------------------------------------- the safety team's view

export async function listSos(opts: {
  status?: SosStatus;
  page: number;
  pageSize: number;
}): Promise<{ items: AdminSosRow[]; total: number }> {
  const params = [opts.status ?? null];
  const [rows, count] = await Promise.all([
    query<SosRow & { full_name: string | null }>(
      `SELECT s.*, u.full_name FROM sos_events s JOIN users u ON u.id = s.user_id
       WHERE ($1::text IS NULL OR s.status = $1)
       ORDER BY (s.status IN ('ACTIVE', 'ACKNOWLEDGED')) DESC, s.created_at DESC
       LIMIT $2 OFFSET $3`,
      [...params, opts.pageSize, (opts.page - 1) * opts.pageSize],
    ),
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sos_events WHERE ($1::text IS NULL OR status = $1)`,
      params,
    ),
  ]);
  return {
    total: Number(count.rows[0]?.n ?? 0),
    items: rows.rows.map((r) => ({
      id: r.id,
      tripId: r.trip_id,
      status: r.status,
      role: r.role,
      userName: r.full_name,
      createdAt: r.created_at.toISOString(),
      locationRecorded: r.latitude !== null,
      contactsNotified: r.contacts_notified,
    })),
  };
}

/** One alert in full. The recorded position is here and only here; reading it is audited by the caller. */
export async function sosDetail(sosId: string): Promise<Omit<AdminSosDetail, 'audit'>> {
  const r = await query<SosRow & { full_name: string | null }>(
    'SELECT s.*, u.full_name FROM sos_events s JOIN users u ON u.id = s.user_id WHERE s.id = $1',
    [sosId],
  );
  const s = r.rows[0];
  if (!s) throw new HttpError(404, 'NOT_FOUND', 'Alert not found.');
  const trip = await getTrip(s.trip_id);
  const names = trip
    ? await query<{ id: string; full_name: string | null }>(
        'SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])',
        [[trip.passenger_id, trip.driver_id].filter((x): x is string => !!x)],
      )
    : { rows: [] };
  const nameOf = (id: string | null) => names.rows.find((n) => n.id === id)?.full_name ?? null;
  const vehicle = trip?.driver_id ? await approvedVehicleOf(trip.driver_id) : null;
  return {
    id: s.id,
    tripId: s.trip_id,
    status: s.status,
    role: s.role,
    userName: s.full_name,
    createdAt: s.created_at.toISOString(),
    locationRecorded: s.latitude !== null,
    contactsNotified: s.contacts_notified,
    location:
      s.latitude !== null && s.longitude !== null
        ? {
            latitude: Number(s.latitude),
            longitude: Number(s.longitude),
            accuracyMeters: s.accuracy_meters,
            source: s.location_source,
            recordedAt: isoOrNull(s.location_at),
          }
        : null,
    acknowledgedAt: isoOrNull(s.acknowledged_at),
    resolvedAt: isoOrNull(s.resolved_at),
    resolutionNote: s.resolution_note,
    cancelledAt: isoOrNull(s.cancelled_at),
    trip: {
      status: trip?.status ?? 'UNKNOWN',
      passengerName: nameOf(trip?.passenger_id ?? null),
      driverName: nameOf(trip?.driver_id ?? null),
      vehicle: vehicle?.description ?? null,
      registration: vehicle?.registrationNumber ?? null,
      pickup: trip?.pickup_name ?? trip?.pickup_address ?? '',
      destination: trip?.dest_name ?? trip?.dest_address ?? '',
    },
  };
}
