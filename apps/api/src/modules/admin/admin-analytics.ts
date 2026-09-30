import {
  ACTIVE_TRIP_STATUSES,
  FINANCE_NOT_SUPPORTED,
  type AnalyticsData,
  type ApiResponse,
  type DailyPoint,
  type IncidentCategory,
  type IncidentStatus,
} from '@yatri/types';
import type { Request, Response } from 'express';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { resolveRange, type RangeQuery } from './admin-range';

/**
 * Analytics, computed on request from the authoritative tables over a chosen range — there is no
 * analytics database and nothing is stored a second time. Definitions (one place, shown to admins):
 *  - a ride belongs to the day it was requested;
 *  - completion / cancellation rates are over rides that reached an end (completed, cancelled or no
 *    driver found), so a ride still in progress does not count against either;
 *  - "gross fares" is the sum of final fares of completed rides. Yatri models no commission, so it is
 *    also what drivers earned; cash actually confirmed is "collected", the rest "outstanding".
 */
const pct = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
const one = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 10) / 10);

export async function analyticsHandler(req: Request, res: Response<ApiResponse<AnalyticsData>>) {
  const range = await resolveRange(req.validatedQuery as RangeQuery, '30d');
  const p = [range.from, range.to];
  const tz = env.PLATFORM_TIME_ZONE;
  const inRange = 't.requested_at >= $1 AND t.requested_at < $2';

  const [counts, money, people, daily, newcomers, safety, ratings] = await Promise.all([
    query<{ status: string; n: number }>(
      `SELECT t.status, count(*)::int AS n FROM trips t WHERE ${inRange} GROUP BY t.status`,
      p,
    ),
    query<{
      gross: number;
      completed: number;
      collected: number;
      fees: number;
    }>(
      `SELECT COALESCE(sum(t.fare_final_npr) FILTER (WHERE t.status = 'COMPLETED'), 0)::int AS gross,
              count(*) FILTER (WHERE t.status = 'COMPLETED')::int AS completed,
              COALESCE(sum(pay.amount_npr) FILTER (WHERE t.status = 'COMPLETED'), 0)::int AS collected,
              COALESCE(sum(t.cancellation_fee_npr) FILTER (WHERE t.status = 'CANCELLED'), 0)::int AS fees
       FROM trips t
       LEFT JOIN trip_payments pay ON pay.trip_id = t.id AND pay.status = 'PAID'
       WHERE ${inRange}`,
      p,
    ),
    query<{ drivers: number; passengers: number }>(
      `SELECT count(DISTINCT t.driver_id) FILTER (WHERE t.status = 'COMPLETED')::int AS drivers,
              count(DISTINCT t.passenger_id)::int AS passengers
       FROM trips t WHERE ${inRange}`,
      p,
    ),
    query<{ day: string; requested: number; completed: number; cancelled: number; gross: number }>(
      `WITH days AS (
         SELECT d::date AS day
         FROM generate_series(($1::timestamptz AT TIME ZONE $3)::date,
                              (($2::timestamptz AT TIME ZONE $3) - interval '1 second')::date,
                              interval '1 day') AS d)
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
              count(t.id)::int AS requested,
              count(t.id) FILTER (WHERE t.status = 'COMPLETED')::int AS completed,
              count(t.id) FILTER (WHERE t.status = 'CANCELLED')::int AS cancelled,
              COALESCE(sum(t.fare_final_npr) FILTER (WHERE t.status = 'COMPLETED'), 0)::int AS gross
       FROM days
       LEFT JOIN trips t
         ON (t.requested_at AT TIME ZONE $3)::date = days.day AND t.requested_at >= $1 AND t.requested_at < $2
       GROUP BY days.day ORDER BY days.day`,
      [...p, tz],
    ),
    query<{ drivers: number; passengers: number }>(
      `SELECT count(*) FILTER (WHERE role = 'DRIVER')::int AS drivers,
              count(*) FILTER (WHERE role = 'PASSENGER')::int AS passengers
       FROM users WHERE created_at >= $1 AND created_at < $2`,
      p,
    ),
    query<{
      category: IncidentCategory | null;
      status: IncidentStatus | null;
      n: number;
      sos: number;
      disputes: number;
      low: number;
    }>(
      `SELECT i.category, i.status, count(*)::int AS n,
              (SELECT count(*)::int FROM sos_events WHERE created_at >= $1 AND created_at < $2) AS sos,
              (SELECT count(*)::int FROM trip_disputes WHERE created_at >= $1 AND created_at < $2) AS disputes,
              (SELECT count(*)::int FROM trip_ratings WHERE stars <= 2 AND created_at >= $1 AND created_at < $2) AS low
       FROM (SELECT 1) one
       LEFT JOIN incident_reports i ON i.created_at >= $1 AND i.created_at < $2
       GROUP BY i.category, i.status`,
      p,
    ),
    query<{ avg: string | null; n: number }>(
      `SELECT round(avg(stars)::numeric, 1)::text AS avg, count(*)::int AS n
       FROM trip_ratings WHERE created_at >= $1 AND created_at < $2`,
      p,
    ),
  ]);

  const status = (s: string) => counts.rows.find((r) => r.status === s)?.n ?? 0;
  const completed = status('COMPLETED');
  const cancelled = status('CANCELLED');
  const noDrivers = status('NO_DRIVERS');
  const requested = counts.rows.reduce((sum, r) => sum + r.n, 0);
  const stillActive = counts.rows
    .filter((r) => (ACTIVE_TRIP_STATUSES as readonly string[]).includes(r.status))
    .reduce((sum, r) => sum + r.n, 0);
  const ended = completed + cancelled + noDrivers;
  const m = money.rows[0] ?? { gross: 0, completed: 0, collected: 0, fees: 0 };
  const ppl = people.rows[0] ?? { drivers: 0, passengers: 0 };
  const fresh = newcomers.rows[0] ?? { drivers: 0, passengers: 0 };

  const incidentsByCategory: Partial<Record<IncidentCategory, number>> = {};
  const incidentsByStatus: Partial<Record<IncidentStatus, number>> = {};
  let incidents = 0;
  for (const r of safety.rows) {
    if (!r.category || !r.status) continue;
    incidents += r.n;
    incidentsByCategory[r.category] = (incidentsByCategory[r.category] ?? 0) + r.n;
    incidentsByStatus[r.status] = (incidentsByStatus[r.status] ?? 0) + r.n;
  }
  const extra = safety.rows[0] ?? { sos: 0, disputes: 0, low: 0 };

  const points: DailyPoint[] = daily.rows.map((d) => ({
    day: d.day,
    requested: d.requested,
    completed: d.completed,
    cancelled: d.cancelled,
    grossFaresNpr: d.gross,
  }));

  res.json({
    success: true,
    data: {
      generatedAt: new Date().toISOString(),
      range,
      rides: {
        requested,
        completed,
        cancelled,
        noDrivers,
        stillActive,
        completionRatePercent: pct(completed, ended),
        cancellationRatePercent: pct(cancelled, ended),
        daily: points,
      },
      money: {
        grossFaresNpr: m.gross,
        averageFareNpr: m.completed === 0 ? null : Math.round(m.gross / m.completed),
        collectedNpr: m.collected,
        outstandingNpr: Math.max(0, m.gross - m.collected),
        cancellationFeesNpr: m.fees,
        driverEarningsNpr: m.gross,
        payouts: { supported: false, reason: FINANCE_NOT_SUPPORTED },
      },
      drivers: {
        active: ppl.drivers,
        newlyRegistered: fresh.drivers,
        ridesPerActiveDriver: one(completed, ppl.drivers),
      },
      passengers: {
        active: ppl.passengers,
        newlyRegistered: fresh.passengers,
        ridesPerActivePassenger: one(requested, ppl.passengers),
      },
      safety: {
        incidents,
        incidentsByCategory,
        incidentsByStatus,
        sosAlerts: extra.sos,
        disputes: extra.disputes,
        lowRatings: extra.low,
      },
      ratings: {
        average: ratings.rows[0]?.avg ? Number(ratings.rows[0].avg) : null,
        count: ratings.rows[0]?.n ?? 0,
      },
    },
  });
}
