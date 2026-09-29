import type { TripStatus, WaitingInfo, WaitingRule } from '@yatri/types';

import { waitingCharge } from '../pricing/pricing';
import type { PricingConfig } from '../pricing/pricing.config';
import { waitingRule } from '../pricing/pricing';

export interface WaitingTimestamps {
  status: TripStatus;
  matchedAtMs: number | null;
  arrivedAtMs: number | null;
  /** When the arrival notification was recorded (the passenger was told). */
  passengerNotifiedAtMs: number | null;
  /** When the passenger-waiting notification was last raised (the driver was told). */
  driverNotifiedAtMs?: number | null;
}

/**
 * The ONE calculation of waiting state, from server timestamps. Both apps render exactly this:
 *  - DRIVER_EN_ROUTE   the passenger is waiting for the driver (never charged);
 *  - DRIVER_ARRIVED    the driver is waiting for the passenger (charged after the free period);
 *  - anything else     no wait is running.
 */
export function computeWaiting(
  t: WaitingTimestamps,
  nowMs: number,
  cfg: PricingConfig,
): WaitingInfo | null {
  const rule: WaitingRule = waitingRule(cfg);
  if (t.status === 'DRIVER_EN_ROUTE' && t.matchedAtMs !== null) {
    return {
      driver: null,
      passenger: {
        startedAt: new Date(t.matchedAtMs).toISOString(),
        seconds: Math.max(0, Math.floor((nowMs - t.matchedAtMs) / 1000)),
        notifiedAt: t.driverNotifiedAtMs ? new Date(t.driverNotifiedAtMs).toISOString() : null,
      },
      rule,
      affectsFare: false,
      chargeableSeconds: 0,
      chargeNpr: 0,
    };
  }
  if (t.status === 'DRIVER_ARRIVED' && t.arrivedAtMs !== null) {
    const seconds = Math.max(0, Math.floor((nowMs - t.arrivedAtMs) / 1000));
    const charge = waitingCharge(seconds, cfg);
    return {
      driver: {
        startedAt: new Date(t.arrivedAtMs).toISOString(),
        seconds,
        notifiedAt: t.passengerNotifiedAtMs
          ? new Date(t.passengerNotifiedAtMs).toISOString()
          : null,
      },
      passenger: null,
      rule,
      affectsFare: charge.chargeableSeconds > 0,
      chargeableSeconds: charge.chargeableSeconds,
      chargeNpr: charge.chargeNpr,
    };
  }
  return null;
}
