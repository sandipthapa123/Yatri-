import { z } from 'zod';

const envSchema = z.object({
  API_BASE_URL: z.string().url().default('http://localhost:4000/api/v1'),
  // Must match apps/api's JWT_ACCESS_SECRET exactly — the admin app verifies
  // access tokens locally (in middleware) instead of calling the API on
  // every request. Server-only: no NEXT_PUBLIC_ prefix, never sent to the browser.
  JWT_ACCESS_SECRET: z.string().min(32),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:', parsed.error.flatten().fieldErrors);
    throw new Error('Failed to load admin app environment configuration.');
  }
  return parsed.data;
}

export const env = loadEnv();

/** The API's scheme+host+port only — signed storage URLs come back as absolute paths (e.g. `/api/v1/storage/content?...`), not full URLs, so this is what resolves them. */
export function apiOrigin(): string {
  return new URL(env.API_BASE_URL).origin;
}
