import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { z } from 'zod';
import { log } from '../lib/logger';

// NODE_ENV=test loads .env.test instead of .env, so the suite runs against a
// dedicated test database/config without touching local dev settings.
loadDotenv({
  path: path.resolve(__dirname, '../..', process.env.NODE_ENV === 'test' ? '.env.test' : '.env'),
});

/** A host that only means "this machine": never acceptable as a public address. */
function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h.startsWith('127.') ||
    h === '0.0.0.0' ||
    h === '[::1]' ||
    h === '::1'
  );
}

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
    MATCHING_STRATEGY: z.enum(['proximity', 'eta_workload']).default('eta_workload'),
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
    CHAT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(30),

    // --- Calls (WebRTC) ---
    CALL_RING_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(45),
    // STUN/TURN for media. Comma-separated URLs; TURN uses coturn's time-limited shared-secret credentials.
    CALL_STUN_URLS: z.string().default('stun:stun.l.google.com:19302').transform(strList),
    CALL_TURN_URLS: z.string().default('').transform(strList),
    CALL_TURN_SHARED_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().optional()),
    CALL_TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

    LOCATION_SEARCH_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),

    // --- Support and privacy (defaults; an administrator can override them in Settings) ---
    SUPPORT_AUTO_CLOSE_DAYS: z.coerce.number().int().min(0).max(365).default(7),
    SUPPORT_MAX_ATTACHMENTS_PER_TICKET: z.coerce.number().int().min(0).max(50).default(6),
    DATA_REQUEST_RESPONSE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    // --- Dispatch, surge and driver limits (defaults; an administrator can override them in Settings) ---
    DISPATCH_RADIUS_EXPANSION_PERCENT: z.coerce.number().int().min(0).max(200).default(25),
    DISPATCH_MAX_RADIUS_METERS: z.coerce.number().int().min(1000).max(50000).default(12000),
    DISPATCH_WORKLOAD_WINDOW_MINUTES: z.coerce.number().int().min(15).max(720).default(120),
    DISPATCH_WORKLOAD_PENALTY_SECONDS: z.coerce.number().int().min(0).max(600).default(60),
    SURGE_MAX_MULTIPLIER: z.coerce.number().min(1).max(10).default(3),
    SURGE_DEMAND_WINDOW_MINUTES: z.coerce.number().int().min(5).max(120).default(15),
    DRIVER_MAX_RIDES_PER_DAY: z.coerce.number().int().min(0).max(200).default(0),
    DRIVER_MAX_ONLINE_HOURS: z.coerce.number().int().min(0).max(24).default(0),
    HEATMAP_CELL_METERS: z.coerce.number().int().min(500).max(5000).default(1000),
    HEATMAP_MIN_COUNT: z.coerce.number().int().min(1).max(20).default(3),
    // --- Fleet and driver operations (defaults; an administrator can override them in Settings) ---
    EXPIRY_REMINDER_DAYS: z.string().default('30,14,7,1').transform(numList),
    RESTRICTED_DRIVER_MAX_RIDES_PER_DAY: z.coerce.number().int().min(1).max(50).default(3),
    // How often documents, licences and service dates are checked and reminders are sent.
    FLEET_MONITOR_MINUTES: z.coerce.number().int().positive().default(60),
    // How often the support sweep (escalations, auto-close) and the retention job run.
    SUPPORT_SWEEP_SECONDS: z.coerce.number().int().positive().default(300),

    // --- Fraud and risk (defaults; an administrator can override them in Settings) ---
    RISK_REVIEW_SCORE: z.coerce.number().int().min(1).max(1000).default(40),
    RISK_EVENT_WINDOW_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    RISK_AUTO_RESTRICT_SCORE: z.coerce.number().int().min(0).max(5000).default(0),
    RISK_MIN_DISTINCT_RULES: z.coerce.number().int().min(2).max(10).default(3),
    RISK_AUTO_RESTRICT_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    RISK_MAX_RESTRICTION_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    // How often the risk detectors run.
    RISK_SWEEP_MINUTES: z.coerce.number().int().positive().default(15),

    MAX_UPLOAD_FILE_SIZE_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(8 * 1024 * 1024),

    // --- Operations (logging, proxies, limits, database, shutdown) ---
    LOG_LEVEL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.enum(['debug', 'info', 'warn', 'error', 'silent']).optional(),
    ),
    // Identifies the running release in logs and health checks (a git SHA or tag, set by the deploy).
    APP_VERSION: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().trim().min(1).max(64).optional(),
    ),
    // How many reverse proxies sit in front of the API (so req.ip is the real client). 0 = none.
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
    // Generic per-IP request ceiling for the whole API, per minute (auth, OTP and other routes have their own, stricter limits).
    API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(600),
    // Per signed-in user, per minute, for state-changing requests across the API (stricter limits sit in front of sensitive routes).
    MUTATION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
    DATABASE_SSL: boolFromEnv(false),
    // Only ever turn this off for a database reached over a private network you control.
    DATABASE_SSL_REJECT_UNAUTHORIZED: boolFromEnv(true),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    // A query running longer than this is cancelled by Postgres (a stuck query cannot hold a connection forever).
    DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15000),
    // A Redis command that does not answer in this time fails instead of hanging the request.
    REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(200).default(3000),
    // On SIGTERM the server stops accepting work and waits at most this long before exiting.
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10000),
  })
  .superRefine((data, ctx) => {
    // Staging is reachable from the internet with real-looking data: it gets production's rules.
    const deployed = data.NODE_ENV === 'production' || data.NODE_ENV === 'staging';
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (deployed) {
      if (data.OTP_DEV_MODE)
        issue('OTP_DEV_MODE', 'OTP_DEV_MODE must be false outside development and test');
      if (data.SMS_PROVIDER === 'console') {
        issue(
          'SMS_PROVIDER',
          'SMS_PROVIDER must not be "console" in staging or production (OTPs would only be logged)',
        );
      }
      for (const origin of data.CORS_ORIGINS) {
        let url: URL | null = null;
        try {
          url = new URL(origin);
        } catch {
          /* reported below */
        }
        if (!url || url.protocol !== 'https:' || isLocalHost(url.hostname)) {
          issue(
            'CORS_ORIGINS',
            `CORS origin "${origin}" must be an https URL that is not localhost (never "*")`,
          );
        }
      }
      const publicUrl = new URL(data.PUBLIC_BASE_URL);
      if (publicUrl.protocol !== 'https:' || isLocalHost(publicUrl.hostname)) {
        issue(
          'PUBLIC_BASE_URL',
          'PUBLIC_BASE_URL must be the public https address (share links are built from it)',
        );
      }
      if (data.JWT_ACCESS_SECRET === data.STORAGE_SIGNING_SECRET) {
        issue(
          'STORAGE_SIGNING_SECRET',
          'STORAGE_SIGNING_SECRET must differ from JWT_ACCESS_SECRET (one leak must not open both)',
        );
      }
    }
    if (data.NODE_ENV === 'production' && (data.ADMIN_SEED_PASSWORD || data.ADMIN_SEED_EMAIL)) {
      issue(
        'ADMIN_SEED_PASSWORD',
        'ADMIN_SEED_* are development-only and must not be set in production',
      );
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
  });

/** Every variable the API reads (for the check that .env.example documents them all). */
export const ENV_KEYS: string[] = Object.keys(envSchema.shape);

/** What is wrong with a set of variables, as "NAME: reason" lines (empty when it is valid). Never includes a value. */
export function envIssues(source: NodeJS.ProcessEnv): string[] {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) return [];
  return parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
}

/** Validate a set of variables. The API uses `process.env`; tests pass their own to prove the rules. */
export function parseEnv(source: NodeJS.ProcessEnv) {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    log.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Failed to load environment configuration.');
  }
  return parsed.data;
}

export const env = parseEnv(process.env);
export type Env = typeof env;
export const isProduction = env.NODE_ENV === 'production';
