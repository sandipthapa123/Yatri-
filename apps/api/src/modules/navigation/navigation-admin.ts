import type { NavigationMetrics, ResolvedRange } from '@yatri/types';

import { query } from '../../lib/db';
import { getRouteProvider } from '../location/providers';
import { NAV_METRICS } from './navigation.service';

/** The admin figures for routes and arrival times: from the daily counters and the counts kept on rides. Nothing personal. */
export async function navigationMetrics(range: ResolvedRange): Promise<NavigationMetrics> {
  const [counters, rides, eta] = await Promise.all([
    query<{ metric: string; value: string }>(
      `SELECT metric, sum(value)::text AS value FROM navigation_metrics
       WHERE day >= ($1::timestamptz AT TIME ZONE $3)::date AND day < ($2::timestamptz AT TIME ZONE $3)::date + 1
       GROUP BY metric`,
      [range.from, range.to, range.timeZone],
    ),
    query<{ total: number; deviated: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE route_deviations > 0)::int AS deviated
       FROM trips WHERE status IN ('COMPLETED', 'CANCELLED') AND driver_id IS NOT NULL
         AND requested_at >= $1 AND requested_at < $2`,
      [range.from, range.to],
    ),
    query<{ n: number; within: number; avg_err: number | null }>(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE abs(nav_eta_seconds - actual_duration_seconds) <= 0.2 * actual_duration_seconds)::int AS within,
              avg(abs(nav_eta_seconds - actual_duration_seconds)::float8 * 100 / actual_duration_seconds) AS avg_err
       FROM trips WHERE status = 'COMPLETED' AND nav_eta_seconds IS NOT NULL AND actual_duration_seconds > 60
         AND requested_at >= $1 AND requested_at < $2`,
      [range.from, range.to],
    ),
  ]);
  const c = (m: string) => Number(counters.rows.find((r) => r.metric === m)?.value ?? 0);
  const planned = c(NAV_METRICS.ROUTES_PLANNED);
  const fallbacks = c(NAV_METRICS.ROUTE_FALLBACKS);
  const e = eta.rows[0];
  const provider = getRouteProvider();
  return {
    rangeLabel: range.label,
    provider: {
      name: provider.name,
      steps: provider.capabilities.steps,
      traffic: provider.capabilities.traffic,
    },
    routesPlanned: planned,
    routeFallbacks: fallbacks,
    fallbackPercent: planned > 0 ? Math.round((fallbacks * 1000) / planned) / 10 : null,
    reroutes: c(NAV_METRICS.REROUTES),
    deviationsConfirmed: c(NAV_METRICS.DEVIATIONS_CONFIRMED),
    ridesTotal: rides.rows[0]?.total ?? 0,
    ridesWithDeviation: rides.rows[0]?.deviated ?? 0,
    arrivalsAtPickup: c(NAV_METRICS.ARRIVALS_AT_PICKUP),
    arrivalsAtDestination: c(NAV_METRICS.ARRIVALS_AT_DESTINATION),
    eta: {
      samples: e?.n ?? 0,
      withinTwentyPercent: e && e.n > 0 ? Math.round((e.within * 1000) / e.n) / 10 : null,
      averageErrorPercent: e && e.avg_err !== null ? Math.round(e.avg_err * 10) / 10 : null,
    },
  };
}
