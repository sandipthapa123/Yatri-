import { describeWindow, windowActive, type TimeWindow } from './operations';
import { settingDef, type SettingDef, type SettingKey } from './settings';
import { PERSONAL_PAYMENT_METHODS } from './preferences';
import type { AuditEntry } from './safety';
import type { ResolvedRange } from './admin-ops';

/**
 * Cities and service: the ONE definition of where Yatri operates and under which rules, so that expanding to
 * another city is data (an administrator adds it) and never code. Nothing here, and nothing in any app, names a
 * city: the apps ask the server which city a point is in and what applies there.
 *
 * How a place maps to rules (the single chain):
 *   a point -> the coverage zones that contain it (`service_zones`, the existing geofence: SERVICE_AREA / CITY kinds)
 *           -> the zone's `city_id` -> the city.
 * A city's boundary is therefore its zones; there is no second map or geofence system. A point inside a zone that
 * belongs to no city keeps the platform-wide rules, exactly as before cities existed.
 *
 * What a city can set (all optional; anything not set is inherited):
 *   - status and operating hours (is service on right now?),
 *   - which vehicle categories are offered,
 *   - fare, cancellation and waiting values (an override of the platform setting of the same key),
 *   - which payment methods are offered,
 *   - extra documents a driver must hold to work there.
 * Precedence for money rules: the vehicle category's own rates, then the city's value, then the platform value.
 */

// ---------------------------------------------------------------- provinces

/** Nepal's seven provinces. Reference data, defined once; a city names one by code. */
export const PROVINCES = [
  { code: 'KOSHI', name: 'Koshi' },
  { code: 'MADHESH', name: 'Madhesh' },
  { code: 'BAGMATI', name: 'Bagmati' },
  { code: 'GANDAKI', name: 'Gandaki' },
  { code: 'LUMBINI', name: 'Lumbini' },
  { code: 'KARNALI', name: 'Karnali' },
  { code: 'SUDURPASHCHIM', name: 'Sudurpashchim' },
] as const;
export type ProvinceCode = (typeof PROVINCES)[number]['code'];
export const PROVINCE_CODES = PROVINCES.map((p) => p.code);
export const provinceName = (code: string) => PROVINCES.find((p) => p.code === code)?.name ?? code;

/** Roughly the middle of Nepal and a zoom that shows the country: where a map starts when no city is known. A starting view only. */
export const NEPAL_VIEW = { latitude: 28.3949, longitude: 84.124, zoom: 6 } as const;

// ---------------------------------------------------------------- status

/**
 * COMING_SOON: set up but not open (riders are told Yatri is not here yet). ACTIVE: open (within its hours).
 * PAUSED: closed for now (an outage, a strike, a decision), to be reopened. Moves are this table.
 */
export const CITY_STATUSES = ['COMING_SOON', 'ACTIVE', 'PAUSED'] as const;
export type CityStatus = (typeof CITY_STATUSES)[number];
export const CITY_STATUS_LABELS: Record<CityStatus, string> = {
  COMING_SOON: 'Coming soon',
  ACTIVE: 'Open',
  PAUSED: 'Paused',
};
export const CITY_STATUS_TRANSITIONS: Record<CityStatus, readonly CityStatus[]> = {
  COMING_SOON: ['ACTIVE'],
  ACTIVE: ['PAUSED'],
  PAUSED: ['ACTIVE'],
};

// ---------------------------------------------------------------- what a city can override

/**
 * The platform settings a city may override: fare, cancellation and waiting values. The key is the platform
 * setting's own key, and a city's value is checked by the platform setting's own definition (`checkSettingValue`),
 * so a rule is defined once and a city only changes the number.
 */
export const CITY_OVERRIDABLE_SETTINGS = [
  'FARE_BASE_NPR',
  'FARE_PER_KM_NPR',
  'FARE_PER_MINUTE_NPR',
  'FARE_MINIMUM_NPR',
  'CANCEL_FREE_SECONDS',
  'CANCEL_FEE_NPR',
  'WAITING_FREE_SECONDS',
  'WAITING_PER_MINUTE_NPR',
  'NO_SHOW_AFTER_SECONDS',
] as const satisfies readonly SettingKey[];
export type CityOverridableSetting = (typeof CITY_OVERRIDABLE_SETTINGS)[number];
export const isCityOverridable = (key: string): key is CityOverridableSetting =>
  (CITY_OVERRIDABLE_SETTINGS as readonly string[]).includes(key);
/** The platform definitions of the settings a city may override (label, unit, limits), in a fixed order. */
export const cityOverridableDefs = (): Array<SettingDef & { key: CityOverridableSetting }> =>
  CITY_OVERRIDABLE_SETTINGS.map(
    (k) => settingDef(k) as SettingDef & { key: CityOverridableSetting },
  );

/** Payment methods a city can offer to a person: the personal ones. A business account pays by its own policy. */
export const CITY_PAYMENT_METHODS = PERSONAL_PAYMENT_METHODS;

export const CITY_NAME_MAX = 80;
export const CITY_CODE_PATTERN = /^[A-Z0-9_]{2,30}$/;

// ---------------------------------------------------------------- is service on?

/** One opening window: the same shape and rule as every other time window (`windowActive`). */
export type CityHoursWindow = Pick<TimeWindow, 'daysOfWeek' | 'startMinute' | 'endMinute'>;

export interface CityServiceFacts {
  status: CityStatus;
  /** No windows means open all day, every day. */
  hours: readonly CityHoursWindow[];
  timeZone: string;
  at: Date;
}

export type CityServiceState =
  { open: true } | { open: false; reason: 'COMING_SOON' | 'PAUSED' | 'CLOSED_FOR_NOW' };

/** The one rule: is Yatri taking rides in this city at this moment? */
export function cityServiceState(f: CityServiceFacts): CityServiceState {
  if (f.status === 'COMING_SOON') return { open: false, reason: 'COMING_SOON' };
  if (f.status === 'PAUSED') return { open: false, reason: 'PAUSED' };
  if (f.hours.length === 0) return { open: true };
  const open = f.hours.some((h) =>
    windowActive({ ...h, startsAt: null, endsAt: null }, f.at, f.timeZone),
  );
  return open ? { open: true } : { open: false, reason: 'CLOSED_FOR_NOW' };
}

/** Opening hours in words, using the one description of a time window; no windows means "Open all day, every day". */
export function describeCityHours(hours: readonly CityHoursWindow[]): string {
  if (hours.length === 0) return 'Open all day, every day';
  return hours.map((h) => describeWindow({ ...h, startsAt: null, endsAt: null })).join('; ');
}

/** What a rider or driver is told when service is not available in a city (one set of words). */
export function describeCityClosed(
  city: { name: string; hoursText: string },
  reason: Extract<CityServiceState, { open: false }>['reason'],
): string {
  switch (reason) {
    case 'COMING_SOON':
      return `Yatri is not open in ${city.name} yet.`;
    case 'PAUSED':
      return `Yatri is paused in ${city.name} for now. Please try again later.`;
    case 'CLOSED_FOR_NOW':
      return `Yatri is closed in ${city.name} right now. We run ${city.hoursText.toLowerCase()}.`;
  }
}

// ---------------------------------------------------------------- what the API returns

export interface CityHoursInfo extends CityHoursWindow {
  id: string;
}

export interface CityInfo {
  id: string;
  code: string;
  name: string;
  provinceCode: ProvinceCode;
  provinceName: string;
  status: CityStatus;
  timeZone: string;
  /** Where a map starts for this city. Never a limit on service: the boundary is the city's zones. */
  centerLatitude: number;
  centerLongitude: number;
  /** Changes with every edit; an edit quotes the version it was based on. */
  version: number;
  hours: CityHoursInfo[];
  hoursText: string;
  /** Open at this moment (status and hours). */
  openNow: boolean;
  closedReason: string | null;
}

/** What apps may know about a city (public: no money rules, nothing personal). */
export interface PublicCity {
  id: string;
  code: string;
  name: string;
  provinceName: string;
  status: CityStatus;
  openNow: boolean;
  hoursText: string;
  centerLatitude: number;
  centerLongitude: number;
  /** Codes of the vehicle categories offered here. */
  vehicleCategories: string[];
  paymentMethods: string[];
}

/** Where a place is, for the server's answer to "what applies here?" */
export interface CityAtPlace {
  city: PublicCity | null;
  /** True when a service area covers the point but belongs to no city (platform-wide rules apply). */
  platformWide: boolean;
  /** Plain words about service here, when it is not available. */
  unavailableMessage: string | null;
}

export interface AdminCityRow {
  id: string;
  code: string;
  name: string;
  provinceName: string;
  status: CityStatus;
  openNow: boolean;
  zones: number;
  ridesThisMonth: number;
  driversOnlineNow: number;
}

export interface CityCategoryAvailability {
  categoryId: string;
  code: string;
  label: string;
  enabled: boolean;
}

export interface CitySettingRow {
  key: CityOverridableSetting;
  label: string;
  unit: string | null;
  /** The platform value now in force (what the city inherits when it sets none). */
  platformValue: number;
  /** The city's own value, or null when it inherits. */
  cityValue: number | null;
}

export interface CityDocumentRequirement {
  documentTypeId: string;
  code: string;
  label: string;
  ownerType: 'DRIVER' | 'VEHICLE';
  required: boolean;
}

export interface CityZoneInfo {
  id: string;
  code: string;
  name: string;
  kind: string;
  isActive: boolean;
  /** True when this zone belongs to this city. */
  inThisCity: boolean;
  /** The city it belongs to now, if another. */
  otherCityName: string | null;
}

export interface CityDetail extends CityInfo {
  categories: CityCategoryAvailability[];
  paymentMethods: Array<{ method: string; enabled: boolean }>;
  settings: CitySettingRow[];
  documents: CityDocumentRequirement[];
  zones: CityZoneInfo[];
  audit: AuditEntry[];
  allowedNext: CityStatus[];
}

export interface CityAnalytics {
  range: ResolvedRange;
  rides: number;
  completed: number;
  cancelled: number;
  noDrivers: number;
  completionRatePercent: number | null;
  grossFaresNpr: number;
  driversOnlineNow: number;
  byCategory: Array<{ code: string | null; label: string | null; rides: number; grossNpr: number }>;
  byDay: Array<{ day: string; rides: number }>;
}

// ---------------------------------------------------------------- request bodies

export interface AdminCityBody {
  code: string;
  name: string;
  provinceCode: ProvinceCode;
  centerLatitude: number;
  centerLongitude: number;
  timeZone: string;
  /** The version this edit was based on (omitted when creating). */
  expectedVersion?: number;
  reason: string;
}
export interface AdminCityStatusBody {
  to: CityStatus;
  expectedVersion: number;
  reason: string;
}
export interface AdminCityHoursBody {
  windows: CityHoursWindow[];
  expectedVersion: number;
  reason: string;
}
export interface AdminCityCategoriesBody {
  /** Category id to whether it is offered. Categories not listed are unchanged. */
  categories: Record<string, boolean>;
  expectedVersion: number;
  reason: string;
}
export interface AdminCityPaymentsBody {
  methods: Record<string, boolean>;
  expectedVersion: number;
  reason: string;
}
export interface AdminCitySettingsBody {
  /** Setting key to the city's value; null puts the key back to inheriting. */
  settings: Record<string, number | null>;
  expectedVersion: number;
  reason: string;
}
export interface AdminCityDocumentsBody {
  documentTypeIds: string[];
  expectedVersion: number;
  reason: string;
}
export interface AdminCityZonesBody {
  /** Zone id to whether it belongs to this city. */
  zones: Record<string, boolean>;
  expectedVersion: number;
  reason: string;
}
