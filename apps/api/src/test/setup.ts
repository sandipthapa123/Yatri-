import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import { env } from '../config/env';
import { pool } from '../config/database';
import { getRedisClient } from '../config/redis';

beforeAll(async () => {
  // Start each test run with a clean local-disk storage root.
  await rm(path.resolve(env.STORAGE_LOCAL_ROOT), { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE
       auth_events, otp_requests, auth_sessions,
       driver_verification_events, notifications, documents, vehicles, driver_details,
       driver_profiles, trips, saved_places, locations, driver_last_locations, users
     RESTART IDENTITY CASCADE`,
  );
  await getRedisClient().flushdb();
});

afterAll(async () => {
  await pool.end();
  getRedisClient().disconnect();
});
