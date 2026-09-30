import { pointInPolygon, polygonProblem, type PolygonPoints } from './geo';
import type { LatLng } from './index';

/**
 * Advanced platform operations: service zones, dynamic pricing rules, driver incentives, the
 * demand/supply picture and their shared words and rules, defined once. The API applies them, the admin
 * console edits them, and the apps only show what the server reports. Geometry is `geo.ts` (one
 * point-in-polygon); money is the one fare in `pricing/`; nothing here restates either.
 */

// ---------------------------------------------------------------- time windows (pricing and incentives)

/**
 * WHEN a rule applies, the same shape for a surge rule and an incentive. Days are ISO (1 Monday to 7
 * Sunday); minutes count from local midnight in the platform time zone; a window whose start is later than
 * its end runs overnight. `startsAt`/`endsAt` bound a special event (an exact span of dates and times).
 * A null part means "no limit on that part".
 */
export interface TimeWindow {
  daysOfWeek: number[] | null;
  startMinute: number | null;
  endMinute: number | null;
  startsAt: string | null;
  endsAt: string | null;
}
export const NO_TIME_LIMIT: TimeWindow = {
  daysOfWeek: null,
  startMinute: null,
  endMinute: null,
  startsAt: null,
  endsAt: null,
};

/** Local weekday (ISO) and minute-of-day of an instant in a time zone. */
export function localParts(at: Date, timeZone: string): { isoDay: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const isoDay = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  return { isoDay, minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Whether `at` falls inside the window. The one definition for every rule that has a window. */
export function windowActive(w: TimeWindow, at: Date, timeZone: string): boolean {
  if (w.startsAt && at.getTime() < new Date(w.startsAt).getTime()) return false;
  if (w.endsAt && at.getTime() >= new Date(w.endsAt).getTime()) return false;
  const { isoDay, minute } = localParts(at, timeZone);
  const days = w.daysOfWeek;
  const dayOk = (d: number) => !days || days.length === 0 || days.includes(d);
  const { startMinute: s, endMinute: e } = w;
  if (s === null && e === null) return dayOk(isoDay);
  const start = s ?? 0;
  const end = e ?? 24 * 60;
  if (start <= end) return dayOk(isoDay) && minute >= start && minute < end;
  // Overnight: the evening part belongs to the day it starts on, the morning part to the day before.
  if (minute >= start) return dayOk(isoDay);
  if (minute < end) return dayOk(isoDay === 1 ? 7 : isoDay - 1);
  return false;
}

export const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
export const minuteText = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** The window in words, for admins and drivers ("Monday to Friday, 07:00 to 10:00"). */
export function describeWindow(w: TimeWindow): string {
  const parts: string[] = [];
  const days = w.daysOfWeek ?? [];
  if (days.length > 0 && days.length < 7) {
    const names = [...days].sort((a, b) => a - b).map((d) => DAY_NAMES[d - 1] as string);
    parts.push(names.join(', '));
  } else parts.push('Every day');
  if (w.startMinute !== null || w.endMinute !== null) {
    parts.push(`${minuteText(w.startMinute ?? 0)} to ${minuteText(w.endMinute ?? 24 * 60)}`);
  }
  if (w.startsAt || w.endsAt) {
    parts.push(
      `${w.startsAt ? `from ${new Date(w.startsAt).toLocaleString()}` : ''}${w.startsAt && w.endsAt ? ' ' : ''}${w.endsAt ? `until ${new Date(w.endsAt).toLocaleString()}` : ''}`,
    );
  }
  return parts.join(', ');
}

export function windowProblem(w: TimeWindow): string | null {
  for (const d of w.daysOfWeek ?? []) {
    if (!Number.isInteger(d) || d < 1 || d > 7) return 'Days must be 1 (Monday) to 7 (Sunday).';
  }
  for (const m of [w.startMinute, w.endMinute]) {
    if (m !== null && (!Number.isInteger(m) || m < 0 || m > 24 * 60)) {
      return 'Times must be between 00:00 and 24:00.';
    }
  }
  if (w.startMinute !== null && w.endMinute !== null && w.startMinute === w.endMinute) {
    return 'The start and end time cannot be the same.';
  }
  if (w.startsAt && w.endsAt && new Date(w.startsAt) >= new Date(w.endsAt)) {
    return 'The event must end after it starts.';
  }
  return null;
}

// ---------------------------------------------------------------- zones

export const ZONE_KINDS = ['SERVICE_AREA', 'CITY', 'RESTRICTED', 'AIRPORT', 'VENUE'] as const;
export type ZoneKind = (typeof ZONE_KINDS)[number];
export const ZONE_KIND_LABELS: Record<ZoneKind, string> = {
  SERVICE_AREA: 'Service area',
  CITY: 'City boundary',
  RESTRICTED: 'Restricted area',
  AIRPORT: 'Airport zone',
  VENUE: 'Venue zone',
};
/**
 * Kinds that say where Yatri operates. While at least one active zone of these kinds exists, a pickup and a
 * drop-off must be inside one; with none, the whole world is open (nothing is restricted until configured).
 */
export const COVERAGE_ZONE_KINDS: readonly ZoneKind[] = ['SERVICE_AREA', 'CITY'];

export interface ZoneDef {
  id: string;
  code: string;
  name: string;
  kind: ZoneKind;
  polygon: PolygonPoints;
  pickupAllowed: boolean;
  dropoffAllowed: boolean;
  /** A sentence a rider or driver is shown for this place ("Airport pickups are at bay 3"). */
  note: string | null;
  /** Higher wins when zones overlap. */
  priority: number;
  isActive: boolean;
}

export const ZONE_NAME_MAX = 80;
export const ZONE_NOTE_MAX = 200;

/** Active zones that contain a point, highest priority first. */
export function zonesAt(zones: readonly ZoneDef[], p: LatLng): ZoneDef[] {
  return zones
    .filter((z) => z.isActive && pointInPolygon(p, z.polygon))
    .sort((a, b) => b.priority - a.priority || a.code.localeCompare(b.code));
}

/** Whether a point is inside the area Yatri serves (always true while no service area is configured). */
export function insideCoverage(zones: readonly ZoneDef[], p: LatLng): boolean {
  const coverage = zones.filter((z) => z.isActive && COVERAGE_ZONE_KINDS.includes(z.kind));
  return coverage.length === 0 || coverage.some((z) => pointInPolygon(p, z.polygon));
}

export type ZonePurpose = 'PICKUP' | 'DROPOFF';
export type ZoneAccess =
  | { ok: true; zones: ZoneDef[] }
  | { ok: false; code: 'OUTSIDE_SERVICE_AREA' | 'NOT_ALLOWED_HERE'; message: string };

/** May a ride start or end at this point? The one rule; the request, the estimate and dispatch all ask it. */
export function checkZoneAccess(
  zones: readonly ZoneDef[],
  p: LatLng,
  purpose: ZonePurpose,
): ZoneAccess {
  const here = zonesAt(zones, p);
  const word = purpose === 'PICKUP' ? 'pick you up' : 'take you';
  const coverageExists = zones.some((z) => z.isActive && COVERAGE_ZONE_KINDS.includes(z.kind));
  if (coverageExists && !here.some((z) => COVERAGE_ZONE_KINDS.includes(z.kind))) {
    return {
      ok: false,
      code: 'OUTSIDE_SERVICE_AREA',
      message: `Yatri cannot ${word} ${purpose === 'PICKUP' ? 'from' : 'to'} this place: it is outside the area we serve.`,
    };
  }
  for (const z of here) {
    const allowed = purpose === 'PICKUP' ? z.pickupAllowed : z.dropoffAllowed;
    if (!allowed) {
      return {
        ok: false,
        code: 'NOT_ALLOWED_HERE',
        message:
          z.note ??
          `${z.name}: ${purpose === 'PICKUP' ? 'pickups' : 'drop-offs'} are not allowed here.`,
      };
    }
  }
  return { ok: true, zones: here };
}

export function zoneProblem(z: { name: string; polygon: unknown }): string | null {
  if (z.name.trim().length < 2 || z.name.length > ZONE_NAME_MAX) return 'Give the zone a name.';
  return polygonProblem(z.polygon);
}

export interface AdminZoneBody {
  code: string;
  name: string;
  kind: ZoneKind;
  polygon: PolygonPoints;
  pickupAllowed: boolean;
  dropoffAllowed: boolean;
  note: string | null;
  priority: number;
  isActive: boolean;
  reason: string;
}

// ---------------------------------------------------------------- dynamic pricing

export interface PricingRuleInfo {
  id: string;
  name: string;
  /** Shown to the rider beside the price ("Airport rush"). */
  label: string;
  zoneId: string | null;
  zoneName: string | null;
  vehicleCategoryId: string | null;
  vehicleCategoryLabel: string | null;
  window: TimeWindow;
  /** Applies only while requests per available driver are at least this (null: whatever the demand). */
  minDemandRatio: number | null;
  multiplier: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export const SURGE_MIN_MULTIPLIER = 1.05;
export const SURGE_ABSOLUTE_MAX = 10;
/** The cap can never be set below normal pricing. */
export const SURGE_MAX_MULTIPLIER_FLOOR = 1;

export interface AdminPricingRuleBody {
  name: string;
  label: string;
  zoneId: string | null;
  vehicleCategoryId: string | null;
  window: TimeWindow;
  minDemandRatio: number | null;
  multiplier: number;
  isActive: boolean;
  reason: string;
}

/** What a rider is told about a price that is higher than usual. One sentence, from one function. */
export function describeSurge(multiplier: number, label: string | null, surgeNpr: number): string {
  if (multiplier <= 1) return 'Normal pricing applies.';
  const x = Number.isInteger(multiplier * 10) ? multiplier.toFixed(1) : multiplier.toFixed(2);
  return `Higher demand pricing${label ? ` (${label})` : ''}: fares are ${x} times normal, NPR ${surgeNpr} more on this ride.`;
}

/**
 * The effect of a fare's multiplier: the amount before it (already at least the minimum fare) and the
 * extra. Whole rupees; the total is always exactly preSurge + surge, so the parts add up.
 */
export function applySurge(
  preSurgeNpr: number,
  multiplier: number,
): { surgeNpr: number; totalNpr: number } {
  const surgeNpr = multiplier > 1 ? Math.round(preSurgeNpr * (multiplier - 1)) : 0;
  return { surgeNpr, totalNpr: preSurgeNpr + surgeNpr };
}

// ---------------------------------------------------------------- demand and supply

export interface ZoneDemandSupply {
  zoneId: string | null;
  zoneName: string;
  kind: ZoneKind | null;
  /** Ride requests in the window. */
  requests: number;
  /** Drivers ONLINE with a fresh location and free for a ride. */
  availableDrivers: number;
  /** Requests per available driver (requests when nobody is available). */
  ratio: number;
  /** The multiplier the rules give right now for a pickup here (any category). */
  surgeMultiplier: number;
}

export interface HeatCell {
  row: number;
  col: number;
  centre: { latitude: number; longitude: number };
  /** null when fewer than the minimum: a small count could point at one person. */
  requests: number | null;
  drivers: number | null;
}

export interface HeatmapData {
  generatedAt: string;
  windowMinutes: number;
  cellMeters: number;
  /** Counts below this are not shown (privacy); the words say "fewer than N". */
  minCount: number;
  cells: HeatCell[];
  zones: ZoneDemandSupply[];
}

export function describeHeatCell(c: HeatCell, minCount: number): string {
  const n = (v: number | null, what: string) =>
    v === null ? `fewer than ${minCount} ${what}` : `${v} ${what}`;
  return `Area around ${c.centre.latitude.toFixed(3)}, ${c.centre.longitude.toFixed(3)}: ${n(c.requests, 'requests')}, ${n(c.drivers, 'available drivers')}.`;
}

// ---------------------------------------------------------------- driver incentives

export const INCENTIVE_KINDS = ['RIDE_TARGET', 'TIME_BONUS', 'ZONE_BONUS'] as const;
export type IncentiveKind = (typeof INCENTIVE_KINDS)[number];
export const INCENTIVE_KIND_LABELS: Record<IncentiveKind, string> = {
  RIDE_TARGET: 'Completed-ride target',
  TIME_BONUS: 'Time-of-day bonus',
  ZONE_BONUS: 'Zone bonus',
};
export const INCENTIVE_PERIODS = ['DAILY', 'WEEKLY'] as const;
export type IncentivePeriod = (typeof INCENTIVE_PERIODS)[number];

/**
 * The key of the day or week a moment falls in, in the platform time zone: a date for a day, and the date
 * of that week Monday for a week. One rule decides which period a ride counts toward.
 */
export function periodKey(at: Date, period: IncentivePeriod, timeZone: string): string {
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  if (period === 'DAILY') return day;
  const { isoDay } = localParts(at, timeZone);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const monday = new Date(Date.UTC(y, m - 1, d - (isoDay - 1)));
  return monday.toISOString().slice(0, 10);
}

export interface IncentiveRuleInfo {
  id: string;
  name: string;
  kind: IncentiveKind;
  zoneId: string | null;
  zoneName: string | null;
  vehicleCategoryId: string | null;
  vehicleCategoryLabel: string | null;
  window: TimeWindow;
  /** For RIDE_TARGET: how often the target resets. */
  period: IncentivePeriod | null;
  targetRides: number | null;
  bonusNpr: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminIncentiveRuleBody {
  name: string;
  kind: IncentiveKind;
  zoneId: string | null;
  vehicleCategoryId: string | null;
  window: TimeWindow;
  period: IncentivePeriod | null;
  targetRides: number | null;
  bonusNpr: number;
  isActive: boolean;
  reason: string;
}

/** Why a rule is incomplete for its kind, or null. The one validation, used by the API. */
export function incentiveProblem(r: {
  kind: IncentiveKind;
  zoneId: string | null;
  period: IncentivePeriod | null;
  targetRides: number | null;
  window: TimeWindow;
  bonusNpr: number;
}): string | null {
  if (!Number.isInteger(r.bonusNpr) || r.bonusNpr < 1) return 'The bonus must be at least NPR 1.';
  const w = windowProblem(r.window);
  if (w) return w;
  switch (r.kind) {
    case 'RIDE_TARGET':
      if (!r.period) return 'A ride target needs a period (daily or weekly).';
      if (!r.targetRides || r.targetRides < 1) return 'A ride target needs a number of rides.';
      return null;
    case 'ZONE_BONUS':
      return r.zoneId ? null : 'A zone bonus needs a zone.';
    case 'TIME_BONUS':
      return r.window.startMinute === null && r.window.endMinute === null && !r.window.startsAt
        ? 'A time bonus needs a time of day or a span of dates.'
        : null;
  }
}

export function describeIncentive(r: IncentiveRuleInfo): string {
  const where = r.zoneName ? ` picked up in ${r.zoneName}` : '';
  const cat = r.vehicleCategoryLabel ? ` in ${r.vehicleCategoryLabel}` : '';
  const when = describeWindow(r.window);
  switch (r.kind) {
    case 'RIDE_TARGET':
      return `Complete ${r.targetRides} rides${where}${cat} ${r.period === 'WEEKLY' ? 'in a week' : 'in a day'} (${when}) and earn NPR ${r.bonusNpr}.`;
    case 'TIME_BONUS':
      return `Earn NPR ${r.bonusNpr} extra for each ride${where}${cat} completed ${when}.`;
    case 'ZONE_BONUS':
      return `Earn NPR ${r.bonusNpr} extra for each ride${where}${cat} completed ${when}.`;
  }
}

export interface DriverIncentiveProgress {
  rule: IncentiveRuleInfo;
  text: string;
  /** Rides counted toward the target in this period (RIDE_TARGET only). */
  completed: number;
  target: number | null;
  earnedNpr: number;
  /** One sentence on where the driver stands. */
  status: string;
}

export interface DriverIncentivesView {
  progress: DriverIncentiveProgress[];
  /** Everything earned, from the award records. Bonuses are recorded, not paid by this system. */
  totalEarnedNpr: number;
  note: string;
}

export interface IncentiveAwardRow {
  id: string;
  ruleName: string;
  driverId: string;
  driverName: string | null;
  tripId: string | null;
  periodKey: string;
  amountNpr: number;
  createdAt: string;
}
