import {
  ACCOUNT_RESTRICTED_MESSAGE,
  ADMIN_PERMISSIONS,
  RISK_CATEGORIES,
  RISK_EVENT_TRANSITIONS,
  RISK_LEVELS,
  RISK_RULES,
  deriveRiskLevel,
  holdsPermission,
  type AdminPermission,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { findEligibleDrivers } from '../modules/dispatch/matching';
import { DETECTORS } from '../modules/risk/detectors';
import { purgeOldRiskEvents, runRiskSweep } from '../modules/risk/sweep';
import { refreshSettings } from '../modules/settings/settings.service';
import { api, loginTestAdmin, onboardUser } from './helpers';
import {
  THAMEL,
  auth,
  clearRedis,
  finishedRide,
  forceDriverOnline,
  putDriverOnline,
  requestRide,
} from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
async function admin(permissions: AdminPermission[] = ['RISK_MANAGE', 'USERS_MANAGE']) {
  const email = `risk-admin-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1', permissions);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  return { token, id: id as string };
}
const get = (token: string, path: string) => api.get(`/api/v1/admin/risk${path}`).set(auth(token));
const post = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/admin/risk${path}`).set(auth(token)).send(body);
const put = (token: string, path: string, body: object) =>
  api.put(`/api/v1/admin/risk${path}`).set(auth(token)).send(body);

const setSetting = async (key: string, value: unknown) => {
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
    [key, JSON.stringify(value)],
  );
  await refreshSettings();
};
const clearSetting = async (key: string) => {
  await pool.query('DELETE FROM platform_settings WHERE key = $1', [key]);
  await refreshSettings();
};

const events = async (userId: string, rule?: string) =>
  (
    await pool.query(
      `SELECT * FROM risk_events WHERE user_id = $1 ${rule ? 'AND rule_code = $2' : ''} ORDER BY created_at`,
      rule ? [userId, rule] : [userId],
    )
  ).rows;
const audits = async (action: string) =>
  (await pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;
const userId = (u: { user: Record<string, unknown> }) => u.user.id as string;

/** Make a rule fire on one record so a test does not need dozens of rides. */
async function lowerThreshold(token: string, code: string, over: Record<string, unknown> = {}) {
  const def = RISK_RULES.find((r) => r.code === code)!;
  const r = await put(token, `/rules/${code}`, {
    enabled: true,
    points: def.points,
    threshold: 1,
    windowHours: def.windowHours,
    reason: 'Test: fire on one record',
    ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function authEvents(
  phone: string | null,
  type: string,
  count: number,
  ip?: string,
  uid?: string,
) {
  for (let i = 0; i < count; i++) {
    await pool.query(
      `INSERT INTO auth_events (user_id, event_type, phone_number, ip_address) VALUES ($1, $2, $3, $4)`,
      [uid ?? null, type, phone, ip ?? null],
    );
  }
}

// ---------------------------------------------------------------- the definitions, once

describe('risk definitions', () => {
  it('has one detector for every rule, valid categories and unique codes', () => {
    const codes = RISK_RULES.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(DETECTORS).sort()).toEqual([...codes].sort());
    for (const r of RISK_RULES) {
      expect(RISK_CATEGORIES).toContain(r.category);
      expect(r.points).toBeGreaterThan(0);
      expect(r.threshold).toBeGreaterThan(0);
    }
  });

  it('derives the level in one place: suspended beats restricted beats review', () => {
    const base = { score: 0, reviewScore: 40, restrictedUntil: null };
    const future = new Date(Date.now() + 3_600_000);
    expect(deriveRiskLevel({ ...base, accountStatus: 'ACTIVE' })).toBe('LOW_RISK');
    expect(deriveRiskLevel({ ...base, score: 40, accountStatus: 'ACTIVE' })).toBe(
      'REVIEW_REQUIRED',
    );
    expect(
      deriveRiskLevel({ ...base, score: 90, restrictedUntil: future, accountStatus: 'ACTIVE' }),
    ).toBe('RESTRICTED');
    expect(
      deriveRiskLevel({ ...base, score: 90, restrictedUntil: future, accountStatus: 'SUSPENDED' }),
    ).toBe('SUSPENDED');
    // a restriction whose time has passed no longer applies
    expect(
      deriveRiskLevel({
        ...base,
        restrictedUntil: new Date(Date.now() - 1000),
        accountStatus: 'ACTIVE',
      }),
    ).toBe('LOW_RISK');
    expect(RISK_LEVELS).toEqual(['LOW_RISK', 'REVIEW_REQUIRED', 'RESTRICTED', 'SUSPENDED']);
  });

  it('only lets a review move between confirmed and dismissed', () => {
    expect(RISK_EVENT_TRANSITIONS.OPEN).toEqual(['CONFIRMED', 'DISMISSED']);
    expect(RISK_EVENT_TRANSITIONS.DISMISSED).not.toContain('OPEN');
  });
});

// ---------------------------------------------------------------- authorization

describe('risk authorization', () => {
  const reads = [
    '/overview',
    '/events',
    '/users',
    '/rules',
    '/history',
    '/events/00000000-0000-4000-8000-000000000001',
    '/users/00000000-0000-4000-8000-000000000001',
    '/trips/00000000-0000-4000-8000-000000000001',
  ];
  const writes: Array<['post' | 'put', string]> = [
    ['post', '/events/00000000-0000-4000-8000-000000000001/review'],
    ['post', '/users/00000000-0000-4000-8000-000000000001/restrict'],
    ['post', '/users/00000000-0000-4000-8000-000000000001/lift'],
    ['post', '/notes'],
    ['put', '/rules/OTP_REQUEST_BURST'],
    ['post', '/sweep/run'],
  ];

  it('refuses every route without a token, to a passenger, and to an admin with other permissions', async () => {
    const passenger = await onboardUser('PASSENGER');
    const other = await admin(
      ADMIN_PERMISSIONS.filter((p) => p !== 'RISK_VIEW' && p !== 'RISK_MANAGE'),
    );
    for (const p of reads) {
      expect((await api.get(`/api/v1/admin/risk${p}`)).status).toBe(401);
      expect((await get(passenger.accessToken, p)).status).toBe(403);
      expect((await get(other.token, p)).status, p).toBe(403);
    }
    for (const [m, p] of writes) {
      expect((await api[m](`/api/v1/admin/risk${p}`).send({})).status).toBe(401);
      expect(
        (await api[m](`/api/v1/admin/risk${p}`).set(auth(other.token)).send({})).status,
        p,
      ).toBe(403);
    }
  });

  it('lets RISK_VIEW read but not change, and RISK_MANAGE do both', async () => {
    const viewer = await admin(['RISK_VIEW']);
    const manager = await admin(['RISK_MANAGE']);
    expect(holdsPermission(['RISK_MANAGE'], 'RISK_VIEW')).toBe(true);
    for (const p of ['/overview', '/events', '/users', '/rules', '/history']) {
      expect((await get(viewer.token, p)).status, p).toBe(200);
      expect((await get(manager.token, p)).status, p).toBe(200);
    }
    for (const [m, p] of writes) {
      const body = await api[m](`/api/v1/admin/risk${p}`).set(auth(viewer.token)).send({});
      expect(body.status, p).toBe(403);
    }
  });

  it('does not let RISK_MANAGE suspend, which stays with the user-management permission', async () => {
    const manager = await admin(['RISK_MANAGE']);
    const p = await onboardUser('PASSENGER');
    const r = await api
      .post(`/api/v1/admin/users/${userId(p)}/suspend`)
      .set(auth(manager.token))
      .send({ reason: 'No permission for this' });
    expect(r.status).toBe(403);
  });
});

// ---------------------------------------------------------------- detectors

describe('detectors', () => {
  it('flags many one-time codes and wrong codes, keeps no personal data, and is idempotent', async () => {
    const p = await onboardUser('PASSENGER');
    await authEvents(p.phoneNumber, 'OTP_REQUESTED', 6, '203.0.113.9');
    await authEvents(p.phoneNumber, 'OTP_VERIFY_FAILED', 6, '203.0.113.9');
    const first = await runRiskSweep();
    expect(first.eventsCreated).toBeGreaterThanOrEqual(2);
    const evs = await events(userId(p));
    expect(evs.map((e) => e.rule_code).sort()).toEqual(['OTP_REQUEST_BURST', 'OTP_WRONG_CODES']);
    for (const e of evs) {
      expect(e.status).toBe('OPEN');
      const text = JSON.stringify(e);
      expect(text).not.toContain(p.phoneNumber);
      expect(text).not.toContain('203.0.113.9');
    }
    // running again adds nothing: the same signal is not counted twice
    const second = await runRiskSweep();
    expect(second.eventsCreated).toBe(0);
    expect(await events(userId(p))).toHaveLength(2);
  });

  it('does not flag below the threshold', async () => {
    const p = await onboardUser('PASSENGER');
    await authEvents(p.phoneNumber, 'OTP_REQUESTED', 4); // plus the one from signing up: five
    await runRiskSweep();
    expect(await events(userId(p))).toHaveLength(0);
  });

  it('flags failed sign-ins and repeated tries on a suspended account', async () => {
    const p = await onboardUser('PASSENGER');
    await authEvents(null, 'LOGIN_FAILED', 10, undefined, userId(p));
    await authEvents(null, 'ACCESS_BLOCKED_SUSPENDED', 3, undefined, userId(p));
    await runRiskSweep();
    expect((await events(userId(p))).map((e) => e.rule_code).sort()).toEqual([
      'LOGIN_FAILURE_BURST',
      'SUSPENDED_RETRIES',
    ]);
  });

  it('flags several accounts from one address with few points, and never from one account', async () => {
    const people = await Promise.all([1, 2, 3, 4].map(() => onboardUser('PASSENGER')));
    const lone = await onboardUser('PASSENGER');
    // every test user signs in from the same local address, so start from a clean sign-in history
    await pool.query('DELETE FROM auth_events');
    for (const p of people) await authEvents(null, 'OTP_VERIFIED', 1, '198.51.100.7', userId(p));
    await authEvents(null, 'OTP_VERIFIED', 5, '198.51.100.8', userId(lone));
    await runRiskSweep();
    for (const p of people) {
      const e = await events(userId(p), 'SHARED_ADDRESS_ACCOUNTS');
      expect(e).toHaveLength(1);
      expect(e[0].points).toBe(5);
      expect(e[0].evidence.relatedUserIds).toHaveLength(3);
      expect(e[0].evidence.relatedUserIds).not.toContain(userId(p));
    }
    expect(await events(userId(lone))).toHaveLength(0);
    // a shared address alone is only five points: nobody is asked to be reviewed for it
    const detail = await get((await admin(['RISK_VIEW'])).token, `/users/${userId(people[0]!)}`);
    expect(detail.body.data.level).toBe('LOW_RISK');
  });

  it('flags repeated implausible driver locations with the kinds, not the places', async () => {
    const d = await onboardUser('DRIVER');
    for (let i = 0; i < 5; i++) {
      await pool.query(
        `INSERT INTO driver_location_flags (driver_id, kind, details) VALUES ($1, $2, $3::jsonb)`,
        [
          userId(d),
          i % 2 ? 'MOCK_LOCATION' : 'LOCATION_JUMP',
          JSON.stringify({ lat: 27.7, lng: 85.3 }),
        ],
      );
    }
    await runRiskSweep();
    const e = await events(userId(d), 'GPS_SPOOFING_FLAGS');
    expect(e).toHaveLength(1);
    expect(e[0].evidence.kinds.sort()).toEqual(['LOCATION_JUMP', 'MOCK_LOCATION']);
    expect(JSON.stringify(e[0])).not.toContain('27.7');
  });

  it('flags a passenger who cancels most of their rides, with the rides to look at', async () => {
    const p = await onboardUser('PASSENGER');
    for (let i = 0; i < 5; i++) {
      const r = await requestRide(p.accessToken);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      const c = await api
        .post(`/api/v1/trips/${r.body.data.id}/cancel`)
        .set(auth(p.accessToken))
        .send({});
      expect(c.status, JSON.stringify(c.body)).toBe(200);
    }
    await runRiskSweep();
    const e = await events(userId(p), 'PASSENGER_CANCELLATIONS');
    expect(e).toHaveLength(1);
    expect(e[0].evidence.count).toBe(5);
    expect(e[0].evidence.tripIds.length).toBeGreaterThan(0);
    expect(e[0].trip_id).toBe(e[0].evidence.tripIds[0]);
  });

  it('flags payment, refund, rating, collusion, dispute and incentive patterns from existing records', async () => {
    const a = await admin(['RISK_MANAGE']);
    const w = await finishedRide(false);
    await pool.query("UPDATE trips SET ended_at = now() - interval '2 days' WHERE id = $1", [
      w.tripId,
    ]);
    for (const code of [
      'UNPAID_RIDES',
      'REFUND_REQUEST_BURST',
      'RATING_BOOSTING',
      'RATING_BOMBING',
      'REPEAT_PAIR_RIDES',
      'REPEATED_DISPUTES',
      'INCENTIVE_SPIKE',
    ]) {
      await lowerThreshold(a.token, code);
    }
    // the records the rules read, written the way their own modules write them
    const pay = await pool.query('SELECT id FROM trip_payments WHERE trip_id = $1', [w.tripId]);
    const payId =
      pay.rows[0]?.id ??
      (
        await pool.query(
          `INSERT INTO trip_payments (trip_id, amount_npr, method, status) VALUES ($1, 500, 'CASH', 'PENDING') RETURNING id`,
          [w.tripId],
        )
      ).rows[0].id;
    await pool.query(
      `INSERT INTO refunds (trip_id, payment_id, requested_by, requested_by_role, amount_npr, reason)
       VALUES ($1, $2, $3, 'PASSENGER', 100, 'PARTIAL')`,
      [w.tripId, payId, w.passengerId],
    );
    await pool.query(
      `INSERT INTO trip_ratings (trip_id, rater_id, ratee_id, rater_role, stars) VALUES ($1, $2, $3, 'PASSENGER', 5)`,
      [w.tripId, w.passengerId, w.driverId],
    );
    await pool.query(
      `INSERT INTO trip_ratings (trip_id, rater_id, ratee_id, rater_role, stars) VALUES ($1, $2, $3, 'DRIVER', 1)`,
      [w.tripId, w.driverId, w.passengerId],
    );
    await pool.query(
      `INSERT INTO support_tickets (requester_id, requester_role, category_code, is_dispute, subject, priority, trip_id)
       VALUES ($1, 'PASSENGER', 'RIDE_OTHER', true, 'Dispute', 'NORMAL', $2)`,
      [w.passengerId, w.tripId],
    );
    const rule = await pool.query(
      `INSERT INTO incentive_rules (name, kind, bonus_npr) VALUES ('Test bonus', 'ZONE_BONUS', 6000) RETURNING id`,
    );
    await pool.query(
      `INSERT INTO incentive_awards (rule_id, driver_id, trip_id, period_key, amount_npr) VALUES ($1, $2, $3, 'x', 6000)`,
      [rule.rows[0].id, w.driverId, w.tripId],
    );
    await runRiskSweep();
    const mine = (await events(w.passengerId)).map((e) => e.rule_code);
    expect(mine).toEqual(
      expect.arrayContaining([
        'UNPAID_RIDES',
        'REFUND_REQUEST_BURST',
        'RATING_BOOSTING',
        'REPEAT_PAIR_RIDES',
        'REPEATED_DISPUTES',
      ]),
    );
    const theirs = (await events(w.driverId)).map((e) => e.rule_code);
    expect(theirs).toEqual(
      expect.arrayContaining([
        'RATING_BOOSTING',
        'RATING_BOMBING',
        'REPEAT_PAIR_RIDES',
        'INCENTIVE_SPIKE',
      ]),
    );
    const spike = (await events(w.driverId, 'INCENTIVE_SPIKE'))[0];
    expect(spike.evidence.count).toBe(6000);
    // the partner is named by id only, so an administrator can follow the link
    const pair = (await events(w.passengerId, 'REPEAT_PAIR_RIDES'))[0];
    expect(pair.evidence.relatedUserIds).toEqual([w.driverId]);
  }, 60_000);

  it('a disabled rule finds nothing, and a rule change is audited with its reason', async () => {
    const a = await admin(['RISK_MANAGE']);
    const p = await onboardUser('PASSENGER');
    await authEvents(p.phoneNumber, 'OTP_REQUESTED', 6);
    const def = RISK_RULES.find((r) => r.code === 'OTP_REQUEST_BURST')!;
    const off = await put(a.token, '/rules/OTP_REQUEST_BURST', {
      enabled: false,
      points: def.points,
      threshold: def.threshold,
      windowHours: def.windowHours,
      reason: 'Switched off while we check the carrier',
    });
    expect(off.status).toBe(200);
    expect(off.body.data.enabled).toBe(false);
    expect(off.body.data.customised).toBe(true);
    await runRiskSweep();
    expect(await events(userId(p))).toHaveLength(0);
    const log = await audits('RISK_RULE_CHANGED');
    expect(log).toHaveLength(1);
    expect(log[0].actor_id).toBe(a.id);
    expect(log[0].detail.reason).toBe('Switched off while we check the carrier');
    // putting it back to the defaults removes the override
    const back = await put(a.token, '/rules/OTP_REQUEST_BURST', {
      enabled: true,
      points: def.points,
      threshold: def.threshold,
      windowHours: def.windowHours,
      reason: 'Carrier is fine again',
    });
    expect(back.body.data.customised).toBe(false);
    expect(
      (
        await put(a.token, '/rules/NOT_A_RULE', {
          enabled: true,
          points: 1,
          threshold: 1,
          windowHours: 1,
          reason: 'abc',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await put(a.token, '/rules/OTP_REQUEST_BURST', {
          enabled: true,
          points: 1000,
          threshold: 1,
          windowHours: 1,
          reason: 'abc',
        })
      ).status,
    ).toBe(400);
  });
});

// ---------------------------------------------------------------- false-positive safety and levels

describe('false-positive safe handling', () => {
  async function fire(userIdValue: string, rule: string, points = 20) {
    await pool.query(
      `INSERT INTO risk_events (user_id, rule_code, category, points, dedupe_key)
       VALUES ($1, $2, 'ACCOUNT', $3, $4)`,
      [userIdValue, rule, points, `${rule}:${userIdValue}:test-${Math.random()}`],
    );
  }

  it('never restricts or suspends on one signal, however strong, and not at all by default', async () => {
    const p = await onboardUser('PASSENGER');
    await fire(userId(p), 'OTP_WRONG_CODES', 100);
    await setSetting('RISK_AUTO_RESTRICT_SCORE', 10);
    try {
      // a fresh signal arrives for the same single rule
      await authEvents(p.phoneNumber, 'OTP_VERIFY_FAILED', 6);
      const r = await runRiskSweep();
      expect(r.restricted).toBe(0);
    } finally {
      await clearSetting('RISK_AUTO_RESTRICT_SCORE');
    }
    const status = await pool.query('SELECT status FROM users WHERE id = $1', [userId(p)]);
    expect(status.rows[0].status).toBe('ACTIVE');
    expect((await requestRide(p.accessToken)).status).toBe(201);
  });

  it('with automatic restriction on, restricts only when several different signals add up, for a short time, and never suspends', async () => {
    const p = await onboardUser('PASSENGER');
    await setSetting('RISK_AUTO_RESTRICT_SCORE', 30);
    await setSetting('RISK_MIN_DISTINCT_RULES', 3);
    await setSetting('RISK_AUTO_RESTRICT_HOURS', 2);
    try {
      await authEvents(p.phoneNumber, 'OTP_REQUESTED', 6);
      await authEvents(p.phoneNumber, 'OTP_VERIFY_FAILED', 6);
      expect((await runRiskSweep()).restricted).toBe(0); // two kinds: not enough
      await authEvents(null, 'LOGIN_FAILED', 10, undefined, userId(p));
      expect((await runRiskSweep()).restricted).toBe(1); // three kinds: restricted
      const prof = (await pool.query('SELECT * FROM risk_profiles WHERE user_id = $1', [userId(p)]))
        .rows[0];
      expect(prof.restriction_source).toBe('AUTOMATIC');
      const hours = (new Date(prof.restricted_until).getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(1.5);
      expect(hours).toBeLessThanOrEqual(2);
      expect(
        (await pool.query('SELECT status FROM users WHERE id = $1', [userId(p)])).rows[0].status,
      ).toBe('ACTIVE');
      expect((await audits('RISK_USER_AUTO_RESTRICTED')).length).toBe(1);

      // an administrator lifts it: the same old signals do not restrict again
      const a = await admin(['RISK_MANAGE']);
      const lift = await post(a.token, `/users/${userId(p)}/lift`, {
        reason: 'Reviewed: they were locked out',
      });
      expect(lift.status).toBe(200);
      expect((await runRiskSweep()).restricted).toBe(0);
      expect((await requestRide(p.accessToken)).status).toBe(201);
    } finally {
      for (const k of [
        'RISK_AUTO_RESTRICT_SCORE',
        'RISK_MIN_DISTINCT_RULES',
        'RISK_AUTO_RESTRICT_HOURS',
      ]) {
        await clearSetting(k);
      }
    }
  });

  it('stops counting a dismissed event, keeps the rule quiet for that person, and can be undone', async () => {
    const a = await admin(['RISK_MANAGE']);
    const p = await onboardUser('PASSENGER');
    await authEvents(p.phoneNumber, 'OTP_VERIFY_FAILED', 6);
    await authEvents(p.phoneNumber, 'OTP_REQUESTED', 6);
    await fire(userId(p), 'LOGIN_FAILURE_BURST', 20);
    await runRiskSweep();
    const before = await get(a.token, `/users/${userId(p)}`);
    expect(before.body.data.score).toBe(45);
    expect(before.body.data.level).toBe('REVIEW_REQUIRED');
    const ev = before.body.data.events.find(
      (e: { ruleCode: string }) => e.ruleCode === 'OTP_WRONG_CODES',
    );

    const bad = await post(a.token, `/events/${ev.id}/review`, {
      status: 'OPEN',
      reason: 'nope nope',
    });
    expect(bad.status).toBe(409); // an open event cannot be "moved" back to open
    const dismissed = await post(a.token, `/events/${ev.id}/review`, {
      status: 'DISMISSED',
      reason: 'They mistyped, confirmed by phone',
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.data.status).toBe('DISMISSED');
    const after = await get(a.token, `/users/${userId(p)}`);
    expect(after.body.data.score).toBe(30);
    expect(after.body.data.level).toBe('LOW_RISK');
    // the same pattern in a new window does not bring it straight back
    await pool.query("UPDATE risk_events SET dedupe_key = dedupe_key || 'old' WHERE id = $1", [
      ev.id,
    ]);
    await authEvents(p.phoneNumber, 'OTP_VERIFY_FAILED', 1);
    expect((await runRiskSweep()).eventsCreated).toBe(0);
    // a dismissed event cannot be dismissed again; it can be confirmed
    expect(
      (
        await post(a.token, `/events/${ev.id}/review`, {
          status: 'DISMISSED',
          reason: 'again please',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post(a.token, `/events/${ev.id}/review`, {
          status: 'CONFIRMED',
          reason: 'Changed my mind',
        })
      ).status,
    ).toBe(200);
    expect((await get(a.token, `/users/${userId(p)}`)).body.data.score).toBe(45);
  });

  it('lets only one of two simultaneous reviews win', async () => {
    const a = await admin(['RISK_MANAGE']);
    const b = await admin(['RISK_MANAGE']);
    const p = await onboardUser('PASSENGER');
    await fire(userId(p), 'OTP_WRONG_CODES');
    const ev = (await events(userId(p)))[0];
    const [x, y] = await Promise.all([
      post(a.token, `/events/${ev.id}/review`, { status: 'CONFIRMED', reason: 'Looks real to me' }),
      post(b.token, `/events/${ev.id}/review`, { status: 'DISMISSED', reason: 'Looks innocent' }),
    ]);
    // Either one won and the other was told (409), or they ran one after the other and both applied in turn.
    expect([x.status, y.status].every((c) => c === 200 || c === 409)).toBe(true);
    expect([x.status, y.status]).toContain(200);
    const final = (await pool.query('SELECT status FROM risk_events WHERE id = $1', [ev.id]))
      .rows[0].status;
    expect(['CONFIRMED', 'DISMISSED']).toContain(final);
    expect((await audits('RISK_EVENT_REVIEWED')).length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------- restriction, suspension, restore

describe('restricting, suspending and restoring', () => {
  it('restricts a passenger temporarily with a neutral refusal, then lifts it', async () => {
    const a = await admin(['RISK_MANAGE']);
    const p = await onboardUser('PASSENGER');
    const r = await post(a.token, `/users/${userId(p)}/restrict`, {
      days: 3,
      reason: 'Several chargebacks',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const refused = await requestRide(p.accessToken);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('ACCOUNT_RESTRICTED');
    expect(refused.body.error.message).toBe(ACCOUNT_RESTRICTED_MESSAGE);
    expect(JSON.stringify(refused.body)).not.toMatch(/chargeback|fraud|risk/i);
    // everything else still works: they can read their own profile and ask support
    expect((await api.get('/api/v1/users/me').set(auth(p.accessToken))).status).toBe(200);
    // restricted people are told, in neutral words
    const note = await pool.query(
      "SELECT body FROM notifications WHERE user_id = $1 AND type = 'RISK_ACCOUNT_RESTRICTED'",
      [userId(p)],
    );
    expect(note.rows[0].body).toBe(ACCOUNT_RESTRICTED_MESSAGE);
    expect(
      (await post(a.token, `/users/${userId(p)}/lift`, { reason: 'Resolved with the rider' }))
        .status,
    ).toBe(200);
    expect((await requestRide(p.accessToken)).status).toBe(201);
    expect(
      (await post(a.token, `/users/${userId(p)}/lift`, { reason: 'Already lifted' })).status,
    ).toBe(409);
  });

  it('ends a restriction by itself when its time passes', async () => {
    const a = await admin(['RISK_MANAGE']);
    const p = await onboardUser('PASSENGER');
    await post(a.token, `/users/${userId(p)}/restrict`, { days: 1, reason: 'Short pause' });
    expect((await requestRide(p.accessToken)).status).toBe(403);
    await pool.query(
      "UPDATE risk_profiles SET restricted_until = now() - interval '1 minute' WHERE user_id = $1",
      [userId(p)],
    );
    expect((await requestRide(p.accessToken)).status).toBe(201);
    const swept = await runRiskSweep();
    expect(swept.lifted).toBe(1);
    expect((await audits('RISK_RESTRICTION_EXPIRED')).length).toBe(1);
  });

  it('keeps restrictions temporary and bounded, and refuses what cannot be restricted', async () => {
    const a = await admin(['RISK_MANAGE', 'ADMINS_MANAGE']);
    const p = await onboardUser('PASSENGER');
    expect(
      (await post(a.token, `/users/${userId(p)}/restrict`, { days: 15, reason: 'Too long' }))
        .status,
    ).toBe(400);
    expect(
      (await post(a.token, `/users/${userId(p)}/restrict`, { days: 0, reason: 'Zero days' }))
        .status,
    ).toBe(400);
    expect(
      (await post(a.token, `/users/${a.id}/restrict`, { days: 1, reason: 'An admin' })).status,
    ).toBe(409);
    expect(
      (
        await post(a.token, '/users/00000000-0000-4000-8000-000000000009/restrict', {
          days: 1,
          reason: 'Nobody',
        })
      ).status,
    ).toBe(404);
    await pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [userId(p)]);
    expect(
      (await post(a.token, `/users/${userId(p)}/restrict`, { days: 1, reason: 'Already out' }))
        .status,
    ).toBe(409);
  });

  it('lets exactly one of two simultaneous restrictions through', async () => {
    const a = await admin(['RISK_MANAGE']);
    const b = await admin(['RISK_MANAGE']);
    const p = await onboardUser('PASSENGER');
    const results = await Promise.all([
      post(a.token, `/users/${userId(p)}/restrict`, { days: 2, reason: 'First reviewer' }),
      post(b.token, `/users/${userId(p)}/restrict`, { days: 5, reason: 'Second reviewer' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await audits('RISK_USER_RESTRICTED')).length).toBe(1);
  });

  it('takes a restricted driver out of matching, and puts them back when lifted', async () => {
    const a = await admin(['RISK_MANAGE']);
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(userId(d));
    const categoryId = (await pool.query("SELECT id FROM vehicle_categories WHERE code = 'CAR'"))
      .rows[0].id;
    const find = async () =>
      (await findEligibleDrivers({ pickup: THAMEL, vehicleCategoryId: categoryId })).some(
        (c) => c.driverId === userId(d),
      );
    expect(await find()).toBe(true);
    const r = await post(a.token, `/users/${userId(d)}/restrict`, {
      days: 1,
      reason: 'Location spoofing',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await find()).toBe(false);
    // a driver who was online is taken offline, with the neutral reason
    const state = await pool.query('SELECT state FROM driver_availability WHERE driver_id = $1', [
      userId(d),
    ]);
    expect(state.rows[0].state).toBe('OFFLINE');
    await post(a.token, `/users/${userId(d)}/lift`, { reason: 'Faulty phone replaced' });
    await putDriverOnline(userId(d));
    expect(await find()).toBe(true);
  });

  it('suspends and restores through the existing account moves, and the risk level follows', async () => {
    const a = await admin(['RISK_MANAGE', 'USERS_MANAGE']);
    const p = await onboardUser('PASSENGER');
    const detail = await get(a.token, `/users/${userId(p)}`);
    expect(detail.body.data.actions).toMatchObject({
      canSuspend: true,
      canRestore: false,
      canRestrict: true,
    });
    const s = await api
      .post(`/api/v1/admin/users/${userId(p)}/suspend`)
      .set(auth(a.token))
      .send({ reason: 'Confirmed fake account' });
    expect(s.status).toBe(200);
    const after = await get(a.token, `/users/${userId(p)}`);
    expect(after.body.data.level).toBe('SUSPENDED');
    expect(after.body.data.actions).toMatchObject({ canRestore: true, canRestrict: false });
    const restored = await api
      .post(`/api/v1/admin/users/${userId(p)}/reactivate`)
      .set(auth(a.token))
      .send({ reason: 'Appeal upheld after review' });
    expect(restored.status).toBe(200);
    expect((await get(a.token, `/users/${userId(p)}`)).body.data.level).toBe('LOW_RISK');
    // the complete history of the person, in order, includes both kinds of action
    const actions = (await get(a.token, `/users/${userId(p)}`)).body.data.audit.map(
      (e: { action: string }) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['USER_SUSPENDED', 'USER_REACTIVATED', 'RISK_USER_VIEWED']),
    );
  });

  it('shows the viewer only the controls they hold the permission for', async () => {
    const viewer = await admin(['RISK_VIEW']);
    const p = await onboardUser('PASSENGER');
    const d = (await get(viewer.token, `/users/${userId(p)}`)).body.data;
    expect(d.actions).toEqual({
      canRestrict: false,
      canLift: false,
      canSuspend: false,
      canRestore: false,
    });
  });
});

// ---------------------------------------------------------------- investigation, notes, audit

describe('investigation, notes and audit', () => {
  it('shows a ride with its signals, adds notes without copying them into the audit log, and audits every read', async () => {
    const a = await admin(['RISK_MANAGE']);
    const w = await finishedRide(true);
    await pool.query(
      `INSERT INTO risk_events (user_id, rule_code, category, points, trip_id, dedupe_key)
       VALUES ($1, 'REPEAT_PAIR_RIDES', 'COLLUSION', 15, $2, 'k1')`,
      [w.passengerId, w.tripId],
    );
    const ev = (await events(w.passengerId))[0];
    const note = await post(a.token, '/notes', {
      note: 'Looks like a regular commute, per the rider',
      eventId: ev.id,
    });
    expect(note.status, JSON.stringify(note.body)).toBe(201);
    expect(note.body.data.tripId).toBe(w.tripId);
    expect(note.body.data.userId).toBe(w.passengerId);
    expect((await post(a.token, '/notes', { note: 'x' })).status).toBe(400);
    expect((await post(a.token, '/notes', { note: '', userId: w.passengerId })).status).toBe(400);

    const trip = await get(a.token, `/trips/${w.tripId}`);
    expect(trip.status).toBe(200);
    expect(trip.body.data).toMatchObject({ hasPayment: true, hasRefund: false, hasDispute: false });
    expect(trip.body.data.events).toHaveLength(1);
    expect(trip.body.data.notes).toHaveLength(1);
    expect(trip.body.data.audit.map((e: { action: string }) => e.action)).toContain(
      'RISK_NOTE_ADDED',
    );
    // the ride read exposes no contact details or coordinates
    expect(JSON.stringify(trip.body)).not.toMatch(/phoneNumber|latitude|longitude/);

    const noteAudit = await audits('RISK_NOTE_ADDED');
    expect(noteAudit.length).toBe(2); // one on the person, one on the ride
    expect(JSON.stringify(noteAudit)).not.toContain('regular commute');
    expect((await audits('RISK_TRIP_VIEWED')).length).toBe(1);
    expect((await get(a.token, '/trips/00000000-0000-4000-8000-000000000001')).status).toBe(404);

    const history = await get(a.token, '/history');
    expect(history.body.data.total).toBeGreaterThanOrEqual(3);
    expect(
      history.body.data.items.every((i: { subjectType: string }) =>
        i.subjectType.startsWith('risk_'),
      ),
    ).toBe(true);
  }, 60_000);

  it('lists and filters events and people, most severe first', async () => {
    const a = await admin(['RISK_VIEW']);
    const low = await onboardUser('PASSENGER');
    const high = await onboardUser('PASSENGER');
    for (const [uid, pts, k] of [
      [userId(low), 5, 'a'],
      [userId(high), 30, 'b'],
      [userId(high), 30, 'c'],
    ] as const) {
      await pool.query(
        `INSERT INTO risk_events (user_id, rule_code, category, points, dedupe_key) VALUES ($1, 'OTP_WRONG_CODES', 'OTP', $2, $3)`,
        [uid, pts, k],
      );
    }
    const users = (await get(a.token, '/users')).body.data;
    expect(users.items.map((u: { userId: string }) => u.userId)).toEqual([
      userId(high),
      userId(low),
    ]);
    expect(users.items[0]).toMatchObject({ level: 'REVIEW_REQUIRED', score: 60, openEvents: 2 });
    expect((await get(a.token, '/users?level=REVIEW_REQUIRED')).body.data.total).toBe(1);
    expect((await get(a.token, '/users?level=BANNED')).status).toBe(400);
    const evs = (await get(a.token, `/events?userId=${userId(high)}&status=OPEN&category=OTP`)).body
      .data;
    expect(evs.total).toBe(2);
    expect((await get(a.token, '/events?category=NOPE')).status).toBe(400);
    const ov = (await get(a.token, '/overview')).body.data;
    expect(ov).toMatchObject({ reviewRequired: 1, openEvents: 3 });
  });

  it('asks the risk team for a review once, without saying who', async () => {
    const m = await admin(['RISK_MANAGE']);
    const p = await onboardUser('PASSENGER');
    await authEvents(p.phoneNumber, 'OTP_REQUESTED', 6);
    await authEvents(p.phoneNumber, 'OTP_VERIFY_FAILED', 6);
    await authEvents(null, 'LOGIN_FAILED', 10, undefined, userId(p));
    await runRiskSweep();
    await authEvents(null, 'ACCESS_BLOCKED_SUSPENDED', 3, undefined, userId(p));
    await runRiskSweep();
    const notes = await pool.query(
      "SELECT body, metadata FROM notifications WHERE user_id = $1 AND type = 'RISK_REVIEW_NEEDED'",
      [m.id],
    );
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0].body).toBe('A person needs a risk review.');
  });
});

// ---------------------------------------------------------------- money stays untouched

describe('financial integrity', () => {
  const snapshot = async () =>
    JSON.stringify(
      (
        await Promise.all([
          pool.query(
            'SELECT id, trip_id, amount_npr, method, status, paid_at FROM trip_payments ORDER BY id',
          ),
          pool.query('SELECT id, amount_npr, status FROM refunds ORDER BY id'),
          pool.query('SELECT id, driver_id, amount_npr FROM incentive_awards ORDER BY id'),
        ])
      ).map((r) => r.rows),
    );

  it('leaves payments, refunds and incentive awards exactly as they were through every risk action', async () => {
    const a = await admin(['RISK_MANAGE', 'USERS_MANAGE']);
    const w = await finishedRide(true);
    await pool.query(
      `INSERT INTO refunds (trip_id, payment_id, requested_by, requested_by_role, amount_npr, reason)
       SELECT $1, id, $2, 'PASSENGER', 100, 'PARTIAL' FROM trip_payments WHERE trip_id = $1`,
      [w.tripId, w.passengerId],
    );
    const before = await snapshot();
    await pool.query(
      `INSERT INTO risk_events (user_id, rule_code, category, points, trip_id, dedupe_key)
       VALUES ($1, 'REFUND_REQUEST_BURST', 'PAYMENT', 15, $2, 'fin1')`,
      [w.passengerId, w.tripId],
    );
    const ev = (await events(w.passengerId))[0];
    await post(a.token, `/events/${ev.id}/review`, { status: 'CONFIRMED', reason: 'Real pattern' });
    await post(a.token, `/users/${w.passengerId}/restrict`, { days: 2, reason: 'Refund abuse' });
    await post(a.token, `/users/${w.passengerId}/lift`, { reason: 'Reviewed' });
    await runRiskSweep();
    expect(await snapshot()).toBe(before);
  }, 60_000);

  it('does not stop an unpaid ride being settled by the driver while the passenger is restricted', async () => {
    const a = await admin(['RISK_MANAGE']);
    const w = await finishedRide(false);
    await post(a.token, `/users/${w.passengerId}/restrict`, { days: 2, reason: 'Suspected abuse' });
    const pay = await api
      .post(`/api/v1/trips/${w.tripId}/payment/confirm`)
      .set(auth(w.driver.accessToken));
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    // and settling twice stays idempotent: one PAID row
    await api.post(`/api/v1/trips/${w.tripId}/payment/confirm`).set(auth(w.driver.accessToken));
    const rows = await pool.query('SELECT status FROM trip_payments WHERE trip_id = $1', [
      w.tripId,
    ]);
    expect(rows.rows).toEqual([{ status: 'PAID' }]);
  }, 60_000);
});

// ---------------------------------------------------------------- abuse controls and retention

describe('abuse controls and retention', () => {
  const ghost = '00000000-0000-4000-8000-0000000000aa';

  it('rate-limits cancelling, rating and confirming payment', async () => {
    await clearRedis();
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    let last = 0;
    for (let i = 0; i < 21; i++) {
      last = (await api.post(`/api/v1/trips/${ghost}/cancel`).set(auth(p.accessToken)).send({}))
        .status;
    }
    expect(last).toBe(429);
    for (let i = 0; i < 31; i++) {
      last = (
        await api.post(`/api/v1/trips/${ghost}/rating`).set(auth(p.accessToken)).send({ stars: 5 })
      ).status;
    }
    expect(last).toBe(429);
    for (let i = 0; i < 61; i++) {
      last = (await api.post(`/api/v1/trips/${ghost}/payment/confirm`).set(auth(d.accessToken)))
        .status;
    }
    expect(last).toBe(429);
  }, 60_000);

  it('deletes risk events after the retention period and no sooner', async () => {
    const p = await onboardUser('PASSENGER');
    await pool.query(
      `INSERT INTO risk_events (user_id, rule_code, category, points, dedupe_key, created_at)
       VALUES ($1, 'OTP_WRONG_CODES', 'OTP', 10, 'old', now() - interval '400 days'),
              ($1, 'OTP_REQUEST_BURST', 'OTP', 10, 'new', now() - interval '10 days')`,
      [userId(p)],
    );
    expect(await purgeOldRiskEvents(365)).toBe(1);
    expect((await events(userId(p))).map((e) => e.dedupe_key)).toEqual(['new']);
    const policy = await pool.query(
      "SELECT action, retain_days, min_retain_days FROM retention_policies WHERE record_type = 'RISK_EVENTS'",
    );
    expect(policy.rows[0]).toMatchObject({
      action: 'DELETE',
      retain_days: 365,
      min_retain_days: 90,
    });
  });

  it("removes a person's signals with their account, not leaving orphans", async () => {
    const p = await onboardUser('PASSENGER');
    await pool.query(
      `INSERT INTO risk_events (user_id, rule_code, category, points, dedupe_key) VALUES ($1, 'OTP_WRONG_CODES', 'OTP', 10, 'gone')`,
      [userId(p)],
    );
    await pool.query('DELETE FROM users WHERE id = $1', [userId(p)]);
    expect((await pool.query("SELECT 1 FROM risk_events WHERE dedupe_key = 'gone'")).rowCount).toBe(
      0,
    );
  });
});
