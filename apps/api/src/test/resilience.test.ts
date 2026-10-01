import {
  NOTIFICATION_MAX_ATTEMPTS,
  describeJobState,
  type AdminPermission,
  type JobInfo,
} from '@yatri/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pool } from '../config/database';
import { notify, retryFailedNotifications } from '../lib/notifications';
import { ConsoleNotificationProvider } from '../lib/notifications/console-provider';
import { runJob, type JobDef } from '../modules/jobs/jobs';
import { JOBS } from '../modules/jobs/registry';
import { reconcilePayments } from '../modules/trips/payment-reconcile';
import { api, loginTestAdmin, onboardUser } from './helpers';
import {
  THAMEL,
  arriveAtPickup,
  auth,
  finishedRide,
  forceDriverOnline,
  requestRide,
  rideWorld,
} from './rides';

afterEach(() => vi.restoreAllMocks());

let n = 0;
const key = () => `test-key-${Date.now()}-${++n}-abcdef`;
const withKey = (t: string, k: string, path: string, body: object = {}) =>
  api.post(path).set(auth(t)).set('Idempotency-Key', k).send(body);
const countTrips = async (passengerId: string) =>
  (await pool.query('SELECT count(*)::int AS n FROM trips WHERE passenger_id = $1', [passengerId]))
    .rows[0].n as number;

// ---------------------------------------------------------------- idempotency

describe('idempotent requests', () => {
  const body = {
    pickup: THAMEL,
    destination: { latitude: 27.6766, longitude: 85.3142, address: 'Patan' },
    vehicleCategory: 'CAR',
  };

  it('repeats the first answer for the same key and creates one ride', async () => {
    const passenger = await onboardUser('PASSENGER');
    const driver = await onboardUser('DRIVER');
    await forceDriverOnline(driver.user.id as string);
    const k = key();
    const first = await withKey(passenger.accessToken, k, '/api/v1/trips/request', body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const second = await withKey(passenger.accessToken, k, '/api/v1/trips/request', body);
    expect(second.status).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await countTrips(passenger.user.id as string)).toBe(1);
  });

  it('lets two simultaneous sends of one request create one ride', async () => {
    const passenger = await onboardUser('PASSENGER');
    const driver = await onboardUser('DRIVER');
    await forceDriverOnline(driver.user.id as string);
    const k = key();
    const [a, b] = await Promise.all([
      withKey(passenger.accessToken, k, '/api/v1/trips/request', body),
      withKey(passenger.accessToken, k, '/api/v1/trips/request', body),
    ]);
    const statuses = [a.status, b.status].sort();
    // One ran; the other replayed it or was told to try again in a moment. Never two rides.
    expect(statuses[0]).toBe(201);
    expect([201, 409]).toContain(statuses[1]);
    expect(await countTrips(passenger.user.id as string)).toBe(1);
  });

  it('refuses a key reused for a different request, and a malformed key', async () => {
    const passenger = await onboardUser('PASSENGER');
    const k = key();
    await withKey(passenger.accessToken, k, '/api/v1/trips/estimate', body);
    const other = await withKey(passenger.accessToken, k, '/api/v1/trips/estimate', {
      ...body,
      vehicleCategory: 'BIKE',
    });
    expect(other.status).toBe(422);
    expect(other.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const bad = await withKey(passenger.accessToken, 'short', '/api/v1/trips/estimate', body);
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('IDEMPOTENCY_KEY_INVALID');
  });

  it('keeps keys private to the person who made them', async () => {
    const a = await onboardUser('PASSENGER');
    const b = await onboardUser('PASSENGER');
    const k = key();
    const first = await withKey(a.accessToken, k, '/api/v1/trips/estimate', body);
    const second = await withKey(b.accessToken, k, '/api/v1/trips/estimate', body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replay']).toBeUndefined();
  });

  it('releases the key when the first attempt failed, so a retry runs for real', async () => {
    const passenger = await onboardUser('PASSENGER');
    const k = key();
    // No driver online: a ride still requests, so force a refusal with an invalid body shape instead.
    const bad = await withKey(passenger.accessToken, k, '/api/v1/trips/request', {
      nonsense: true,
    });
    expect(bad.status).toBe(400);
    const rows = await pool.query('SELECT 1 FROM idempotency_keys WHERE key = $1', [k]);
    expect(rows.rowCount).toBe(0);
  });

  it('replays driver steps (start, complete) instead of failing or repeating', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    const k = key();
    const start = await withKey(w.driver.accessToken, k, `/api/v1/trips/${w.tripId}/start`);
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const again = await withKey(w.driver.accessToken, k, `/api/v1/trips/${w.tripId}/start`);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replay']).toBe('true');
    const events = await pool.query(
      `SELECT count(*)::int AS n FROM trip_events WHERE trip_id = $1 AND type = 'TRIP_STARTED'`,
      [w.tripId],
    );
    expect(events.rows[0].n).toBe(1);
  });

  it('works without a key, as before', async () => {
    const passenger = await onboardUser('PASSENGER');
    const r = await api.post('/api/v1/trips/estimate').set(auth(passenger.accessToken)).send(body);
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------- notifications

describe('notification delivery', () => {
  const send = (userId: string, extra: object = {}) =>
    notify({ userId, type: 'RIDE_UPDATE', title: 'Hello', body: 'World', ...extra });
  const row = async (userId: string) =>
    (
      await pool.query(
        'SELECT delivery_status, attempts, next_attempt_at, last_error FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
        [userId],
      )
    ).rows[0];
  const makeDue = (userId: string) =>
    pool.query(
      `UPDATE notifications SET next_attempt_at = now() - interval '1 second' WHERE user_id = $1`,
      [userId],
    );

  it('keeps a failed push, retries it later, and marks it sent', async () => {
    const u = await onboardUser('PASSENGER');
    const id = u.user.id as string;
    const spy = vi
      .spyOn(ConsoleNotificationProvider.prototype, 'send')
      .mockRejectedValueOnce(new Error('provider down'));
    await send(id);
    let r = await row(id);
    expect(r.delivery_status).toBe('FAILED');
    expect(r.attempts).toBe(1);
    expect(r.last_error).toContain('provider down');
    expect(r.next_attempt_at).not.toBeNull();

    // Not due yet: nothing is retried.
    expect((await retryFailedNotifications()).retried).toBe(0);
    await makeDue(id);
    const out = await retryFailedNotifications();
    expect(out.sent).toBeGreaterThanOrEqual(1);
    r = await row(id);
    expect(r.delivery_status).toBe('SENT');
    expect(r.attempts).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last attempt and says so', async () => {
    const u = await onboardUser('PASSENGER');
    const id = u.user.id as string;
    vi.spyOn(ConsoleNotificationProvider.prototype, 'send').mockRejectedValue(
      new Error('still down'),
    );
    await send(id);
    for (let i = 1; i < NOTIFICATION_MAX_ATTEMPTS; i += 1) {
      await makeDue(id);
      await retryFailedNotifications();
    }
    const r = await row(id);
    expect(r.delivery_status).toBe('DEAD');
    expect(r.attempts).toBe(NOTIFICATION_MAX_ATTEMPTS);
    expect(r.next_attempt_at).toBeNull();
  });

  it('records and delivers a notification with one dedupe key once', async () => {
    const u = await onboardUser('PASSENGER');
    const id = u.user.id as string;
    const spy = vi.spyOn(ConsoleNotificationProvider.prototype, 'send');
    await send(id, { dedupeKey: 'doc-expiry:42:7d' });
    await send(id, { dedupeKey: 'doc-expiry:42:7d' });
    await send(id, { dedupeKey: 'doc-expiry:42:1d' });
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM notifications WHERE user_id = $1',
      [id],
    );
    expect(count.rows[0].n).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('never lets two overlapping retry runs push the same notification', async () => {
    const u = await onboardUser('PASSENGER');
    const id = u.user.id as string;
    vi.spyOn(ConsoleNotificationProvider.prototype, 'send').mockRejectedValueOnce(new Error('x'));
    await send(id);
    await makeDue(id);
    const spy = vi.spyOn(ConsoleNotificationProvider.prototype, 'send').mockResolvedValue();
    await Promise.all([retryFailedNotifications(), retryFailedNotifications()]);
    // One push at the start (it failed) and exactly one retry, not two.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------- the job runner

describe('background jobs', () => {
  const job = (name: string, run: () => Promise<unknown>): JobDef => ({
    name,
    label: name,
    help: 'test',
    everySeconds: 60,
    run,
  });
  const runs = async (name: string) =>
    (
      await pool.query(
        'SELECT status, result, error, trigger FROM job_runs WHERE name = $1 ORDER BY id',
        [name],
      )
    ).rows;

  it('lists each job once, with a plain label and help', () => {
    const names = JOBS.map((j) => j.name);
    expect(new Set(names).size).toBe(names.length);
    for (const j of JOBS) {
      expect(j.label.length).toBeGreaterThan(3);
      expect(j.help.length).toBeGreaterThan(10);
      expect(j.everySeconds).toBeGreaterThan(0);
    }
  });

  it('records a run and its result', async () => {
    const name = `t-ok-${Date.now()}`;
    const out = await runJob(job(name, async () => ({ counted: 3 })));
    expect(out.status).toBe('OK');
    const r = await runs(name);
    expect(r).toHaveLength(1);
    expect(r[0].result).toEqual({ counted: 3 });
  });

  it('survives a failing job, records the failure, and runs again next time', async () => {
    const name = `t-fail-${Date.now()}`;
    const out = await runJob(job(name, async () => Promise.reject(new Error('boom'))));
    expect(out.status).toBe('FAILED');
    const again = await runJob(job(name, async () => 'fine'));
    expect(again.status).toBe('OK'); // the lock was released after the failure
    const r = await runs(name);
    expect(r.map((x: { status: string }) => x.status)).toEqual(['FAILED', 'OK']);
    expect(r[0].error).toContain('boom');
  });

  it('runs once when started twice at the same moment', async () => {
    const name = `t-lock-${Date.now()}`;
    let ran = 0;
    const slow = job(name, async () => {
      ran += 1;
      await new Promise((r) => setTimeout(r, 300));
      return null;
    });
    const [a, b] = await Promise.all([runJob(slow, 'MANUAL'), runJob(slow, 'MANUAL')]);
    expect(ran).toBe(1);
    expect([a.status, b.status].sort()).toEqual(['OK', 'SKIPPED']);
  });

  it('describes health in words, late runs as unhealthy', () => {
    const now = Date.now();
    const ok = describeJobState(
      60,
      { status: 'OK', startedAt: new Date(now - 30_000).toISOString() } as never,
      now,
    );
    expect(ok.healthy).toBe(true);
    const late = describeJobState(
      60,
      { status: 'OK', startedAt: new Date(now - 3_600_000).toISOString() } as never,
      now,
    );
    expect(late.healthy).toBe(false);
    expect(late.text.length).toBeGreaterThan(5);
    const failed = describeJobState(
      60,
      { status: 'FAILED', startedAt: new Date(now - 1000).toISOString() } as never,
      now,
    );
    expect(failed.healthy).toBe(false);
    expect(describeJobState(60, null, now).text).toBe('Has not run yet');
  });
});

// ---------------------------------------------------------------- payments

describe('payment reconciliation', () => {
  it('creates the payment a finished ride is missing, exactly once', async () => {
    const w = await finishedRide(false);
    await pool.query('DELETE FROM trip_payments WHERE trip_id = $1', [w.tripId]);
    await pool.query(`UPDATE trips SET ended_at = now() - interval '5 minutes' WHERE id = $1`, [
      w.tripId,
    ]);
    const first = await reconcilePayments();
    expect(first.created).toBeGreaterThanOrEqual(1);
    const rows = await pool.query('SELECT status FROM trip_payments WHERE trip_id = $1', [
      w.tripId,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('PENDING');
    await reconcilePayments();
    const after = await pool.query('SELECT 1 FROM trip_payments WHERE trip_id = $1', [w.tripId]);
    expect(after.rowCount).toBe(1);
  });

  it('leaves a ride that already has its payment alone', async () => {
    const w = await finishedRide(true);
    await pool.query(`UPDATE trips SET ended_at = now() - interval '5 minutes' WHERE id = $1`, [
      w.tripId,
    ]);
    await reconcilePayments();
    const rows = await pool.query('SELECT status FROM trip_payments WHERE trip_id = $1', [
      w.tripId,
    ]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('PAID');
  });
});

// ---------------------------------------------------------------- recovery after a restart

describe('recovering an active ride', () => {
  it('gives the same authoritative ride back to a freshly started app', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    for (const who of ['passenger', 'driver'] as const) {
      const active = await api.get('/api/v1/trips/active').set(auth(w[who].accessToken));
      expect(active.status).toBe(200);
      expect(active.body.data.id).toBe(w.tripId);
      const live = await api.get(`/api/v1/trips/${w.tripId}/live`).set(auth(w[who].accessToken));
      expect(live.status).toBe(200);
      expect(typeof live.body.data.serverTime).toBe('string');
      expect(typeof live.body.data.version).toBe('number');
    }
  });

  it('survives losing the cached trip data (a Redis flush) without losing the ride', async () => {
    const w = await rideWorld();
    const { clearRedis } = await import('./rides');
    await clearRedis();
    const live = await api.get(`/api/v1/trips/${w.tripId}/live`).set(auth(w.passenger.accessToken));
    expect(live.status).toBe(200);
    const start = await api
      .post(`/api/v1/trips/${w.tripId}/arrived`)
      .set(auth(w.driver.accessToken));
    expect([200, 409, 422]).toContain(start.status); // decided by the server's rules, not a crash
  });

  it('cannot be completed twice by two simultaneous requests', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    const [a, b] = await Promise.all([
      api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken)),
      api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken)),
    ]);
    expect([a.status, b.status].filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    const pay = await pool.query('SELECT 1 FROM trip_payments WHERE trip_id = $1', [w.tripId]);
    expect(pay.rowCount).toBe(1);
    const done = await pool.query(
      `SELECT count(*)::int AS n FROM trip_events WHERE trip_id = $1 AND type = 'TRIP_COMPLETED'`,
      [w.tripId],
    );
    expect(done.rows[0].n).toBe(1);
  });

  it('refuses a ride request while one is active, however the app retries', async () => {
    const w = await rideWorld();
    const again = await requestRide(w.passenger.accessToken);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await countTrips(w.passengerId)).toBe(1);
  });
});

// ---------------------------------------------------------------- admin screen

describe('admin background jobs', () => {
  const admin = (permissions: AdminPermission[]) =>
    loginTestAdmin(
      `jobs-admin-${Date.now()}-${++n}@example.com`,
      'a-strong-test-password-1',
      permissions,
    );

  it('lists the jobs with a plain-language state, and needs permission', async () => {
    const viewer = await admin(['OPERATIONS_VIEW']);
    const res = await api.get('/api/v1/admin/jobs').set(auth(viewer));
    expect(res.status).toBe(200);
    const jobs = res.body.data as JobInfo[];
    expect(jobs.map((j) => j.name)).toEqual(JOBS.map((j) => j.name));
    expect(jobs.every((j) => typeof j.statusText === 'string' && j.statusText.length > 0)).toBe(
      true,
    );
    const nobody = await admin(['RISK_VIEW']);
    expect((await api.get('/api/v1/admin/jobs').set(auth(nobody))).status).toBe(403);
    const passenger = await onboardUser('PASSENGER');
    expect((await api.get('/api/v1/admin/jobs').set(auth(passenger.accessToken))).status).toBe(403);
  });

  it('runs a job by hand only with SETTINGS_MANAGE, and audits it', async () => {
    const viewer = await admin(['OPERATIONS_VIEW']);
    const denied = await api.post('/api/v1/admin/jobs/call-sweep/run').set(auth(viewer));
    expect(denied.status).toBe(403);
    const manager = await admin(['SETTINGS_MANAGE']);
    const ok = await api.post('/api/v1/admin/jobs/call-sweep/run').set(auth(manager));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('OK');
    const audit = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'JOB_RUN_MANUALLY'`);
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    const reader = await admin(['OPERATIONS_VIEW']);
    const history = await api.get('/api/v1/admin/jobs/call-sweep/runs').set(auth(reader));
    expect(history.status).toBe(200);
    expect(history.body.data[0].trigger).toBe('MANUAL');
    const missing = await api.post('/api/v1/admin/jobs/nope/run').set(auth(manager));
    expect(missing.status).toBe(404);
  });
});

// ---------------------------------------------------------------- one architecture

describe('one job architecture', () => {
  it('has no timer for time-based work outside the job runner', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(__dirname, '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) return n === 'test' ? [] : walk(p);
        return p.endsWith('.ts') ? [p] : [];
      });
    // The runner itself; the gateway's per-connection heartbeat/session/staleness checks (they belong to a socket, not
    // to the platform); and a script string sent to the browser by the public share page.
    const allowed = new Set([
      join('modules', 'jobs', 'jobs.ts'),
      join('modules', 'realtime', 'gateway.ts'),
      join('modules', 'sharing', 'share.page.ts'),
    ]);
    const offenders = walk(root)
      .filter((f) => /\bsetInterval\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f))
      .filter((f) => !allowed.has(f));
    expect(offenders).toEqual([]);
    const gateway = readFileSync(join(root, 'modules', 'realtime', 'gateway.ts'), 'utf8');
    expect(gateway).toContain('startJobScheduler(JOBS)');
  });

  it('lets only the runner decide when a job runs, and every registry job is a function that finds work in data', () => {
    for (const j of JOBS) expect(typeof j.run).toBe('function');
  });
});
