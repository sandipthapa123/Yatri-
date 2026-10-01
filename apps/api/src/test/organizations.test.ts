import {
  DEFAULT_ORG_POLICY,
  ORG_APPROVAL_TRANSITIONS,
  ORG_PAYMENT_MODE_METHOD,
  ORG_PERMISSIONS,
  ORG_ROLES,
  ORG_ROLE_PERMISSIONS,
  ORG_STATEMENT_TRANSITIONS,
  assignableOrgRoles,
  canManageOrgMember,
  describePayment,
  evaluateBooking,
  orgRoleHolds,
  type AdminPermission,
  type BookingFacts,
  type OrgPolicy,
  type OrgRole,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { sweepApprovals } from '../modules/organizations/approvals.service';
import { issueStatements, previousPeriodKey } from '../modules/organizations/statements.service';
import { dropZoneCache } from '../modules/operations/zones.service';
import { refreshSettings } from '../modules/settings/settings.service';
import { api, loginTestAdmin, onboardUser, type OnboardedUser } from './helpers';
import {
  THAMEL,
  PATAN,
  acceptCurrentOffer,
  arriveAtPickup,
  auth,
  clearRedis,
  forceDriverOnline,
} from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
const base = '/api/v1/organizations';
const id = (u: OnboardedUser) => u.user.id as string;

async function person(name: string) {
  const u = await onboardUser('PASSENGER');
  await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [id(u), name]);
  return u;
}
async function admin(permissions: AdminPermission[]) {
  const email = `org-admin-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1', permissions);
  return {
    token,
    id: (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id as string,
  };
}
const get = (t: string, path: string) => api.get(`${base}${path}`).set(auth(t));
const post = (t: string, path: string, body: object = {}) =>
  api.post(`${base}${path}`).set(auth(t)).send(body);
const put = (t: string, path: string, body: object) =>
  api.put(`${base}${path}`).set(auth(t)).send(body);
const patch = (t: string, path: string, body: object) =>
  api.patch(`${base}${path}`).set(auth(t)).send(body);
const del = (t: string, path: string) => api.delete(`${base}${path}`).set(auth(t));
const adminGet = (t: string, path: string) =>
  api.get(`/api/v1/admin/organizations${path}`).set(auth(t));
const adminPost = (t: string, path: string, body: object = {}) =>
  api.post(`/api/v1/admin/organizations${path}`).set(auth(t)).send(body);

const trip = {
  pickup: { ...THAMEL, address: 'Thamel, Kathmandu' },
  destination: { ...PATAN, address: 'Patan Dhoka, Lalitpur' },
};
const ride = (over: Record<string, unknown> = {}) => ({ ...trip, vehicleCategory: 'CAR', ...over });

async function createOrg(owner: OnboardedUser, name = `Acme ${Date.now()}-${++n}`) {
  const r = await post(owner.accessToken, '', { name, billingEmail: 'accounts@acme.example.com' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data.id as string;
}
async function join(orgId: string, inviterToken: string, member: OnboardedUser, role: OrgRole) {
  const inv = await post(inviterToken, `/${orgId}/members`, {
    phoneNumber: member.phoneNumber,
    role,
  });
  expect(inv.status, JSON.stringify(inv.body)).toBe(202);
  const acc = await post(member.accessToken, `/invitations/${orgId}/accept`);
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
}

/** An organization with one person in every role, and a driver for rides. */
async function world() {
  const [owner, adminP, booker, member, viewer, outsider, driver] = await Promise.all([
    person('Olga Owner'),
    person('Adam Admin'),
    person('Bina Booker'),
    person('Mina Member'),
    person('Vik Viewer'),
    person('Out Sider'),
    onboardUser('DRIVER'),
  ]);
  const orgId = await createOrg(owner);
  await join(orgId, owner.accessToken, adminP, 'ADMIN');
  await join(orgId, owner.accessToken, booker, 'BOOKER');
  await join(orgId, owner.accessToken, member, 'MEMBER');
  await join(orgId, owner.accessToken, viewer, 'VIEWER');
  return { orgId, owner, adminP, booker, member, viewer, outsider, driver };
}
type World = Awaited<ReturnType<typeof world>>;

const setPolicy = async (w: World, over: Partial<OrgPolicy>) => {
  const cur = (await get(w.owner.accessToken, `/${w.orgId}/policy`)).body.data;
  const body = { ...DEFAULT_ORG_POLICY, ...pickPolicy(cur), ...over };
  const r = await put(w.owner.accessToken, `/${w.orgId}/policy`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data;
};
const pickPolicy = (v: Record<string, unknown>): OrgPolicy => ({
  allowedCategoryCodes: v.allowedCategoryCodes as string[],
  allowedZoneIds: v.allowedZoneIds as string[],
  perRideLimitNpr: v.perRideLimitNpr as number | null,
  perMemberMonthlyLimitNpr: v.perMemberMonthlyLimitNpr as number | null,
  monthlyLimitNpr: v.monthlyLimitNpr as number | null,
  approvalOverNpr: v.approvalOverNpr as number | null,
  approvalForAll: v.approvalForAll as boolean,
  memberSelfBooking: v.memberSelfBooking as boolean,
  costCenterRequired: v.costCenterRequired as boolean,
  paymentMode: v.paymentMode as OrgPolicy['paymentMode'],
});

const book = (token: string, orgId: string, over: Record<string, unknown> = {}) =>
  post(token, `/${orgId}/bookings`, ride(over));
const fareOf = async (w: World) => {
  const r = await post(w.owner.accessToken, `/${w.orgId}/bookings/preview`, ride());
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.data.fareNpr as number;
};
const orgTrip = async (tripId: string) =>
  (await pool.query('SELECT * FROM trips WHERE id = $1', [tripId])).rows[0];
const payment = async (tripId: string) =>
  (await pool.query('SELECT * FROM trip_payments WHERE trip_id = $1', [tripId])).rows[0];
const audits = async (action: string) =>
  (await pool.query('SELECT * FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows;

/** A business ride taken to the end: booked through the organization, accepted, driven and completed. */
async function finishBusinessRide(
  w: World,
  bookerToken: string,
  rider: OnboardedUser,
  over: Record<string, unknown> = {},
) {
  await forceDriverOnline(id(w.driver));
  const b = await book(bookerToken, w.orgId, { passengerId: id(rider), ...over });
  expect(b.status, JSON.stringify(b.body)).toBe(201);
  const tripId = b.body.data.tripId as string;
  const acc = await acceptCurrentOffer(w.driver.accessToken);
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
  const world = {
    passenger: rider,
    driver: w.driver,
    tripId,
    passengerId: id(rider),
    driverId: id(w.driver),
  };
  await arriveAtPickup(world);
  await api.post(`/api/v1/trips/${tripId}/start`).set(auth(w.driver.accessToken));
  const done = await api.post(`/api/v1/trips/${tripId}/complete`).set(auth(w.driver.accessToken));
  expect(done.status, JSON.stringify(done.body)).toBe(200);
  return tripId;
}
/** Move a finished ride into last month, so a statement can be issued for it. */
async function inLastMonth(tripId: string, daysIn = 2) {
  await pool.query(
    `UPDATE trips SET requested_at = date_trunc('month', now()) - ($2::int * interval '1 day'),
                      ended_at = date_trunc('month', now()) - ($2::int * interval '1 day') + interval '1 hour'
     WHERE id = $1`,
    [tripId, daysIn],
  );
}
const setSetting = async (key: string, value: unknown) => {
  await pool.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
    [key, JSON.stringify(value)],
  );
  await refreshSettings();
};
const clearSetting = async (key: string) => {
  await pool.query('DELETE FROM platform_settings WHERE key = $1', [key]);
  await refreshSettings();
};

// ---------------------------------------------------------------- the definitions, once

describe('organization roles and the booking rule', () => {
  it('keeps organization roles apart from platform roles and gives each role only what it needs', () => {
    expect(ORG_ROLES).toEqual(['OWNER', 'ADMIN', 'BOOKER', 'MEMBER', 'VIEWER']);
    expect(ORG_ROLE_PERMISSIONS.OWNER).toEqual(ORG_PERMISSIONS);
    expect(orgRoleHolds('VIEWER', 'RIDES_BOOK_SELF')).toBe(false);
    expect(orgRoleHolds('VIEWER', 'REPORTS_VIEW')).toBe(true);
    expect(orgRoleHolds('MEMBER', 'RIDES_BOOK_FOR_OTHERS')).toBe(false);
    expect(orgRoleHolds('BOOKER', 'RIDES_BOOK_FOR_OTHERS')).toBe(true);
    expect(orgRoleHolds('BOOKER', 'BILLING_VIEW')).toBe(false);
    expect(orgRoleHolds('ADMIN', 'RIDES_APPROVE')).toBe(true);
    // no organization permission is named like a platform admin permission
    for (const p of ORG_PERMISSIONS) expect(['USERS_MANAGE', 'FLEET_MANAGE']).not.toContain(p);
  });

  it('lets only owners make owners and administrators, and administrators manage the roles below', () => {
    expect(assignableOrgRoles('OWNER')).toEqual(ORG_ROLES);
    expect(assignableOrgRoles('ADMIN')).toEqual(['BOOKER', 'MEMBER', 'VIEWER']);
    expect(assignableOrgRoles('BOOKER')).toEqual([]);
    expect(canManageOrgMember('ADMIN', 'OWNER')).toBe(false);
    expect(canManageOrgMember('ADMIN', 'ADMIN')).toBe(false);
    expect(canManageOrgMember('ADMIN', 'MEMBER')).toBe(true);
    expect(canManageOrgMember('OWNER', 'OWNER')).toBe(true);
    expect(canManageOrgMember('MEMBER', 'VIEWER')).toBe(false);
  });

  const facts = (
    over: Partial<BookingFacts> = {},
    policy: Partial<OrgPolicy> = {},
  ): BookingFacts => ({
    policy: { ...DEFAULT_ORG_POLICY, ...policy },
    bookerRole: 'BOOKER',
    forSelf: false,
    categoryCode: 'CAR',
    fareNpr: 500,
    pickupZoneIds: ['z1'],
    dropoffZoneIds: ['z1'],
    costCenterId: null,
    spentThisMonthNpr: { organization: 0, passenger: 0 },
    ...over,
  });

  it('applies each policy rule, with denial before approval before allowed', () => {
    expect(evaluateBooking(facts()).outcome).toBe('ALLOWED');
    expect(evaluateBooking(facts({}, { allowedCategoryCodes: ['MOTORCYCLE'] })).outcome).toBe(
      'DENIED',
    );
    expect(evaluateBooking(facts({}, { allowedCategoryCodes: ['CAR'] })).outcome).toBe('ALLOWED');
    expect(evaluateBooking(facts({}, { allowedZoneIds: ['z2'] })).outcome).toBe('DENIED');
    expect(
      evaluateBooking(facts({ dropoffZoneIds: ['z2'] }, { allowedZoneIds: ['z1'] })).outcome,
    ).toBe('DENIED');
    expect(evaluateBooking(facts({}, { allowedZoneIds: ['z1'] })).outcome).toBe('ALLOWED');
    expect(evaluateBooking(facts({}, { costCenterRequired: true })).outcome).toBe('DENIED');
    expect(
      evaluateBooking(facts({ costCenterId: 'c' }, { costCenterRequired: true })).outcome,
    ).toBe('ALLOWED');
    expect(evaluateBooking(facts({}, { perRideLimitNpr: 499 })).outcome).toBe('DENIED');
    expect(evaluateBooking(facts({}, { perRideLimitNpr: 500 })).outcome).toBe('ALLOWED');
    expect(
      evaluateBooking(
        facts(
          { spentThisMonthNpr: { organization: 0, passenger: 600 } },
          { perMemberMonthlyLimitNpr: 1000 },
        ),
      ).outcome,
    ).toBe('DENIED');
    expect(
      evaluateBooking(
        facts(
          { spentThisMonthNpr: { organization: 600, passenger: 0 } },
          { monthlyLimitNpr: 1000 },
        ),
      ).outcome,
    ).toBe('DENIED');
    expect(
      evaluateBooking(
        facts(
          { spentThisMonthNpr: { organization: 500, passenger: 0 } },
          { monthlyLimitNpr: 1000 },
        ),
      ).outcome,
    ).toBe('ALLOWED');
    expect(
      evaluateBooking(facts({ bookerRole: 'MEMBER', forSelf: true }, { memberSelfBooking: false }))
        .outcome,
    ).toBe('DENIED');
    // approval
    expect(evaluateBooking(facts({}, { approvalOverNpr: 499 })).outcome).toBe('NEEDS_APPROVAL');
    expect(evaluateBooking(facts({}, { approvalOverNpr: 500 })).outcome).toBe('ALLOWED');
    expect(evaluateBooking(facts({}, { approvalForAll: true })).outcome).toBe('NEEDS_APPROVAL');
    // denial wins over approval
    expect(evaluateBooking(facts({}, { approvalForAll: true, perRideLimitNpr: 1 })).outcome).toBe(
      'DENIED',
    );
    // those who approve are not asked to approve their own, but are held to every limit
    expect(evaluateBooking(facts({ bookerRole: 'OWNER' }, { approvalForAll: true })).outcome).toBe(
      'ALLOWED',
    );
    expect(evaluateBooking(facts({ bookerRole: 'OWNER' }, { perRideLimitNpr: 1 })).outcome).toBe(
      'DENIED',
    );
    // every reason is in words
    expect(
      evaluateBooking(facts({}, { perRideLimitNpr: 1, costCenterRequired: true })).reasons,
    ).toHaveLength(2);
  });

  it('has approval and statement tables with one way out of the first state', () => {
    expect(ORG_APPROVAL_TRANSITIONS.PENDING).toHaveLength(4);
    for (const s of ['APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'] as const)
      expect(ORG_APPROVAL_TRANSITIONS[s]).toEqual([]);
    expect(ORG_STATEMENT_TRANSITIONS.ISSUED).toEqual(['PAID', 'VOID']);
    expect(ORG_STATEMENT_TRANSITIONS.PAID).toEqual([]);
    expect(ORG_PAYMENT_MODE_METHOD).toEqual({ ON_ACCOUNT: 'ORGANIZATION', EMPLOYEE_CASH: 'CASH' });
    expect(describePayment('ORGANIZATION', 'PENDING')).toBe('Billed to the organization');
    expect(describePayment('CASH', 'PENDING')).toBe('Awaiting cash');
  });
});

// ---------------------------------------------------------------- organizations and members

describe('organization creation', () => {
  it('makes the creator the owner, with the default policy, audited', async () => {
    const owner = await person('Olga Owner');
    const orgId = await createOrg(owner, 'Himal Travels');
    const o = await get(owner.accessToken, `/${orgId}`);
    expect(o.body.data).toMatchObject({ name: 'Himal Travels', myRole: 'OWNER', status: 'ACTIVE' });
    expect(o.body.data.myPermissions).toEqual([...ORG_PERMISSIONS]);
    const policy = await get(owner.accessToken, `/${orgId}/policy`);
    expect(pickPolicy(policy.body.data)).toEqual(DEFAULT_ORG_POLICY);
    expect(policy.body.data.categoryOptions.length).toBeGreaterThan(0);
    expect((await audits('ORG_CREATED')).length).toBe(1);
    expect((await get(owner.accessToken, '')).body.data.map((x: { id: string }) => x.id)).toEqual([
      orgId,
    ]);
  });

  it('is only for rider accounts, validates input and limits how many one person can start', async () => {
    const driver = await onboardUser('DRIVER');
    expect((await post(driver.accessToken, '', { name: 'Driver Co' })).status).toBe(403);
    expect((await api.post(base).send({ name: 'Anon' })).status).toBe(401);
    const adm = await admin(['ORGANIZATIONS_MANAGE']);
    expect((await post(adm.token, '', { name: 'Admin Co' })).status).toBe(403);
    const p = await person('Pat');
    expect((await post(p.accessToken, '', { name: 'x' })).status).toBe(400);
    expect(
      (await post(p.accessToken, '', { name: 'Fine Name', billingEmail: 'not-an-email' })).status,
    ).toBe(400);
    expect((await post(p.accessToken, '', { name: 'Fine Name', extra: true })).status).toBe(400);
    await setSetting('ORG_MAX_PER_USER', 1);
    try {
      await createOrg(p);
      const second = await post(p.accessToken, '', { name: 'Second Org' });
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('TOO_MANY_ORGANIZATIONS');
    } finally {
      await clearSetting('ORG_MAX_PER_USER');
    }
  });

  it('rate-limits creating organizations', async () => {
    await clearRedis();
    await setSetting('ORG_MAX_PER_USER', 20);
    try {
      const p = await person('Spammer');
      let last = 0;
      for (let i = 0; i < 6; i++)
        last = (await post(p.accessToken, '', { name: `Org number ${i}` })).status;
      expect(last).toBe(429);
    } finally {
      await clearSetting('ORG_MAX_PER_USER');
    }
  });
});

describe('member management', () => {
  it('invites by phone, never reveals whether a number has an account, and needs acceptance', async () => {
    const owner = await person('Olga');
    const orgId = await createOrg(owner);
    const known = await person('Kim Known');
    const a = await post(owner.accessToken, `/${orgId}/members`, {
      phoneNumber: known.phoneNumber,
      role: 'MEMBER',
    });
    const b = await post(owner.accessToken, `/${orgId}/members`, {
      phoneNumber: '+9779800000999',
      role: 'MEMBER',
    });
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body.data.message).toBe(b.body.data.message);
    expect(JSON.stringify(a.body)).not.toContain(known.phoneNumber);
    // not a member yet: cannot see the organization, but sees the invitation
    expect((await get(known.accessToken, `/${orgId}`)).status).toBe(404);
    const inv = (await get(known.accessToken, '/invitations')).body.data;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ organizationId: orgId, role: 'MEMBER' });
    expect((await post(known.accessToken, `/invitations/${orgId}/accept`)).status).toBe(200);
    expect((await get(known.accessToken, `/${orgId}`)).body.data.myRole).toBe('MEMBER');
    // already a member: a second invitation changes nothing
    await post(owner.accessToken, `/${orgId}/members`, {
      phoneNumber: known.phoneNumber,
      role: 'VIEWER',
    });
    expect((await get(known.accessToken, `/${orgId}`)).body.data.myRole).toBe('MEMBER');
    expect((await post(known.accessToken, `/invitations/${orgId}/accept`)).status).toBe(404);
    const note = await pool.query(
      "SELECT body FROM notifications WHERE user_id = $1 AND type = 'ORG_INVITED'",
      [id(known)],
    );
    expect(note.rows).toHaveLength(1);
    expect(note.rows[0].body).not.toContain(known.phoneNumber);
    expect((await audits('ORG_MEMBER_INVITED')).length).toBeGreaterThanOrEqual(1);
  });

  it('lets a person decline, and re-invites after removal', async () => {
    const owner = await person('Olga');
    const orgId = await createOrg(owner);
    const p = await person('Dee Decline');
    await post(owner.accessToken, `/${orgId}/members`, {
      phoneNumber: p.phoneNumber,
      role: 'MEMBER',
    });
    expect((await post(p.accessToken, `/invitations/${orgId}/decline`)).status).toBe(200);
    expect((await get(p.accessToken, '/invitations')).body.data).toHaveLength(0);
    await join(orgId, owner.accessToken, p, 'BOOKER');
    expect((await get(p.accessToken, `/${orgId}`)).body.data.myRole).toBe('BOOKER');
  });

  it('applies who may change whom, and protects the last owner, under concurrent changes', async () => {
    const w = await world();
    const members = (await get(w.owner.accessToken, `/${w.orgId}/members`)).body.data as Array<{
      id: string;
      userId: string;
      role: OrgRole;
      canChange: boolean;
    }>;
    const of = (u: OnboardedUser) => members.find((m) => m.userId === id(u))!;
    expect(members).toHaveLength(5);
    expect(of(w.owner).canChange).toBe(false); // not yourself
    expect(of(w.member).canChange).toBe(true);

    // an administrator cannot touch an owner or another administrator, nor make one
    const asAdmin = (await get(w.adminP.accessToken, `/${w.orgId}/members`)).body
      .data as typeof members;
    expect(asAdmin.find((m) => m.userId === id(w.owner))!.canChange).toBe(false);
    expect(
      (
        await patch(w.adminP.accessToken, `/${w.orgId}/members/${of(w.owner).id}`, {
          role: 'MEMBER',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await patch(w.adminP.accessToken, `/${w.orgId}/members/${of(w.member).id}`, {
          role: 'ADMIN',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await patch(w.adminP.accessToken, `/${w.orgId}/members/${of(w.member).id}`, {
          role: 'BOOKER',
        })
      ).status,
    ).toBe(200);
    expect((await del(w.adminP.accessToken, `/${w.orgId}/members/${of(w.owner).id}`)).status).toBe(
      403,
    );
    // others cannot manage anyone
    for (const u of [w.booker, w.viewer]) {
      expect(
        (await patch(u.accessToken, `/${w.orgId}/members/${of(w.member).id}`, { role: 'VIEWER' }))
          .status,
      ).toBe(403);
    }
    // not your own role
    expect(
      (
        await patch(w.owner.accessToken, `/${w.orgId}/members/${of(w.owner).id}`, {
          role: 'MEMBER',
        })
      ).status,
    ).toBe(409);

    // the last owner cannot leave or be demoted, even when two owners try to demote each other at once
    expect((await post(w.owner.accessToken, `/${w.orgId}/leave`)).body.error.code).toBe(
      'LAST_OWNER',
    );
    expect(
      (
        await patch(w.owner.accessToken, `/${w.orgId}/members/${of(w.adminP).id}`, {
          role: 'OWNER',
        })
      ).status,
    ).toBe(200);
    const [x, y] = await Promise.all([
      patch(w.owner.accessToken, `/${w.orgId}/members/${of(w.adminP).id}`, { role: 'MEMBER' }),
      patch(w.adminP.accessToken, `/${w.orgId}/members/${of(w.owner).id}`, { role: 'MEMBER' }),
    ]);
    const owners = await pool.query(
      "SELECT count(*)::int AS n FROM organization_members WHERE organization_id = $1 AND role = 'OWNER' AND status = 'ACTIVE'",
      [w.orgId],
    );
    expect(owners.rows[0].n).toBeGreaterThanOrEqual(1);
    // whoever ran second saw the other's change (their own role is read again under the lock)
    expect(
      [x.status, y.status].every((s) => [200, 403, 409].includes(s)),
      JSON.stringify([x.body, y.body]),
    ).toBe(true);
    expect([x.status, y.status]).toContain(200);
  });

  it('removes a member, withdraws what waited for them, and tells them', async () => {
    const w = await world();
    await setPolicy(w, { approvalForAll: true });
    const waiting = await book(w.member.accessToken, w.orgId);
    expect(waiting.status).toBe(202);
    const m = (await get(w.owner.accessToken, `/${w.orgId}/members`)).body.data.find(
      (x: { userId: string }) => x.userId === id(w.member),
    );
    expect((await del(w.owner.accessToken, `/${w.orgId}/members/${m.id}`)).status).toBe(200);
    expect((await get(w.member.accessToken, `/${w.orgId}`)).status).toBe(404);
    const a = await pool.query('SELECT status FROM organization_approvals WHERE id = $1', [
      waiting.body.data.approval.id,
    ]);
    expect(a.rows[0].status).toBe('CANCELLED');
    const note = await pool.query(
      "SELECT 1 FROM notifications WHERE user_id = $1 AND type = 'ORG_REMOVED'",
      [id(w.member)],
    );
    expect(note.rowCount).toBe(1);
    expect((await audits('ORG_MEMBER_REMOVED')).length).toBe(1);
  });
});

// ---------------------------------------------------------------- role permissions and isolation

describe('role permissions and authorization', () => {
  it('opens each endpoint to exactly the roles that hold its permission', async () => {
    const w = await world();
    const roles: Array<[OrgRole, OnboardedUser]> = [
      ['OWNER', w.owner],
      ['ADMIN', w.adminP],
      ['BOOKER', w.booker],
      ['MEMBER', w.member],
      ['VIEWER', w.viewer],
    ];
    const ghost = '00000000-0000-4000-8000-0000000000aa';
    const cases: Array<[string, (t: string) => Promise<{ status: number }>, OrgRole[]]> = [
      ['read organization', (t) => get(t, `/${w.orgId}`), ORG_ROLES.slice()],
      [
        'edit organization',
        (t) => put(t, `/${w.orgId}`, { name: 'Renamed Org' }),
        ['OWNER', 'ADMIN'],
      ],
      ['read policy', (t) => get(t, `/${w.orgId}/policy`), ORG_ROLES.slice()],
      ['activity', (t) => get(t, `/${w.orgId}/activity`), ['OWNER', 'ADMIN']],
      [
        'list members',
        (t) => get(t, `/${w.orgId}/members`),
        ['OWNER', 'ADMIN', 'BOOKER', 'VIEWER'],
      ],
      [
        'invite',
        (t) => post(t, `/${w.orgId}/members`, { phoneNumber: '+9779800000777', role: 'MEMBER' }),
        ['OWNER', 'ADMIN'],
      ],
      [
        'cost centre',
        (t) =>
          post(t, `/${w.orgId}/cost-centers`, {
            code: `C${Math.random().toString(36).slice(2, 8)}`,
            name: 'Ops',
          }),
        ['OWNER', 'ADMIN'],
      ],
      ['usage report', (t) => get(t, `/${w.orgId}/reports/usage`), ['OWNER', 'ADMIN', 'VIEWER']],
      ['statements', (t) => get(t, `/${w.orgId}/statements`), ['OWNER', 'ADMIN']],
      [
        'decide',
        (t) => post(t, `/${w.orgId}/approvals/${ghost}/decision`, { decision: 'DECLINE' }),
        ['OWNER', 'ADMIN'],
      ],
      ['rides', (t) => get(t, `/${w.orgId}/rides`), ORG_ROLES.slice()],
      ['approvals list', (t) => get(t, `/${w.orgId}/approvals`), ORG_ROLES.slice()],
    ];
    const wrong: string[] = [];
    for (const [name, call, allowed] of cases) {
      for (const [role, u] of roles) {
        const status = (await call(u.accessToken)).status;
        // asking to decide an approval that does not exist is a 404 for those who may decide, a 403 for the rest
        const granted = name === 'decide' ? status === 404 : status !== 403;
        if (granted !== allowed.includes(role)) wrong.push(`${name} as ${role}: ${status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('tells a stranger the organization does not exist, and keeps organizations apart', async () => {
    const w = await world();
    const other = await person('Other Owner');
    const otherOrg = await createOrg(other, 'Other Org');
    for (const path of [
      '',
      '/members',
      '/policy',
      '/rides',
      '/statements',
      '/reports/usage',
      '/approvals',
    ]) {
      expect((await get(w.outsider.accessToken, `/${w.orgId}${path}`)).status, path).toBe(404);
      expect((await get(w.owner.accessToken, `/${otherOrg}${path}`)).status, path).toBe(404);
    }
    expect((await book(w.outsider.accessToken, w.orgId)).status).toBe(404);
    expect((await get(w.owner.accessToken, '/not-a-uuid')).status).toBe(400);
    expect((await api.get(`${base}/${w.orgId}`)).status).toBe(401);
  });

  it('is separate from platform roles: an organization role grants no admin permission and an admin is no member', async () => {
    const w = await world();
    const adm = await admin(['ORGANIZATIONS_MANAGE', 'USERS_MANAGE']);
    for (const path of [`/${w.orgId}`, '']) expect((await get(adm.token, path)).status).toBe(403);
    expect(
      (await api.get('/api/v1/admin/organizations').set(auth(w.owner.accessToken))).status,
    ).toBe(403);
    expect((await api.get('/api/v1/admin/users').set(auth(w.owner.accessToken))).status).toBe(403);
  });

  it('refuses every platform route without the organization permission', async () => {
    const w = await world();
    const none = await admin(['OPERATIONS_VIEW']);
    const viewer = await admin(['ORGANIZATIONS_VIEW']);
    const manager = await admin(['ORGANIZATIONS_MANAGE']);
    const reads = ['', '/statements', `/${w.orgId}`];
    for (const p of reads) {
      expect((await adminGet(none.token, p)).status, p).toBe(403);
      expect((await adminGet(viewer.token, p)).status, p).toBe(200);
      expect((await adminGet(manager.token, p)).status, p).toBe(200);
    }
    for (const [p, b] of [
      [`/${w.orgId}/status`, { to: 'SUSPENDED', reason: 'testing' }],
      ['/statements/issue', {}],
      [
        '/statements/00000000-0000-4000-8000-000000000001/paid',
        { receivedNpr: 1, reference: 'ref' },
      ],
      ['/statements/00000000-0000-4000-8000-000000000001/void', { reason: 'testing' }],
    ] as Array<[string, object]>) {
      expect((await adminPost(viewer.token, p, b)).status, p).toBe(403);
      expect((await adminPost(none.token, p, b)).status, p).toBe(403);
    }
  });
});

// ---------------------------------------------------------------- corporate booking

describe('corporate booking', () => {
  it('books a ride for an employee: the booker and the rider are different people on one ordinary ride', async () => {
    const w = await world();
    const cc = await post(w.owner.accessToken, `/${w.orgId}/cost-centers`, {
      code: 'OPS',
      name: 'Operations',
      department: 'Logistics',
    });
    expect(cc.status).toBe(201);
    const b = await book(w.booker.accessToken, w.orgId, {
      passengerId: id(w.member),
      costCenterId: cc.body.data.id,
      purpose: 'Airport pickup',
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const t = await orgTrip(b.body.data.tripId);
    expect(t).toMatchObject({
      passenger_id: id(w.member),
      booked_by: id(w.booker),
      organization_id: w.orgId,
      cost_center_id: cc.body.data.id,
      purpose: 'Airport pickup',
      status: 'SEARCHING',
    });
    // the rider has it as their own ride, is told, and sees it is a business ride
    const mine = await api.get('/api/v1/trips/active').set(auth(w.member.accessToken));
    expect(mine.body.data.id).toBe(b.body.data.tripId);
    expect(mine.body.data.business).toMatchObject({
      purpose: 'Airport pickup',
      billedToOrganization: true,
      bookedByOther: true,
    });
    expect(mine.body.data.business.organizationName).toContain('Acme');
    const note = await pool.query(
      "SELECT body FROM notifications WHERE user_id = $1 AND type = 'ORG_RIDE_BOOKED_FOR_YOU'",
      [id(w.member)],
    );
    expect(note.rows).toHaveLength(1);
    expect(note.rows[0].body).not.toMatch(/Thamel|Patan|NPR/);
    // the booker is NOT a participant of the ride: the ride endpoints do not open it to them
    expect(
      (await api.get(`/api/v1/trips/${b.body.data.tripId}`).set(auth(w.booker.accessToken))).status,
    ).toBe(404);
    expect(
      (await api.get('/api/v1/trips/active').set(auth(w.booker.accessToken))).body.data,
    ).toBeNull();
    // but it is in the organization's history for the booker (they booked it)
    const hist = await get(w.booker.accessToken, `/${w.orgId}/rides`);
    expect(hist.body.data.items[0]).toMatchObject({
      tripId: b.body.data.tripId,
      bookedByName: 'Bina Booker',
      passengerName: 'Mina Member',
      costCenterCode: 'OPS',
      purpose: 'Airport pickup',
    });
    expect((await audits('ORG_RIDE_BOOKED')).length).toBe(1);
  });

  it('lets members book for themselves, bookers for anyone in the organization, and nobody else', async () => {
    const w = await world();
    expect((await book(w.member.accessToken, w.orgId)).status).toBe(201);
    expect((await book(w.member.accessToken, w.orgId, { passengerId: id(w.booker) })).status).toBe(
      403,
    );
    expect((await book(w.viewer.accessToken, w.orgId)).status).toBe(403);
    expect((await book(w.viewer.accessToken, w.orgId, { passengerId: id(w.member) })).status).toBe(
      403,
    );
    // for someone outside the organization
    const r = await book(w.booker.accessToken, w.orgId, { passengerId: id(w.outsider) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PASSENGER_NOT_MEMBER');
    // a booker can also ride themselves; the owner books for an administrator
    expect((await book(w.booker.accessToken, w.orgId)).status).toBe(201);
    expect((await book(w.owner.accessToken, w.orgId, { passengerId: id(w.adminP) })).status).toBe(
      201,
    );
    // one active ride per person still holds
    const again = await book(w.owner.accessToken, w.orgId, { passengerId: id(w.adminP) });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TRIP_ALREADY_ACTIVE');
    // an ordinary ride request is unaffected and carries no organization
    const plain = await api
      .post('/api/v1/trips/request')
      .set(auth(w.viewer.accessToken))
      .send(ride());
    expect(plain.status).toBe(201);
    expect((await orgTrip(plain.body.data.id)).organization_id).toBeNull();
  });

  it("uses the rider's default cost centre and requires one when the policy says so", async () => {
    const w = await world();
    await setPolicy(w, { costCenterRequired: true });
    const refused = await book(w.member.accessToken, w.orgId);
    expect(refused.status).toBe(422);
    expect(refused.body.error.details.reasons[0]).toMatch(/cost centre/i);
    const cc = (
      await post(w.owner.accessToken, `/${w.orgId}/cost-centers`, { code: 'HR', name: 'People' })
    ).body.data;
    const m = (await get(w.owner.accessToken, `/${w.orgId}/members`)).body.data.find(
      (x: { userId: string }) => x.userId === id(w.member),
    );
    expect(
      (
        await patch(w.owner.accessToken, `/${w.orgId}/members/${m.id}`, {
          defaultCostCenterId: cc.id,
        })
      ).status,
    ).toBe(200);
    const ok = await book(w.member.accessToken, w.orgId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await orgTrip(ok.body.data.tripId)).cost_center_id).toBe(cc.id);
    // another organization's cost centre is refused
    const other = await person('Other');
    const otherOrg = await createOrg(other);
    const foreign = (
      await post(other.accessToken, `/${otherOrg}/cost-centers`, { code: 'X', name: 'Foreign' })
    ).body.data;
    await pool.query("UPDATE trips SET status = 'CANCELLED' WHERE id = $1", [ok.body.data.tripId]);
    expect((await book(w.member.accessToken, w.orgId, { costCenterId: foreign.id })).status).toBe(
      400,
    );
  });

  it('refuses a booking the policy forbids, in words, and creates nothing', async () => {
    const w = await world();
    const fare = await fareOf(w);
    const trips = async () =>
      (
        await pool.query('SELECT count(*)::int AS n FROM trips WHERE organization_id = $1', [
          w.orgId,
        ])
      ).rows[0].n;

    await setPolicy(w, { allowedCategoryCodes: ['MOTORCYCLE'] });
    const cat = await book(w.member.accessToken, w.orgId);
    expect(cat.status).toBe(422);
    expect(cat.body.error.code).toBe('BOOKING_NOT_ALLOWED');
    expect(cat.body.error.message).toMatch(/vehicle type/i);

    await setPolicy(w, { allowedCategoryCodes: [], perRideLimitNpr: fare - 1 });
    expect((await book(w.member.accessToken, w.orgId)).status).toBe(422);

    await setPolicy(w, { perRideLimitNpr: null, memberSelfBooking: false });
    expect((await book(w.member.accessToken, w.orgId)).status).toBe(422);
    expect((await book(w.booker.accessToken, w.orgId, { passengerId: id(w.member) })).status).toBe(
      201,
    ); // a booker still can
    expect(await trips()).toBe(1);
    // zones: a wide service area, and a small zone around the pickup only
    const box = (half: number) => {
      const dLat = half / 111_195;
      const dLng = dLat / Math.cos((THAMEL.latitude * Math.PI) / 180);
      return JSON.stringify([
        [THAMEL.latitude - dLat, THAMEL.longitude - dLng],
        [THAMEL.latitude - dLat, THAMEL.longitude + dLng],
        [THAMEL.latitude + dLat, THAMEL.longitude + dLng],
        [THAMEL.latitude + dLat, THAMEL.longitude - dLng],
      ]);
    };
    const area = await pool.query(
      `INSERT INTO service_zones (code, name, kind, polygon) VALUES ('WIDE_AREA', 'Wide area', 'SERVICE_AREA', $1::jsonb) RETURNING id`,
      [box(9000)],
    );
    const small = await pool.query(
      `INSERT INTO service_zones (code, name, kind, polygon) VALUES ('THAMEL_ONLY', 'Thamel only', 'VENUE', $1::jsonb) RETURNING id`,
      [box(800)],
    );
    dropZoneCache();
    await setPolicy(w, { memberSelfBooking: true, allowedZoneIds: [small.rows[0].id] });
    const zone = await book(w.owner.accessToken, w.orgId, { passengerId: id(w.adminP) });
    expect(zone.status, JSON.stringify(zone.body)).toBe(422);
    expect(zone.body.error.message).toMatch(/areas/i);
    await setPolicy(w, { allowedZoneIds: [area.rows[0].id] });
    expect((await book(w.owner.accessToken, w.orgId, { passengerId: id(w.adminP) })).status).toBe(
      201,
    );
  });

  it('shows the policy decision before booking, without creating anything', async () => {
    const w = await world();
    await setPolicy(w, { approvalForAll: true });
    const p = await post(w.member.accessToken, `/${w.orgId}/bookings/preview`, ride());
    expect(p.body.data.outcome).toBe('NEEDS_APPROVAL');
    expect(p.body.data.fareNpr).toBeGreaterThan(0);
    const o = await post(w.owner.accessToken, `/${w.orgId}/bookings/preview`, ride());
    expect(o.body.data.outcome).toBe('ALLOWED');
    expect((await post(w.viewer.accessToken, `/${w.orgId}/bookings/preview`, ride())).status).toBe(
      403,
    );
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM trips WHERE organization_id = $1', [
          w.orgId,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM organization_approvals')).rows[0].n,
    ).toBe(0);
  });

  it('refuses a restricted rider, a changed fare, and a suspended organization', async () => {
    const w = await world();
    await pool.query(
      `INSERT INTO risk_profiles (user_id, restricted_until, restriction_source) VALUES ($1, now() + interval '1 day', 'ADMIN')`,
      [id(w.member)],
    );
    const r = await book(w.booker.accessToken, w.orgId, { passengerId: id(w.member) });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.error.code).toBe('ACCOUNT_RESTRICTED');
    const fare = await book(w.owner.accessToken, w.orgId, { confirmedTotalNpr: 1 });
    expect(fare.status).toBe(409);
    expect(fare.body.error.code).toBe('FARE_CHANGED');
    const adm = await admin(['ORGANIZATIONS_MANAGE']);
    expect(
      (
        await adminPost(adm.token, `/${w.orgId}/status`, {
          to: 'SUSPENDED',
          reason: 'Unpaid invoices',
        })
      ).status,
    ).toBe(200);
    const s = await book(w.owner.accessToken, w.orgId);
    expect(s.status).toBe(409);
    expect(s.body.error.code).toBe('ORGANIZATION_SUSPENDED');
  });
});

// ---------------------------------------------------------------- approvals

describe('approval workflow', () => {
  it('holds a ride that needs approval, then creates it when an approver says yes', async () => {
    const w = await world();
    await setPolicy(w, { approvalForAll: true });
    const b = await book(w.booker.accessToken, w.orgId, {
      passengerId: id(w.member),
      purpose: 'Client visit',
    });
    expect(b.status, JSON.stringify(b.body)).toBe(202);
    expect(b.body.data).toMatchObject({ outcome: 'NEEDS_APPROVAL', tripId: null });
    const a = b.body.data.approval;
    expect(a).toMatchObject({
      status: 'PENDING',
      requestedByName: 'Bina Booker',
      passengerName: 'Mina Member',
      canDecide: false,
      canCancel: true,
    });
    // nothing was dispatched
    expect((await pool.query('SELECT count(*)::int AS n FROM trips')).rows[0].n).toBe(0);
    // the approvers (not the requester) were told, without details
    const told = await pool.query(
      "SELECT user_id, body FROM notifications WHERE type = 'ORG_APPROVAL_NEEDED'",
    );
    expect(told.rows.map((r) => r.user_id).sort()).toEqual([id(w.owner), id(w.adminP)].sort());
    expect(told.rows[0].body).not.toMatch(/Thamel|Patan|NPR|Mina/);
    // who can see and decide
    expect((await get(w.member.accessToken, `/${w.orgId}/approvals`)).body.data).toHaveLength(1); // it is for them
    expect((await get(w.viewer.accessToken, `/${w.orgId}/approvals`)).body.data).toHaveLength(0);
    const asOwner = (await get(w.owner.accessToken, `/${w.orgId}/approvals`)).body.data[0];
    expect(asOwner.canDecide).toBe(true);
    expect(
      (
        await post(w.booker.accessToken, `/${w.orgId}/approvals/${a.id}/decision`, {
          decision: 'APPROVE',
        })
      ).status,
    ).toBe(403);

    const ok = await post(w.owner.accessToken, `/${w.orgId}/approvals/${a.id}/decision`, {
      decision: 'APPROVE',
      note: 'Fine',
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: 'APPROVED',
      decisionNote: 'Fine',
      decidedByName: 'Olga Owner',
    });
    const t = await orgTrip(ok.body.data.tripId);
    expect(t).toMatchObject({
      passenger_id: id(w.member),
      booked_by: id(w.booker),
      organization_id: w.orgId,
      purpose: 'Client visit',
    });
    expect((await audits('ORG_APPROVAL_APPROVED')).length).toBe(1);
    // decided once
    expect(
      (
        await post(w.adminP.accessToken, `/${w.orgId}/approvals/${a.id}/decision`, {
          decision: 'DECLINE',
        })
      ).status,
    ).toBe(409);
  });

  it('exempts approvers from approving their own rides but not from the limits, and lets people withdraw or be declined', async () => {
    const w = await world();
    await setPolicy(w, { approvalForAll: true });
    expect((await book(w.owner.accessToken, w.orgId)).status).toBe(201); // an approver books freely
    const waiting = await book(w.member.accessToken, w.orgId, { purpose: 'Meeting' });
    // cancel (only by the one who asked)
    expect(
      (
        await post(
          w.booker.accessToken,
          `/${w.orgId}/approvals/${waiting.body.data.approval.id}/cancel`,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await post(
          w.member.accessToken,
          `/${w.orgId}/approvals/${waiting.body.data.approval.id}/cancel`,
        )
      ).status,
    ).toBe(200);
    // decline
    const second = await book(w.member.accessToken, w.orgId);
    const d = await post(
      w.adminP.accessToken,
      `/${w.orgId}/approvals/${second.body.data.approval.id}/decision`,
      { decision: 'DECLINE', note: 'Use the bus' },
    );
    expect(d.body.data).toMatchObject({ status: 'DECLINED', decisionNote: 'Use the bus' });
    const told = await pool.query(
      "SELECT body FROM notifications WHERE user_id = $1 AND type = 'ORG_APPROVAL_DECIDED'",
      [id(w.member)],
    );
    expect(told.rows.length).toBe(1);
    // the approver may not decide their own request
    await pool.query("UPDATE organization_members SET role = 'ADMIN' WHERE user_id = $1", [
      id(w.booker),
    ]);
    await pool.query(
      "UPDATE organization_approvals SET status = 'PENDING', decided_by = NULL WHERE id = $1",
      [second.body.data.approval.id],
    );
    await pool.query('UPDATE organization_approvals SET requested_by = $2 WHERE id = $1', [
      second.body.data.approval.id,
      id(w.booker),
    ]);
    const own = await post(
      w.booker.accessToken,
      `/${w.orgId}/approvals/${second.body.data.approval.id}/decision`,
      { decision: 'APPROVE' },
    );
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe('OWN_REQUEST');
  });

  it('lets exactly one of two approvers decide, and keeps a request waiting when the ride cannot be created', async () => {
    const w = await world();
    await setPolicy(w, { approvalForAll: true });
    const b = await book(w.member.accessToken, w.orgId);
    const aid = b.body.data.approval.id;
    const [x, y] = await Promise.all([
      post(w.owner.accessToken, `/${w.orgId}/approvals/${aid}/decision`, { decision: 'APPROVE' }),
      post(w.adminP.accessToken, `/${w.orgId}/approvals/${aid}/decision`, { decision: 'APPROVE' }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM trips WHERE organization_id = $1', [
          w.orgId,
        ])
      ).rows[0].n,
    ).toBe(1);
    expect((await audits('ORG_APPROVAL_APPROVED')).length).toBe(1);

    // a rider who is already on a ride: approving fails, the request is still waiting
    const again = await book(w.member.accessToken, w.orgId);
    expect(again.status).toBe(202);
    const blocked = await post(
      w.owner.accessToken,
      `/${w.orgId}/approvals/${again.body.data.approval.id}/decision`,
      { decision: 'APPROVE' },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('TRIP_ALREADY_ACTIVE');
    const row = await pool.query(
      'SELECT status, trip_id FROM organization_approvals WHERE id = $1',
      [again.body.data.approval.id],
    );
    expect(row.rows[0]).toEqual({ status: 'PENDING', trip_id: null });
  });

  it('re-applies the policy when approving, expires old requests and restores a stuck approval', async () => {
    const w = await world();
    await setPolicy(w, { approvalForAll: true });
    const b = await book(w.member.accessToken, w.orgId);
    const aid = b.body.data.approval.id;
    // limits tightened while it waited
    await setPolicy(w, { approvalForAll: true, perRideLimitNpr: 1 });
    const refused = await post(w.owner.accessToken, `/${w.orgId}/approvals/${aid}/decision`, {
      decision: 'APPROVE',
    });
    expect(refused.status).toBe(422);
    expect(
      (await pool.query('SELECT status FROM organization_approvals WHERE id = $1', [aid])).rows[0]
        .status,
    ).toBe('PENDING');
    // expiry
    await pool.query(
      "UPDATE organization_approvals SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [aid],
    );
    const late = await post(w.owner.accessToken, `/${w.orgId}/approvals/${aid}/decision`, {
      decision: 'APPROVE',
    });
    expect(late.status).toBe(409);
    expect(
      (await pool.query('SELECT status FROM organization_approvals WHERE id = $1', [aid])).rows[0]
        .status,
    ).toBe('EXPIRED');
    // the sweep expires and tells, and restores an approval that never became a ride
    await setPolicy(w, { approvalForAll: true, perRideLimitNpr: null });
    const c = await book(w.member.accessToken, w.orgId);
    await pool.query(
      "UPDATE organization_approvals SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [c.body.data.approval.id],
    );
    const d = await book(w.booker.accessToken, w.orgId, { passengerId: id(w.adminP) });
    await pool.query(
      "UPDATE organization_approvals SET status = 'APPROVED', decided_at = now() - interval '5 minutes' WHERE id = $1",
      [d.body.data.approval.id],
    );
    const swept = await sweepApprovals();
    expect(swept).toEqual({ expired: 1, restored: 1 });
    expect(
      (
        await pool.query('SELECT status FROM organization_approvals WHERE id = $1', [
          d.body.data.approval.id,
        ])
      ).rows[0].status,
    ).toBe('PENDING');
    expect(await sweepApprovals()).toEqual({ expired: 0, restored: 0 });
  });
});

// ---------------------------------------------------------------- spending limits

describe('spending limits', () => {
  it('stops at the monthly limit even when two members book at the same moment', async () => {
    const w = await world();
    const fare = await fareOf(w);
    await setPolicy(w, { monthlyLimitNpr: fare + Math.floor(fare / 2) });
    const [a, b] = await Promise.all([
      book(w.member.accessToken, w.orgId),
      book(w.booker.accessToken, w.orgId),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);
    const refused = a.status === 422 ? a : b;
    expect(refused.body.error.message).toMatch(/monthly limit/i);
    expect(
      (
        await pool.query('SELECT count(*)::int AS n FROM trips WHERE organization_id = $1', [
          w.orgId,
        ])
      ).rows[0].n,
    ).toBe(1);
  });

  it('applies a per-member monthly limit to that rider only, and frees it when a ride is cancelled', async () => {
    const w = await world();
    const fare = await fareOf(w);
    await setPolicy(w, { perMemberMonthlyLimitNpr: fare + 1 });
    const first = await book(w.member.accessToken, w.orgId);
    expect(first.status).toBe(201);
    await api
      .post(`/api/v1/trips/${first.body.data.tripId}/cancel`)
      .set(auth(w.member.accessToken))
      .send({});
    const second = await book(w.member.accessToken, w.orgId); // the cancelled ride cost nothing
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    await api
      .post(`/api/v1/trips/${second.body.data.tripId}/cancel`)
      .set(auth(w.member.accessToken))
      .send({});
    // two rides active for one rider is impossible, so check the limit with a finished-cost row instead
    await pool.query(
      `UPDATE trips SET status = 'COMPLETED', fare_final_npr = $2, ended_at = now() WHERE id = $1`,
      [second.body.data.tripId, fare],
    );
    const over = await book(w.member.accessToken, w.orgId);
    expect(over.status).toBe(422);
    expect(over.body.error.message).toMatch(/rider's monthly limit/i);
    // someone else is unaffected
    expect((await book(w.booker.accessToken, w.orgId)).status).toBe(201);
  });
});

// ---------------------------------------------------------------- billing and statements

describe('corporate billing on the existing payment records', () => {
  it('bills an on-account ride to the organization: nothing for the driver to collect', async () => {
    const w = await world();
    const tripId = await finishBusinessRide(w, w.booker.accessToken, w.member);
    const p = await payment(tripId);
    expect(p).toMatchObject({ method: 'ORGANIZATION', status: 'PENDING', statement_id: null });
    expect(p.amount_npr).toBe((await orgTrip(tripId)).fare_final_npr);
    const confirm = await api
      .post(`/api/v1/trips/${tripId}/payment/confirm`)
      .set(auth(w.driver.accessToken));
    expect(confirm.status).toBe(409);
    expect(confirm.body.error.code).toBe('BILLED_TO_ORGANIZATION');
    expect((await payment(tripId)).status).toBe('PENDING');
    // the driver's and rider's own views say so
    const mine = await api.get(`/api/v1/trips/${tripId}`).set(auth(w.driver.accessToken));
    expect(mine.body.data.business).toMatchObject({ billedToOrganization: true });
    const hist = await get(w.booker.accessToken, `/${w.orgId}/rides`);
    expect(hist.body.data.items[0]).toMatchObject({
      costNpr: p.amount_npr,
      paymentStatus: 'Billed to the organization',
      statementNumber: null,
    });
  }, 90_000);

  it('leaves an employee-cash ride as cash, tagged to the organization', async () => {
    const w = await world();
    await setPolicy(w, { paymentMode: 'EMPLOYEE_CASH' });
    const tripId = await finishBusinessRide(w, w.member.accessToken, w.member);
    expect((await payment(tripId)).method).toBe('CASH');
    expect(
      (await api.post(`/api/v1/trips/${tripId}/payment/confirm`).set(auth(w.driver.accessToken)))
        .status,
    ).toBe(200);
    expect((await payment(tripId)).status).toBe('PAID');
    const hist = await get(w.owner.accessToken, `/${w.orgId}/rides`);
    expect(hist.body.data.items[0].paymentStatus).toBe('Paid in cash');
    // cash rides are never on a statement
    await inLastMonth(tripId);
    expect((await issueStatements(undefined, null)).issued).toBe(0);
  }, 90_000);

  it('issues a monthly statement that groups the payments, once, and totals exactly their sum', async () => {
    const w = await world();
    const cc = (
      await post(w.owner.accessToken, `/${w.orgId}/cost-centers`, { code: 'SAL', name: 'Sales' })
    ).body.data;
    const t1 = await finishBusinessRide(w, w.booker.accessToken, w.member, {
      costCenterId: cc.id,
      purpose: 'Client A',
    });
    const t2 = await finishBusinessRide(w, w.owner.accessToken, w.adminP);
    await inLastMonth(t1, 3);
    await inLastMonth(t2, 5);
    const key = await previousPeriodKey();
    const sum = (await payment(t1)).amount_npr + (await payment(t2)).amount_npr;

    // the current month cannot be billed
    const nowKey = (await pool.query("SELECT to_char(now(), 'YYYY-MM') AS k")).rows[0].k;
    await expect(issueStatements(nowKey, null)).rejects.toMatchObject({
      code: 'PERIOD_NOT_FINISHED',
    });

    const run = await issueStatements(key, null);
    expect(run).toEqual({ periodKey: key, issued: 1, skipped: 0 });
    // running it again, or from two places at once, issues nothing more
    const [r2, r3] = await Promise.all([issueStatements(key, null), issueStatements(key, null)]);
    expect(r2.issued + r3.issued).toBe(0);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM organization_statements')).rows[0].n,
    ).toBe(1);

    const list = (await get(w.owner.accessToken, `/${w.orgId}/statements`)).body.data;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ periodKey: key, status: 'ISSUED', rides: 2, totalNpr: sum });
    const detail = (await get(w.owner.accessToken, `/${w.orgId}/statements/${list[0].id}`)).body
      .data;
    expect(detail.lines.reduce((s: number, l: { amountNpr: number }) => s + l.amountNpr, 0)).toBe(
      sum,
    );
    expect(
      detail.byCostCenter.reduce((s: number, g: { totalNpr: number }) => s + g.totalNpr, 0),
    ).toBe(sum);
    expect(detail.byCostCenter.find((g: { code: string | null }) => g.code === 'SAL').rides).toBe(
      1,
    );
    expect(detail.lines.find((l: { tripId: string }) => l.tripId === t1)).toMatchObject({
      purpose: 'Client A',
      passengerName: 'Mina Member',
      bookedByName: 'Bina Booker',
    });
    // every payment is on one statement, the rides show it
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM trip_payments WHERE statement_id IS NOT NULL',
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (await get(w.owner.accessToken, `/${w.orgId}/rides`)).body.data.items.every(
        (r: { statementNumber: number }) => r.statementNumber === list[0].number,
      ),
    ).toBe(true);
    // the people who pay were told, with no amounts of rides in it
    const told = await pool.query(
      "SELECT user_id FROM notifications WHERE type = 'ORG_STATEMENT_ISSUED'",
    );
    expect(told.rows.map((r) => r.user_id).sort()).toEqual([id(w.owner), id(w.adminP)].sort());
    // only people who hold BILLING_VIEW can see it; another organization's statement is not found
    for (const u of [w.booker, w.member, w.viewer]) {
      expect((await get(u.accessToken, `/${w.orgId}/statements`)).status).toBe(403);
    }
    const other = await person('Other');
    const otherOrg = await createOrg(other);
    expect((await get(other.accessToken, `/${otherOrg}/statements/${list[0].id}`)).status).toBe(
      404,
    );
    // a late ride rolls into the next statement, never into the issued one
    const t3 = await finishBusinessRide(w, w.owner.accessToken, w.adminP);
    await inLastMonth(t3, 6);
    expect((await issueStatements(key, null)).issued).toBe(0);
    expect((await payment(t3)).statement_id).toBeNull();
    expect((await audits('ORG_STATEMENT_ISSUED')).length).toBe(1);
  }, 180_000);

  it('records a payment once, for the exact total, in one step for every payment on it', async () => {
    const w = await world();
    const t1 = await finishBusinessRide(w, w.owner.accessToken, w.member);
    const t2 = await finishBusinessRide(w, w.owner.accessToken, w.adminP);
    await inLastMonth(t1, 3);
    await inLastMonth(t2, 4);
    await issueStatements(undefined, null);
    const adm = await admin(['ORGANIZATIONS_MANAGE']);
    const viewer = await admin(['ORGANIZATIONS_VIEW']);
    const s = (await adminGet(adm.token, '/statements')).body.data.items[0];
    expect(s.totalNpr).toBe((await payment(t1)).amount_npr + (await payment(t2)).amount_npr);

    expect(
      (
        await adminPost(viewer.token, `/statements/${s.id}/paid`, {
          receivedNpr: s.totalNpr,
          reference: 'BANK-1',
        })
      ).status,
    ).toBe(403);
    const short = await adminPost(adm.token, `/statements/${s.id}/paid`, {
      receivedNpr: s.totalNpr - 1,
      reference: 'BANK-1',
    });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('AMOUNT_MISMATCH');
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM trip_payments WHERE status = 'PAID'"))
        .rows[0].n,
    ).toBe(0);

    const [x, y] = await Promise.all([
      adminPost(adm.token, `/statements/${s.id}/paid`, {
        receivedNpr: s.totalNpr,
        reference: 'BANK-1',
      }),
      adminPost(adm.token, `/statements/${s.id}/paid`, {
        receivedNpr: s.totalNpr,
        reference: 'BANK-1',
      }),
    ]);
    expect([x.status, y.status]).toEqual([200, 200]);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM trip_payments WHERE status = 'PAID'"))
        .rows[0].n,
    ).toBe(2);
    expect((await audits('ORG_STATEMENT_PAID')).length).toBe(1); // recorded once
    const events = await pool.query(
      "SELECT count(*)::int AS n FROM trip_events WHERE type = 'PAYMENT_RECEIVED' AND trip_id = ANY($1)",
      [[t1, t2]],
    );
    expect(events.rows[0].n).toBe(2);
    const paid = (await adminGet(adm.token, `/statements/${s.id}`)).body.data;
    expect(paid).toMatchObject({ status: 'PAID', paidReference: 'BANK-1', totalNpr: s.totalNpr });
    // a different reference for a paid statement is refused, and a paid statement cannot be cancelled
    expect(
      (
        await adminPost(adm.token, `/statements/${s.id}/paid`, {
          receivedNpr: s.totalNpr,
          reference: 'OTHER',
        })
      ).status,
    ).toBe(409);
    expect(
      (await adminPost(adm.token, `/statements/${s.id}/void`, { reason: 'Oops' })).status,
    ).toBe(409);
    expect((await payment(t1)).amount_npr + (await payment(t2)).amount_npr).toBe(s.totalNpr); // amounts never move
    const hist = await get(w.owner.accessToken, `/${w.orgId}/rides`);
    expect(hist.body.data.items[0].paymentStatus).toBe('Paid by the organization');

    // a ride billed to an organization is not refunded to the rider
    const ticket = await api.post('/api/v1/support/tickets').set(auth(w.member.accessToken)).send({
      categoryCode: 'RIDE_FARE',
      subject: 'Fare problem',
      body: 'I was charged too much',
      tripId: t1,
    });
    expect(ticket.status, JSON.stringify(ticket.body)).toBe(201);
    const refund = await api
      .post(`/api/v1/support/tickets/${ticket.body.data.id}/refund`)
      .set(auth(w.member.accessToken))
      .send({ reason: 'FULL_FARE' });
    expect(refund.status).toBe(409);
    expect(refund.body.error.code).toBe('BILLED_TO_ORGANIZATION');
  }, 180_000);

  it('cancels an unpaid statement so its rides are billed again on the next one', async () => {
    const w = await world();
    const t1 = await finishBusinessRide(w, w.owner.accessToken, w.member);
    await inLastMonth(t1, 3);
    await issueStatements(undefined, null);
    const adm = await admin(['ORGANIZATIONS_MANAGE']);
    const s = (await adminGet(adm.token, '/statements')).body.data.items[0];
    expect((await adminPost(adm.token, `/statements/${s.id}/void`, { reason: 'x' })).status).toBe(
      400,
    );
    const v = await adminPost(adm.token, `/statements/${s.id}/void`, {
      reason: 'Issued by mistake',
    });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.data).toMatchObject({ status: 'VOID', rides: 0, totalNpr: 0 });
    expect((await payment(t1)).statement_id).toBeNull();
    expect(
      (
        await adminPost(adm.token, `/statements/${s.id}/paid`, {
          receivedNpr: 0,
          reference: 'zero',
        })
      ).status,
    ).toBe(409);
    const again = await issueStatements(undefined, null);
    expect(again.issued).toBe(1);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM organization_statements WHERE status = 'ISSUED'",
        )
      ).rows[0].n,
    ).toBe(1);
    expect((await audits('ORG_STATEMENT_VOIDED')).length).toBe(1);
  }, 120_000);

  it('lists statements for the platform with filters and totals that match the payments', async () => {
    const w = await world();
    const t1 = await finishBusinessRide(w, w.owner.accessToken, w.member);
    await inLastMonth(t1, 2);
    await issueStatements(undefined, null);
    const adm = await admin(['ORGANIZATIONS_VIEW']);
    const all = (await adminGet(adm.token, '/statements')).body.data;
    expect(all.total).toBe(1);
    expect(all.items[0]).toMatchObject({ organizationId: w.orgId, rides: 1, status: 'ISSUED' });
    expect((await adminGet(adm.token, '/statements?status=PAID')).body.data.total).toBe(0);
    expect((await adminGet(adm.token, '/statements?status=NOPE')).status).toBe(400);
    const orgs = (await adminGet(adm.token, '')).body.data;
    expect(orgs.items[0]).toMatchObject({
      id: w.orgId,
      members: 5,
      outstandingNpr: (await payment(t1)).amount_npr,
    });
    const detail = (await adminGet(adm.token, `/${w.orgId}`)).body.data;
    expect(detail.owners).toEqual([{ userId: id(w.owner), name: 'Olga Owner' }]);
    expect(detail.statements).toHaveLength(1);
    expect((await audits('ORG_VIEWED_BY_STAFF')).length).toBe(1);
  }, 120_000);
});

// ---------------------------------------------------------------- history, reports, privacy, suspension

describe('history, reports and privacy', () => {
  it('shows each person only what their role allows, and no live location or contact details', async () => {
    const w = await world();
    const cc = (
      await post(w.owner.accessToken, `/${w.orgId}/cost-centers`, {
        code: 'ENG',
        name: 'Engineering',
      })
    ).body.data;
    await finishBusinessRide(w, w.booker.accessToken, w.member, { costCenterId: cc.id });
    const adminRide = await book(w.owner.accessToken, w.orgId, { passengerId: id(w.adminP) });
    expect(adminRide.status).toBe(201);
    const count = async (u: OnboardedUser) =>
      (await get(u.accessToken, `/${w.orgId}/rides`)).body.data.total;
    expect(await count(w.owner)).toBe(2);
    expect(await count(w.viewer)).toBe(2); // sees all rides
    expect(await count(w.booker)).toBe(1); // booked one
    expect(await count(w.member)).toBe(1); // rode one
    expect(await count(w.adminP)).toBe(2); // admins see all
    const text = JSON.stringify((await get(w.owner.accessToken, `/${w.orgId}/rides`)).body);
    expect(text).not.toMatch(/phoneNumber|latitude|longitude|\+977/);
    const filtered = await get(w.owner.accessToken, `/${w.orgId}/rides?costCenterId=${cc.id}`);
    expect(filtered.body.data.total).toBe(1);
  }, 90_000);

  it('reports usage by month, cost centre, member and vehicle type from the same rides', async () => {
    const w = await world();
    const cc = (
      await post(w.owner.accessToken, `/${w.orgId}/cost-centers`, { code: 'FIN', name: 'Finance' })
    ).body.data;
    await finishBusinessRide(w, w.owner.accessToken, w.member, { costCenterId: cc.id });
    const t2 = await book(w.owner.accessToken, w.orgId, { passengerId: id(w.adminP) });
    await api
      .post(`/api/v1/trips/${t2.body.data.tripId}/cancel`)
      .set(auth(w.adminP.accessToken))
      .send({});
    const rep = (await get(w.viewer.accessToken, `/${w.orgId}/reports/usage?range=30d`)).body.data;
    expect(rep).toMatchObject({ rides: 2, completed: 1, cancelled: 1 });
    const paid = (await pool.query('SELECT sum(amount_npr)::int AS s FROM trip_payments')).rows[0]
      .s;
    expect(rep.spendNpr).toBe(paid); // a cancelled ride costs nothing; a finished one is its payment
    expect(rep.byCostCenter.find((c: { code: string }) => c.code === 'FIN')).toMatchObject({
      rides: 1,
      spendNpr: paid,
    });
    expect(rep.byCostCenter.reduce((s: number, c: { spendNpr: number }) => s + c.spendNpr, 0)).toBe(
      paid,
    );
    expect(rep.byMember.reduce((s: number, c: { spendNpr: number }) => s + c.spendNpr, 0)).toBe(
      paid,
    );
    expect(rep.byCategory.reduce((s: number, c: { rides: number }) => s + c.rides, 0)).toBe(2);
    expect(rep.byMonth).toHaveLength(1);
    expect(rep.range.label).toBeTruthy();
    expect(
      (await get(w.viewer.accessToken, `/${w.orgId}/reports/usage?from=2026-01-01`)).status,
    ).toBe(400);
    expect((await get(w.booker.accessToken, `/${w.orgId}/reports/usage`)).status).toBe(403);
  }, 120_000);

  it('records every administrative change in the audit trail, visible to those who manage the organization', async () => {
    const w = await world();
    await setPolicy(w, { approvalOverNpr: 5000 });
    await post(w.owner.accessToken, `/${w.orgId}/cost-centers`, { code: 'A1', name: 'Alpha' });
    const act = (await get(w.owner.accessToken, `/${w.orgId}/activity`)).body.data as Array<{
      action: string;
      actorName: string | null;
    }>;
    const actions = act.map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'ORG_CREATED',
        'ORG_MEMBER_INVITED',
        'ORG_MEMBER_JOINED',
        'ORG_POLICY_CHANGED',
        'ORG_COST_CENTER_ADDED',
      ]),
    );
    expect(act.find((a) => a.action === 'ORG_POLICY_CHANGED')!.actorName).toBe('Olga Owner');
    expect((await put(w.booker.accessToken, `/${w.orgId}/policy`, DEFAULT_ORG_POLICY)).status).toBe(
      403,
    );
    const bad = await put(w.owner.accessToken, `/${w.orgId}/policy`, {
      ...DEFAULT_ORG_POLICY,
      allowedCategoryCodes: ['NOPE'],
    });
    expect(bad.status).toBe(400);
    expect(
      (
        await put(w.owner.accessToken, `/${w.orgId}/policy`, {
          ...DEFAULT_ORG_POLICY,
          monthlyLimitNpr: -5,
        })
      ).status,
    ).toBe(400);
    expect(
      (await put(w.owner.accessToken, `/${w.orgId}/policy`, { ...DEFAULT_ORG_POLICY, bonus: 1 }))
        .status,
    ).toBe(400);
    const dup = await post(w.owner.accessToken, `/${w.orgId}/cost-centers`, {
      code: 'a1',
      name: 'Again',
    });
    expect(dup.status).toBe(409);
  });
});

describe('suspension and accounts', () => {
  it('lets the platform suspend and reactivate an organization, with a reason, withdrawing waiting approvals', async () => {
    const w = await world();
    await setPolicy(w, { approvalForAll: true });
    const waiting = await book(w.member.accessToken, w.orgId);
    const adm = await admin(['ORGANIZATIONS_MANAGE']);
    expect(
      (await adminPost(adm.token, `/${w.orgId}/status`, { to: 'SUSPENDED', reason: 'x' })).status,
    ).toBe(400);
    const s = await adminPost(adm.token, `/${w.orgId}/status`, {
      to: 'SUSPENDED',
      reason: 'Statements overdue',
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.data.status).toBe('SUSPENDED');
    expect(
      (
        await adminPost(adm.token, `/${w.orgId}/status`, {
          to: 'SUSPENDED',
          reason: 'Again please',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await pool.query('SELECT status FROM organization_approvals WHERE id = $1', [
          waiting.body.data.approval.id,
        ])
      ).rows[0].status,
    ).toBe('CANCELLED');
    expect(
      (
        await post(
          w.owner.accessToken,
          `/${w.orgId}/approvals/${waiting.body.data.approval.id}/decision`,
          { decision: 'APPROVE' },
        )
      ).status,
    ).toBe(409);
    // still readable, so people can see why and what is owed
    expect((await get(w.owner.accessToken, `/${w.orgId}`)).body.data.status).toBe('SUSPENDED');
    expect(
      (await adminPost(adm.token, `/${w.orgId}/status`, { to: 'ACTIVE', reason: 'Paid up' }))
        .status,
    ).toBe(200);
    expect((await book(w.owner.accessToken, w.orgId)).status).toBe(201);
    const log = await pool.query(
      "SELECT action, detail FROM audit_log WHERE action IN ('ORG_SUSPENDED', 'ORG_REACTIVATED') ORDER BY id",
    );
    expect(log.rows.map((r) => r.action)).toEqual(['ORG_SUSPENDED', 'ORG_REACTIVATED']);
    expect(log.rows[0].detail.reason).toBe('Statements overdue');
    const told = await pool.query("SELECT 1 FROM notifications WHERE type = 'ORG_SUSPENDED'");
    expect(told.rowCount).toBe(2); // owner and administrator
  });

  it('will not let the only owner of an organization delete their account', async () => {
    const w = await world();
    const { deletionBlockers } = await import('../modules/compliance/data-requests.service');
    expect((await deletionBlockers(id(w.owner))).join(' ')).toMatch(/only owner/);
    expect(await deletionBlockers(id(w.member))).toEqual([]);
  });
});
