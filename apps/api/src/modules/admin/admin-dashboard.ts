import {
  ACTIVE_TRIP_STATUSES,
  ASSIGNED_TRIP_STATUSES,
  TERMINAL_TRIP_STATUSES,
  OPEN_INCIDENT_STATES,
  PAYMENT_STATUSES,
  type ApiResponse,
  type DashboardData,
  type PaymentStatus,
  type TripStatus,
} from '@yatri/types';
import type { Request, Response } from 'express';

import { query } from '../../lib/db';
import { sqlIn } from '../../lib/sql';
import { availabilityConfig } from '../availability/availability.service';
import { countAvailableDrivers } from '../dispatch/matching';
import { resolveRange, type RangeQuery } from './admin-range';

/**
 * The live operational dashboard. Every number is counted from the authoritative tables at the
 * moment of the request (nothing is cached or stored twice): rides from `trips`, drivers from
 * availability and their last saved location, payments from `trip_payments`, safety from the safety
 * tables. Live counts (active rides, online drivers) are "right now"; the rest follow the range.
 */
export async function dashboardHandler(req: Request, res: Response<ApiResponse<DashboardData>>) {
  const range = await resolveRange(req.validatedQuery as RangeQuery, 'today');
  const cfg = availabilityConfig();
  const slack = cfg.freshSeconds + cfg.persistSeconds;

  const [live, ended, driverRow, available, payments, safety, pending] = await Promise.all([
    query<{ status: TripStatus; n: number }>(
      `SELECT status, count(*)::int AS n FROM trips
       WHERE status IN ${sqlIn(ACTIVE_TRIP_STATUSES)} GROUP BY status`,
    ),
    query<{ status: TripStatus; n: number }>(
      `SELECT status, count(*)::int AS n FROM trips
       WHERE requested_at >= $1 AND requested_at < $2
         AND status IN ${sqlIn(TERMINAL_TRIP_STATUSES)} GROUP BY status`,
      [range.from, range.to],
    ),
    query<{ online: number; on_trip: number; stale: number }>(
      `SELECT count(*)::int AS online,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM trips t WHERE t.driver_id = a.driver_id
                  AND t.status IN ${sqlIn(ASSIGNED_TRIP_STATUSES)}))::int AS on_trip,
              count(*) FILTER (WHERE l.recorded_at IS NULL
                OR l.recorded_at < now() - ($1::int * interval '1 second'))::int AS stale
       FROM driver_availability a
       JOIN users u ON u.id = a.driver_id AND u.status = 'ACTIVE'
       LEFT JOIN driver_last_locations l ON l.driver_id = a.driver_id
       WHERE a.state = 'ONLINE'`,
      [slack],
    ),
    countAvailableDrivers(),
    query<{ status: PaymentStatus; n: number }>(
      `SELECT p.status, count(*)::int AS n
       FROM trip_payments p JOIN trips t ON t.id = p.trip_id
       WHERE t.requested_at >= $1 AND t.requested_at < $2 GROUP BY p.status`,
      [range.from, range.to],
    ),
    query<{ incidents: number; sos: number; disputes: number }>(
      `SELECT (SELECT count(*)::int FROM incident_reports WHERE status IN ${sqlIn(OPEN_INCIDENT_STATES)}) AS incidents,
              (SELECT count(*)::int FROM sos_events WHERE status IN ('ACTIVE', 'ACKNOWLEDGED')) AS sos,
              (SELECT count(*)::int FROM trip_disputes WHERE status = 'OPEN') AS disputes`,
    ),
    query<{ n: number }>(
      `SELECT count(*)::int AS n FROM driver_profiles WHERE status IN ('SUBMITTED', 'UNDER_REVIEW')`,
    ),
  ]);

  const activeByStatus: Partial<Record<TripStatus, number>> = {};
  for (const r of live.rows) activeByStatus[r.status] = r.n;
  const endedBy = (s: TripStatus) => ended.rows.find((r) => r.status === s)?.n ?? 0;
  const byPayment = Object.fromEntries(PAYMENT_STATUSES.map((s) => [s, 0])) as Record<
    PaymentStatus,
    number
  >;
  for (const r of payments.rows) byPayment[r.status] = r.n;
  const d = driverRow.rows[0] ?? { online: 0, on_trip: 0, stale: 0 };

  res.json({
    success: true,
    data: {
      generatedAt: new Date().toISOString(),
      range,
      rides: {
        active: live.rows.reduce((sum, r) => sum + r.n, 0),
        activeByStatus,
        completed: endedBy('COMPLETED'),
        cancelled: endedBy('CANCELLED'),
        noDrivers: endedBy('NO_DRIVERS'),
      },
      drivers: {
        online: d.online,
        available,
        onTrip: d.on_trip,
        staleLocation: d.stale,
        pendingVerification: pending.rows[0]?.n ?? 0,
      },
      payments: byPayment,
      safety: {
        openIncidents: safety.rows[0]?.incidents ?? 0,
        activeSos: safety.rows[0]?.sos ?? 0,
        openDisputes: safety.rows[0]?.disputes ?? 0,
      },
    },
  });
}
