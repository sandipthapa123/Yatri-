import type { CityOverridableSetting } from '@yatri/types';

import { extraBoardingSeconds } from '../accessibility/boarding';
import { cancellationRules, type CancellationRules } from '../trips/cancellation';
import { pricingConfig, type PricingConfig } from '../pricing/pricing.config';
import { cityOverride, getCityData, type CityData } from './cities.service';

/**
 * A city's fare, waiting and cancellation values: the platform value (`pricingConfig()`, `cancellationRules()`, still
 * the one place that reads the platform settings) with the city's own value laid over each key it sets. A ride keeps
 * the rules of the city it was requested in (`trips.city_id`), so editing a city never changes a ride already under way.
 * A vehicle category's own rates are applied on top by `pricingFor` (category, then city, then platform).
 */
const num = (city: CityData | null, key: CityOverridableSetting, platform: number) =>
  cityOverride(city, key) ?? platform;

export function pricingConfigFor(city: CityData | null): PricingConfig {
  const p = pricingConfig();
  if (!city) return p;
  return {
    baseNpr: num(city, 'FARE_BASE_NPR', p.baseNpr),
    perKmNpr: num(city, 'FARE_PER_KM_NPR', p.perKmNpr),
    perMinuteNpr: num(city, 'FARE_PER_MINUTE_NPR', p.perMinuteNpr),
    minimumNpr: num(city, 'FARE_MINIMUM_NPR', p.minimumNpr),
    waitingFreeSeconds: num(city, 'WAITING_FREE_SECONDS', p.waitingFreeSeconds),
    waitingPerMinuteNpr: num(city, 'WAITING_PER_MINUTE_NPR', p.waitingPerMinuteNpr),
    noShowAfterSeconds: num(city, 'NO_SHOW_AFTER_SECONDS', p.noShowAfterSeconds),
  };
}

export function cancellationRulesFor(city: CityData | null): CancellationRules {
  const r = cancellationRules();
  if (!city) return r;
  return {
    freeSeconds: num(city, 'CANCEL_FREE_SECONDS', r.freeSeconds),
    feeNpr: num(city, 'CANCEL_FEE_NPR', r.feeNpr),
  };
}

/** For code that has a ride (or any record) with a `city_id`. */
export async function pricingConfigForCityId(id: string | null): Promise<PricingConfig> {
  return pricingConfigFor(await getCityData(id));
}
/**
 * The pricing rules for ONE ride: the city's, with the extra boarding time a rider who needs it was promised added to the free
 * waiting time and to the wait before a driver may cancel for a no-show. No charge is added for the extra time.
 */
export async function pricingConfigForTrip(t: {
  id: string;
  city_id: string | null;
}): Promise<PricingConfig> {
  const cfg = await pricingConfigForCityId(t.city_id);
  const extra = await extraBoardingSeconds(t.id);
  if (extra <= 0) return cfg;
  return {
    ...cfg,
    waitingFreeSeconds: cfg.waitingFreeSeconds + extra,
    noShowAfterSeconds: cfg.noShowAfterSeconds + extra,
  };
}
export async function cancellationRulesForCityId(id: string | null): Promise<CancellationRules> {
  return cancellationRulesFor(await getCityData(id));
}
