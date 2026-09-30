import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

// NODE_ENV=test loads .env.test instead of .env, so the suite runs against a
// dedicated test database/config without touching local dev settings.
loadDotenv({
  path: path.resolve(__dirname, '../..', process.env.NODE_ENV === 'test' ? '.env.test' : '.env'),
});

function numList(v: string): number[] {
  return v
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
}
function strList(v: string): string[] {
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function boolFromEnv(defaultValue: boolean) {
  return z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? defaultValue : v === 'true'));
}

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    CORS_ORIGINS: z
      .string()
      .default('http://localhost:3000')
      .transform((value) => value.split(',').map((origin) => origin.trim())),

    // --- Auth / sessions ---
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters')
      .refine(
        (val) => !/^(dev|test|change[-_]?me|secret)/i.test(val),
        'JWT_ACCESS_SECRET looks like a placeholder value',
      ),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    // --- OTP ---
    OTP_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
    OTP_TTL_MINUTES: z.coerce.number().int().positive().default(5),
    OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
    OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
    OTP_REQUEST_MAX_PER_WINDOW: z.coerce.number().int().positive().default(5),
    OTP_REQUEST_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
    OTP_IP_REQUEST_MAX_PER_WINDOW: z.coerce.number().int().positive().default(20),

    // Development-only OTP bypass. Must never be true in production — enforced below.
    OTP_DEV_MODE: boolFromEnv(false),

    // --- SMS provider ---
    SMS_PROVIDER: z.enum(['console', 'http']).default('console'),
    SMS_HTTP_ENDPOINT: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
    SMS_HTTP_API_KEY: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),

    // --- Admin seed (development only; never a hard-coded default) ---
    ADMIN_SEED_EMAIL: z.string().email().optional(),
    ADMIN_SEED_PASSWORD: z.string().min(12).optional(),
    // Development only: comma-separated admin permissions granted to the seeded admin, or ALL
    // (e.g. OPERATIONS_VIEW,DRIVER_LOCATION_VIEW). Real environments grant these deliberately, per admin.
    ADMIN_SEED_PERMISSIONS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean),
      ),

    // --- Document storage ---
    STORAGE_PROVIDER: z.enum(['local']).default('local'),
    STORAGE_LOCAL_ROOT: z.string().min(1).default('./storage'),
    STORAGE_SIGNING_SECRET: z
      .string()
      .min(32, 'STORAGE_SIGNING_SECRET must be at least 32 characters')
      .refine(
        (val) => !/^(dev|test|change[-_]?me|secret)/i.test(val),
        'STORAGE_SIGNING_SECRET looks like a placeholder value',
      ),
    STORAGE_SIGNED_URL_TTL_SECONDS: z.coerce.number().int().positive().default(300),
    // --- Location / maps ---
    // Provider-specific code lives in modules/location/providers; the rest
    // of the app only sees the LocationProvider / RouteProvider interfaces.
    LOCATION_PROVIDER: z.enum(['nominatim', 'static', 'none']).default('nominatim'),
    LOCATION_PROVIDER_BASE_URL: z.string().url().default('https://nominatim.openstreetmap.org'),
    // Optional; sent as the `key` query param (LocationIQ-style Nominatim APIs). Never returned to clients.
    LOCATION_PROVIDER_API_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().optional(),
    ),
    LOCATION_PROVIDER_USER_AGENT: z.string().min(1).default('Yatri-API/0.1 (dev)'),
    // Comma-separated ISO 3166-1 alpha-2 codes results are limited to. Add codes to expand beyond Nepal.
    LOCATION_COUNTRY_CODES: z
      .string()
      .default('np')
      .transform((v) =>
        v
          .split(',')
          .map((c) => c.trim().toLowerCase())
          .filter(Boolean),
      ),
    LOCATION_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),
    LOCATION_SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(86400),
    LOCATION_REVERSE_CACHE_TTL_SECONDS: z.coerce.number().int().min(0).default(86400),
    LOCATION_ROUTING_PROVIDER: z
      .enum(['haversine', 'osrm', 'graphhopper', 'valhalla'])
      .default('haversine'),
    LOCATION_ROUTING_BASE_URL: z.string().url().default('https://router.project-osrm.org'),
    LOCATION_ROUTING_API_KEY: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().optional(),
    ),
    // --- Live tracking ---
    // Location updates arriving faster than this (per party) are dropped.
    // Minimum pause between reverse-geocode lookups for one moving party (cost control).
    TRACKING_PLACE_REFRESH_MS: z.coerce.number().int().min(0).default(15000),
    TRACKING_MIN_INTERVAL_MS: z.coerce.number().int().min(0).default(800),
    // --- Driver availability ---
    // A location no older than this counts as fresh (usable for matching).
    DRIVER_LOCATION_FRESH_SECONDS: z.coerce.number().int().positive().default(30),
    // Past this a silent driver reads as 'lost' (trip UI); availability stale timeout is separate below.
    DRIVER_LOCATION_LOST_SECONDS: z.coerce.number().int().positive().default(60),
    // Online but silent for this long -> the server moves the driver to UNAVAILABLE.
    DRIVER_STALE_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(180),
    // Cadence the client is told to use, per driver situation (battery vs. freshness).
    DRIVER_UPDATE_INTERVAL_IDLE_MS: z.coerce.number().int().min(1000).default(10000),
    DRIVER_UPDATE_INTERVAL_EN_ROUTE_MS: z.coerce.number().int().min(1000).default(3000),
    DRIVER_UPDATE_INTERVAL_ON_TRIP_MS: z.coerce.number().int().min(1000).default(3000),
    // Going online needs a fix at least this accurate.
    DRIVER_ONLINE_MAX_ACCURACY_METERS: z.coerce.number().int().positive().default(100),
    // Postgres gets at most one location write per driver per this many seconds.
    DRIVER_LOCATION_PERSIST_SECONDS: z.coerce.number().int().min(0).default(20),
    // A GOING_ONLINE / GOING_OFFLINE transition that never completes is rolled back after this.
    DRIVER_TRANSITION_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(30),
    // --- Pricing & waiting (whole Nepalese rupees) ---
    FARE_BASE_NPR: z.coerce.number().int().min(0).default(50),
    FARE_PER_KM_NPR: z.coerce.number().min(0).default(30),
    FARE_PER_MINUTE_NPR: z.coerce.number().min(0).default(2),
    FARE_MINIMUM_NPR: z.coerce.number().int().min(0).default(100),
    // Waiting at the pickup: free period, then a per-minute charge added to the fare.
    WAITING_FREE_SECONDS: z.coerce.number().int().min(0).default(180),
    WAITING_PER_MINUTE_NPR: z.coerce.number().min(0).default(5),
    // After this long a waiting driver may cancel as a passenger no-show.
    NO_SHOW_AFTER_SECONDS: z.coerce.number().int().positive().default(300),
    // When (seconds of waiting) the other party is told about a wait, and at what driver
    // distances (meters) "driver is N away" events fire. Comma-separated.
    WAITING_NOTIFY_SECONDS: z.string().default('120,240,360,480,600').transform(numList),
    NEARBY_NOTIFY_METERS: z.string().default('1000,500,200').transform(numList),

    // The driver must be this close to the pickup for the server to accept "I have arrived".
    TRIP_ARRIVAL_RADIUS_METERS: z.coerce.number().int().positive().default(150),

    // --- Dispatch (matching) ---
    DISPATCH_RADIUS_METERS: z.coerce.number().int().positive().default(5000),
    DISPATCH_OFFER_TTL_SECONDS: z.coerce.number().int().positive().default(20),
    DISPATCH_SEARCH_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(120),
    // Safety. How many emergency contacts a person may keep, and the local emergency services number the
    // apps offer to call (Nepal Police is 100). Neither is hard-coded in an app.
    EMERGENCY_CONTACTS_MAX: z.coerce.number().int().min(1).max(10).default(5),
    EMERGENCY_SERVICES_NUMBER: z.string().trim().min(2).max(20).default('100'),
    // Trip sharing with a trusted contact. A link works for at most SHARE_DURATION_HOURS, and only
    // until the ride ends (then it shows the outcome for SHARE_ENDED_GRACE_MINUTES and stops).
    SHARE_DURATION_HOURS: z.coerce.number().positive().default(6),
    SHARE_MAX_PER_TRIP: z.coerce.number().int().positive().default(5),
    SHARE_ENDED_GRACE_MINUTES: z.coerce.number().int().min(0).default(15),
    // Where share links point (the API host serves the contact's page). No trailing slash.
    PUBLIC_BASE_URL: z.string().url().default('http://localhost:4000'),
    // Which call provider carries voice/video. Only "webrtc" (peer-to-peer media, server signalling) exists.
    CALL_PROVIDER: z.enum(['webrtc']).default('webrtc'),
    // How candidate drivers are ranked. Only "proximity" exists today; add a strategy in
    // dispatch/matching.ts and its name here, never in a controller or an app.
    MATCHING_STRATEGY: z.enum(['proximity']).default('proximity'),
    // Cancellation rules. A passenger who cancels within CANCEL_FREE_SECONDS of a driver being
    // assigned, or before any driver is assigned, pays nothing; later, the fee below is RECORDED on
    // the ride (not charged: payments are a later phase). 0 disables the fee.
    CANCEL_FREE_SECONDS: z.coerce.number().int().min(0).default(120),
    CANCEL_FEE_NPR: z.coerce.number().int().min(0).default(0),
    // --- Platform settings (see @yatri/types settings.ts and settings/settings.service.ts) ---
    // Every setting an admin may change has its default here (the FARE_*, CANCEL_*, WAITING_*,
    // NO_SHOW_* and *_NOTIFY_* values above and below); the database only holds what an admin set.
    SERVICE_REQUESTS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    SERVICE_PAUSED_MESSAGE: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .default('Ride requests are paused for a short while. Please try again soon.'),
    // How long a process trusts its copy of the settings before re-reading them (0 = every request).
    SETTINGS_CACHE_SECONDS: z.coerce.number().int().min(0).default(10),
    // The time zone that days and "today" mean in dashboards and reports.
    PLATFORM_TIME_ZONE: z.string().trim().min(1).default('Asia/Kathmandu'),
    DISPATCH_MAX_OFFERS: z.coerce.number().int().positive().default(6),
    // An assigned driver silent for this long (still en route) is replaced by re-matching.
    TRIP_DRIVER_LOST_SECONDS: z.coerce.number().int().positive().default(120),

    // --- Chat ---
    // Chat stays writable this long after a trip ends (e.g. to arrange a lost item), then read-only.
    CHAT_OPEN_AFTER_TRIP_MINUTES: z.coerce.number().int().min(0).default(15),
    // Chat text is deleted this many days after the ride ends (rides with an open dispute are kept
    // until it is resolved). 0 = keep forever.
    CHAT_RETENTION_DAYS: z.coerce.number().int().min(0).default(90),
    CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),

    // --- Calls (WebRTC) ---
    CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(45),
    // STUN/TURN for media. Comma-separated URLs; TURN uses coturn's time-limited shared-secret credentials.
    CALL_STUN_URLS: z.string().default('stun:stun.l.google.com:19302').transform(strList),
    CALL_TURN_URLS: z.string().default('').transform(strList),
    CALL_TURN_SHARED_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    CALL_TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

    LOCATION_SEARCH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),

    MAX_UPLOAD_FILE_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 1024 * 1024),
  })
  .superRefine((data, ctx) => {
    if (data.NODE_ENV === 'production' && data.OTP_DEV_MODE) {
      ctx.addIssue({
        code: 'custom',
        path: ['OTP_DEV_MODE'],
        message: 'OTP_DEV_MODE must never be true when NODE_ENV=production',
      });
    }
    if (data.SMS_PROVIDER === 'http' && !data.SMS_HTTP_ENDPOINT) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_HTTP_ENDPOINT'],
        message: 'SMS_HTTP_ENDPOINT is required when SMS_PROVIDER=http',
      });
    }
    if (
      data.NODE_ENV === 'production' &&
      data.LOCATION_PROVIDER === 'nominatim' &&
      new URL(data.LOCATION_PROVIDER_BASE_URL).hostname.endsWith('nominatim.openstreetmap.org')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOCATION_PROVIDER_BASE_URL'],
        message:
          'The public OpenStreetMap Nominatim server forbids production use; point this at a self-hosted or commercial Nominatim-compatible service',
      });
    }
    if (data.NODE_ENV === 'production' && data.SMS_PROVIDER === 'console') {
      ctx.addIssue({
        code: 'custom',
        path: ['SMS_PROVIDER'],
        message: 'SMS_PROVIDER must not be "console" in production (OTPs would only be logged)',
      });
    }
  });

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Failed to load environment configuration.');
  }
  return parsed.data;
}

export const env = loadEnv();
export type Env = typeof env;
export const isProduction = env.NODE_ENV === 'production';
