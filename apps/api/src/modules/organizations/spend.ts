import type { PoolClient } from 'pg';

import { query } from '../../lib/db';

/**
 * What a ride costs an organization, in ONE expression, used by the monthly limits and the usage report (so
 * the number a limit stops at and the number a report shows can never differ): a finished ride is its final
 * fare, a ride under way is its estimate (committed), and a cancelled or unmatched ride costs nothing (the
 * platform does not charge cancellation fees to an organization). Billing itself reads `trip_payments`.
 */
export const ORG_TRIP_COST_SQL = `(CASE t.status
    WHEN 'COMPLETED' THEN COALESCE(t.fare_final_npr, t.fare_estimate_npr, 0)
    WHEN 'CANCELLED' THEN 0
    WHEN 'NO_DRIVERS' THEN 0
    ELSE COALESCE(t.fare_estimate_npr, 0) END)`;

export interface MonthlySpend {
  organization: number;
  passenger: number;
}

/** What is already committed this calendar month (platform time zone) by the organization and by one rider. */
export async function spentThisMonth(
  orgId: string,
  passengerId: string,
  client?: PoolClient,
): Promise<MonthlySpend> {
  const sql = `SELECT COALESCE(sum(${ORG_TRIP_COST_SQL}), 0)::int AS organization,
                      COALESCE(sum(${ORG_TRIP_COST_SQL}) FILTER (WHERE t.passenger_id = $2), 0)::int AS passenger
               FROM trips t
               WHERE t.organization_id = $1 AND t.requested_at >= date_trunc('month', now())`;
  const r = client
    ? await client.query<MonthlySpend>(sql, [orgId, passengerId])
    : await query<MonthlySpend>(sql, [orgId, passengerId]);
  return r.rows[0] ?? { organization: 0, passenger: 0 };
}
