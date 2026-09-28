import { afterAll, beforeEach } from 'vitest';

import { pool } from '../config/database';
import { getRedisClient } from '../config/redis';

beforeEach(async () => {
  await pool.query(
    'TRUNCATE TABLE auth_events, otp_requests, auth_sessions, driver_profiles, users RESTART IDENTITY CASCADE',
  );
  await getRedisClient().flushdb();
});

afterAll(async () => {
  await pool.end();
  getRedisClient().disconnect();
});
