import { beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { matchDrivers } from '../modules/dispatch/matching';
import { api, loginTestAdmin, onboardUser } from './helpers';
import { THAMEL, auth } from './rides';

/**
 * Performance under a realistic amount of data. The database is emptied before every test, so this
 * file builds its own world once (a few thousand people, tens of thousands of rides, payments and
 * notifications) inside `beforeAll`'s first test run, then times the calls an operator and a rider
 * actually make, and checks with EXPLAIN that the hot lookups walk an index instead of the table.
 *
 * The limits are generous on purpose (this is a laptop database shared with a test runner): they
 * catch a query that has become quadratic or lost its index, not a few milliseconds.
 */
const TRIPS = 30_000;
const PASSENGERS = 2_000;
const DRIVERS = 300;
const BUDGET_MS = 2_500;

let adminToken = '';
let someone = { id: '', token: '' };

async function seed() {
  const admin = `perf-${Date.now()}@example.com`;
  adminToken = await loginTestAdmin(admin, 'a-strong-test-password-1', [
    'OPERATIONS_VIEW',
    'ANALYTICS_VIEW',
    'USERS_VIEW',
    'FINANCE_VIEW',
    'NOTIFICATIONS_VIEW',
    'AUDIT_VIEW',
    'DRIVERS_REVIEW',
  ]);
  const p = await onboardUser('PASSENGER');
  someone = { id: p.user.id as string, token: p.accessToken };

  await pool.query(
    `INSERT INTO users (role, status, phone_number, full_name)
     SELECT 'PASSENGER', 'ACTIVE', '+9779' || lpad(g::text, 8, '0'), 'Rider ' || g
     FROM generate_series(1, $1) g`,
    [PASSENGERS],
  );
  await pool.query(
    `INSERT INTO users (role, status, phone_number, full_name)
     SELECT 'DRIVER', 'ACTIVE', '+9778' || lpad(g::text, 8, '0'), 'Driver ' || g
     FROM generate_series(1, $1) g`,
    [DRIVERS],
  );
  const loc = await pool.query(
    `INSERT INTO locations (latitude, longitude, address) VALUES (27.7154, 85.3123, 'Thamel'), (27.6727, 85.325, 'Patan') RETURNING id`,
  );
  const [a, b] = [loc.rows[0].id, loc.rows[1].id];
  await pool.query(
    `INSERT INTO trips (passenger_id, driver_id, status, pickup_location_id, destination_location_id,
                        requested_at, fare_estimate_npr, fare_final_npr, cancellation_fee_npr, ended_at)
     WITH p AS (SELECT array_agg(id ORDER BY id) AS ids FROM users WHERE role = 'PASSENGER'),
          d AS (SELECT array_agg(id ORDER BY id) AS ids FROM users WHERE role = 'DRIVER')
     SELECT p.ids[1 + (g % array_length(p.ids, 1))],
            CASE WHEN g % 5 = 4 THEN NULL ELSE d.ids[1 + (g % array_length(d.ids, 1))] END,
            (ARRAY['COMPLETED','COMPLETED','COMPLETED','CANCELLED','NO_DRIVERS'])[1 + (g % 5)], $2::uuid, $3::uuid,
            now() - (random() * interval '60 days'), 200 + (g % 400),
            CASE WHEN g % 5 < 3 THEN 200 + (g % 400) END, 0, now()
     FROM generate_series(1, $1) g, p, d`,
    [TRIPS, a, b],
  );
  await pool.query(
    `INSERT INTO trip_payments (trip_id, amount_npr, method, status, paid_at)
     SELECT id, fare_final_npr, 'CASH', CASE WHEN random() < 0.9 THEN 'PAID' ELSE 'PENDING' END, now()
     FROM trips WHERE status = 'COMPLETED'`,
  );
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, created_at)
     SELECT t.passenger_id, 'TRIP_DRIVER_ASSIGNED', 'Driver assigned', 'body', t.requested_at FROM trips t`,
  );
  await pool.query('ANALYZE');
}

// The database is emptied before every test, so each timing test seeds again first. Seeding is the
// expensive part and is NOT counted in any of the timings.
async function timed(path: string, token = adminToken) {
  const started = Date.now();
  const res = await api.get(path).set(auth(token));
  return { res, ms: Date.now() - started };
}

describe('operations stay fast with a realistic amount of data', () => {
  beforeAll(() => undefined);

  it('answers dashboards, reports and lists within budget', async () => {
    await seed();
    const calls = [
      '/api/v1/admin/dashboard?range=30d',
      '/api/v1/admin/analytics?range=90d',
      '/api/v1/admin/analytics?range=30d',
      '/api/v1/admin/users?pageSize=20',
      '/api/v1/admin/users?search=Rider%2019&sort=name',
      '/api/v1/admin/trips?range=30d&sort=newest',
      '/api/v1/admin/trips?group=ended&pageSize=50',
      '/api/v1/admin/trips?search=Driver%2012',
      '/api/v1/admin/payments?range=30d&sort=amount',
      '/api/v1/admin/finance/summary?range=90d',
      '/api/v1/admin/finance/earnings?range=30d',
      '/api/v1/admin/notifications/summary?range=30d',
      '/api/v1/admin/notifications?range=7d',
      '/api/v1/admin/audit?range=30d',
      '/api/v1/admin/vehicles',
    ];
    const slow: string[] = [];
    const report: string[] = [];
    for (const path of calls) {
      const { res, ms } = await timed(path);
      expect(res.status, path).toBe(200);
      report.push(`${String(ms).padStart(5)} ms  ${path}`);
      if (ms > BUDGET_MS) slow.push(`${path} took ${ms} ms`);
    }
    // PERF_REPORT=1 prints the measured times: a benchmark you can read, not only a pass or a fail.
    if (process.env.PERF_REPORT) {
      process.stdout.write(`\nPERF (${TRIPS} rides)\n${report.join('\n')}\n`);
    }
    expect(slow).toEqual([]);
  }, 180_000);

  it('serves a rider their own history quickly, from an index', async () => {
    await seed();
    // give the rider a few rides among the thousands
    await pool.query(
      `UPDATE trips SET passenger_id = $1 WHERE id IN (SELECT id FROM trips ORDER BY id LIMIT 25)`,
      [someone.id],
    );
    const { res, ms } = await timed('/api/v1/trips/history?page=1&pageSize=20', someone.token);
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(BUDGET_MS);
    const plan = await pool.query(
      `EXPLAIN (FORMAT JSON) SELECT id FROM trips WHERE passenger_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [someone.id],
    );
    expect(JSON.stringify(plan.rows[0])).toContain('trips_passenger_history_idx'); // not a walk of 30,000 rows
  }, 180_000);

  it('finds nearby drivers with the coordinate index, among hundreds online', async () => {
    await seed();
    await pool.query(
      `INSERT INTO driver_profiles (user_id, status) SELECT id, 'VERIFIED' FROM users WHERE role = 'DRIVER'`,
    );
    await pool.query(
      `INSERT INTO vehicles (driver_user_id, category_id, make, model, year, color, registration_number, verification_status)
         SELECT u.id, c.id, 'Toyota', 'Corolla', 2020, 'White', 'P-' || u.id::text, 'APPROVED'
         FROM users u, vehicle_categories c WHERE u.role = 'DRIVER' AND c.code = 'CAR'`,
    );
    await pool.query(
      `INSERT INTO driver_availability (driver_id, state, online_since)
         SELECT id, 'ONLINE', now() FROM users WHERE role = 'DRIVER'`,
    );
    await pool.query(
      `INSERT INTO driver_last_locations (driver_id, latitude, longitude, accuracy_meters, recorded_at)
         SELECT id, 27.60 + random() * 0.25, 85.20 + random() * 0.25, 8, now() FROM users WHERE role = 'DRIVER'`,
    );
    await pool.query('ANALYZE');
    const category = (await pool.query("SELECT id FROM vehicle_categories WHERE code = 'CAR'"))
      .rows[0].id as string;
    const started = Date.now();
    await matchDrivers({ pickup: THAMEL, vehicleCategoryId: category });
    expect(Date.now() - started).toBeLessThan(1_000);
    const plan = await pool.query(
      `EXPLAIN (FORMAT JSON) SELECT driver_id FROM driver_last_locations
         WHERE latitude BETWEEN 27.70 AND 27.73 AND longitude BETWEEN 85.30 AND 85.33`,
    );
    expect(JSON.stringify(plan.rows[0])).toContain('driver_last_locations_lat_lng_idx');
  }, 180_000);

  it('has no duplicate indexes (each one slows every write for nothing)', async () => {
    const dup = await pool.query(`
      SELECT array_agg(indexrelid::regclass::text) AS names
      FROM pg_index
      GROUP BY indrelid, indkey::text, indclass::text, indoption::text, coalesce(indpred::text, ''), coalesce(indexprs::text, '')
      HAVING count(*) > 1`);
    expect(dup.rows.map((r) => r.names)).toEqual([]);
  });
});
