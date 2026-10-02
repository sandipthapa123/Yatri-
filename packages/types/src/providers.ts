/**
 * Service providers: the ONE definition of what Yatri buys from outside (a text message, a push, a map, a payment, a file
 * store, a call, a realtime bus, an email, error reporting), which vendors can fill each need, which of them are only for
 * development, how a failure is named and what a person is told about it. Business logic talks to one interface per need
 * and never to a vendor; which vendor is configured is server configuration per environment (DEVELOPMENT, STAGING,
 * PRODUCTION), and credentials only ever come from the environment.
 *
 * What a person is told about a provider failure is a fixed sentence per need (below). The vendor's own words, status codes
 * and addresses are logged on the server at most as a short kind, and never sent to a client or an administrator.
 */

export const PROVIDER_CAPABILITIES = [
  'OTP',
  'PUSH',
  'MAPS',
  'PAYMENTS',
  'STORAGE',
  'CALLS',
  'REALTIME',
  'EMAIL',
  'MONITORING',
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const PROVIDER_CAPABILITY_LABELS: Record<ProviderCapability, { label: string; help: string }> = {
  OTP: { label: 'Sign-in codes (SMS)', help: 'Sends the one-time code a person signs in with.' },
  PUSH: { label: 'Push notifications', help: 'Delivers notifications to phones.' },
  MAPS: { label: 'Maps, search and routes', help: 'Finds places, names a spot, and plans routes and arrival times.' },
  PAYMENTS: { label: 'Digital payments', help: 'Takes payment by an online provider. Cash does not need one.' },
  STORAGE: { label: 'File storage', help: 'Keeps uploaded documents and files, privately.' },
  CALLS: { label: 'Voice and video calls', help: 'Connects calls between a rider and a driver.' },
  REALTIME: { label: 'Live updates', help: 'Carries live ride, chat and call messages between servers and phones.' },
  EMAIL: { label: 'Email', help: 'Sends email where a message has to be email.' },
  MONITORING: { label: 'Error reporting', help: 'Tells the team when the service has a problem.' },
};

export const ENVIRONMENT_PROFILES = ['DEVELOPMENT', 'STAGING', 'PRODUCTION'] as const;
export type EnvironmentProfile = (typeof ENVIRONMENT_PROFILES)[number];

/** NODE_ENV is the one switch: "test" and "development" are DEVELOPMENT. */
export function environmentProfileOf(nodeEnv: string): EnvironmentProfile {
  return nodeEnv === 'production' ? 'PRODUCTION' : nodeEnv === 'staging' ? 'STAGING' : 'DEVELOPMENT';
}

/**
 * The vendors each need can use, and the names that stand for "nothing real". The environment variable that picks one
 * is named in ENV_KEY; the allowed values are these lists (the API's configuration reads them from here).
 */
export const PROVIDER_CHOICES = {
  OTP: ['console', 'http', 'twilio'],
  PUSH: ['console', 'expo'],
  MAPS_GEOCODING: ['static', 'nominatim', 'mapbox', 'none'],
  MAPS_ROUTING: ['haversine', 'osrm', 'graphhopper', 'valhalla', 'mapbox'],
  PAYMENTS: ['none', 'sandbox', 'khalti'],
  STORAGE: ['local', 's3'],
  CALLS: ['webrtc', 'twilio'],
  REALTIME: ['redis'],
  EMAIL: ['console', 'resend'],
  MONITORING: ['none', 'sentry'],
} as const;

/** Which environment variable selects the vendor for each need. */
export const PROVIDER_ENV_KEY: Record<keyof typeof PROVIDER_CHOICES, string> = {
  OTP: 'SMS_PROVIDER',
  PUSH: 'PUSH_PROVIDER',
  MAPS_GEOCODING: 'LOCATION_PROVIDER',
  MAPS_ROUTING: 'LOCATION_ROUTING_PROVIDER',
  PAYMENTS: 'PAYMENT_PROVIDER',
  STORAGE: 'STORAGE_PROVIDER',
  CALLS: 'CALL_PROVIDER',
  REALTIME: 'REALTIME_PROVIDER',
  EMAIL: 'EMAIL_PROVIDER',
  MONITORING: 'MONITORING_PROVIDER',
};

/**
 * Vendors that are not real services: they log, store on one disk, or draw a straight line. They are fine on a developer's
 * machine and wrong anywhere people depend on them. The rule per environment is `providerProblems`.
 */
export const SIMULATED_PROVIDERS: Partial<Record<keyof typeof PROVIDER_CHOICES, readonly string[]>> = {
  OTP: ['console'],
  PUSH: ['console'],
  // A straight-line route ("haversine") and "no search" are honest modes, not stand-ins, so they are allowed anywhere.
  MAPS_GEOCODING: ['static'],
  PAYMENTS: ['sandbox'],
  STORAGE: ['local'],
  EMAIL: ['console'],
};

/** What must be configured for a vendor to work (the names of environment variables; their values are secrets or settings). */
export const PROVIDER_REQUIRED_ENV: Record<string, readonly string[]> = {
  'OTP:http': ['SMS_HTTP_ENDPOINT'],
  'OTP:twilio': ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
  'PUSH:expo': [],
  'MAPS_GEOCODING:mapbox': ['MAPBOX_ACCESS_TOKEN'],
  'MAPS_ROUTING:mapbox': ['MAPBOX_ACCESS_TOKEN'],
  'PAYMENTS:khalti': ['KHALTI_SECRET_KEY'],
  'STORAGE:s3': ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
  'CALLS:twilio': ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  'EMAIL:resend': ['RESEND_API_KEY', 'EMAIL_FROM'],
  'MONITORING:sentry': ['SENTRY_DSN'],
};

/** The variables that hold a secret. Never logged, never in an API answer, never in the admin screen. */
export const SECRET_ENV_KEYS = [
  'TWILIO_AUTH_TOKEN',
  'SMS_HTTP_API_KEY',
  'EXPO_ACCESS_TOKEN',
  'MAPBOX_ACCESS_TOKEN',
  'LOCATION_PROVIDER_API_KEY',
  'LOCATION_ROUTING_API_KEY',
  'KHALTI_SECRET_KEY',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'RESEND_API_KEY',
  'SENTRY_DSN',
  'CALL_TURN_SHARED_SECRET',
  'JWT_ACCESS_SECRET',
  'STORAGE_SIGNING_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
] as const;

export interface ProviderSelection {
  OTP: string;
  PUSH: string;
  MAPS_GEOCODING: string;
  MAPS_ROUTING: string;
  PAYMENTS: string;
  STORAGE: string;
  CALLS: string;
  REALTIME: string;
  EMAIL: string;
  MONITORING: string;
}

/**
 * What is wrong with a set of chosen vendors for an environment, in words (empty when fine). The one rule behind the API's
 * start-up check and its tests: a deployed environment (STAGING, PRODUCTION) may not rely on a simulated vendor, a chosen
 * vendor must have what it needs, and production must report errors.
 */
export function providerProblems(
  env: EnvironmentProfile,
  chosen: ProviderSelection,
  configured: (key: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const need of Object.keys(PROVIDER_CHOICES) as Array<keyof typeof PROVIDER_CHOICES>) {
    const vendor = chosen[need];
    if (env !== 'DEVELOPMENT' && SIMULATED_PROVIDERS[need]?.includes(vendor)) {
      out.push(`${PROVIDER_ENV_KEY[need]}=${vendor} is only for development; ${env.toLowerCase()} needs a real provider.`);
    }
    for (const key of PROVIDER_REQUIRED_ENV[`${need}:${vendor}`] ?? []) {
      if (!configured(key)) out.push(`${key} is required when ${PROVIDER_ENV_KEY[need]}=${vendor}.`);
    }
  }
  if (env === 'PRODUCTION' && chosen.MONITORING === 'none') {
    out.push('MONITORING_PROVIDER must report errors in production (use sentry).');
  }
  return out;
}

// ---------------------------------------------------------------- failures

export const PROVIDER_ERROR_KINDS = [
  'TIMEOUT',
  'UNAVAILABLE',
  'RATE_LIMITED',
  'AUTH',
  'BAD_REQUEST',
  'BAD_RESPONSE',
  'NOT_CONFIGURED',
  'CIRCUIT_OPEN',
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

/** A kind that may go away on its own, so asking again (or using a fallback) is worth trying. */
export const PROVIDER_ERROR_RETRYABLE: Record<ProviderErrorKind, boolean> = {
  TIMEOUT: true,
  UNAVAILABLE: true,
  RATE_LIMITED: true,
  AUTH: false,
  BAD_REQUEST: false,
  BAD_RESPONSE: false,
  NOT_CONFIGURED: false,
  CIRCUIT_OPEN: false,
};

/** The one sentence a person is given when a need cannot be met right now. Nothing about the vendor. */
export const PROVIDER_PUBLIC_MESSAGES: Record<ProviderCapability, string> = {
  OTP: 'We could not send your code right now. Please try again in a moment.',
  PUSH: 'We could not send that notification right now.',
  MAPS: 'The map service is not available right now. Please try again, or pick a saved place.',
  PAYMENTS: 'The payment service is not available right now. You can pay the driver in cash instead.',
  STORAGE: 'We could not reach file storage right now. Please try again in a moment.',
  CALLS: 'Calls are not available right now. You can still send messages.',
  REALTIME: 'Live updates are not available right now. Your screen will refresh when they are back.',
  EMAIL: 'We could not send that email right now.',
  MONITORING: 'Error reporting is not available.',
};

// ---------------------------------------------------------------- health, for administrators

export const PROVIDER_HEALTH_STATES = ['UP', 'DEGRADED', 'DOWN', 'UNVERIFIED', 'SIMULATED', 'NOT_CONFIGURED'] as const;
export type ProviderHealthState = (typeof PROVIDER_HEALTH_STATES)[number];
export const PROVIDER_HEALTH_LABELS: Record<ProviderHealthState, string> = {
  UP: 'Working',
  DEGRADED: 'Working with problems',
  DOWN: 'Not working',
  UNVERIFIED: 'Set up, but there is no live check for this vendor',
  SIMULATED: 'A development stand-in, not a real service',
  NOT_CONFIGURED: 'Not set up',
};

/** The health of the failure ratio over the last calls: the one rule (a pure function so it is tested). */
export function healthFromCalls(calls: number, failures: number): ProviderHealthState | null {
  if (calls < 5) return null;
  const ratio = failures / calls;
  return ratio >= 0.5 ? 'DOWN' : ratio >= 0.1 ? 'DEGRADED' : 'UP';
}

export interface ProviderStatusInfo {
  capability: ProviderCapability;
  label: string;
  help: string;
  /** The vendor's name only ("twilio", "expo"), never an address, key or account. */
  provider: string;
  state: ProviderHealthState;
  stateText: string;
  /** When the last check or call finished, and how long it took. */
  checkedAt: string | null;
  latencyMs: number | null;
  /** Today's calls and how many failed. Counts only. */
  callsToday: number;
  failuresToday: number;
  /** The kind of the last failure ("TIMEOUT"), never the vendor's words. */
  lastFailureKind: ProviderErrorKind | null;
  /** True when this need is filled by a development stand-in. */
  simulated: boolean;
}

export interface ProvidersOverview {
  environment: EnvironmentProfile;
  /** Problems with the chosen vendors for this environment (the same rule as start-up). */
  problems: string[];
  items: ProviderStatusInfo[];
}

// ---------------------------------------------------------------- digital payments

export const PAYMENT_ATTEMPT_STATUSES = ['INITIATED', 'COMPLETED', 'FAILED', 'EXPIRED'] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

/** What a rider needs to pay a finished ride online. The amount is the server's. */
export interface DigitalPaymentInfo {
  attemptId: string;
  status: PaymentAttemptStatus;
  amountNpr: number;
  /** Where the rider pays (the provider's page). Null once finished. */
  paymentUrl: string | null;
  expiresAt: string | null;
}

/** A phone's address for push notifications. Held only to deliver the person's own notifications. */
export interface PushTokenBody {
  token: string;
  platform: 'ios' | 'android';
}
