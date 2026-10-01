/**
 * Runs first in every test worker, before the app's configuration is read: point this worker at its own database,
 * its own Redis database number and its own storage folder (see workers.ts). When the tests run in one process
 * (no worker id) nothing changes and the template database is used directly.
 */
import path from 'node:path';

import { config as loadDotenv } from 'dotenv';

// Read the test environment now (the app does the same later and never overrides what is already set).
loadDotenv({ path: path.resolve(__dirname, '../..', '.env.test') });

const id = Number(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '');

if (Number.isInteger(id) && id >= 1) {
  const db = process.env.DATABASE_URL;
  if (db) {
    const u = new URL(db);
    u.pathname = `${u.pathname}_w${id}`;
    process.env.DATABASE_URL = u.toString();
  } else {
    throw new Error('worker-env: DATABASE_URL must be set in .env.test');
  }
  const redis = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  redis.pathname = `/${id}`;
  process.env.REDIS_URL = redis.toString();
  process.env.STORAGE_LOCAL_ROOT = `./storage-test/w${id}`;
}
