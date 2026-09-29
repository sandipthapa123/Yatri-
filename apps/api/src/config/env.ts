import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

// NODE_ENV=test loads .env.test instead of .env, so the suite runs against a
// dedicated test database/config without touching local dev settings.
loadDotenv({
  path: path.resolve(__dirname, '../..', process.env.NODE_ENV === 'test' ? '.env.test' : '.env'),
});

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
    LOCATION_PROVIDER: z.enum(['nominatim', 'none']).default('nominatim'),
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
    LOCATION_ROUTING_PROVIDER: z.enum(['haversine', 'osrm']).default('haversine'),
    LOCATION_ROUTING_BASE_URL: z.string().url().default('https://router.project-osrm.org'),
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
