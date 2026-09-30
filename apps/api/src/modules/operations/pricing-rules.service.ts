import {
  SURGE_ABSOLUTE_MAX,
  SURGE_MIN_MULTIPLIER,
  type AdminPricingRuleBody,
  type PricingRuleInfo,
} from '@yatri/types';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { windowFromRow, windowSchema, type WindowRow } from './window-columns';

/**
 * Dynamic pricing rules as data: where (a zone), when (a window, or a special event's dates), for which
 * vehicle category, under what demand, and by how much. Editing is audited with a reason. The engine that
 * applies them is `surge.ts`; nothing about a rule is written in an app.
 */
export type PricingRuleRow = PricingRuleInfo;

interface Row extends WindowRow {
  id: string;
  name: string;
  label: string;
  zone_id: string | null;
  zone_name: string | null;
  vehicle_category_id: string | null;
  category_label: string | null;
  min_demand_ratio: string | null;
  multiplier: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}
const SELECT = `SELECT r.id, r.name, r.label, r.zone_id, z.name AS zone_name, r.vehicle_category_id,
    c.label AS category_label, r.days_of_week, r.start_minute, r.end_minute, r.starts_at, r.ends_at,
    r.min_demand_ratio, r.multiplier, r.is_active, r.created_at, r.updated_at
  FROM pricing_rules r
  LEFT JOIN service_zones z ON z.id = r.zone_id
  LEFT JOIN vehicle_categories c ON c.id = r.vehicle_category_id`;
const toRule = (r: Row): PricingRuleInfo => ({
  id: r.id,
  name: r.name,
  label: r.label,
  zoneId: r.zone_id,
  zoneName: r.zone_name,
  vehicleCategoryId: r.vehicle_category_id,
  vehicleCategoryLabel: r.category_label,
  window: windowFromRow(r),
  minDemandRatio: r.min_demand_ratio === null ? null : Number(r.min_demand_ratio),
  multiplier: Number(r.multiplier),
  isActive: r.is_active,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});

export async function listPricingRules(): Promise<PricingRuleInfo[]> {
  const r = await query<Row>(`${SELECT} ORDER BY r.is_active DESC, r.created_at DESC`);
  return r.rows.map(toRule);
}

const CACHE_MS = 5_000;
let cache: { at: number; rules: PricingRuleInfo[] } | null = null;
export const dropPricingRuleCache = () => {
  cache = null;
};
export async function activePricingRules(): Promise<PricingRuleInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.rules;
  const r = await query<Row>(`${SELECT} WHERE r.is_active`);
  const rules = r.rows.map(toRule);
  cache = { at: Date.now(), rules };
  return rules;
}

export const pricingRuleSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    label: z.string().trim().min(2).max(60),
    zoneId: z.string().uuid().nullable(),
    vehicleCategoryId: z.string().uuid().nullable(),
    window: windowSchema,
    minDemandRatio: z.number().positive().max(1000).nullable(),
    multiplier: z.number().min(SURGE_MIN_MULTIPLIER).max(SURGE_ABSOLUTE_MAX),
    isActive: z.boolean(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

async function checkRefs(body: AdminPricingRuleBody) {
  if (body.zoneId) {
    const z = await query('SELECT 1 FROM service_zones WHERE id = $1', [body.zoneId]);
    if (!z.rowCount) throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown zone.');
  }
  if (body.vehicleCategoryId) {
    const c = await query('SELECT 1 FROM vehicle_categories WHERE id = $1', [
      body.vehicleCategoryId,
    ]);
    if (!c.rowCount) throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown vehicle category.');
  }
}

const params = (b: AdminPricingRuleBody) => [
  b.name,
  b.label,
  b.zoneId,
  b.vehicleCategoryId,
  b.window.daysOfWeek,
  b.window.startMinute,
  b.window.endMinute,
  b.window.startsAt,
  b.window.endsAt,
  b.minDemandRatio,
  b.multiplier,
  b.isActive,
];

export async function createPricingRule(body: AdminPricingRuleBody, adminId: string) {
  await checkRefs(body);
  const r = await query<{ id: string }>(
    `INSERT INTO pricing_rules (name, label, zone_id, vehicle_category_id, days_of_week, start_minute,
       end_minute, starts_at, ends_at, min_demand_ratio, multiplier, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    params(body),
  );
  dropPricingRuleCache();
  const id = (r.rows[0] as { id: string }).id;
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'PRICING_RULE_CREATED',
    subjectType: 'pricing_rule',
    subjectIds: [id],
    detail: { name: body.name, multiplier: body.multiplier, reason: body.reason },
  });
  return (await listPricingRules()).find((x) => x.id === id) as PricingRuleInfo;
}

export async function updatePricingRule(id: string, body: AdminPricingRuleBody, adminId: string) {
  await checkRefs(body);
  const r = await query(
    `UPDATE pricing_rules SET name = $2, label = $3, zone_id = $4, vehicle_category_id = $5,
       days_of_week = $6, start_minute = $7, end_minute = $8, starts_at = $9, ends_at = $10,
       min_demand_ratio = $11, multiplier = $12, is_active = $13, updated_at = now()
     WHERE id = $1`,
    [id, ...params(body)],
  );
  if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Pricing rule not found.');
  dropPricingRuleCache();
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'PRICING_RULE_UPDATED',
    subjectType: 'pricing_rule',
    subjectIds: [id],
    detail: {
      name: body.name,
      multiplier: body.multiplier,
      active: body.isActive,
      reason: body.reason,
    },
  });
  return (await listPricingRules()).find((x) => x.id === id) as PricingRuleInfo;
}
