import type { DriverAvailabilityState } from '@yatri/types';

import { query } from '../../lib/db';
import { sqlIn } from '../../lib/sql';
import { TRANSITIONAL_STATES } from './availability.machine';

export interface AvailabilityRow {
  driver_id: string;
  state: DriverAvailabilityState;
  state_version: number;
  state_changed_at: Date;
  online_since: Date | null;
  offline_reason: string | null;
}

const COLS = 'driver_id, state, state_version, state_changed_at, online_since, offline_reason';

/** Every driver has exactly one row; it is created lazily and idempotently. */
export async function getOrCreateAvailability(driverId: string): Promise<AvailabilityRow> {
  const res = await query<AvailabilityRow>(
    `INSERT INTO driver_availability (driver_id) VALUES ($1)
     ON CONFLICT (driver_id) DO UPDATE SET driver_id = EXCLUDED.driver_id
     RETURNING ${COLS}`,
    [driverId],
  );
  return res.rows[0] as AvailabilityRow;
}

/**
 * The only way state changes. The UPDATE only applies if the row is still in one of
 * `from` (compare-and-swap), so two racing requests can never both "win" a transition.
 * Returns the new row, or null when someone else got there first.
 */
export async function casTransition(
  driverId: string,
  from: readonly DriverAvailabilityState[],
  to: DriverAvailabilityState,
  opts: { reason?: string | null; actorId?: string | null; eventType?: string } = {},
): Promise<AvailabilityRow | null> {
  const res = await query<AvailabilityRow & { prev_state: DriverAvailabilityState }>(
    `WITH prev AS (
       SELECT state FROM driver_availability WHERE driver_id = $1 AND state = ANY($2::text[])
       FOR UPDATE
     ), upd AS (
       UPDATE driver_availability a SET
         state = $3,
         state_version = a.state_version + 1,
         state_changed_at = now(),
         updated_at = now(),
         online_since = CASE WHEN $3 = 'ONLINE' THEN now()
                             WHEN $3 IN ('OFFLINE', 'UNAVAILABLE', 'SUSPENDED') THEN NULL
                             ELSE a.online_since END,
         offline_reason = CASE WHEN $3 IN ('OFFLINE', 'UNAVAILABLE', 'SUSPENDED') THEN $4
                               WHEN $3 = 'ONLINE' THEN NULL
                               ELSE a.offline_reason END
       FROM prev
       WHERE a.driver_id = $1
       RETURNING a.${COLS.split(', ').join(', a.')}, prev.state AS prev_state
     ), ev AS (
       INSERT INTO driver_availability_events (driver_id, actor_id, event_type, from_state, to_state, reason)
       SELECT $1, $5, $6, prev_state, $3, $4 FROM upd
     )
     SELECT * FROM upd`,
    [
      driverId,
      from as string[],
      to,
      opts.reason ?? null,
      opts.actorId ?? null,
      opts.eventType ?? 'STATE_CHANGE',
    ],
  );
  return res.rows[0] ?? null;
}

export async function recordAvailabilityEvent(input: {
  driverId: string;
  actorId?: string | null;
  eventType: string;
  reason?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO driver_availability_events (driver_id, actor_id, event_type, reason)
     VALUES ($1, $2, $3, $4)`,
    [input.driverId, input.actorId ?? null, input.eventType, input.reason ?? null],
  );
}

export async function listStuckTransitions(olderThanSeconds: number) {
  const res = await query<{ driver_id: string; state: DriverAvailabilityState }>(
    `SELECT driver_id, state FROM driver_availability
     WHERE state IN ${sqlIn(TRANSITIONAL_STATES)}
       AND state_changed_at < now() - ($1::int * interval '1 second')`,
    [olderThanSeconds],
  );
  return res.rows;
}

export async function listOnlineDrivers() {
  const res = await query<{ driver_id: string; state_changed_at: Date }>(
    `SELECT driver_id, state_changed_at FROM driver_availability WHERE state = 'ONLINE'`,
  );
  return res.rows;
}
