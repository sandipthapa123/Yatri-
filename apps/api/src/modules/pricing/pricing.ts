import { applySurge, type FareBreakdown, type WaitingRule } from '@yatri/types';

import type { PricingConfig } from './pricing.config';

/**
 * Pure fare rules. The server is the only place a fare is calculated; apps display the
 * numbers they are given. The distance/time come from the RouteProvider (or, honestly
 * flagged, the straight-line estimate) — never from the client.
 */
export interface SurgeQuote {
  multiplier: number;
  label: string | null;
}
export const NORMAL_PRICING: SurgeQuote = { multiplier: 1, label: null };

export function estimateFare(
  input: { distanceMeters: number; durationSeconds: number | null; routeBased: boolean },
  cfg: PricingConfig,
  surge: SurgeQuote = NORMAL_PRICING,
): FareBreakdown {
  const km = input.distanceMeters / 1000;
  const minutes = (input.durationSeconds ?? 0) / 60;
  const distanceNpr = Math.round(km * cfg.perKmNpr);
  const timeNpr = Math.round(minutes * cfg.perMinuteNpr);
  const subtotal = cfg.baseNpr + distanceNpr + timeNpr;
  const minimumFareApplied = subtotal < cfg.minimumNpr;
  // Demand pricing is one step on top of the normal fare (minimum included): total = normal + extra.
  const { surgeNpr, totalNpr } = applySurge(Math.max(cfg.minimumNpr, subtotal), surge.multiplier);
  return {
    currency: 'NPR',
    baseNpr: cfg.baseNpr,
    distanceNpr,
    timeNpr,
    minimumFareApplied,
    totalNpr,
    distanceMeters: Math.round(input.distanceMeters),
    durationSeconds: input.durationSeconds === null ? null : Math.round(input.durationSeconds),
    routeBased: input.routeBased,
    surgeMultiplier: surge.multiplier,
    surgeNpr,
    surgeLabel: surge.multiplier > 1 ? surge.label : null,
  };
}

/**
 * The FINAL fare: the very same fare rules as the estimate, applied to what the ride actually
 * measured (distance driven, time taken), plus the waiting charge fixed when the ride started.
 * There is one fare implementation; this only chooses its inputs.
 */
export function finalFare(
  actual: { distanceMeters: number; durationSeconds: number },
  cfg: PricingConfig,
  waitingChargeNpr: number,
  surge: SurgeQuote = NORMAL_PRICING,
): { fare: FareBreakdown; totalNpr: number } {
  // The multiplier is the one the rider was quoted when they requested (locked on the ride).
  const fare = estimateFare({ ...actual, routeBased: false }, cfg, surge);
  return { fare, totalNpr: fare.totalNpr + waitingChargeNpr };
}

export function waitingRule(cfg: PricingConfig): WaitingRule {
  return {
    freeSeconds: cfg.waitingFreeSeconds,
    perMinuteNpr: cfg.waitingPerMinuteNpr,
    noShowAfterSeconds: cfg.noShowAfterSeconds,
  };
}

/** Seconds of the driver's wait beyond the free period, and the charge for them (per started minute). */
export function waitingCharge(
  waitedSeconds: number,
  cfg: Pick<PricingConfig, 'waitingFreeSeconds' | 'waitingPerMinuteNpr'>,
): { chargeableSeconds: number; chargeNpr: number } {
  const chargeableSeconds = Math.max(0, Math.floor(waitedSeconds) - cfg.waitingFreeSeconds);
  const chargeNpr = Math.ceil(chargeableSeconds / 60) * cfg.waitingPerMinuteNpr;
  return { chargeableSeconds, chargeNpr };
}
