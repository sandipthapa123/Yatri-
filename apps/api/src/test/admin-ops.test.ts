import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  ADMIN_PERMISSIONS,
  ADMIN_PERMISSION_LABELS,
  PERMISSION_IMPLIES,
  PLATFORM_SETTINGS,
  SETTING_KEYS,
  checkSettingValue,
  holdsPermission,
  settingDef,
  type AdminPermission,
} from '@yatri/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pool } from '../config/database';
import { adminRouter } from '../modules/admin/admin.routes';
import { pricingConfig } from '../modules/pricing/pricing.config';
import { getSetting, refreshSettings, settingDefault } from '../modules/settings/settings.service';
import {
  BASELINE_ADMIN_PERMISSIONS,
  api,
  createVerifiedDriver,
  loginTestAdmin,
  onboardUser,
} from './helpers';
import { arriveAtPickup, auth, backdate, forceDriverOnline, requestRide, rideWorld } from './rides';

// Several tests here create many administrators and make hundreds of requests (the RBAC matrix).
vi.setConfig({ testTimeout: 60_000 });

const ZERO_UUID = '00000000-0000-4000-8000-000000000000';
const PASSWORD = 'a-strong-test-password-1';
let seq = 0;

async function admin(permissions: AdminPermission[] = []) {
  const email = `ops-${Date.now()}-${++seq}@example.com`;
  const token = await loginTestAdmin(email, PASSWORD, permissions);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0]
    .id as string;
  return { token, id, email };
}
const get = (token: string, path: string) => api.get(`/api/v1/admin${path}`).set(auth(token));
const send = (method: 'post' | 'put' | 'patch', token: string, path: string, body: object = {}) =>
  api[method](`/api/v1/admin${path}`).set(auth(token)).send(body);
const audit = async (action: string, subjectId?: string) =>
  (
    await pool.query(
      `SELECT actor_id, actor_role, subject_id, detail FROM audit_log
       WHERE action = $1 AND ($2::uuid IS NULL OR subject_id = $2) ORDER BY id`,
      [action, subjectId ?? null],
    )
  ).rows as Array<{
    actor_id: string | null;
    actor_role: string;
    subject_id: string | null;
    detail: Record<string, unknown>;
  }>;

afterEach(async () => {
  // Nothing in these tests may leave a setting changed for the next test file.
  await pool.query('DELETE FROM platform_settings');
  await refreshSettings();
});

// ============================================================ RBAC

/** Every route the admin router registers (method, path), found from the router itself. */
function registeredRoutes(): Array<{ method: 'get' | 'post' | 'put' | 'patch'; path: string }> {
  type Layer = {
    route?: { path: string; methods: Record<string, boolean> };
    handle?: { stack?: Layer[] };
  };
  const out: Array<{ method: 'get' | 'post' | 'put' | 'patch'; path: string }> = [];
  const walk = (stack: Layer[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          if (m === 'get' || m === 'post' || m === 'put' || m === 'patch') {
            out.push({
              method: m,
              path: `${prefix}${layer.route.path === '/' ? '' : layer.route.path}`,
            });
          }
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, '/admins'); // the only nested router
      }
    }
  };
  walk((adminRouter as unknown as { stack: Layer[] }).stack, '');
  return out;
}
const concrete = (path: string) => path.replace(':id', ZERO_UUID).replace(':key', 'FARE_BASE_NPR');

describe('RBAC: every admin route names a permission', () => {
  it('finds the routes it is checking (so a new route cannot slip past unnoticed)', () => {
    expect(registeredRoutes().length).toBeGreaterThanOrEqual(45);
  });

  it('refuses every route except /me to an administrator holding no permission', async () => {
    const none = await admin([]);
    const failures: string[] = [];
    for (const r of registeredRoutes()) {
      const res = await api[r.method](`/api/v1/admin${concrete(r.path)}`)
        .set(auth(none.token))
        .send(r.method === 'get' ? undefined : {});
      const expected = r.path === '/me' ? 200 : 403;
      if (res.status !== expected)
        failures.push(`${r.method.toUpperCase()} ${r.path} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('refuses everyone who is not an administrator, and everyone not signed in', async () => {
    const passenger = await onboardUser('PASSENGER');
    for (const r of registeredRoutes().filter((x) => x.method === 'get')) {
      const p = concrete(r.path);
      expect((await api.get(`/api/v1/admin${p}`)).status, `${p} unauthenticated`).toBe(401);
      expect((await get(passenger.accessToken, p)).status, `${p} as passenger`).toBe(403);
    }
  });

  const READS: Array<[AdminPermission, string]> = [
    ['OPERATIONS_VIEW', '/dashboard'],
    ['OPERATIONS_VIEW', '/trips'],
    ['OPERATIONS_VIEW', '/availability/drivers'],
    ['ANALYTICS_VIEW', '/analytics'],
    ['USERS_VIEW', '/users'],
    ['DRIVERS_REVIEW', '/drivers'],
    ['DRIVERS_REVIEW', '/vehicles'],
    ['FINANCE_VIEW', '/payments'],
    ['FINANCE_VIEW', '/finance/summary'],
    ['FINANCE_VIEW', '/finance/earnings'],
    ['NOTIFICATIONS_VIEW', '/notifications'],
    ['NOTIFICATIONS_VIEW', '/notifications/summary'],
    ['SETTINGS_VIEW', '/settings'],
    ['SETTINGS_VIEW', '/vehicle-categories'],
    ['AUDIT_VIEW', '/audit'],
    ['ADMINS_MANAGE', '/admins'],
    ['OPERATIONS_VIEW', '/operations/heatmap'],
    ['OPERATIONS_VIEW', '/operations/options'],
    ['OPERATIONS_VIEW', '/operations/zones'],
    ['OPERATIONS_VIEW', '/operations/pricing-rules'],
    ['OPERATIONS_VIEW', '/operations/incentive-rules'],
    ['OPERATIONS_VIEW', '/operations/incentive-awards'],
    ['DISPUTES_MANAGE', '/support/tickets'],
    ['DISPUTES_MANAGE', '/support/assignees'],
    ['SETTINGS_VIEW', '/support/config'],
    ['COMPLIANCE_MANAGE', '/compliance/policies'],
    ['COMPLIANCE_MANAGE', '/compliance/data-requests'],
    ['COMPLIANCE_MANAGE', '/compliance/retention'],
    ['SAFETY_REVIEW', '/sos'],
    ['SAFETY_REVIEW', '/incidents'],
  ];
  it('opens each read to exactly the permission it names, and to no other', async () => {
    const holders = new Map<AdminPermission, string>();
    for (const p of ADMIN_PERMISSIONS) holders.set(p, (await admin([p])).token);
    const bad: string[] = [];
    for (const [needed, path] of READS) {
      for (const [held, token] of holders) {
        const res = await get(token, path);
        const allowed = holdsPermission([held], needed);
        if (allowed && res.status !== 200)
          bad.push(`${held} should open ${path}, got ${res.status}`);
        if (!allowed && res.status !== 403)
          bad.push(`${held} must not open ${path}, got ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  }, 120_000); // one administrator per permission and several hundred requests

  it('says what an administrator may do, and a removed permission stops working at once', async () => {
    const a = await admin(['USERS_VIEW']);
    expect((await get(a.token, '/me')).body.data.permissions).toEqual(['USERS_VIEW']);
    expect((await get(a.token, '/users')).status).toBe(200);
    await pool.query("UPDATE users SET admin_permissions = '{}' WHERE id = $1", [a.id]);
    expect((await get(a.token, '/users')).status).toBe(403); // same token, no re-login
    await pool.query("UPDATE users SET admin_permissions = ARRAY['nonsense'] WHERE id = $1", [
      a.id,
    ]);
    expect((await get(a.token, '/me')).body.data.permissions).toEqual([]); // unknown names grant nothing
  });

  it('has one definition of permissions, implication and labels', () => {
    for (const p of ADMIN_PERMISSIONS)
      expect(ADMIN_PERMISSION_LABELS[p].label.length).toBeGreaterThan(2);
    for (const [holder, implied] of Object.entries(PERMISSION_IMPLIES)) {
      expect(ADMIN_PERMISSIONS).toContain(holder);
      for (const i of implied ?? []) expect(ADMIN_PERMISSIONS).toContain(i);
    }
    expect(holdsPermission(['USERS_MANAGE'], 'USERS_VIEW')).toBe(true);
    expect(holdsPermission(['USERS_VIEW'], 'USERS_MANAGE')).toBe(false);
  });
});

describe('RBAC: managing administrators', () => {
  it('lets a manager grant only what they hold, never edit themselves, and audits the change', async () => {
    const manager = await admin(['ADMINS_MANAGE', 'USERS_VIEW']);
    const target = await admin([]);
    const set = (token: string, id: string, permissions: string[], reason = 'because') =>
      send('put', token, `/admins/${id}/permissions`, { permissions, reason });

    expect((await set(manager.token, manager.id, ['FINANCE_VIEW'])).body.error.code).toBe(
      'CANNOT_CHANGE_SELF',
    );
    const over = await set(manager.token, target.id, ['USERS_VIEW', 'FINANCE_VIEW']);
    expect(over.status).toBe(403);
    expect(over.body.error.code).toBe('CANNOT_GRANT');
    expect(over.body.error.details.permissions).toEqual(['FINANCE_VIEW']);
    expect((await set(manager.token, target.id, ['USERS_VIEW'], 'x')).status).toBe(400); // reason too short
    expect((await set(manager.token, target.id, ['MADE_UP'])).status).toBe(400);

    const ok = await set(manager.token, target.id, ['USERS_VIEW'], 'Support lead');
    expect(ok.status).toBe(200);
    expect(ok.body.data.permissions).toEqual(['USERS_VIEW']);
    expect((await get(target.token, '/users')).status).toBe(200);
    const [entry] = await audit('ADMIN_PERMISSIONS_CHANGED', target.id);
    expect(entry).toMatchObject({ actor_id: manager.id, actor_role: 'ADMIN' });
    expect(entry?.detail).toEqual({ granted: ['USERS_VIEW'], removed: [], reason: 'Support lead' });

    // taking away is not limited to what the manager holds
    const removed = await set(manager.token, target.id, [], 'Left the team');
    expect(removed.status).toBe(200);
    expect((await get(target.token, '/users')).status).toBe(403);
    expect((await set(manager.token, ZERO_UUID, [])).status).toBe(404);

    const lister = (await get(manager.token, '/admins')).body.data as Array<{
      id: string;
      isYou: boolean;
    }>;
    expect(lister.find((a) => a.id === manager.id)?.isYou).toBe(true);
    expect(lister.find((a) => a.id === target.id)?.isYou).toBe(false);
  });

  it('applies two managers editing one administrator one after the other', async () => {
    const m1 = await admin(['ADMINS_MANAGE', 'USERS_VIEW', 'FINANCE_VIEW']);
    const m2 = await admin(['ADMINS_MANAGE', 'USERS_VIEW', 'FINANCE_VIEW']);
    const target = await admin([]);
    const results = await Promise.all([
      send('put', m1.token, `/admins/${target.id}/permissions`, {
        permissions: ['USERS_VIEW'],
        reason: 'one',
      }),
      send('put', m2.token, `/admins/${target.id}/permissions`, {
        permissions: ['FINANCE_VIEW'],
        reason: 'two',
      }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const final = (
      await pool.query('SELECT admin_permissions AS p FROM users WHERE id = $1', [target.id])
    ).rows[0].p;
    expect(final.length).toBe(1); // one whole set won; they were not merged into a mixture
    expect((await audit('ADMIN_PERMISSIONS_CHANGED', target.id)).length).toBe(2);
  });
});

// ============================================================ users

describe('user management', () => {
  it('searches, filters, sorts and paginates on the server, and audits the read', async () => {
    const a = await admin(['USERS_VIEW']);
    const tag = `Zed${Date.now()}`;
    const p1 = await onboardUser('PASSENGER');
    const p2 = await onboardUser('PASSENGER');
    const d1 = await onboardUser('DRIVER');
    await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [p1.user.id, `${tag} Anna`]);
    await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [p2.user.id, `${tag} Bina`]);
    await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      d1.user.id,
      `${tag} Chandra`,
    ]);

    const q = async (qs: string) => (await get(a.token, `/users?${qs}`)).body.data;
    expect((await q(`search=${tag}`)).total).toBe(3);
    expect(
      (await q(`search=${tag}&role=DRIVER`)).items.map((u: { fullName: string }) => u.fullName),
    ).toEqual([`${tag} Chandra`]);
    expect(
      (await q(`search=${tag}&sort=name`)).items.map((u: { fullName: string }) => u.fullName),
    ).toEqual([`${tag} Anna`, `${tag} Bina`, `${tag} Chandra`]);
    const page1 = await q(`search=${tag}&sort=name&pageSize=2&page=1`);
    const page2 = await q(`search=${tag}&sort=name&pageSize=2&page=2`);
    expect(page1.items).toHaveLength(2);
    expect(page2.items.map((u: { fullName: string }) => u.fullName)).toEqual([`${tag} Chandra`]);
    expect(page1.total).toBe(3);
    // phone search, and a wildcard is searched for, not obeyed
    expect((await q(`search=${encodeURIComponent(String(p1.phoneNumber))}`)).total).toBe(1);
    expect((await q('search=%25')).total).toBe(0);
    expect((await q('search=_____________')).total).toBe(0);
    expect((await get(a.token, '/users?role=NOPE')).status).toBe(400);
    expect((await get(a.token, '/users?pageSize=500')).status).toBe(400);
    expect((await audit('VIEW_USER_LIST')).some((e) => e.actor_id === a.id)).toBe(true);
  });

  it('shows a person, records that the admin looked, and hides what the admin may not do', async () => {
    const viewer = await admin(['USERS_VIEW']);
    const target = await onboardUser('PASSENGER');
    const id = target.user.id as string;
    const detail = (await get(viewer.token, `/users/${id}`)).body.data;
    expect(detail).toMatchObject({
      id,
      role: 'PASSENGER',
      canSuspend: false,
      canReactivate: false,
      activeRide: null,
    });
    expect(detail.rating).toEqual({ average: null, count: 0 });
    expect((await audit('VIEW_USER', id)).map((e) => e.actor_id)).toContain(viewer.id);
    expect((await get(viewer.token, `/users/${ZERO_UUID}`)).status).toBe(404);
    const manager = await admin(['USERS_MANAGE']);
    expect((await get(manager.token, `/users/${id}`)).body.data.canSuspend).toBe(true);
  });

  it('suspends and reactivates with a reason, signs the person out, and audits both', async () => {
    const manager = await admin(['USERS_MANAGE']);
    const person = await onboardUser('PASSENGER');
    const id = person.user.id as string;
    const act = (to: 'suspend' | 'reactivate', reason = 'Repeated abuse of drivers') =>
      send('post', manager.token, `/users/${id}/${to}`, { reason });

    expect((await act('suspend', 'no')).status).toBe(400);
    expect((await act('reactivate')).status).toBe(409); // not suspended
    expect((await api.get('/api/v1/users/me').set(auth(person.accessToken))).status).toBe(200);
    expect((await act('suspend')).status).toBe(200);
    const blocked = await api.get('/api/v1/users/me').set(auth(person.accessToken));
    expect(blocked.status).toBe(401); // every session was ended
    expect((await act('suspend')).body.error.code).toBe('INVALID_STATE_TRANSITION'); // already suspended
    expect((await act('reactivate', 'Appeal upheld')).status).toBe(200);
    const [s] = await audit('USER_SUSPENDED', id);
    const [r] = await audit('USER_REACTIVATED', id);
    expect(s).toMatchObject({ actor_id: manager.id, actor_role: 'ADMIN' });
    expect(s?.detail).toEqual({ reason: 'Repeated abuse of drivers', role: 'PASSENGER' });
    expect(r?.detail).toMatchObject({ reason: 'Appeal upheld' });
  });

  it('refuses to suspend yourself, an administrator (without ADMINS_MANAGE), or someone on a ride', async () => {
    const manager = await admin(['USERS_MANAGE']);
    expect(
      (await send('post', manager.token, `/users/${manager.id}/suspend`, { reason: 'oops' })).body
        .error.code,
    ).toBe('CANNOT_CHANGE_SELF');
    const other = await admin([]);
    const blocked = await send('post', manager.token, `/users/${other.id}/suspend`, {
      reason: 'test',
    });
    expect(blocked.status).toBe(403);
    const both = await admin(['USERS_MANAGE', 'ADMINS_MANAGE']);
    expect(
      (await send('post', both.token, `/users/${other.id}/suspend`, { reason: 'test' })).status,
    ).toBe(200);

    const w = await rideWorld();
    const busy = await send('post', manager.token, `/users/${w.driverId}/suspend`, {
      reason: 'test',
    });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('USER_HAS_ACTIVE_RIDE');
    const view = (await get(manager.token, `/users/${w.driverId}`)).body.data;
    expect(view.activeRide).toMatchObject({ tripId: w.tripId, status: 'DRIVER_EN_ROUTE' });
  });

  it('takes a driver off the road when suspended, and lets only one of two simultaneous suspensions win', async () => {
    const m1 = await admin(['USERS_MANAGE']);
    const m2 = await admin(['USERS_MANAGE']);
    const driver = await onboardUser('DRIVER');
    const id = driver.user.id as string;
    await forceDriverOnline(id);
    const results = await Promise.all([
      send('post', m1.token, `/users/${id}/suspend`, { reason: 'first' }),
      send('post', m2.token, `/users/${id}/suspend`, { reason: 'second' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await audit('USER_SUSPENDED', id)).length).toBe(1);
    const state = (
      await pool.query('SELECT state FROM driver_availability WHERE driver_id = $1', [id])
    ).rows[0].state;
    expect(state).toBe('SUSPENDED');
  });
});

// ============================================================ drivers and vehicles

describe('driver and vehicle management', () => {
  it('audits every verification decision against the driver and the admin who made it', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    const [verified] = await audit('DRIVER_VERIFIED', id);
    expect(verified?.actor_role).toBe('ADMIN');
    expect((await audit('DOCUMENT_APPROVED')).length).toBeGreaterThan(0);
    expect((await audit('VEHICLE_APPROVED')).length).toBeGreaterThan(0);

    const reviewer = await admin(['DRIVERS_REVIEW']);
    const suspend = await send('post', reviewer.token, `/drivers/${id}/suspend`, {
      reason: 'Failed a spot check',
    });
    expect(suspend.status).toBe(200);
    const [s] = await audit('DRIVER_SUSPENDED', id);
    expect(s).toMatchObject({ actor_id: reviewer.id });
    expect(s?.detail).toEqual({ reason: 'Failed a spot check' });
    // a failed action is not audited as if it happened
    const again = await send('post', reviewer.token, `/drivers/${id}/suspend`, { reason: 'Again' });
    expect(again.status).toBe(409);
    expect((await audit('DRIVER_SUSPENDED', id)).length).toBe(1);
  });

  it('lists vehicles with filters, search, sorting and paging', async () => {
    const { driver } = await createVerifiedDriver();
    const reviewer = await admin(['DRIVERS_REVIEW']);
    const reg = (
      await pool.query('SELECT registration_number AS r FROM vehicles WHERE driver_user_id = $1', [
        driver.user.id,
      ])
    ).rows[0].r as string;
    const list = (await get(reviewer.token, `/vehicles?search=${encodeURIComponent(reg)}`)).body
      .data;
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      registrationNumber: reg,
      driverId: driver.user.id,
      verificationStatus: 'APPROVED',
    });
    expect(
      (await get(reviewer.token, `/vehicles?search=${encodeURIComponent(reg)}&status=REJECTED`))
        .body.data.total,
    ).toBe(0);
    expect((await get(reviewer.token, '/vehicles?status=NOPE')).status).toBe(400);
    const sorted = (
      await get(reviewer.token, '/vehicles?sort=registration&pageSize=5')
    ).body.data.items.map((v: { registrationNumber: string }) => v.registrationNumber);
    expect(sorted).toEqual([...sorted].sort());
  });
});

// ============================================================ ride monitoring

describe('ride monitoring and the live dashboard', () => {
  it('counts what is happening now, from the records', async () => {
    const ops = await admin(['OPERATIONS_VIEW']);
    const before = (await get(ops.token, '/dashboard')).body.data;
    const w = await rideWorld(); // one active ride, one driver online
    const after = (await get(ops.token, '/dashboard')).body.data;
    expect(after.rides.active - before.rides.active).toBe(1);
    expect(
      after.rides.activeByStatus.DRIVER_EN_ROUTE -
        (before.rides.activeByStatus.DRIVER_EN_ROUTE ?? 0),
    ).toBe(1);
    expect(after.drivers.online - before.drivers.online).toBe(1);
    expect(after.drivers.onTrip - before.drivers.onTrip).toBe(1);
    expect(after.drivers.available).toBe(before.drivers.available); // the online driver is on a ride
    expect(after.drivers.available).toBeLessThanOrEqual(after.drivers.online);

    // independent check straight from the tables
    const live = (
      await pool.query(
        "SELECT count(*)::int AS n FROM trips WHERE status IN ('SEARCHING','DRIVER_EN_ROUTE','DRIVER_ARRIVED','IN_PROGRESS')",
      )
    ).rows[0].n;
    expect(after.rides.active).toBe(live);
    const online = (
      await pool.query("SELECT count(*)::int AS n FROM driver_availability WHERE state = 'ONLINE'")
    ).rows[0].n;
    expect(after.drivers.online).toBe(online);
    expect(w.tripId).toBeTruthy();
  });

  it('counts available and stale drivers, and pending applications, by the same rules as matching', async () => {
    const ops = await admin(['OPERATIONS_VIEW']);
    const before = (await get(ops.token, '/dashboard')).body.data;
    const idle = await onboardUser('DRIVER');
    await forceDriverOnline(idle.user.id as string); // verified, online, fresh, idle
    const mid = (await get(ops.token, '/dashboard')).body.data;
    expect(mid.drivers.available - before.drivers.available).toBe(1);
    expect(mid.drivers.online - before.drivers.online).toBe(1);

    await pool.query(
      "UPDATE driver_last_locations SET recorded_at = now() - interval '2 hours' WHERE driver_id = $1",
      [idle.user.id],
    );
    const stale = (await get(ops.token, '/dashboard')).body.data;
    expect(stale.drivers.available).toBe(mid.drivers.available - 1);
    expect(stale.drivers.staleLocation - mid.drivers.staleLocation).toBe(1);
    expect(stale.drivers.online).toBe(mid.drivers.online); // still online, but not offerable

    const pending = (
      await pool.query(
        "SELECT count(*)::int AS n FROM driver_profiles WHERE status IN ('SUBMITTED','UNDER_REVIEW')",
      )
    ).rows[0].n;
    expect(stale.drivers.pendingVerification).toBe(pending);
  });

  it('follows the period for finished rides and payments, in the platform time zone', async () => {
    const ops = await admin(['OPERATIONS_VIEW']);
    const far = (await get(ops.token, '/dashboard?from=1999-01-01&to=1999-01-02')).body.data;
    expect(far.rides).toMatchObject({ completed: 0, cancelled: 0, noDrivers: 0 });
    expect(far.payments).toEqual({ PENDING: 0, PAID: 0, FAILED: 0, VOID: 0 });
    expect(far.range.timeZone).toBe('Asia/Kathmandu');
    expect(far.range.from).toBe('1998-12-31T18:15:00.000Z'); // midnight in Kathmandu (UTC+5:45)
    expect(far.range.to).toBe('1999-01-02T18:15:00.000Z'); // the end date is included
    for (const bad of [
      'from=1999-01-01',
      'from=1999-02-01&to=1999-01-01',
      'from=1990-01-01&to=2026-01-01',
      'range=fortnight',
      'from=yesterday&to=today',
    ]) {
      expect((await get(ops.token, `/dashboard?${bad}`)).status, bad).toBe(400);
    }
  });

  it('lists rides by group, period and sort, and finds them by search', async () => {
    const ops = await admin(['OPERATIONS_VIEW']);
    const w = await rideWorld();
    const active = (await get(ops.token, '/trips?group=active&pageSize=50')).body.data;
    expect(
      active.items.every((t: { status: string }) =>
        ['SEARCHING', 'DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS'].includes(t.status),
      ),
    ).toBe(true);
    expect(active.items.some((t: { id: string }) => t.id === w.tripId)).toBe(true);
    const ended = (await get(ops.token, '/trips?group=ended&pageSize=50')).body.data;
    expect(ended.items.some((t: { id: string }) => t.id === w.tripId)).toBe(false);
    expect(
      (await get(ops.token, '/trips?range=today&group=active&pageSize=50')).body.data.items.some(
        (t: { id: string }) => t.id === w.tripId,
      ),
    ).toBe(true);
    expect((await get(ops.token, '/trips?from=1999-01-01&to=1999-01-31')).body.data.total).toBe(0);
    const byFare = (await get(ops.token, '/trips?sort=fare&pageSize=50')).body.data.items.map(
      (t: { fareNpr: number | null }) => t.fareNpr ?? -1,
    );
    expect(byFare).toEqual([...byFare].sort((a, b) => b - a));
    expect(
      (await get(ops.token, `/trips?search=${encodeURIComponent(String(w.passenger.phoneNumber))}`))
        .body.data.total,
    ).toBeGreaterThanOrEqual(1);
    expect((await get(ops.token, '/trips?search=%25')).body.data.total).toBe(0);
    expect((await get(ops.token, '/trips?group=nope')).status).toBe(400);
  });

  it('lets only RIDES_MANAGE cancel a ride, and audits it with the reason', async () => {
    const w = await rideWorld();
    const viewer = await admin(['OPERATIONS_VIEW']);
    expect(
      (await send('post', viewer.token, `/trips/${w.tripId}/cancel`, { reason: 'Stuck ride' }))
        .status,
    ).toBe(403);
    const manager = await admin(['RIDES_MANAGE']);
    expect(
      (await send('post', manager.token, `/trips/${w.tripId}/cancel`, { reason: 'Stuck ride' }))
        .status,
    ).toBe(200);
    const [e] = await audit('TRIP_CANCELLED_BY_ADMIN', w.tripId);
    expect(e).toMatchObject({ actor_id: manager.id, actor_role: 'ADMIN' });
    expect(e?.detail).toEqual({ reason: 'Stuck ride' });
  });
});

// ============================================================ financial data

const DAY = `${1990 + Math.floor(Math.random() * 15)}-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`;

interface Seed {
  tripIds: string[];
  passengers: string[];
  drivers: string[];
}
let seed: Seed | null = null; // the last day written (the database is emptied before every test)

/**
 * A day of rides with known numbers, written straight to the tables far in the past so nothing else
 * in the database can touch it. Times are Kathmandu time (UTC+5:45); two rides sit either side of the
 * day's boundary and must NOT be counted.
 *   completed 100 (paid), 200 (paid), 300 (cash not confirmed)   cancelled with fee 50   no driver found
 */
async function seedDay(): Promise<Seed> {
  const w = await rideWorld();
  const loc = (
    await pool.query(
      'SELECT pickup_location_id AS a, destination_location_id AS b FROM trips WHERE id = $1',
      [w.tripId],
    )
  ).rows[0];
  const [pa, pb, pc] = [
    await onboardUser('PASSENGER'),
    await onboardUser('PASSENGER'),
    await onboardUser('PASSENGER'),
  ];
  const [dx, dy] = [await onboardUser('DRIVER'), await onboardUser('DRIVER')];
  const P = [pa, pb, pc].map((u) => u.user.id as string);
  const D = [dx, dy].map((u) => u.user.id as string);
  await pool.query(
    "UPDATE users SET created_at = $2::timestamptz + interval '3 hours' WHERE id = ANY($1::uuid[])",
    [[...P, ...D], `${DAY} 00:00:00+05:45`],
  );
  const ids: string[] = [];
  const add = async (
    at: string,
    status: string,
    passenger: string,
    driver: string | null,
    fare: number | null,
    fee = 0,
    pay: 'PAID' | 'PENDING' | null = null,
  ) => {
    const r = await pool.query(
      `INSERT INTO trips (passenger_id, driver_id, status, pickup_location_id, destination_location_id,
                          requested_at, fare_estimate_npr, fare_final_npr, cancellation_fee_npr, ended_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $6::timestamptz + interval '20 minutes')
       RETURNING id`,
      [
        passenger,
        driver,
        status,
        loc.a,
        loc.b,
        at,
        fare,
        status === 'COMPLETED' ? fare : null,
        fee,
      ],
    );
    const id = r.rows[0].id as string;
    ids.push(id);
    if (pay) {
      await pool.query(
        `INSERT INTO trip_payments (trip_id, amount_npr, method, status, paid_at)
         VALUES ($1, $2, 'CASH', $3, CASE WHEN $3 = 'PAID' THEN now() ELSE NULL END)`,
        [id, fare, pay],
      );
    }
    return id;
  };
  const noon = `${DAY} 12:00:00+05:45`;
  const t1 = await add(noon, 'COMPLETED', P[0]!, D[0]!, 100, 0, 'PAID');
  await add(noon, 'COMPLETED', P[1]!, D[0]!, 200, 0, 'PAID');
  const t3 = await add(noon, 'COMPLETED', P[1]!, D[1]!, 300, 0, 'PENDING');
  await add(noon, 'CANCELLED', P[2]!, D[1]!, 150, 50);
  await add(noon, 'NO_DRIVERS', P[2]!, null, 120);
  await add(`${DAY} 00:00:00+05:45`, 'COMPLETED', P[0]!, D[0]!, 111, 0, 'PAID'); // first instant of the day: counted? see below
  // the instants just outside the day, in Kathmandu time
  await pool.query('SELECT 1');
  await add(`${DAY}T23:59:59+05:45`, 'COMPLETED', P[0]!, D[0]!, 222, 0, 'PAID'); // last second of the day: counted
  await add(
    `${new Date(Date.parse(`${DAY}T00:00:00+05:45`) - 1000).toISOString()}`,
    'COMPLETED',
    P[0]!,
    D[0]!,
    999,
    0,
    'PAID',
  ); // the second before: NOT counted
  await add(
    `${new Date(Date.parse(`${DAY}T00:00:00+05:45`) + 86_400_000).toISOString()}`,
    'COMPLETED',
    P[0]!,
    D[0]!,
    888,
    0,
    'PAID',
  ); // the next midnight: NOT counted
  await pool.query(
    `INSERT INTO trip_ratings (trip_id, rater_id, ratee_id, rater_role, stars, created_at) VALUES
       ($1, $2, $3, 'PASSENGER', 5, $5::timestamptz), ($4, $6, $3, 'PASSENGER', 1, $5::timestamptz)`,
    [t1, P[0], D[0], t3, noon, P[1]],
  );
  seed = { tripIds: ids, passengers: P, drivers: D };
  return seed;
}

describe('financial data', () => {
  it('shows payments, totals and driver earnings that add up, and says there are no wallets or payouts', async () => {
    await seedDay();
    const fin = await admin(['FINANCE_VIEW']);
    const q = `from=${DAY}&to=${DAY}`;
    const s = (await get(fin.token, `/finance/summary?${q}`)).body.data;
    // 100 + 200 + 300 + 111 + 222 (both boundary rides that belong to the day) = 933 of fares
    expect(s.grossFaresNpr).toBe(933);
    expect(s.collectedNpr).toBe(633); // everything but the 300 whose cash was never confirmed
    expect(s.outstandingNpr).toBe(300);
    expect(s.cancellationFeesNpr).toBe(50);
    expect(s.byStatus.PAID).toEqual({ count: 4, amountNpr: 633 });
    expect(s.byStatus.PENDING).toEqual({ count: 1, amountNpr: 300 });
    expect(s.wallets.supported).toBe(false);
    expect(s.payouts.reason).toMatch(/cash/i);

    const pays = (await get(fin.token, `/payments?${q}&pageSize=50`)).body.data;
    expect(pays.total).toBe(5);
    expect(pays.items.reduce((sum: number, p: { amountNpr: number }) => sum + p.amountNpr, 0)).toBe(
      933,
    );
    expect(
      (await get(fin.token, `/payments?${q}&status=PENDING`)).body.data.items.map(
        (p: { amountNpr: number }) => p.amountNpr,
      ),
    ).toEqual([300]);
    expect((await get(fin.token, `/payments?${q}&sort=amount`)).body.data.items[0].amountNpr).toBe(
      300,
    );

    const earn = (await get(fin.token, `/finance/earnings?${q}`)).body.data;
    const byId = new Map(earn.items.map((e: { driverId: string }) => [e.driverId, e]));
    const [dx, dy] = seed!.drivers;
    expect(byId.get(dx!)).toMatchObject({
      rides: 4,
      earnedNpr: 633,
      collectedNpr: 633,
      outstandingNpr: 0,
    });
    expect(byId.get(dy!)).toMatchObject({
      rides: 1,
      earnedNpr: 300,
      collectedNpr: 0,
      outstandingNpr: 300,
    });
    expect(earn.items[0].earnedNpr).toBeGreaterThanOrEqual(earn.items[1].earnedNpr);
    // the money totals agree with each other across the three views
    expect(earn.items.reduce((sum: number, e: { earnedNpr: number }) => sum + e.earnedNpr, 0)).toBe(
      s.grossFaresNpr,
    );
  });

  it('writes every look at financial data to the audit log', async () => {
    await seedDay();
    const fin = await admin(['FINANCE_VIEW']);
    for (const p of ['/finance/summary', '/payments', '/finance/earnings']) await get(fin.token, p);
    const actions = (
      await pool.query('SELECT action FROM audit_log WHERE actor_id = $1 ORDER BY id', [fin.id])
    ).rows.map((r) => r.action);
    expect(actions).toEqual(['VIEW_FINANCE_SUMMARY', 'VIEW_PAYMENTS', 'VIEW_DRIVER_EARNINGS']);
  });

  it('keeps money away from administrators without FINANCE_VIEW, and never shows message text in notification monitoring', async () => {
    const ops = await admin(['OPERATIONS_VIEW', 'ANALYTICS_VIEW']);
    for (const p of ['/payments', '/finance/summary', '/finance/earnings'])
      expect((await get(ops.token, p)).status).toBe(403);
    const n = await admin(['NOTIFICATIONS_VIEW']);
    const list = (await get(n.token, '/notifications?range=30d&pageSize=5')).body.data;
    for (const row of list.items)
      expect(Object.keys(row).sort()).toEqual([
        'createdAt',
        'id',
        'read',
        'title',
        'type',
        'userName',
        'userRole',
      ]);
  });
});

// ============================================================ analytics accuracy

describe('analytics accuracy', () => {
  it('produces exactly the figures a hand count gives for a known day', async () => {
    const sd = await seedDay();
    const an = await admin(['ANALYTICS_VIEW']);
    const inDb = await pool.query(
      'SELECT count(*)::int AS n, min(requested_at) AS mn FROM trips WHERE id = ANY($1::uuid[])',
      [sd.tripIds],
    );
    if (inDb.rows[0].n !== 9) throw new Error('SEED GONE ' + JSON.stringify(inDb.rows[0]) + DAY);
    const a = (await get(an.token, `/analytics?from=${DAY}&to=${DAY}`)).body.data;
    // requested: 100, 200, 300, cancelled, no-driver, plus the two boundary rides that belong to the day
    expect(a.rides).toMatchObject({
      requested: 7,
      completed: 5,
      cancelled: 1,
      noDrivers: 1,
      stillActive: 0,
    });
    expect(a.rides.completionRatePercent).toBe(71.4); // 5 of the 7 that ended
    expect(a.rides.cancellationRatePercent).toBe(14.3);
    expect(a.rides.daily).toEqual([
      { day: DAY, requested: 7, completed: 5, cancelled: 1, grossFaresNpr: 933 },
    ]);
    expect(a.money).toMatchObject({
      grossFaresNpr: 933,
      averageFareNpr: 187, // 933 / 5 rounded
      collectedNpr: 633,
      outstandingNpr: 300,
      cancellationFeesNpr: 50,
      driverEarningsNpr: 933,
    });
    expect(a.money.payouts.supported).toBe(false);
    expect(a.drivers).toMatchObject({ active: 2, newlyRegistered: 2, ridesPerActiveDriver: 2.5 });
    expect(a.passengers).toMatchObject({ active: 3, newlyRegistered: 3 });
    expect(a.passengers.ridesPerActivePassenger).toBe(2.3); // 7 rides / 3 passengers
    expect(a.ratings).toEqual({ average: 3, count: 2 });
    expect(a.safety.lowRatings).toBe(1);
  });

  it('adds up across ranges: two adjacent days equal the whole', async () => {
    await seedDay();
    const an = await admin(['ANALYTICS_VIEW']);
    const [y, m, d] = DAY.split('-').map(Number) as [number, number, number];
    const day = (offset: number) =>
      new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
    const one = (await get(an.token, `/analytics?from=${DAY}&to=${DAY}`)).body.data;
    const before = (await get(an.token, `/analytics?from=${day(-1)}&to=${day(-1)}`)).body.data;
    const after = (await get(an.token, `/analytics?from=${day(1)}&to=${day(1)}`)).body.data;
    const whole = (await get(an.token, `/analytics?from=${day(-1)}&to=${day(1)}`)).body.data;
    expect(before.rides.requested).toBe(1); // the second before midnight
    expect(after.rides.requested).toBe(1); // the next midnight
    expect(whole.rides.requested).toBe(
      one.rides.requested + before.rides.requested + after.rides.requested,
    );
    expect(whole.money.grossFaresNpr).toBe(one.money.grossFaresNpr + 999 + 888);
    expect(whole.rides.daily.map((x: { day: string }) => x.day)).toEqual([day(-1), DAY, day(1)]);
  });

  it('counts safety reports raised in the period', async () => {
    const an = await admin(['ANALYTICS_VIEW']);
    const before = (await get(an.token, '/analytics?range=today')).body.data.safety;
    const w = await rideWorld();
    await api
      .post(`/api/v1/trips/${w.tripId}/incidents`)
      .set(auth(w.passenger.accessToken))
      .send({ category: 'HARASSMENT', description: 'The driver kept asking personal questions' });
    await api.post(`/api/v1/trips/${w.tripId}/sos`).set(auth(w.passenger.accessToken)).send({});
    const after = (await get(an.token, '/analytics?range=today')).body.data.safety;
    expect(after.incidents - before.incidents).toBe(1);
    expect(
      (after.incidentsByCategory.HARASSMENT ?? 0) - (before.incidentsByCategory.HARASSMENT ?? 0),
    ).toBe(1);
    expect(after.sosAlerts - before.sosAlerts).toBe(1);
  });

  it('is empty, not broken, for a period with nothing in it', async () => {
    const an = await admin(['ANALYTICS_VIEW']);
    const a = (await get(an.token, '/analytics?from=1980-05-05&to=1980-05-07')).body.data;
    expect(a.rides).toMatchObject({
      requested: 0,
      completionRatePercent: null,
      cancellationRatePercent: null,
    });
    expect(a.rides.daily).toHaveLength(3);
    expect(a.money).toMatchObject({ grossFaresNpr: 0, averageFareNpr: null });
    expect(a.drivers.ridesPerActiveDriver).toBeNull();
    expect(a.ratings).toEqual({ average: null, count: 0 });
  });
});

// ============================================================ configuration

describe('platform settings', () => {
  const put = (token: string, key: string, body: object) =>
    send('put', token, `/settings/${key}`, body);
  const setting = async (token: string, key: string) =>
    (
      (await get(token, '/settings')).body.data.settings as Array<{
        key: string;
        value: unknown;
        version: number;
        overridden: boolean;
      }>
    ).find((s) => s.key === key)!;

  it('shows every setting with its default, and lets viewing and changing be separate permissions', async () => {
    const viewer = await admin(['SETTINGS_VIEW']);
    const res = (await get(viewer.token, '/settings')).body.data;
    expect(res.canManage).toBe(false);
    expect(res.settings.map((s: { key: string }) => s.key)).toEqual([...SETTING_KEYS]);
    for (const s of res.settings) {
      expect(s.value).toEqual(settingDefault(s.key));
      expect(s).toMatchObject({ overridden: false, version: 0 });
    }
    expect(
      (await put(viewer.token, 'FARE_BASE_NPR', { value: 60, expectedVersion: 0, reason: 'test' }))
        .status,
    ).toBe(403);
    const manager = await admin(['SETTINGS_MANAGE']); // implies viewing
    expect((await get(manager.token, '/settings')).body.data.canManage).toBe(true);
  });

  it('validates every value with the one rule, and refuses unknown settings', async () => {
    const m = await admin(['SETTINGS_MANAGE']);
    const bad: Array<[string, unknown]> = [
      ['FARE_BASE_NPR', -1],
      ['FARE_BASE_NPR', 1.5],
      ['FARE_BASE_NPR', 'lots'],
      ['FARE_BASE_NPR', 1_000_000],
      ['FARE_PER_KM_NPR', -0.1],
      ['CANCEL_FREE_SECONDS', 99_999],
      ['NO_SHOW_AFTER_SECONDS', 0],
      ['SERVICE_REQUESTS_ENABLED', 'maybe'],
      ['SERVICE_PAUSED_MESSAGE', ''],
      ['SERVICE_PAUSED_MESSAGE', 'x'.repeat(201)],
      ['WAITING_NOTIFY_SECONDS', ''],
      ['WAITING_NOTIFY_SECONDS', 'a,b'],
      ['NEARBY_NOTIFY_METERS', [1, 2.5]],
    ];
    for (const [key, value] of bad) {
      const res = await put(m.token, key, { value, expectedVersion: 0, reason: 'test' });
      expect(res.status, `${key}=${JSON.stringify(value)}`).toBe(400);
      expect(res.body.error.code).toBe('INVALID_SETTING');
    }
    expect(
      (await put(m.token, 'NOT_A_SETTING', { value: 1, expectedVersion: 0, reason: 'test' }))
        .status,
    ).toBe(404);
    expect(
      (await put(m.token, 'FARE_BASE_NPR', { value: 60, expectedVersion: 0, reason: 'x' })).status,
    ).toBe(400);
    expect((await put(m.token, 'FARE_BASE_NPR', { value: 60, reason: 'test reason' })).status).toBe(
      400,
    );
    expect(
      (
        await put(m.token, 'FARE_BASE_NPR', {
          value: 60,
          expectedVersion: 0,
          reason: 'test',
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect((await setting(m.token, 'FARE_BASE_NPR')).overridden).toBe(false); // nothing was saved
  });

  it('saves a change once, versions it, applies it to prices at once, and audits who, what and why', async () => {
    const m = await admin(['SETTINGS_MANAGE']);
    const p = await onboardUser('PASSENGER');
    const estimate = async () =>
      (
        await api
          .post('/api/v1/trips/estimate')
          .set(auth(p.accessToken))
          .send({
            pickup: { latitude: 27.7154, longitude: 85.3123, address: 'Thamel', name: 'Thamel' },
            destination: { latitude: 27.6727, longitude: 85.325, address: 'Patan', name: 'Patan' },
            vehicleCategory: 'CAR',
          })
      ).body.data;
    const before = await estimate();
    const car = (x: { fare: { totalNpr: number } }) => x.fare.totalNpr;

    const saved = await put(m.token, 'FARE_BASE_NPR', {
      value: '500',
      expectedVersion: 0,
      reason: 'Festival season',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({
      value: 500,
      overridden: true,
      version: 1,
      updatedByName: 'Test Admin',
    });
    expect(getSetting('FARE_BASE_NPR')).toBe(500);
    expect(pricingConfig().baseNpr).toBe(500); // the pricing rule reads the store, not a copy
    const after = await estimate();
    expect(car(after) - car(before)).toBe(450);

    const [e] = await audit('SETTING_CHANGED');
    expect(e).toMatchObject({ actor_id: m.id, actor_role: 'ADMIN', subject_id: null });
    expect(e?.detail).toEqual({
      key: 'FARE_BASE_NPR',
      from: '50 NPR',
      to: '500 NPR',
      reason: 'Festival season',
    });

    const back = await put(m.token, 'FARE_BASE_NPR', {
      value: null,
      expectedVersion: 1,
      reason: 'Season over',
    });
    expect(back.body.data).toMatchObject({ value: 50, overridden: false, version: 2 });
    expect(car(await estimate())).toBe(car(before));
    expect((await audit('SETTING_RESET')).length).toBe(1);
  });

  it('refuses a stale edit, and of two simultaneous edits applies exactly one', async () => {
    const a = await admin(['SETTINGS_MANAGE']);
    const b = await admin(['SETTINGS_MANAGE']);
    expect(
      (await put(a.token, 'CANCEL_FEE_NPR', { value: 20, expectedVersion: 0, reason: 'first' }))
        .status,
    ).toBe(200);
    const stale = await put(b.token, 'CANCEL_FEE_NPR', {
      value: 30,
      expectedVersion: 0,
      reason: 'second',
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('SETTING_CHANGED');
    expect(stale.body.error.details.currentVersion).toBe(1);
    expect((await setting(a.token, 'CANCEL_FEE_NPR')).value).toBe(20);

    const race = await Promise.all([
      put(a.token, 'WAITING_PER_MINUTE_NPR', {
        value: 7,
        expectedVersion: 0,
        reason: 'first admin',
      }),
      put(b.token, 'WAITING_PER_MINUTE_NPR', {
        value: 9,
        expectedVersion: 0,
        reason: 'second admin',
      }),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = race.find((r) => r.status === 200)!.body.data.value;
    expect((await setting(a.token, 'WAITING_PER_MINUTE_NPR')).value).toBe(winner);
    expect((await setting(a.token, 'WAITING_PER_MINUTE_NPR')).version).toBe(1);
  });

  it('changes the cancellation fee and waiting rules where they are applied', async () => {
    const m = await admin(['SETTINGS_MANAGE']);
    await put(m.token, 'CANCEL_FEE_NPR', {
      value: 75,
      expectedVersion: 0,
      reason: 'Discourage cancels',
    });
    await put(m.token, 'CANCEL_FREE_SECONDS', {
      value: 0,
      expectedVersion: 0,
      reason: 'Discourage cancels',
    });
    const w = await rideWorld();
    await backdate(w.tripId, 'matched_at', 30);
    // what the passenger is told cancelling would cost, and what is then recorded
    const told = await api.get(`/api/v1/trips/${w.tripId}`).set(auth(w.passenger.accessToken));
    expect(told.body.data.cancelFeeNpr).toBe(75);
    const res = await api
      .post(`/api/v1/trips/${w.tripId}/cancel`)
      .set(auth(w.passenger.accessToken))
      .send({});
    expect(res.status).toBe(200);
    const recorded = await pool.query(
      'SELECT cancellation_fee_npr AS fee FROM trips WHERE id = $1',
      [w.tripId],
    );
    expect(recorded.rows[0].fee).toBe(75);
    await put(m.token, 'WAITING_NOTIFY_SECONDS', {
      value: '90, 30, 30',
      expectedVersion: 0,
      reason: 'Sooner reminders',
    });
    expect(getSetting('WAITING_NOTIFY_SECONDS')).toEqual([30, 90]);
  });

  it('pauses new requests without touching rides already under way, and shows apps the same store', async () => {
    const m = await admin(['SETTINGS_MANAGE']);
    const running = await rideWorld();
    const cfg = async () => (await api.get('/api/v1/config/platform')).body.data;
    expect((await cfg()).requestsEnabled).toBe(true);

    await put(m.token, 'SERVICE_REQUESTS_ENABLED', {
      value: false,
      expectedVersion: 0,
      reason: 'Outage',
    });
    await put(m.token, 'SERVICE_PAUSED_MESSAGE', {
      value: 'Back at 6 pm',
      expectedVersion: 0,
      reason: 'Outage',
    });
    expect(await cfg()).toMatchObject({
      requestsEnabled: false,
      pausedMessage: 'Back at 6 pm',
      fare: { baseNpr: 50 },
    });

    const p = await onboardUser('PASSENGER');
    const refused = await requestRide(p.accessToken);
    expect(refused.status).toBe(503);
    expect(refused.body.error).toMatchObject({ code: 'SERVICE_PAUSED', message: 'Back at 6 pm' });
    // the ride that was already under way carries on
    await arriveAtPickup(running);
    expect(
      (await api.get(`/api/v1/trips/${running.tripId}`).set(auth(running.passenger.accessToken)))
        .body.data.status,
    ).toBe('DRIVER_ARRIVED');

    await put(m.token, 'SERVICE_REQUESTS_ENABLED', {
      value: null,
      expectedVersion: 1,
      reason: 'Recovered',
    });
    expect((await cfg()).requestsEnabled).toBe(true);
    expect((await requestRide(p.accessToken)).status).toBe(201);
  });

  it('publishes only what the apps may know, and needs no sign-in for it', async () => {
    const res = await api.get('/api/v1/config/platform');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual([
      'cancellation',
      'fare',
      'pausedMessage',
      'requestsEnabled',
      'waiting',
    ]);
    expect(res.body.data.fare).toEqual({
      baseNpr: 50,
      perKmNpr: 30,
      perMinuteNpr: 2,
      minimumNpr: 100,
    });
  });
});

describe('vehicle categories', () => {
  const patch = (token: string, id: string, body: object) =>
    send('patch', token, `/vehicle-categories/${id}`, body);
  it('edits a category with a reason, audits before and after, and keeps one category requestable', async () => {
    const m = await admin(['SETTINGS_MANAGE']);
    const cats = (await get(m.token, '/vehicle-categories')).body.data as Array<{
      id: string;
      code: string;
      label: string;
      isActive: boolean;
      baseFareNpr: number | null;
    }>;
    const car = cats.find((c) => c.code === 'CAR')!;
    expect((await patch(m.token, car.id, { label: 'Car+', reason: 'x' })).status).toBe(400);
    expect((await patch(m.token, car.id, { baseFareNpr: -5, reason: 'test reason' })).status).toBe(
      400,
    );
    const res = await patch(m.token, car.id, { baseFareNpr: 80, reason: 'Premium cars' });
    expect(res.status).toBe(200);
    expect(res.body.data.baseFareNpr).toBe(80);
    const [e] = await audit('VEHICLE_CATEGORY_CHANGED', car.id);
    expect(e?.detail).toMatchObject({
      reason: 'Premium cars',
      before: { baseFareNpr: car.baseFareNpr },
      after: { baseFareNpr: 80 },
    });
    // restore
    expect(
      (await patch(m.token, car.id, { baseFareNpr: car.baseFareNpr, reason: 'Undo test' })).status,
    ).toBe(200);
    // switching off every category is refused
    const active = cats.filter((c) => c.isActive);
    const results: number[] = [];
    for (const c of active)
      results.push((await patch(m.token, c.id, { isActive: false, reason: 'test reason' })).status);
    expect(results.slice(0, -1).every((s) => s === 200)).toBe(true);
    expect(results[results.length - 1]).toBe(409);
    for (const c of active) await patch(m.token, c.id, { isActive: true, reason: 'Restore test' });
    expect((await patch(m.token, ZERO_UUID, { label: 'Nope', reason: 'test reason' })).status).toBe(
      404,
    );
  });
});

// ============================================================ audit logging

describe('audit log', () => {
  it('can be searched and filtered, and reading it is itself recorded', async () => {
    const a = await admin(['AUDIT_VIEW', 'USERS_MANAGE']);
    const person = await onboardUser('PASSENGER');
    await send('post', a.token, `/users/${person.user.id}/suspend`, { reason: 'Audit test' });
    const list = (await get(a.token, '/audit?range=today&action=USER_SUSPENDED&pageSize=50')).body
      .data;
    const mine = list.items.find((e: { subjectIds: string[] }) =>
      e.subjectIds.includes(person.user.id as string),
    );
    expect(mine).toMatchObject({
      action: 'USER_SUSPENDED',
      actorName: 'Test Admin',
      actorRole: 'ADMIN',
      subjectType: 'user',
      detail: { reason: 'Audit test' },
    });
    expect(
      (await get(a.token, '/audit?range=today&subjectType=user&search=Test%20Admin')).body.data
        .total,
    ).toBeGreaterThan(0);
    expect((await get(a.token, '/audit?from=1999-01-01&to=1999-01-02')).body.data.total).toBe(0);
    expect((await get(a.token, '/audit?range=today&search=%25')).body.data.total).toBe(0);
    expect((await audit('VIEW_AUDIT_LOG')).some((e) => e.actor_id === a.id)).toBe(true);
    const ids = list.items.map((e: { id: string }) => Number(e.id));
    expect(ids).toEqual([...ids].sort((x, y) => y - x)); // newest first
  });

  it('records the acting admin for every sensitive action and never a reason it was not given', async () => {
    const w = await rideWorld();
    const ops = await admin(['RIDES_MANAGE', 'DISPUTES_MANAGE']);
    const cancel = await send('post', ops.token, `/trips/${w.tripId}/cancel`, {
      reason: 'Operator cancel',
    });
    expect(cancel.status).toBe(200);
    const failed = await send('post', ops.token, `/trips/${w.tripId}/cancel`, {
      reason: 'Second try',
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect((await audit('TRIP_CANCELLED_BY_ADMIN', w.tripId)).length).toBe(1);
    const none = await send('post', ops.token, `/trips/${w.tripId}/cancel`, {}); // no reason
    expect(none.status).toBe(400);
    expect((await audit('TRIP_CANCELLED_BY_ADMIN', w.tripId)).length).toBe(1);
  });
});

// ============================================================ search and filtering on notifications

describe('notification monitoring', () => {
  it('summarises and lists what was sent, with filters, without the message text', async () => {
    const n = await admin(['NOTIFICATIONS_VIEW']);
    const before = (await get(n.token, '/notifications/summary?range=today')).body.data;
    await rideWorld(); // notifies both people
    const after = (await get(n.token, '/notifications/summary?range=today')).body.data;
    expect(after.total - before.total).toBeGreaterThanOrEqual(2);
    expect(after.read + after.unread).toBe(after.total);
    expect(after.byType.reduce((s: number, t: { count: number }) => s + t.count, 0)).toBe(
      after.total,
    );
    const type = after.byType[0].type as string;
    const filtered = (await get(n.token, `/notifications?range=today&type=${type}&pageSize=50`))
      .body.data;
    expect(filtered.total).toBe(after.byType.find((t: { type: string }) => t.type === type).count);
    expect(filtered.items.every((r: { type: string }) => r.type === type)).toBe(true);
    expect(
      (await get(n.token, '/notifications?range=today&read=true')).body.data.items.every(
        (r: { read: boolean }) => r.read,
      ),
    ).toBe(true);
    expect((await get(n.token, '/notifications?read=maybe')).status).toBe(400);
  });
});

// ============================================================ SSOT

/** Every .ts source file under a directory, skipping tests. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory())
      return name === 'test' || name === 'node_modules' ? [] : sources(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}
const API_SRC = join(__dirname, '..');

describe('single source of truth', () => {
  it('reads every admin-editable setting only through the settings store', () => {
    const editable = SETTING_KEYS.join('|');
    const reads = new RegExp(`\\benv\\.(${editable})\\b`);
    const offenders = sources(API_SRC)
      .filter((f) => !f.includes(join('src', 'config')) && !f.endsWith('settings.service.ts'))
      .filter((f) => reads.test(readFileSync(f, 'utf8')))
      .map((f) => f.replace(API_SRC, ''));
    expect(offenders).toEqual([]);
  });

  it('gives every setting a valid default and a complete definition', () => {
    for (const def of PLATFORM_SETTINGS) {
      const d = settingDefault(def.key);
      expect(checkSettingValue(settingDef(def.key)!, d), `default of ${def.key}`).toMatchObject({
        ok: true,
      });
      expect(def.label.length).toBeGreaterThan(3);
      expect(def.help.length).toBeGreaterThan(10);
    }
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
  });

  it('accepts exactly the shared permission list when granting permissions', async () => {
    const m = await admin(['ADMINS_MANAGE', ...ADMIN_PERMISSIONS]);
    const t = await admin([]);
    const res = await send('put', m.token, `/admins/${t.id}/permissions`, {
      permissions: [...ADMIN_PERMISSIONS],
      reason: 'Everything',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual([...ADMIN_PERMISSIONS].sort());
  });

  it('shows every admin page in the menu only for a permission that exists', async () => {
    const nav = readFileSync(
      join(__dirname, '..', '..', '..', 'admin', 'src', 'lib', 'nav.ts'),
      'utf8',
    );
    const named = [...nav.matchAll(/permission: '([A-Z_]+)'/g)].map((m) => m[1]);
    expect(named.length).toBeGreaterThanOrEqual(12);
    for (const p of named) expect(ADMIN_PERMISSIONS as readonly string[]).toContain(p);
  });

  it('keeps the baseline test permissions a subset of the real list', () => {
    for (const p of BASELINE_ADMIN_PERMISSIONS) expect(ADMIN_PERMISSIONS).toContain(p);
  });
});

// ============================================================ accessibility (static checks of the admin app)

const ADMIN_SRC = join(__dirname, '..', '..', '..', 'admin', 'src');
function adminFiles(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? adminFiles(p, ext) : ext.test(p) ? [p] : [];
  });
}

describe('admin accessibility (static)', () => {
  const tsx = adminFiles(ADMIN_SRC, /\.tsx?$/);

  it('never uses a browser alert, confirm or prompt dialog', () => {
    const banned = /\b(window\.)?(alert|confirm|prompt)\s*\(/;
    const offenders = tsx.filter((f) =>
      banned.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')),
    );
    expect(offenders.map((f) => f.replace(ADMIN_SRC, ''))).toEqual([]);
  });

  it('has exactly one main landmark per page, the console layout, with a skip link to it', () => {
    const layout = readFileSync(join(ADMIN_SRC, 'app', '(console)', 'layout.tsx'), 'utf8');
    expect(layout).toContain('href="#main"');
    expect(layout).toContain('id="main"');
    const inConsole = tsx.filter((f) => f.includes('(console)') && !f.endsWith('layout.tsx'));
    expect(
      inConsole
        .filter((f) => /<main[\s>]/.test(readFileSync(f, 'utf8')))
        .map((f) => f.replace(ADMIN_SRC, '')),
    ).toEqual([]);
  });

  it('labels every field and never relies on placeholder or colour alone', () => {
    const offenders: string[] = [];
    for (const f of tsx.filter((x) => x.endsWith('.tsx'))) {
      const src = readFileSync(f, 'utf8');
      // every <input>/<select>/<textarea> that is visible needs an id (for its label) or aria-label or wraps in a label
      for (const m of src.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
        const attrs = m[2] ?? '';
        if (/type="(hidden|checkbox)"/.test(attrs) && /type="hidden"/.test(attrs)) continue;
        if (
          !/\bid=|aria-label=|aria-labelledby=/.test(attrs) &&
          !/<label[^>]*>[^<]*(\n|\s)*<\1/.test(src)
        )
          offenders.push(`${f.replace(ADMIN_SRC, '')}: <${m[1]}${attrs.slice(0, 40)}`);
      }
      if (/placeholder=/.test(src))
        offenders.push(`${f.replace(ADMIN_SRC, '')}: placeholder used as a label`);
    }
    expect(offenders).toEqual([]);
  });

  it('gives every data table a caption and column headers, and every result a status region', () => {
    const offenders: string[] = [];
    for (const f of tsx.filter((x) => x.endsWith('.tsx'))) {
      const src = readFileSync(f, 'utf8');
      if (/<table\b/.test(src) && !/<caption\b/.test(src))
        offenders.push(`${f.replace(ADMIN_SRC, '')}: table without caption`);
      if (/<table\b/.test(src) && !/scope="col"|<SortableTh/.test(src))
        offenders.push(`${f.replace(ADMIN_SRC, '')}: table without headers`);
      // (a status or alert region: either is announced without moving focus)
      const acts = /useActionState\(/.test(src);
      if (acts && !/role="(status|alert)"|aria-live=/.test(src))
        offenders.push(`${f.replace(ADMIN_SRC, '')}: action without a status region`);
    }
    expect(offenders).toEqual([]);
  });

  it('keeps destructive and financial actions behind an in-page confirmation', () => {
    const settings = readFileSync(
      join(ADMIN_SRC, 'app', '(console)', 'settings', 'Editors.tsx'),
      'utf8',
    );
    expect(settings).toContain('Are you sure?');
    const confirm = readFileSync(
      join(ADMIN_SRC, 'app', '(console)', 'ui', 'ConfirmAction.tsx'),
      'utf8',
    );
    expect(confirm).toContain("e.key === 'Escape'"); // keyboard: Escape goes back
    expect(confirm).toContain('.focus()'); // focus is moved into, and back out of, the confirmation
    const users = readFileSync(
      join(ADMIN_SRC, 'app', '(console)', 'users', '[id]', 'page.tsx'),
      'utf8',
    );
    expect(users).toContain('ConfirmAction');
  });
});
