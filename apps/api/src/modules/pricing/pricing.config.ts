import { settingNumber } from '../settings/settings.service';

/** THE fare and waiting rules, from the platform settings (admin-editable, environment default). Nothing else in the system restates them. */
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
    baseNpr: settingNumber('FARE_BASE_NPR'),
    perKmNpr: settingNumber('FARE_PER_KM_NPR'),
    perMinuteNpr: settingNumber('FARE_PER_MINUTE_NPR'),
    minimumNpr: settingNumber('FARE_MINIMUM_NPR'),
    waitingFreeSeconds: settingNumber('WAITING_FREE_SECONDS'),
    waitingPerMinuteNpr: settingNumber('WAITING_PER_MINUTE_NPR'),
    noShowAfterSeconds: settingNumber('NO_SHOW_AFTER_SECONDS'),
  };
}
