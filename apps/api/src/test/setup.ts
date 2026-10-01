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

/**
 * The test server runs the same background sweeps as production, in this process. One of them can
 * hold row locks while TRUNCATE wants the tables, and Postgres resolves that by aborting one side
 * (deadlock, 40P01). Retrying the truncate is correct: the sweep finishes in milliseconds.
 */
async function truncateAll() {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(TRUNCATE_SQL);
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== '40P01' || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

const TRUNCATE_SQL = `TRUNCATE TABLE
       cities, auth_events, otp_requests, auth_sessions,
       driver_verification_events, notifications, documents, vehicles, driver_details,
       driver_profiles, fleets, vehicle_service_records, expiry_notices, service_zones, pricing_rules, incentive_rules, incentive_awards, trip_ratings, trip_payments, trip_calls, trip_messages, trip_offers, trip_events, trips, driver_availability_events, driver_location_flags, driver_availability, saved_places, locations, driver_last_locations, users
     RESTART IDENTITY CASCADE`;

beforeEach(async () => {
  await truncateAll();
  await getRedisClient().flushdb();
});

afterAll(async () => {
  await pool.end();
  getRedisClient().disconnect();
});
