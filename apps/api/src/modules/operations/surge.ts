import {
  SURGE_MAX_MULTIPLIER_FLOOR,
  windowActive,
  zonesAt,
  type LatLng,
  type TimeWindow,
} from '@yatri/types';

import { env } from '../../config/env';
import { settingNumber } from '../settings/settings.service';
import type { SurgeQuote } from '../pricing/pricing';
import { ratioFor } from './demand';
import { activePricingRules, type PricingRuleRow } from './pricing-rules.service';
import { activeZones } from './zones.service';

/**
 * THE dynamic-pricing engine: which multiplier applies to a ride. It picks, among the active rules that
 * match the pickup zone, the vehicle category, the time and (when the rule asks) the current demand, the
 * HIGHEST multiplier (rules do not stack), never above SURGE_MAX_MULTIPLIER. Only the server runs it: an
 * estimate shows the result, a request locks it on the ride, and the final fare uses the locked value.
 * The fare arithmetic itself is `pricing/pricing.ts`; this only decides the multiplier.
 */
export interface SurgeContext {
  zoneIds: ReadonlySet<string>;
  categoryId: string | null;
  at: Date;
  timeZone: string;
  cap: number;
  /** Requests per available driver for a zone (null: the whole service). Called only for rules that need it. */
  ratioFor: (zoneId: string | null) => Promise<number>;
}

export interface SurgeDecision extends SurgeQuote {
  /** The rules that produced it (names), for the audit of a price. */
  rules: string[];
}

export const NO_SURGE: SurgeDecision = { multiplier: 1, label: null, rules: [] };

/** Pure: apply the rules to a context. Kept free of the database so the cases are unit-tested. */
export async function pickSurge(
  rules: readonly PricingRuleRow[],
  ctx: SurgeContext,
): Promise<SurgeDecision> {
  let best: { rule: PricingRuleRow; multiplier: number } | null = null;
  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.zoneId !== null && !ctx.zoneIds.has(rule.zoneId)) continue;
    if (rule.vehicleCategoryId !== null && rule.vehicleCategoryId !== ctx.categoryId) continue;
    const window: TimeWindow = rule.window;
    if (!windowActive(window, ctx.at, ctx.timeZone)) continue;
    if (rule.minDemandRatio !== null && (await ctx.ratioFor(rule.zoneId)) < rule.minDemandRatio)
      continue;
    const multiplier = Math.min(rule.multiplier, ctx.cap);
    if (multiplier <= 1) continue;
    if (!best || multiplier > best.multiplier) best = { rule, multiplier };
  }
  if (!best) return NO_SURGE;
  return { multiplier: best.multiplier, label: best.rule.label, rules: [best.rule.name] };
}

/** The multiplier for a pickup and vehicle category right now. */
export async function surgeFor(input: {
  pickup: LatLng;
  categoryId: string | null;
  at?: Date;
}): Promise<SurgeDecision> {
  const [rules, zones] = await Promise.all([activePricingRules(), activeZones()]);
  if (rules.length === 0) return NO_SURGE;
  return pickSurge(rules, {
    zoneIds: new Set(zonesAt(zones, input.pickup).map((z) => z.id)),
    categoryId: input.categoryId,
    at: input.at ?? new Date(),
    timeZone: env.PLATFORM_TIME_ZONE,
    cap: Math.max(SURGE_MAX_MULTIPLIER_FLOOR, settingNumber('SURGE_MAX_MULTIPLIER')),
    ratioFor,
  });
}
