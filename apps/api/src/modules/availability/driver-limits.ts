import { env } from '../../config/env';
import { query } from '../../lib/db';
import { settingNumber } from '../settings/settings.service';

/**
 * Driver operational limits, from the platform settings (0 = no limit): most rides finished in a day, and
 * longest time online without a break. One definition: go-online eligibility says why a driver is
 * refused, and matching leaves out anyone over a limit, both from `driversOverLimit`.
 */
export interface LimitResult {
  /** driverId -> the sentence that explains the limit, for every driver who is over one. */
  over: Map<string, string>;
}

export async function driversOverLimit(driverIds: readonly string[]): Promise<LimitResult> {
  const over = new Map<string, string>();
  if (driverIds.length === 0) return { over };
  const maxRides = settingNumber('DRIVER_MAX_RIDES_PER_DAY');
  const maxHours = settingNumber('DRIVER_MAX_ONLINE_HOURS');
  if (maxRides > 0) {
    // "Today" is the platform's day (the same time zone every report uses).
    const r = await query<{ driver_id: string; n: number }>(
      `SELECT driver_id, count(*)::int AS n FROM trips
       WHERE driver_id = ANY($1::uuid[]) AND status = 'COMPLETED'
         AND ended_at >= date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2
       GROUP BY driver_id HAVING count(*) >= $3`,
      [driverIds, env.PLATFORM_TIME_ZONE, maxRides],
    );
    for (const row of r.rows) {
      over.set(
        row.driver_id,
        `You have finished ${row.n} rides today, the most allowed in a day. You can take more rides tomorrow.`,
      );
    }
  }
  if (maxHours > 0) {
    const r = await query<{ driver_id: string }>(
      `SELECT driver_id FROM driver_availability
       WHERE driver_id = ANY($1::uuid[]) AND state = 'ONLINE'
         AND online_since < now() - ($2::int * interval '1 hour')`,
      [driverIds, maxHours],
    );
    for (const row of r.rows) {
      if (!over.has(row.driver_id)) {
        over.set(
          row.driver_id,
          `You have been online for more than ${maxHours} hours. Go offline and rest, then go online again.`,
        );
      }
    }
  }
  return { over };
}

/** Why one driver may not go online because of a limit, or null. */
export async function limitReasonFor(driverId: string): Promise<string | null> {
  // A driver who is not yet online has no online time to count: only the daily ride limit can apply.
  return (await driversOverLimit([driverId])).over.get(driverId) ?? null;
}
