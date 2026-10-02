import { ACCESSIBILITY_NOTIFICATION_TYPES } from './accessibility';
import { FLEET_NOTIFICATION_TYPES } from './fleet';
import { ORG_NOTIFICATION_TYPES } from './organization';
import { RISK_NOTIFICATION_TYPES } from './risk';
import { SUPPORT_NOTIFICATION_TYPES } from './support';

/**
 * Personal preferences: the ONE definition of every setting a person can change about how the apps look,
 * sound, notify and behave for them. The API validates and stores against this table, the notification service
 * reads it, and every app renders its settings screen from it; no app keeps a setting of its own or its own copy
 * of a default or an allowed value.
 *
 * What a preference is NOT. It is never a business rule. Fares, cancellation, who is matched, who may book, what
 * is paid and what a person may see of others are decided by the server, whatever a client says. A preference
 * changes presentation (theme, size, language), delivery (which notifications are pushed), a default the person
 * would otherwise choose by hand (vehicle type), or a little of what the person themselves reveals (how their
 * name is shown to a driver). Where the server enforces one (notifications, name shown, recent places, default
 * vehicle) the table says so with `server: true`; the rest are read by the apps.
 *
 * Only what differs from the default is stored, so changing a default (an administrator changes the platform
 * default language) reaches everyone who has not chosen.
 */

export type PreferenceRole = 'PASSENGER' | 'DRIVER';

export const PREFERENCE_GROUPS = [
  'appearance',
  'language',
  'accessibility',
  'notifications',
  'privacy',
  'safety',
  'rides',
] as const;
export type PreferenceGroup = (typeof PREFERENCE_GROUPS)[number];
export const PREFERENCE_GROUP_LABELS: Record<PreferenceGroup, string> = {
  appearance: 'Appearance',
  language: 'Language',
  accessibility: 'Accessibility',
  notifications: 'Notifications',
  privacy: 'Privacy',
  safety: 'Safety',
  rides: 'Rides',
};

// ---------------------------------------------------------------- reference values

/**
 * Languages. `available` is true only for a language the apps actually have words for: the others are listed so
 * people can see what is coming, and the server refuses to save them.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English', available: true },
  { code: 'ne', label: 'Nepali (नेपाली), not translated yet', available: false },
] as const;
export type LanguageCode = (typeof LANGUAGES)[number]['code'];
export const AVAILABLE_LANGUAGE_CODES = LANGUAGES.filter((l) => l.available).map((l) => l.code);

export const THEME_CHOICES = ['SYSTEM', 'LIGHT', 'DARK'] as const;
export const TEXT_SIZES = ['STANDARD', 'LARGE', 'EXTRA_LARGE'] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
/** How much larger text and touch targets are, per size (the apps multiply their own sizes by this). */
export const TEXT_SCALE: Record<TextSize, number> = { STANDARD: 1, LARGE: 1.2, EXTRA_LARGE: 1.45 };
/** Extra room for touch targets when the person asks for larger ones. */
export const LARGER_TOUCH_SCALE = 1.25;
export const MOTION_CHOICES = ['SYSTEM', 'ON', 'OFF'] as const;
export const NAME_VISIBILITY = ['FULL', 'FIRST_NAME'] as const;
/** Payment methods a PERSON chooses between. An organization pays by its own policy, never by preference. */
export const PERSONAL_PAYMENT_METHODS = ['CASH'] as const;

// ---------------------------------------------------------------- notification categories

/**
 * Every notification belongs to one category. A person can turn an OPTIONAL category off (it is then recorded in
 * their history but not pushed); a MANDATORY one is always delivered, because missing it can hurt (a safety alert,
 * a document that is about to lock a driver out, a change to their account). A type nobody has classified is
 * treated as mandatory, so nothing is silently dropped.
 */
export const NOTIFICATION_CATEGORIES = [
  'SAFETY',
  'ACCOUNT',
  'RIDE_UPDATES',
  'CHAT_AND_CALLS',
  'PAYMENTS',
  'SUPPORT',
  'BUSINESS',
  'REWARDS',
  'PROMOTIONS',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const NOTIFICATION_CATEGORY_INFO: Record<
  NotificationCategory,
  { label: string; help: string; mandatory: boolean }
> = {
  SAFETY: {
    label: 'Safety alerts',
    help: 'Emergency alerts, safety reports and trip sharing. Always on.',
    mandatory: true,
  },
  ACCOUNT: {
    label: 'Account and documents',
    help: 'Changes to your account, approvals, documents, privacy requests. Always on.',
    mandatory: true,
  },
  RIDE_UPDATES: {
    label: 'Ride updates',
    help: 'A driver found, arriving, nearby, the ride started or ended, no driver available.',
    mandatory: false,
  },
  CHAT_AND_CALLS: {
    label: 'Messages and calls',
    help: 'A new chat message, an incoming or missed call during a ride.',
    mandatory: false,
  },
  PAYMENTS: {
    label: 'Payments',
    help: 'A payment was received for a ride.',
    mandatory: false,
  },
  SUPPORT: {
    label: 'Help and support',
    help: 'Replies and decisions on your support requests and refunds.',
    mandatory: false,
  },
  BUSINESS: {
    label: 'Business rides',
    help: 'Invitations, approvals, rides booked for you and statements for your organization.',
    mandatory: false,
  },
  REWARDS: {
    label: 'Bonuses and reward points',
    help: 'Bonuses and reward points you have earned, and when points are about to expire.',
    mandatory: false,
  },
  PROMOTIONS: {
    label: 'Offers and news',
    help: 'Offers and messages from Yatri. Off unless you turn it on.',
    mandatory: false,
  },
};

const values = <T extends Record<string, string>>(o: T): string[] => Object.values(o);
const SAFETY_TYPES = new Set([
  'SOS_TRIGGERED',
  'SOS_CANCELLED',
  'SOS_UPDATE',
  'INCIDENT_REPORTED',
  'INCIDENT_UPDATE',
  'TRIP_SHARE_STARTED',
  'TRIP_SHARE_STOPPED',
]);
const ACCOUNT_TYPES = new Set([
  'DATA_REQUEST_UPDATE',
  'DRIVER_APPLICATION_SUBMITTED',
  'DRIVER_APPROVED',
  'DRIVER_REJECTED',
  'DRIVER_SUSPENDED',
  'DOCUMENT_APPROVED',
  'DOCUMENT_REJECTED',
  'VEHICLE_APPROVED',
  'VEHICLE_REJECTED',
  ...values(FLEET_NOTIFICATION_TYPES),
  ...values(RISK_NOTIFICATION_TYPES),
  ...values(ACCESSIBILITY_NOTIFICATION_TYPES),
]);
const SUPPORT_TYPES = new Set(values(SUPPORT_NOTIFICATION_TYPES));
const BUSINESS_TYPES = new Set(values(ORG_NOTIFICATION_TYPES));

/** The category of a notification type: the ONE mapping, used by the notification service and the settings screen. */
export function notificationCategoryOf(type: string): NotificationCategory {
  if (SAFETY_TYPES.has(type)) return 'SAFETY';
  if (ACCOUNT_TYPES.has(type)) return 'ACCOUNT';
  if (SUPPORT_TYPES.has(type)) return 'SUPPORT';
  if (BUSINESS_TYPES.has(type)) return 'BUSINESS';
  if (type.startsWith('CHAT_') || type.startsWith('CALL_')) return 'CHAT_AND_CALLS';
  if (type.startsWith('PAYMENT_')) return 'PAYMENTS';
  if (type.startsWith('INCENTIVE_') || type.startsWith('REWARD_') || type.startsWith('REFERRAL_')) {
    return 'REWARDS';
  }
  if (type.startsWith('OFFER_') || type.startsWith('CAMPAIGN_')) return 'PROMOTIONS';
  if (type.startsWith('TRIP_') || type.startsWith('DRIVER_') || type === 'NO_DRIVERS_FOUND') {
    return 'RIDE_UPDATES';
  }
  return 'ACCOUNT'; // unclassified: never silently dropped
}

export const notificationPrefKey = (c: NotificationCategory) => `notify.${c}` as const;

// ---------------------------------------------------------------- the definitions

export type PreferenceKind = 'enum' | 'boolean' | 'text';

export interface PreferenceDef {
  key: string;
  group: PreferenceGroup;
  label: string;
  help: string;
  kind: PreferenceKind;
  /** For an enum: the allowed values (and the words for each). */
  options?: ReadonlyArray<{ value: string; label: string; available?: boolean }>;
  /** The built-in default. A key listed in PLATFORM_DEFAULTED takes its default from a platform setting instead. */
  default: string | boolean | null;
  roles: readonly PreferenceRole[];
  /** True when the SERVER acts on it (the apps cannot ignore it); false when the apps read it. */
  server: boolean;
}

const BOTH = ['PASSENGER', 'DRIVER'] as const;
const PASSENGER = ['PASSENGER'] as const;

const notificationDefs = NOTIFICATION_CATEGORIES.filter(
  (c) => !NOTIFICATION_CATEGORY_INFO[c].mandatory,
).map((c): PreferenceDef => ({
  key: notificationPrefKey(c),
  group: 'notifications',
  label: NOTIFICATION_CATEGORY_INFO[c].label,
  help: NOTIFICATION_CATEGORY_INFO[c].help,
  kind: 'boolean',
  // Marketing is opt-in: nothing promotional is pushed until the person turns it on.
  default: c !== 'PROMOTIONS',
  roles: c === 'BUSINESS' ? PASSENGER : BOTH,
  server: true,
}));

export const PREFERENCE_DEFS: readonly PreferenceDef[] = [
  {
    key: 'theme',
    group: 'appearance',
    label: 'Theme',
    help: 'Light, dark, or follow the phone.',
    kind: 'enum',
    options: [
      { value: 'SYSTEM', label: 'Follow the phone' },
      { value: 'LIGHT', label: 'Light' },
      { value: 'DARK', label: 'Dark' },
    ],
    default: 'SYSTEM',
    roles: BOTH,
    server: false,
  },
  {
    key: 'textSize',
    group: 'appearance',
    label: 'Text size',
    help: 'Larger text and buttons in the app. This is on top of the size set in the phone.',
    kind: 'enum',
    options: [
      { value: 'STANDARD', label: 'Standard' },
      { value: 'LARGE', label: 'Large' },
      { value: 'EXTRA_LARGE', label: 'Extra large' },
    ],
    default: 'STANDARD',
    roles: BOTH,
    server: false,
  },
  {
    key: 'language',
    group: 'language',
    label: 'Language',
    help: 'The language of the app. A language marked not translated yet cannot be chosen.',
    kind: 'enum',
    options: LANGUAGES.map((l) => ({ value: l.code, label: l.label, available: l.available })),
    default: null, // the platform default language (DEFAULT_LANGUAGE in platform settings)
    roles: BOTH,
    server: false,
  },
  {
    key: 'reducedMotion',
    group: 'accessibility',
    label: 'Reduced motion',
    help: 'Avoid movement and transitions that are not needed to use the app.',
    kind: 'enum',
    options: [
      { value: 'SYSTEM', label: 'Follow the phone' },
      { value: 'ON', label: 'Reduce motion' },
      { value: 'OFF', label: 'Allow motion' },
    ],
    default: 'SYSTEM',
    roles: BOTH,
    server: false,
  },
  {
    key: 'largerTouchTargets',
    group: 'accessibility',
    label: 'Larger buttons',
    help: 'Make buttons and other things you tap bigger and easier to hit.',
    kind: 'boolean',
    default: false,
    roles: BOTH,
    server: false,
  },
  {
    key: 'speakUpdates',
    group: 'accessibility',
    label: 'Read ride updates aloud',
    help: 'On iPhone the app speaks changes (a driver found, arriving) itself; with TalkBack they are announced as usual. Turn off if your screen reader already says too much.',
    kind: 'boolean',
    default: true,
    roles: BOTH,
    server: false,
  },
  {
    key: 'hapticFeedback',
    group: 'accessibility',
    label: 'Vibration feedback',
    help: 'Vibrate when something important happens (a driver arrives, an offer comes in) so you do not have to rely on sound or on looking.',
    kind: 'boolean',
    default: true,
    roles: BOTH,
    server: false,
  },
  {
    key: 'simplifiedNavigation',
    group: 'accessibility',
    label: 'Simpler screens',
    help: 'During a ride, show only the essentials and keep extra options (trip sharing, accessibility details) behind a More options button.',
    kind: 'boolean',
    default: false,
    roles: BOTH,
    server: false,
  },
  ...notificationDefs,
  {
    key: 'nameShownToDrivers',
    group: 'privacy',
    label: 'Name shown to your driver',
    help: 'Your driver always sees a name for the ride. Choose whether it is your full name or only your first name.',
    kind: 'enum',
    options: [
      { value: 'FULL', label: 'Full name' },
      { value: 'FIRST_NAME', label: 'First name only' },
    ],
    default: 'FULL',
    roles: PASSENGER,
    server: true,
  },
  {
    key: 'showRecentPlaces',
    group: 'privacy',
    label: 'Suggest recent destinations',
    help: 'Offer the places you recently went to when you plan a ride. Turn off to stop them being shown; you can also clear them.',
    kind: 'boolean',
    default: true,
    roles: PASSENGER,
    server: true,
  },
  {
    key: 'confirmBeforeSos',
    group: 'safety',
    label: 'Ask before sending an emergency alert',
    help: 'Show a confirmation so an alert is not sent by accident. Turn off only if you need the fastest possible alert.',
    kind: 'boolean',
    default: true,
    roles: BOTH,
    server: false,
  },
  {
    key: 'suggestTripSharing',
    group: 'safety',
    label: 'Remind me to share my trip',
    help: 'When a driver is on the way, suggest sharing the trip with a trusted contact.',
    kind: 'boolean',
    default: true,
    roles: PASSENGER,
    server: false,
  },
  {
    key: 'defaultVehicle',
    group: 'rides',
    label: 'Preferred vehicle type',
    help: 'The type chosen first when you plan a ride. You can change it each time; the price is always the server’s.',
    kind: 'text', // a vehicle category code the server checks is currently offered; empty means no preference
    default: null,
    roles: PASSENGER,
    server: true,
  },
  {
    key: 'defaultPayment',
    group: 'rides',
    label: 'Preferred way to pay',
    help: 'Rides are paid to the driver in cash. A business ride is paid by your organization as its rules say, whatever you choose here.',
    kind: 'enum',
    options: PERSONAL_PAYMENT_METHODS.map((m) => ({ value: m, label: 'Cash to the driver' })),
    default: 'CASH',
    roles: PASSENGER,
    server: true,
  },
];

export type PreferenceKey = string;
export const PREFERENCE_KEYS = PREFERENCE_DEFS.map((d) => d.key);
export const preferenceDef = (key: string): PreferenceDef | undefined =>
  PREFERENCE_DEFS.find((d) => d.key === key);

/** The definitions that apply to a role. */
export const preferencesFor = (role: PreferenceRole): PreferenceDef[] =>
  PREFERENCE_DEFS.filter((d) => d.roles.includes(role));

/** Defaults that an administrator sets in platform settings (not built in). */
export const PLATFORM_DEFAULTED: Record<string, string> = { language: 'DEFAULT_LANGUAGE' };

export type PreferenceValue = string | boolean | null;
export type PreferenceValues = Record<string, PreferenceValue>;

export type PreferenceCheck = { ok: true; value: PreferenceValue } | { ok: false; message: string };

/**
 * Is this a legal value for this preference? `null` always means "go back to the default". Whether a vehicle code
 * is one the service offers is the server's check on top of this (it needs the live categories).
 */
export function checkPreferenceValue(def: PreferenceDef, raw: unknown): PreferenceCheck {
  if (raw === null) return { ok: true, value: null };
  switch (def.kind) {
    case 'boolean':
      return typeof raw === 'boolean'
        ? { ok: true, value: raw }
        : { ok: false, message: `${def.label} must be on or off.` };
    case 'enum': {
      const option = def.options?.find((o) => o.value === raw);
      if (typeof raw !== 'string' || !option)
        return { ok: false, message: `${def.label} is not one of the choices.` };
      if (option.available === false)
        return { ok: false, message: `${option.label.split(',')[0]} is not available yet.` };
      return { ok: true, value: raw };
    }
    case 'text':
      if (typeof raw !== 'string' || raw.trim() === '' || raw.length > 40) {
        return {
          ok: false,
          message: `${def.label} must be a short value, or reset to no preference.`,
        };
      }
      return { ok: true, value: raw.trim() };
  }
}

// ---------------------------------------------------------------- API shapes

export interface PreferencesResponse {
  /** What is in force: the person's choices over the defaults, for every key that applies to their role. */
  values: PreferenceValues;
  /** The keys the person has set themselves (the rest are defaults). */
  overridden: string[];
  /** The defaults now in force (including the platform default language). */
  defaults: PreferenceValues;
  /** The vehicle types currently offered, for choosing a preferred one (empty for roles without that setting). */
  vehicleOptions: Array<{ code: string; label: string }>;
  /** Changes with every save; a save quotes the version it was based on. */
  version: number;
  updatedAt: string | null;
}

export interface UpdatePreferencesBody {
  /** key to new value; null puts a key back to its default. */
  changes: Record<string, unknown>;
  /** The version this edit was based on. A stale one is refused so two devices cannot overwrite each other unseen. */
  expectedVersion?: number;
}

export interface RecentPlace {
  name: string | null;
  address: string;
  latitude: number;
  longitude: number;
  lastUsedAt: string;
  rides: number;
}
export interface RecentPlacesResponse {
  items: RecentPlace[];
  /** True when the person turned suggestions off (the list is then empty on purpose). */
  hidden: boolean;
}

export interface DeviceSession {
  id: string;
  /** What the app said this device is called; null when it never said. */
  deviceLabel: string | null;
  lastUsedAt: string | null;
  signedInAt: string;
  current: boolean;
}

/** The effective value of a preference as the apps use it (a typed read of the response). */
export function preferenceValue<T extends PreferenceValue>(
  r: Pick<PreferencesResponse, 'values'>,
  key: string,
): T {
  return r.values[key] as T;
}
