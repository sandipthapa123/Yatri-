import {
  describeIncentive,
  incentiveProblem,
  periodKey,
  windowActive,
  zonesAt,
  INCENTIVE_KINDS,
  INCENTIVE_PERIODS,
  type AdminIncentiveRuleBody,
  type DriverIncentivesView,
  type IncentiveAwardRow,
  type IncentiveRuleInfo,
} from '@yatri/types';
import { z } from 'zod';

import { env } from '../../config/env';
import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { windowFromRow, windowSchema, type WindowRow } from './window-columns';
import { activeZones } from './zones.service';

/**
 * Driver incentives, calculated in ONE place: `evaluateIncentives`, run when a ride completes. A rule is a
 * completed-ride target (per day or week), a time-of-day bonus, or a zone bonus; it names the zone,
 * vehicle category and time window it applies to with the same zone test and time window as dynamic pricing.
 * Each bonus earned is one row in `incentive_awards` (unique per ride, or per driver and period for a
 * target), so a repeated completion or two instances cannot pay twice. Awards are a record of what the
 * platform owes: they never change a fare, a payment or a refund.
 */
interface RuleRow extends WindowRow {
  id: string;
  name: string;
  kind: IncentiveRuleInfo['kind'];
  zone_id: string | null;
  zone_name: string | null;
  vehicle_category_id: string | null;
  category_label: string | null;
  period: IncentiveRuleInfo['period'];
  target_rides: number | null;
  bonus_npr: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}
const SELECT = `SELECT r.id, r.name, r.kind, r.zone_id, z.name AS zone_name, r.vehicle_category_id,
    c.label AS category_label, r.days_of_week, r.start_minute, r.end_minute, r.starts_at, r.ends_at,
    r.period, r.target_rides, r.bonus_npr, r.is_active, r.created_at, r.updated_at
  FROM incentive_rules r
  LEFT JOIN service_zones z ON z.id = r.zone_id
  LEFT JOIN vehicle_categories c ON c.id = r.vehicle_category_id`;
const toRule = (r: RuleRow): IncentiveRuleInfo => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  zoneId: r.zone_id,
  zoneName: r.zone_name,
  vehicleCategoryId: r.vehicle_category_id,
  vehicleCategoryLabel: r.category_label,
  window: windowFromRow(r),
  period: r.period,
  targetRides: r.target_rides,
  bonusNpr: r.bonus_npr,
  isActive: r.is_active,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export async function listIncentiveRules(onlyActive = false): Promise<IncentiveRuleInfo[]> {
  const r = await query<RuleRow>(
    `${SELECT} ${onlyActive ? 'WHERE r.is_active' : ''} ORDER BY r.is_active DESC, r.created_at DESC`,
  );
  return r.rows.map(toRule);
}

export const incentiveRuleSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(INCENTIVE_KINDS),
    zoneId: z.string().uuid().nullable(),
    vehicleCategoryId: z.string().uuid().nullable(),
    window: windowSchema,
    period: z.enum(INCENTIVE_PERIODS).nullable(),
    targetRides: z.number().int().min(1).max(1000).nullable(),
    bonusNpr: z.number().int().min(1).max(100000),
    isActive: z.boolean(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

const params = (b: AdminIncentiveRuleBody) => [
  b.name,
  b.kind,
  b.zoneId,
  b.vehicleCategoryId,
  b.window.daysOfWeek,
  b.window.startMinute,
  b.window.endMinute,
  b.window.startsAt,
  b.window.endsAt,
  b.kind === 'RIDE_TARGET' ? b.period : null,
  b.kind === 'RIDE_TARGET' ? b.targetRides : null,
  b.bonusNpr,
  b.isActive,
];

async function check(b: AdminIncentiveRuleBody) {
  const problem = incentiveProblem(b);
  if (problem) throw new HttpError(400, 'VALIDATION_ERROR', problem);
  if (
    b.zoneId &&
    !(await query('SELECT 1 FROM service_zones WHERE id = $1', [b.zoneId])).rowCount
  ) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown zone.');
  }
  if (
    b.vehicleCategoryId &&
    !(await query('SELECT 1 FROM vehicle_categories WHERE id = $1', [b.vehicleCategoryId])).rowCount
  ) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown vehicle category.');
  }
}

export async function createIncentiveRule(b: AdminIncentiveRuleBody, adminId: string) {
  await check(b);
  const r = await query<{ id: string }>(
    `INSERT INTO incentive_rules (name, kind, zone_id, vehicle_category_id, days_of_week, start_minute,
       end_minute, starts_at, ends_at, period, target_rides, bonus_npr, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
    params(b),
  );
  const id = (r.rows[0] as { id: string }).id;
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'INCENTIVE_RULE_CREATED',
    subjectType: 'incentive_rule',
    subjectIds: [id],
    detail: { name: b.name, kind: b.kind, bonusNpr: b.bonusNpr, reason: b.reason },
  });
  return (await listIncentiveRules()).find((x) => x.id === id) as IncentiveRuleInfo;
}

export async function updateIncentiveRule(id: string, b: AdminIncentiveRuleBody, adminId: string) {
  await check(b);
  const r = await query(
    `UPDATE incentive_rules SET name = $2, kind = $3, zone_id = $4, vehicle_category_id = $5,
       days_of_week = $6, start_minute = $7, end_minute = $8, starts_at = $9, ends_at = $10,
       period = $11, target_rides = $12, bonus_npr = $13, is_active = $14, updated_at = now()
     WHERE id = $1`,
    [id, ...params(b)],
  );
  if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Incentive rule not found.');
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'INCENTIVE_RULE_UPDATED',
    subjectType: 'incentive_rule',
    subjectIds: [id],
    detail: { name: b.name, bonusNpr: b.bonusNpr, active: b.isActive, reason: b.reason },
  });
  return (await listIncentiveRules()).find((x) => x.id === id) as IncentiveRuleInfo;
}

// ---------------------------------------------------------------- evaluation

interface RideFacts {
  id: string;
  driverId: string;
  endedAt: Date;
  categoryId: string | null;
  pickup: { latitude: number; longitude: number };
}

/** Whether one completed ride qualifies for a rule (zone, category and time window; not the count). */
function rideMatches(
  rule: IncentiveRuleInfo,
  ride: RideFacts,
  zoneIdsAtPickup: ReadonlySet<string>,
): boolean {
  if (rule.zoneId !== null && !zoneIdsAtPickup.has(rule.zoneId)) return false;
  if (rule.vehicleCategoryId !== null && rule.vehicleCategoryId !== ride.categoryId) return false;
  return windowActive(rule.window, ride.endedAt, env.PLATFORM_TIME_ZONE);
}

async function ridesOf(driverId: string, sinceDays: number): Promise<RideFacts[]> {
  const r = await query<{
    id: string;
    driver_id: string;
    ended_at: Date;
    vehicle_category_id: string | null;
    latitude: number;
    longitude: number;
  }>(
    `SELECT t.id, t.driver_id, t.ended_at, t.vehicle_category_id,
            pl.latitude::float8 AS latitude, pl.longitude::float8 AS longitude
     FROM trips t JOIN locations pl ON pl.id = t.pickup_location_id
     WHERE t.driver_id = $1 AND t.status = 'COMPLETED' AND t.ended_at > now() - ($2::int * interval '1 day')`,
    [driverId, sinceDays],
  );
  return r.rows.map((x) => ({
    id: x.id,
    driverId: x.driver_id,
    endedAt: x.ended_at,
    categoryId: x.vehicle_category_id,
    pickup: { latitude: x.latitude, longitude: x.longitude },
  }));
}

async function award(
  rule: IncentiveRuleInfo,
  driverId: string,
  tripId: string | null,
  key: string,
): Promise<boolean> {
  const r = await query<{ id: string }>(
    `INSERT INTO incentive_awards (rule_id, driver_id, trip_id, period_key, amount_npr)
     VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
    [rule.id, driverId, tripId, key, rule.bonusNpr],
  );
  const row = r.rows[0];
  if (!row) return false; // already awarded: a repeat changes nothing
  await recordAudit({
    actorId: null,
    actorRole: 'SYSTEM',
    action: 'INCENTIVE_AWARDED',
    subjectType: 'incentive_award',
    subjectIds: [row.id],
    detail: { rule: rule.name, amountNpr: rule.bonusNpr, periodKey: key },
  });
  await notify({
    userId: driverId,
    type: 'INCENTIVE_EARNED',
    title: 'Yatri bonus',
    body: `You earned a bonus of NPR ${rule.bonusNpr}: ${rule.name}.`,
    metadata: { ruleId: rule.id, tripId },
  }).catch(() => undefined);
  return true;
}

/**
 * Called once a ride is completed. Per-ride bonuses are awarded for this ride; target bonuses are awarded
 * when this ride brings the driver to the target for the day or week it belongs to. Returns the rules paid.
 */
export async function evaluateIncentives(tripId: string): Promise<string[]> {
  const t = await query<{ driver_id: string | null; ended_at: Date | null; status: string }>(
    'SELECT driver_id, ended_at, status FROM trips WHERE id = $1',
    [tripId],
  );
  const trip = t.rows[0];
  if (!trip || trip.status !== 'COMPLETED' || !trip.driver_id || !trip.ended_at) return [];
  const rules = await listIncentiveRules(true);
  if (rules.length === 0) return [];
  const rides = await ridesOf(trip.driver_id, 8);
  const ride = rides.find((x) => x.id === tripId);
  if (!ride) return [];
  const zones = await activeZones();
  const zoneIds = (r: RideFacts) => new Set(zonesAt(zones, r.pickup).map((z) => z.id));
  const tz = env.PLATFORM_TIME_ZONE;
  const paid: string[] = [];
  for (const rule of rules) {
    if (!rideMatches(rule, ride, zoneIds(ride))) continue;
    if (rule.kind !== 'RIDE_TARGET') {
      if (await award(rule, trip.driver_id, tripId, periodKey(ride.endedAt, 'DAILY', tz))) {
        paid.push(rule.name);
      }
      continue;
    }
    if (!rule.period || !rule.targetRides) continue;
    const period = rule.period;
    const key = periodKey(ride.endedAt, period, tz);
    const counted = rides.filter(
      (x) => periodKey(x.endedAt, period, tz) === key && rideMatches(rule, x, zoneIds(x)),
    ).length;
    if (counted >= rule.targetRides && (await award(rule, trip.driver_id, null, key))) {
      paid.push(rule.name);
    }
  }
  return paid;
}

// ---------------------------------------------------------------- what a driver sees, and what admins audit

/** The driver's own standing on every active rule, and what they have earned (from the award records). */
export async function driverIncentives(driverId: string): Promise<DriverIncentivesView> {
  const rules = await listIncentiveRules(true);
  const rides = await ridesOf(driverId, 8);
  const zones = await activeZones();
  const tz = env.PLATFORM_TIME_ZONE;
  const now = new Date();
  const earned = await query<{ rule_id: string; period_key: string; n: number }>(
    `SELECT rule_id, period_key, sum(amount_npr)::int AS n FROM incentive_awards
     WHERE driver_id = $1 GROUP BY rule_id, period_key`,
    [driverId],
  );
  const total = await query<{ n: number }>(
    'SELECT COALESCE(sum(amount_npr), 0)::int AS n FROM incentive_awards WHERE driver_id = $1',
    [driverId],
  );
  const progress = rules.map((rule) => {
    const period = rule.period ?? 'DAILY';
    const key = periodKey(now, period, tz);
    const counted = rides.filter(
      (x) =>
        periodKey(x.endedAt, period, tz) === key &&
        rideMatches(rule, x, new Set(zonesAt(zones, x.pickup).map((z) => z.id))),
    ).length;
    const earnedNpr = earned.rows
      .filter((e) => e.rule_id === rule.id && (rule.kind !== 'RIDE_TARGET' || e.period_key === key))
      .reduce((n, e) => n + e.n, 0);
    let status: string;
    if (rule.kind === 'RIDE_TARGET') {
      const target = rule.targetRides as number;
      const span = rule.period === 'WEEKLY' ? 'week' : 'day';
      status =
        counted >= target
          ? `Target reached: you earned NPR ${rule.bonusNpr} this ${span}.`
          : `${counted} of ${target} rides done this ${span}; ${target - counted} to go.`;
    } else {
      status =
        earnedNpr > 0
          ? `You have earned NPR ${earnedNpr} from this bonus.`
          : 'No bonus earned from this yet.';
    }
    return {
      rule,
      text: describeIncentive(rule),
      completed: rule.kind === 'RIDE_TARGET' ? counted : 0,
      target: rule.kind === 'RIDE_TARGET' ? rule.targetRides : null,
      earnedNpr,
      status,
    };
  });
  return {
    progress,
    totalEarnedNpr: total.rows[0]?.n ?? 0,
    note: 'Bonuses are recorded by Yatri and are separate from the fares you collect in cash. Ask support how and when they are paid.',
  };
}

export async function listAwards(page: number, pageSize: number) {
  const [rows, count] = await Promise.all([
    query<{
      id: string;
      rule_name: string;
      driver_id: string;
      full_name: string | null;
      trip_id: string | null;
      period_key: string;
      amount_npr: number;
      created_at: Date;
    }>(
      `SELECT a.id, r.name AS rule_name, a.driver_id, u.full_name, a.trip_id, a.period_key, a.amount_npr, a.created_at
       FROM incentive_awards a JOIN incentive_rules r ON r.id = a.rule_id JOIN users u ON u.id = a.driver_id
       ORDER BY a.created_at DESC, a.id LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize],
    ),
    query<{ n: string; total: string }>(
      'SELECT count(*)::text AS n, COALESCE(sum(amount_npr), 0)::text AS total FROM incentive_awards',
    ),
  ]);
  const items: IncentiveAwardRow[] = rows.rows.map((a) => ({
    id: a.id,
    ruleName: a.rule_name,
    driverId: a.driver_id,
    driverName: a.full_name,
    tripId: a.trip_id,
    periodKey: a.period_key,
    amountNpr: a.amount_npr,
    createdAt: a.created_at.toISOString(),
  }));
  return {
    items,
    total: Number(count.rows[0]?.n ?? 0),
    totalAwardedNpr: Number(count.rows[0]?.total ?? 0),
  };
}
