import { WAITING_TRIP_STATUSES } from '@yatri/types';

import { query } from '../../lib/db';
import { sqlIn } from '../../lib/sql';
import { env } from '../../config/env';
import { offerNext } from '../dispatch/dispatch.service';
import { settingList } from '../settings/settings.service';
import { bumpTripVersion, loadMeta, saveMeta } from '../tracking/tracking.service';
import { recordTripEvent } from './trip-events.service';
import { driverDropsOut, metaFromRow } from './trips.service';
import { getTrip } from './trips.repository';
import { secondsSince } from './waiting';
import { log } from '../../lib/logger';

/**
 * Time-driven trip housekeeping, safe to run on every instance (each write is a guarded
 * transition or a de-duplicated event):
 *  - waiting milestones: while a driver waits at the pickup the passenger is told at each
 *    configured interval; while the passenger waits for the driver, the driver is told;
 *  - a driver who was assigned but is no longer reachable (offline/unavailable past
 *    TRIP_DRIVER_LOST_SECONDS) is replaced by re-matching.
 */
export interface TripSweepResult {
  waitingEvents: number;
  rematched: string[];
}

function highestCrossed(seconds: number, thresholds: number[]): number | null {
  let hit: number | null = null;
  for (const t of thresholds) if (seconds >= t) hit = t;
  return hit;
}

export async function sweepTrips(nowMs = Date.now()): Promise<TripSweepResult> {
  const out: TripSweepResult = { waitingEvents: 0, rematched: [] };
  const thresholds = settingList('WAITING_NOTIFY_SECONDS');

  const waiting = await query<{
    id: string;
    status: 'DRIVER_EN_ROUTE' | 'DRIVER_ARRIVED';
    matched_at: Date | null;
    arrived_at: Date | null;
  }>(
    `SELECT id, status, matched_at, arrived_at FROM trips
     WHERE status IN ${sqlIn(WAITING_TRIP_STATUSES)}`,
  );
  for (const t of waiting.rows) {
    // One ride's problem must not stop the waiting notices for every ride after it.
    try {
      const arrived = t.status === 'DRIVER_ARRIVED';
      const startedAt = arrived ? t.arrived_at : t.matched_at;
      if (!startedAt) continue;
      const seconds = secondsSince(startedAt.getTime(), nowMs);
      const crossed = highestCrossed(seconds, thresholds);
      if (crossed === null) continue;

      const ev = await recordTripEvent({
        tripId: t.id,
        type: arrived ? 'DRIVER_WAITING' : 'PASSENGER_WAITING',
        payload: { seconds: crossed },
        dedupeKey: `${arrived ? 'dw' : 'pw'}:${crossed}`, // each milestone at most once per trip
      });
      if (!ev) continue;
      out.waitingEvents++;

      // Record when the other party was told, so both apps can show "notified".
      if (arrived) {
        await query('UPDATE trips SET passenger_notified_at = now() WHERE id = $1', [t.id]);
        const row = await getTrip(t.id);
        if (row) await saveMeta({ ...metaFromRow(row) });
      } else {
        const meta = await loadMeta(t.id);
        if (meta) await saveMeta({ ...meta, driverNotifiedAtMs: nowMs });
      }
      await bumpTripVersion(t.id);
    } catch (err) {
      log.error('waiting notice failed', t.id, err);
    }
  }

  const lost = await query<{ id: string; driver_id: string }>(
    `SELECT t.id, t.driver_id FROM trips t
     JOIN driver_availability a ON a.driver_id = t.driver_id
     WHERE t.status IN ${sqlIn(WAITING_TRIP_STATUSES)}
       AND a.state <> 'ONLINE'
       AND a.state_changed_at < now() - ($1::int * interval '1 second')`,
    [env.TRIP_DRIVER_LOST_SECONDS],
  );
  for (const t of lost.rows) {
    try {
      await driverDropsOut(t.id, t.driver_id, 'DRIVER_LOST');
      await offerNext(t.id);
      out.rematched.push(t.id);
    } catch (err) {
      log.error('re-match after lost driver failed', t.id, err);
    }
  }
  return out;
}
