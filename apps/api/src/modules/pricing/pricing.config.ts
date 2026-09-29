import { env } from '../../config/env';

/** THE fare and waiting rules, from configuration. Nothing else in the system restates them. */
export interface PricingConfig {
  baseNpr: number;
  perKmNpr: number;
  perMinuteNpr: number;
  minimumNpr: number;
  waitingFreeSeconds: number;
  waitingPerMinuteNpr: number;
  noShowAfterSeconds: number;
}

export function pricingConfig(): PricingConfig {
  return {
    baseNpr: env.FARE_BASE_NPR,
    perKmNpr: env.FARE_PER_KM_NPR,
    perMinuteNpr: env.FARE_PER_MINUTE_NPR,
    minimumNpr: env.FARE_MINIMUM_NPR,
    waitingFreeSeconds: env.WAITING_FREE_SECONDS,
    waitingPerMinuteNpr: env.WAITING_PER_MINUTE_NPR,
    noShowAfterSeconds: env.NO_SHOW_AFTER_SECONDS,
  };
}
