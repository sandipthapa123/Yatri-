import {
  describePayment,
  orgRoleHolds,
  type OrgRideRow,
  type OrgUsageReport,
  type PaymentMethod,
  type PaymentStatus,
  type ResolvedRange,
} from '@yatri/types';

import { query } from '../../lib/db';
import type { OrgContext } from './access';
import { ORG_TRIP_COST_SQL } from './spend';

/**
 * The organization's ride history and usage reports. Both read the ordinary trips (and their payments) and
 * apply ONE cost expression (`ORG_TRIP_COST_SQL`, the same the monthly limits use). History shows who booked,
 * who rode, where and what it cost: never a live position, route, phone number or chat. People without
 * RIDES_VIEW_ALL see only rides they booked or rode in.
 */
export interface RideFilters {
  status?: string | undefined;
  costCenterId?: string | undefined;
  passengerId?: string | undefined;
  page: number;
  pageSize: number;
}

interface Row {
  id: string;
  status: string;
  requested_at: Date;
  ended_at: Date | null;
  booked_by_name: string | null;
  passenger_name: string | null;
  pickup_address: string;
  dest_address: string;
  category: string | null;
  cost_center_code: string | null;
  purpose: string | null;
  cost: number;
  method: PaymentMethod | null;
  payment_status: PaymentStatus | null;
  statement_number: string | null;
}

const FROM = `FROM trips t
  JOIN users p ON p.id = t.passenger_id
  LEFT JOIN users b ON b.id = t.booked_by
  JOIN locations pl ON pl.id = t.pickup_location_id
  JOIN locations dl ON dl.id = t.destination_location_id
  LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
  LEFT JOIN organization_cost_centers cc ON cc.id = t.cost_center_id
  LEFT JOIN trip_payments pay ON pay.trip_id = t.id
  LEFT JOIN organization_statements st ON st.id = pay.statement_id`;

export async function listOrgRides(
  ctx: OrgContext,
  f: RideFilters,
): Promise<{ items: OrgRideRow[]; total: number }> {
  const all = orgRoleHolds(ctx.role, 'RIDES_VIEW_ALL');
  const where = [
    't.organization_id = $1',
    '($2::boolean OR t.booked_by = $3 OR t.passenger_id = $3)',
  ];
  const params: unknown[] = [ctx.orgId, all, ctx.userId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace('?', `$${params.length}`));
  };
  if (f.status) add('t.status = ?', f.status);
  if (f.costCenterId) add('t.cost_center_id = ?', f.costCenterId);
  if (f.passengerId) add('t.passenger_id = ?', f.passengerId);
  const clause = `WHERE ${where.join(' AND ')}`;
  const [rows, count] = await Promise.all([
    query<Row>(
      `SELECT t.id, t.status, t.requested_at, t.ended_at, b.full_name AS booked_by_name, p.full_name AS passenger_name,
              pl.address AS pickup_address, dl.address AS dest_address, vc.label AS category,
              cc.code AS cost_center_code, t.purpose, ${ORG_TRIP_COST_SQL}::int AS cost,
              pay.method, pay.status AS payment_status, st.number::text AS statement_number
       ${FROM} ${clause}
       ORDER BY t.requested_at DESC, t.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, (f.page - 1) * f.pageSize],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n ${FROM} ${clause}`, params),
  ]);
  return {
    total: count.rows[0]?.n ?? 0,
    items: rows.rows.map((r) => ({
      tripId: r.id,
      status: r.status,
      requestedAt: r.requested_at.toISOString(),
      endedAt: r.ended_at?.toISOString() ?? null,
      bookedByName: r.booked_by_name,
      passengerName: r.passenger_name,
      pickupAddress: r.pickup_address,
      destinationAddress: r.dest_address,
      vehicleCategory: r.category,
      costCenterCode: r.cost_center_code,
      purpose: r.purpose,
      costNpr: r.cost,
      paymentStatus: describePayment(r.method, r.payment_status ?? 'NONE'),
      statementNumber: r.statement_number === null ? null : Number(r.statement_number),
    })),
  };
}

/** Usage over a range (the platform's one date rule: rides count on the day they were requested). */
export async function usageReport(ctx: OrgContext, range: ResolvedRange): Promise<OrgUsageReport> {
  const base = `FROM trips t
    LEFT JOIN organization_cost_centers cc ON cc.id = t.cost_center_id
    LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id
    JOIN users p ON p.id = t.passenger_id
    WHERE t.organization_id = $1 AND t.requested_at >= $2 AND t.requested_at < $3`;
  const params = [ctx.orgId, range.from, range.to];
  const [totals, month, center, member, category] = await Promise.all([
    query<{ rides: number; completed: number; cancelled: number; spend: number }>(
      `SELECT count(*)::int AS rides, count(*) FILTER (WHERE t.status = 'COMPLETED')::int AS completed,
              count(*) FILTER (WHERE t.status = 'CANCELLED')::int AS cancelled,
              COALESCE(sum(${ORG_TRIP_COST_SQL}), 0)::int AS spend ${base}`,
      params,
    ),
    query<{ month: string; rides: number; spend: number }>(
      `SELECT to_char(t.requested_at, 'YYYY-MM') AS month, count(*)::int AS rides,
              COALESCE(sum(${ORG_TRIP_COST_SQL}), 0)::int AS spend ${base} GROUP BY 1 ORDER BY 1`,
      params,
    ),
    query<{ code: string | null; name: string | null; rides: number; spend: number }>(
      `SELECT cc.code, cc.name, count(*)::int AS rides, COALESCE(sum(${ORG_TRIP_COST_SQL}), 0)::int AS spend
       ${base} GROUP BY cc.code, cc.name ORDER BY spend DESC, cc.code NULLS LAST`,
      params,
    ),
    query<{ user_id: string; name: string | null; rides: number; spend: number }>(
      `SELECT t.passenger_id AS user_id, p.full_name AS name, count(*)::int AS rides,
              COALESCE(sum(${ORG_TRIP_COST_SQL}), 0)::int AS spend
       ${base} GROUP BY t.passenger_id, p.full_name ORDER BY spend DESC, p.full_name`,
      params,
    ),
    query<{ code: string | null; label: string | null; rides: number; spend: number }>(
      `SELECT vc.code, vc.label, count(*)::int AS rides, COALESCE(sum(${ORG_TRIP_COST_SQL}), 0)::int AS spend
       ${base} GROUP BY vc.code, vc.label ORDER BY spend DESC, vc.code`,
      params,
    ),
  ]);
  const t = totals.rows[0];
  return {
    range,
    rides: t?.rides ?? 0,
    completed: t?.completed ?? 0,
    cancelled: t?.cancelled ?? 0,
    spendNpr: t?.spend ?? 0,
    byMonth: month.rows.map((m) => ({ month: m.month, rides: m.rides, spendNpr: m.spend })),
    byCostCenter: center.rows.map((c) => ({
      code: c.code,
      name: c.name,
      rides: c.rides,
      spendNpr: c.spend,
    })),
    byMember: member.rows.map((m) => ({
      userId: m.user_id,
      name: m.name,
      rides: m.rides,
      spendNpr: m.spend,
    })),
    byCategory: category.rows.map((c) => ({
      code: c.code,
      label: c.label,
      rides: c.rides,
      spendNpr: c.spend,
    })),
  };
}
