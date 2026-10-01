/**
 * Platform settings: the ONE registry of every value operations may change without a deploy —
 * its key, words, kind and limits. The server validates against it, the admin screens render from it,
 * and the values themselves live in one place (the `platform_settings` table, falling back to the
 * environment default when nothing has been set). Apps never keep their own copy of a value: they
 * receive what they need from the API.
 *
 * Adding a setting = adding one entry here, its environment default in the API config, and using
 * `getSetting` where it applies. Nothing else lists settings.
 */

export const SETTING_GROUPS = [
  'availability',
  'fare',
  'cancellation',
  'waiting',
  'notifications',
  'support',
  'dispatch',
  'risk',
  'business',
] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const SETTING_GROUP_LABELS: Record<SettingGroup, string> = {
  availability: 'Service availability',
  fare: 'Fare parameters',
  cancellation: 'Cancellation rules',
  waiting: 'Waiting rules',
  notifications: 'Notification settings',
  support: 'Support and privacy',
  dispatch: 'Dispatch, surge limits and driver limits',
  risk: 'Fraud and risk',
  business: 'Business accounts',
};

export type SettingKind = 'boolean' | 'int' | 'number' | 'intList' | 'text';
export type SettingValue = boolean | number | number[] | string;

export interface SettingDef {
  key: string;
  group: SettingGroup;
  label: string;
  help: string;
  kind: SettingKind;
  /** Inclusive limits: a number's value, a list's items, a text's length. */
  min?: number;
  max?: number;
  unit?: string;
}

export const PLATFORM_SETTINGS = [
  {
    key: 'SERVICE_REQUESTS_ENABLED',
    group: 'availability',
    label: 'Accept new ride requests',
    help: 'Turn off to pause new requests (for example during an outage). Rides already under way are not affected.',
    kind: 'boolean',
  },
  {
    key: 'SERVICE_PAUSED_MESSAGE',
    group: 'availability',
    label: 'Message shown while requests are paused',
    help: 'Passengers who try to request a ride while requests are paused are shown this.',
    kind: 'text',
    min: 1,
    max: 200,
  },
  {
    key: 'FARE_BASE_NPR',
    group: 'fare',
    label: 'Base fare',
    help: 'Charged at the start of every ride.',
    kind: 'int',
    min: 0,
    max: 100000,
    unit: 'NPR',
  },
  {
    key: 'FARE_PER_KM_NPR',
    group: 'fare',
    label: 'Price per kilometre',
    help: 'Added for each kilometre of the route.',
    kind: 'number',
    min: 0,
    max: 10000,
    unit: 'NPR',
  },
  {
    key: 'FARE_PER_MINUTE_NPR',
    group: 'fare',
    label: 'Price per minute',
    help: 'Added for each minute of the ride.',
    kind: 'number',
    min: 0,
    max: 10000,
    unit: 'NPR',
  },
  {
    key: 'FARE_MINIMUM_NPR',
    group: 'fare',
    label: 'Minimum fare',
    help: 'No ride costs less than this.',
    kind: 'int',
    min: 0,
    max: 100000,
    unit: 'NPR',
  },
  {
    key: 'CANCEL_FREE_SECONDS',
    group: 'cancellation',
    label: 'Free cancellation window',
    help: 'A passenger who cancels within this long of a driver being assigned pays nothing.',
    kind: 'int',
    min: 0,
    max: 3600,
    unit: 'seconds',
  },
  {
    key: 'CANCEL_FEE_NPR',
    group: 'cancellation',
    label: 'Cancellation fee',
    help: 'Recorded when a passenger cancels after the free window. 0 means no fee.',
    kind: 'int',
    min: 0,
    max: 100000,
    unit: 'NPR',
  },
  {
    key: 'WAITING_FREE_SECONDS',
    group: 'waiting',
    label: 'Free waiting time',
    help: 'How long a driver waits at the pickup before waiting is charged.',
    kind: 'int',
    min: 0,
    max: 3600,
    unit: 'seconds',
  },
  {
    key: 'WAITING_PER_MINUTE_NPR',
    group: 'waiting',
    label: 'Waiting charge',
    help: 'Charged for each minute of waiting after the free time.',
    kind: 'number',
    min: 0,
    max: 10000,
    unit: 'NPR per minute',
  },
  {
    key: 'NO_SHOW_AFTER_SECONDS',
    group: 'waiting',
    label: 'Driver may report no-show after',
    help: 'How long a driver must wait before they can report that the passenger did not arrive.',
    kind: 'int',
    min: 1,
    max: 7200,
    unit: 'seconds',
  },
  {
    key: 'WAITING_NOTIFY_SECONDS',
    group: 'notifications',
    label: 'Waiting reminders at',
    help: 'Seconds of waiting at which the passenger and driver are reminded. Comma separated, for example 120,240,360.',
    kind: 'intList',
    min: 1,
    max: 7200,
    unit: 'seconds',
  },
  {
    key: 'NEARBY_NOTIFY_METERS',
    group: 'notifications',
    label: 'Driver-nearby alerts at',
    help: 'Distances (metres) at which the passenger is told the driver is close. Comma separated, for example 1000,500,200.',
    kind: 'intList',
    min: 1,
    max: 50000,
    unit: 'metres',
  },
  {
    key: 'SUPPORT_AUTO_CLOSE_DAYS',
    group: 'support',
    label: 'Close resolved tickets after',
    help: 'A resolved support ticket nobody has replied to is closed after this many days. 0 keeps them open until closed by hand.',
    kind: 'int',
    min: 0,
    max: 365,
    unit: 'days',
  },
  {
    key: 'SUPPORT_MAX_ATTACHMENTS_PER_TICKET',
    group: 'support',
    label: 'Files allowed on one ticket',
    help: 'The most photos, screenshots or documents one support ticket can hold.',
    kind: 'int',
    min: 0,
    max: 50,
  },
  {
    key: 'DATA_REQUEST_RESPONSE_DAYS',
    group: 'support',
    label: 'Days to answer a data or deletion request',
    help: 'The due date shown on account-deletion and data-access requests. Confirm the legal limit for your country with counsel.',
    kind: 'int',
    min: 1,
    max: 90,
    unit: 'days',
  },
  {
    key: 'DISPATCH_RADIUS_EXPANSION_PERCENT',
    group: 'dispatch',
    label: 'Widen the search after each unanswered offer',
    help: 'When a driver declines or does not answer, the next search looks this much farther out (a percentage of the normal radius), up to the largest radius below. 0 never widens it.',
    kind: 'int',
    min: 0,
    max: 200,
    unit: '%',
  },
  {
    key: 'DISPATCH_MAX_RADIUS_METERS',
    group: 'dispatch',
    label: 'Largest search radius',
    help: 'The farthest a driver can be from the pickup, however long the search has gone on.',
    kind: 'int',
    min: 1000,
    max: 50000,
    unit: 'metres',
  },
  {
    key: 'DISPATCH_WORKLOAD_WINDOW_MINUTES',
    group: 'dispatch',
    label: 'Workload window',
    help: 'Rides a driver finished in this long count as their recent workload when drivers are ranked.',
    kind: 'int',
    min: 15,
    max: 720,
    unit: 'minutes',
  },
  {
    key: 'DISPATCH_WORKLOAD_PENALTY_SECONDS',
    group: 'dispatch',
    label: 'Workload penalty per recent ride',
    help: "Each recent ride adds this much to a driver's arrival time when ranking, so work is shared. 0 ranks by arrival time alone.",
    kind: 'int',
    min: 0,
    max: 600,
    unit: 'seconds',
  },
  {
    key: 'SURGE_MAX_MULTIPLIER',
    group: 'dispatch',
    label: 'Highest price multiplier',
    help: 'No pricing rule, or combination of them, can raise a fare above this many times the normal fare.',
    kind: 'number',
    min: 1,
    max: 10,
  },
  {
    key: 'SURGE_DEMAND_WINDOW_MINUTES',
    group: 'dispatch',
    label: 'Demand window',
    help: 'Ride requests in this long count as current demand when a pricing rule depends on demand, and on the heatmap.',
    kind: 'int',
    min: 5,
    max: 120,
    unit: 'minutes',
  },
  {
    key: 'DRIVER_MAX_RIDES_PER_DAY',
    group: 'dispatch',
    label: 'Most rides per driver per day',
    help: 'A driver who has finished this many rides today is not offered more until tomorrow. 0 means no limit.',
    kind: 'int',
    min: 0,
    max: 200,
  },
  {
    key: 'DRIVER_MAX_ONLINE_HOURS',
    group: 'dispatch',
    label: 'Longest continuous time online',
    help: 'A driver online for longer than this without a break is not offered rides until they go offline and back online. 0 means no limit.',
    kind: 'int',
    min: 0,
    max: 24,
    unit: 'hours',
  },
  {
    key: 'HEATMAP_CELL_METERS',
    group: 'dispatch',
    label: 'Heatmap cell size',
    help: 'The side of each square on the demand and supply map. Bigger squares show less detail about where anyone is.',
    kind: 'int',
    min: 500,
    max: 5000,
    unit: 'metres',
  },
  {
    key: 'HEATMAP_MIN_COUNT',
    group: 'dispatch',
    label: 'Smallest count shown on the heatmap',
    help: 'A square with fewer requests or drivers than this shows "fewer than N" instead of a number, so nobody can be picked out.',
    kind: 'int',
    min: 1,
    max: 20,
  },
  {
    key: 'EXPIRY_REMINDER_DAYS',
    group: 'dispatch',
    label: 'Expiry reminders at',
    help: 'Days before a driver or vehicle document, licence, registration, insurance or service date runs out at which the person is reminded. Comma separated, for example 30,14,7,1. The largest number is also how early "expiring soon" shows.',
    kind: 'intList',
    min: 1,
    max: 365,
    unit: 'days',
  },
  {
    key: 'RESTRICTED_DRIVER_MAX_RIDES_PER_DAY',
    group: 'dispatch',
    label: 'Most rides a restricted driver can take in a day',
    help: 'A driver whose operational status is restricted is not offered more rides once they have finished this many today.',
    kind: 'int',
    min: 1,
    max: 50,
  },
  {
    key: 'RISK_REVIEW_SCORE',
    group: 'risk',
    label: 'Risk score that asks for a review',
    help: 'When the points from open and confirmed risk events reach this, they are listed as needing review. Nothing happens to the person; a human decides.',
    kind: 'int',
    min: 1,
    max: 1000,
    unit: 'points',
  },
  {
    key: 'RISK_EVENT_WINDOW_DAYS',
    group: 'risk',
    label: 'How long a risk event counts',
    help: 'Risk events older than this no longer add to the score (they are kept for the retention period).',
    kind: 'int',
    min: 1,
    max: 365,
    unit: 'days',
  },
  {
    key: 'RISK_AUTO_RESTRICT_SCORE',
    group: 'risk',
    label: 'Score that restricts temporarily without a person',
    help: 'Reaching this score from several different kinds of signal restricts the account for a short time, then lifts itself unless an administrator acts. 0 turns this off, so only administrators restrict. It never suspends.',
    kind: 'int',
    min: 0,
    max: 5000,
    unit: 'points',
  },
  {
    key: 'RISK_MIN_DISTINCT_RULES',
    group: 'risk',
    label: 'Different signals needed before an automatic restriction',
    help: 'One kind of signal, however often it repeats, never restricts an account by itself: this many different rules must have fired.',
    kind: 'int',
    min: 2,
    max: 10,
  },
  {
    key: 'RISK_AUTO_RESTRICT_HOURS',
    group: 'risk',
    label: 'Length of an automatic restriction',
    help: 'How long an automatic restriction lasts if nobody lifts it sooner.',
    kind: 'int',
    min: 1,
    max: 168,
    unit: 'hours',
  },
  {
    key: 'RISK_MAX_RESTRICTION_DAYS',
    group: 'risk',
    label: 'Longest restriction an administrator can apply',
    help: 'Restrictions are always temporary. A longer measure is a suspension, which is a separate, reversible decision.',
    kind: 'int',
    min: 1,
    max: 90,
    unit: 'days',
  },
  {
    key: 'ORG_APPROVAL_TTL_MINUTES',
    group: 'business',
    label: 'How long a ride waits for approval',
    help: 'A business ride that needs approval is dropped if nobody decides within this time, so a rider is never sent a car for a trip they no longer need.',
    kind: 'int',
    min: 5,
    max: 1440,
    unit: 'minutes',
  },
  {
    key: 'ORG_PAYMENT_TERMS_DAYS',
    group: 'business',
    label: 'Days to pay a statement',
    help: 'A monthly statement is due this many days after it is issued.',
    kind: 'int',
    min: 1,
    max: 90,
    unit: 'days',
  },
  {
    key: 'ORG_MAX_PER_USER',
    group: 'business',
    label: 'Most organizations one person can create',
    help: 'A limit on how many business accounts a single person can start, to slow down misuse.',
    kind: 'int',
    min: 1,
    max: 20,
  },
] as const satisfies readonly SettingDef[];

export type SettingKey = (typeof PLATFORM_SETTINGS)[number]['key'];
export const SETTING_KEYS: readonly SettingKey[] = PLATFORM_SETTINGS.map((s) => s.key);

export function settingDef(key: string): SettingDef | undefined {
  return (PLATFORM_SETTINGS as readonly SettingDef[]).find((s) => s.key === key);
}

/** What a stored/entered value must look like: null message = valid. The one validation rule. */
export type SettingCheck = { ok: true; value: SettingValue } | { ok: false; message: string };

const inRange = (n: number, def: SettingDef) =>
  (def.min === undefined || n >= def.min) && (def.max === undefined || n <= def.max);
const rangeWords = (def: SettingDef) =>
  `between ${def.min ?? '-∞'} and ${def.max ?? '∞'}${def.unit ? ` ${def.unit}` : ''}`;

/**
 * Check a raw value (from JSON, or text typed into a form) against its definition. Text input is
 * accepted for numbers, booleans and lists so the same rule serves the API and the admin form.
 */
export function checkSettingValue(def: SettingDef, raw: unknown): SettingCheck {
  switch (def.kind) {
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true' || raw === 'on') return { ok: true, value: true };
      if (raw === 'false' || raw === 'off') return { ok: true, value: false };
      return { ok: false, message: `${def.label} must be on or off.` };
    }
    case 'int':
    case 'number': {
      const n =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string' && raw.trim() !== ''
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(n)) return { ok: false, message: `${def.label} must be a number.` };
      if (def.kind === 'int' && !Number.isInteger(n)) {
        return { ok: false, message: `${def.label} must be a whole number.` };
      }
      if (!inRange(n, def))
        return { ok: false, message: `${def.label} must be ${rangeWords(def)}.` };
      return { ok: true, value: n };
    }
    case 'intList': {
      const items = Array.isArray(raw)
        ? raw
        : typeof raw === 'string'
          ? raw.split(',').map((s) => s.trim())
          : null;
      if (!items || items.length === 0 || items.length > 20) {
        return { ok: false, message: `${def.label} needs between 1 and 20 numbers.` };
      }
      const nums = items.map((i) => (typeof i === 'number' ? i : i === '' ? NaN : Number(i)));
      if (nums.some((n) => !Number.isInteger(n) || !inRange(n, def))) {
        return {
          ok: false,
          message: `Each item of ${def.label} must be a whole number ${rangeWords(def)}.`,
        };
      }
      return { ok: true, value: [...new Set(nums)].sort((a, b) => a - b) };
    }
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, message: `${def.label} must be text.` };
      const t = raw.trim();
      if (t.length < (def.min ?? 0) || t.length > (def.max ?? Infinity)) {
        return {
          ok: false,
          message: `${def.label} must be ${def.min ?? 0} to ${def.max ?? '∞'} characters.`,
        };
      }
      return { ok: true, value: t };
    }
  }
}

/** A value as words, for lists and the audit trail ("on", "NPR 50", "120, 240, 360"). One formatter. */
export function describeSettingValue(def: SettingDef, value: SettingValue): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return `${value.join(', ')}${def.unit ? ` ${def.unit}` : ''}`;
  if (typeof value === 'number') return def.unit ? `${value} ${def.unit}` : String(value);
  return value;
}

/** One setting as the admin sees it. */
export interface PlatformSettingInfo {
  key: string;
  group: SettingGroup;
  label: string;
  help: string;
  kind: SettingKind;
  unit: string | null;
  /** The value in force now. */
  value: SettingValue;
  /** What it falls back to when unset (the deployment default). */
  defaultValue: SettingValue;
  /** True when an admin has set it (false = using the default). */
  overridden: boolean;
  /** Changes with every edit; an edit must quote the version it was based on. */
  version: number;
  updatedAt: string | null;
  updatedByName: string | null;
}

export interface PlatformSettingsResponse {
  settings: PlatformSettingInfo[];
  canManage: boolean;
}

export interface UpdateSettingBody {
  value: unknown;
  /** The version the admin saw; a stale one is refused so two admins cannot overwrite each other. */
  expectedVersion: number;
  /** Why (kept in the audit log). */
  reason: string;
}

/**
 * What the apps may know: the values in force, read from the same store. Apps display these and
 * never decide with them (the server prices, cancels and gates requests itself).
 */
export interface PublicPlatformConfig {
  requestsEnabled: boolean;
  pausedMessage: string | null;
  fare: { baseNpr: number; perKmNpr: number; perMinuteNpr: number; minimumNpr: number };
  cancellation: { freeSeconds: number; feeNpr: number };
  waiting: { freeSeconds: number; perMinuteNpr: number; noShowAfterSeconds: number };
}
