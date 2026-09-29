import { rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach } from 'vitest';

import { env } from '../config/env';
import { assertUtf8Database, pool } from '../config/database';
import { getRedisClient } from '../config/redis';

beforeAll(async () => {
  await assertUtf8Database(); // Nepali text must round-trip; refuse a legacy-encoded test database
  // Start each test run with a clean local-disk storage root.
  await rm(path.resolve(env.STORAGE_LOCAL_ROOT), { recursive: true, force: true });
});

beforeEach(async () => {
  await pool.query(
    `TRUNCATE TABLE
       auth_events, otp_requests, auth_sessions,
       driver_verification_events, notifications, documents, vehicles, driver_details,
       driver_profiles, trip_disputes, trip_ratings, trip_payments, trip_calls, trip_messages, trip_offers, trip_events, trips, driver_availability_events, driver_location_flags, driver_availability, saved_places, locations, driver_last_locations, users
     RESTART IDENTITY CASCADE`,
  );
  await getRedisClient().flushdb();
});

afterAll(async () => {
  await pool.end();
  getRedisClient().disconnect();
});
