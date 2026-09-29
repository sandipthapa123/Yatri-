import type { FareBreakdown, WaitingRule } from '@yatri/types';

import type { PricingConfig } from './pricing.config';

/**
 * Pure fare rules. The server is the only place a fare is calculated; apps display the
 * numbers they are given. The distance/time come from the RouteProvider (or, honestly
 * flagged, the straight-line estimate) — never from the client.
 */
export function estimateFare(
  input: { distanceMeters: number; durationSeconds: number | null; routeBased: boolean },
  cfg: PricingConfig,
): FareBreakdown {
  const km = input.distanceMeters / 1000;
  const minutes = (input.durationSeconds ?? 0) / 60;
  const distanceNpr = Math.round(km * cfg.perKmNpr);
  const timeNpr = Math.round(minutes * cfg.perMinuteNpr);
  const subtotal = cfg.baseNpr + distanceNpr + timeNpr;
  const minimumFareApplied = subtotal < cfg.minimumNpr;
  return {
    currency: 'NPR',
    baseNpr: cfg.baseNpr,
    distanceNpr,
    timeNpr,
    minimumFareApplied,
    totalNpr: Math.max(cfg.minimumNpr, subtotal),
    distanceMeters: Math.round(input.distanceMeters),
    durationSeconds: input.durationSeconds === null ? null : Math.round(input.durationSeconds),
    routeBased: input.routeBased,
  };
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
