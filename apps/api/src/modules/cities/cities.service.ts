import {
  CITY_PAYMENT_METHODS,
  COVERAGE_ZONE_KINDS,
  cityServiceState,
  describeCityClosed,
  describeCityHours,
  provinceName,
  zonesAt,
  type CityAtPlace,
  type CityHoursInfo,
  type CityInfo,
  type CityOverridableSetting,
  type CityServiceState,
  type CityStatus,
  type LatLng,
  type ProvinceCode,
  type PublicCity,
} from '@yatri/types';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { activeZones } from '../operations/zones.service';
import { listActiveCategories } from '../pricing/categories';

/**
 * Cities, as the rest of the system asks about them. The data is `cities` and the tables under it; the rules
 * (what a status and hours mean, how a place maps to a city) are in @yatri/types and `service_zones`. This module
 * only loads them (through a short cache that every edit drops) and answers: which city is this point in, is service
 * on there now, what does it offer. Every ride request, estimate, go-online and matching decision asks here, so the
 * answer is the same for the passenger app, the driver app, the admin dashboard and the backend.
 */
interface CityRow {
  id: string;
  code: string;
  name: string;
  province_code: ProvinceCode;
  status: CityStatus;
  time_zone: string;
  center_latitude: string;
  center_longitude: string;
  version: number;
}

export interface CityData {
  info: Omit<CityInfo, 'openNow' | 'closedReason'>;
  disabledCategoryIds: Set<string>;
  disabledPaymentMethods: Set<string>;
  settings: Map<string, number>;
}

const CACHE_MS = 5_000;
let cache: { at: number; cities: Map<string, CityData> } | null = null;
export const dropCityCache = () => {
  cache = null;
};

async function load(): Promise<Map<string, CityData>> {
  const [cities, hours, cats, pay, sets] = await Promise.all([
    query<CityRow>(
      'SELECT id, code, name, province_code, status, time_zone, center_latitude, center_longitude, version FROM cities ORDER BY name',
    ),
    query<{
      id: string;
      city_id: string;
      days_of_week: number[] | null;
      start_minute: number | null;
      end_minute: number | null;
    }>(
      'SELECT id, city_id, days_of_week, start_minute, end_minute FROM city_hours ORDER BY start_minute NULLS FIRST, id',
    ),
    query<{ city_id: string; category_id: string }>(
      'SELECT city_id, category_id FROM city_categories WHERE NOT enabled',
    ),
    query<{ city_id: string; method: string }>(
      'SELECT city_id, method FROM city_payment_methods WHERE NOT enabled',
    ),
    query<{ city_id: string; key: string; value: number }>(
      'SELECT city_id, key, value FROM city_settings',
    ),
  ]);
  const out = new Map<string, CityData>();
  for (const c of cities.rows) {
    const h: CityHoursInfo[] = hours.rows
      .filter((x) => x.city_id === c.id)
      .map((x) => ({
        id: x.id,
        daysOfWeek: x.days_of_week,
        startMinute: x.start_minute,
        endMinute: x.end_minute,
      }));
    out.set(c.id, {
      info: {
        id: c.id,
        code: c.code,
        name: c.name,
        provinceCode: c.province_code,
        provinceName: provinceName(c.province_code),
        status: c.status,
        timeZone: c.time_zone,
        centerLatitude: Number(c.center_latitude),
        centerLongitude: Number(c.center_longitude),
        version: c.version,
        hours: h,
        hoursText: describeCityHours(h),
      },
      disabledCategoryIds: new Set(
        cats.rows.filter((x) => x.city_id === c.id).map((x) => x.category_id),
      ),
      disabledPaymentMethods: new Set(
        pay.rows.filter((x) => x.city_id === c.id).map((x) => x.method),
      ),
      settings: new Map(
        sets.rows.filter((x) => x.city_id === c.id).map((x) => [x.key, Number(x.value)]),
      ),
    });
  }
  return out;
}

export async function allCityData(): Promise<Map<string, CityData>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cities;
  const cities = await load();
  cache = { at: Date.now(), cities };
  return cities;
}

export async function getCityData(id: string | null): Promise<CityData | null> {
  if (!id) return null;
  return (await allCityData()).get(id) ?? null;
}

/** Is service on in this city at this moment, and if not, why. */
export function serviceState(city: CityData, at: Date = new Date()): CityServiceState {
  return cityServiceState({
    status: city.info.status,
    hours: city.info.hours,
    timeZone: city.info.timeZone,
    at,
  });
}

export function toCityInfo(city: CityData, at: Date = new Date()): CityInfo {
  const s = serviceState(city, at);
  return {
    ...city.info,
    openNow: s.open,
    closedReason: s.open ? null : describeCityClosed(city.info, s.reason),
  };
}

// ---------------------------------------------------------------- where a point is

/**
 * The city a point is in, from the existing geofence: the highest-priority coverage zone containing it that belongs
 * to a city. `platformWide` is true when a coverage zone contains it but none of them belongs to a city, which keeps
 * the platform rules (the behaviour before cities existed).
 */
export async function cityAtPoint(
  p: LatLng,
): Promise<{ city: CityData | null; platformWide: boolean }> {
  const here = zonesAt(await activeZones(), p).filter((z) => COVERAGE_ZONE_KINDS.includes(z.kind));
  const owned = here.find((z) => z.cityId);
  if (owned?.cityId) {
    const city = await getCityData(owned.cityId);
    if (city) return { city, platformWide: false };
  }
  return { city: null, platformWide: here.length > 0 };
}

// ---------------------------------------------------------------- may a ride be made here?

/**
 * The checks that make "rides cannot be created where Yatri service is unavailable" true, in one place: the pickup's
 * city must be open now, the drop-off must be in the SAME city (no ride crosses a city line), and the vehicle
 * category must be offered there. A point in no city (platform-wide) has no city rules. Returns the city the ride
 * belongs to (or null) so its rules follow it.
 */
export async function assertRideService(input: {
  pickup: LatLng;
  dropoff: LatLng;
  categoryId?: string | undefined;
  at?: Date;
}): Promise<CityData | null> {
  const at = input.at ?? new Date();
  const from = await cityAtPoint(input.pickup);
  const to = await cityAtPoint(input.dropoff);
  if (!from.city) {
    // The pickup is in no city: a drop-off inside one would cross a line into a city that never agreed to it.
    if (to.city) {
      throw new HttpError(
        422,
        'CROSS_CITY_RIDE',
        `Yatri cannot take you from here to ${to.city.info.name}. Rides stay inside one city.`,
      );
    }
    return null;
  }
  const state = serviceState(from.city, at);
  if (!state.open) {
    throw new HttpError(
      422,
      state.reason === 'CLOSED_FOR_NOW' ? 'OUTSIDE_OPERATING_HOURS' : 'SERVICE_UNAVAILABLE_HERE',
      describeCityClosed(from.city.info, state.reason),
    ).withDetails({ city: from.city.info.name, hours: from.city.info.hoursText });
  }
  if (to.city?.info.id !== from.city.info.id) {
    throw new HttpError(
      422,
      'CROSS_CITY_RIDE',
      to.city
        ? `Yatri cannot take you from ${from.city.info.name} to ${to.city.info.name}. Rides stay inside one city.`
        : `This destination is outside ${from.city.info.name}. Rides stay inside one city.`,
    );
  }
  if (input.categoryId && from.city.disabledCategoryIds.has(input.categoryId)) {
    throw new HttpError(
      422,
      'CATEGORY_NOT_OFFERED_HERE',
      `That vehicle type is not offered in ${from.city.info.name}.`,
    );
  }
  return from.city;
}

/** The vehicle categories offered in a city (all active ones when it has no city). */
export async function offeredCategoryIds(city: CityData | null): Promise<Set<string>> {
  const all = await listActiveCategories();
  return new Set(all.filter((c) => !city || !city.disabledCategoryIds.has(c.id)).map((c) => c.id));
}

/** The payment methods a person may use in a city (the personal ones, less any switched off there). */
export function paymentMethodsFor(city: CityData | null): string[] {
  return CITY_PAYMENT_METHODS.filter((m) => !city || !city.disabledPaymentMethods.has(m));
}

// ---------------------------------------------------------------- the city's own values for the platform rules

/** The city's value for a platform setting, or null when it inherits the platform's. */
export function cityOverride(city: CityData | null, key: CityOverridableSetting): number | null {
  return city?.settings.get(key) ?? null;
}

// ---------------------------------------------------------------- what apps may know

export async function publicCities(at: Date = new Date()): Promise<PublicCity[]> {
  const data = await allCityData();
  const categories = await listActiveCategories();
  return [...data.values()].map((c) => {
    const state = serviceState(c, at);
    return {
      id: c.info.id,
      code: c.info.code,
      name: c.info.name,
      provinceName: c.info.provinceName,
      status: c.info.status,
      openNow: state.open,
      hoursText: c.info.hoursText,
      centerLatitude: c.info.centerLatitude,
      centerLongitude: c.info.centerLongitude,
      vehicleCategories: categories
        .filter((k) => !c.disabledCategoryIds.has(k.id))
        .map((k) => k.code),
      paymentMethods: paymentMethodsFor(c),
    };
  });
}

/** The answer to "what applies at this place?" for the apps (see `GET /config/service-at`). */
export async function serviceAtPlace(p: LatLng, at: Date = new Date()): Promise<CityAtPlace> {
  const { city, platformWide } = await cityAtPoint(p);
  if (!city) return { city: null, platformWide, unavailableMessage: null };
  const state = serviceState(city, at);
  const pub = (await publicCities(at)).find((c) => c.id === city.info.id) ?? null;
  return {
    city: pub,
    platformWide: false,
    unavailableMessage: state.open ? null : describeCityClosed(city.info, state.reason),
  };
}
