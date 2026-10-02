import { query } from '../../lib/db';
import { settingNumber } from '../settings/settings.service';

/**
 * Extra boarding time, for a rider who said they need it (the need `EXTRA_BOARDING_TIME`, copied onto the ride when it was
 * requested). The platform setting says how many seconds; this is the one place that looks it up, so the waiting rule the
 * apps display, the waiting charge and the no-show wait always agree.
 */
export async function extraBoardingSeconds(tripId: string): Promise<number> {
  const r = await query<{ extra: boolean }>(
    `SELECT 'EXTRA_BOARDING_TIME' = ANY(needs) AS extra FROM trip_accessibility WHERE trip_id = $1`,
    [tripId],
  );
  return r.rows[0]?.extra ? settingNumber('EXTRA_BOARDING_SECONDS') : 0;
}
