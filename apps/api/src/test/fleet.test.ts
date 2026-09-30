import {
  OPERATIONAL_STATES,
  OPERATIONAL_TRANSITIONS,
  VEHICLE_LIFECYCLE_STATES,
  VEHICLE_LIFECYCLE_TRANSITIONS,
  canOperationalTransition,
  canVehicleTransition,
  daysUntil,
  describeExpiry,
  describeOperationalStatus,
  describeVehicleLifecycle,
  expiryState,
  reminderStage,
  vehicleLifecycleLeadingTo,
  type AdminPermission,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { evaluateDriverEligibility } from '../modules/availability/eligibility';
import { findEligibleDrivers } from '../modules/dispatch/matching';
import { vehicleRideProblems } from '../modules/fleet/eligibility';
import { expiryItems, todayKey } from '../modules/fleet/expiry.service';
import { runFleetMonitor } from '../modules/fleet/monitor';
import { refreshSettings } from '../modules/settings/settings.service';
import { api, createVerifiedDriver, loginTestAdmin, onboardUser } from './helpers';
import { THAMEL, auth, putDriverOnline } from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
async function admin(permissions: AdminPermission[] = ['FLEET_MANAGE']) {
  const email = `fleet-admin-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1', permissions);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  return { token, id: id as string };
}
const get = (token: string, path: string) => api.get(`/api/v1/admin/fleet${path}`).set(auth(token));
const post = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/admin/fleet${path}`).set(auth(token)).send(body);
const put = (token: string, path: string, body: object) =>
  api.put(`/api/v1/admin/fleet${path}`).set(auth(token)).send(body);

// "Today" is the platform's day, the same one the database and the expiry rules use.
const today = () => todayKey();
const plusDays = (d: number) => {
  const [y, m, day] = todayKey().split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day + d)).toISOString().slice(0, 10);
};
const categoryId = async (code = 'CAR') =>
  (await pool.query('SELECT id FROM vehicle_categories WHERE code = $1', [code])).rows[0]
    .id as string;
const notes = async (userId: string, type: string) =>
  (
    await pool.query(
      'SELECT body FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at',
      [userId, type],
    )
  ).rows as Array<{ body: string }>;

const fleetBody = (over: Record<string, unknown> = {}) => ({
  name: `Fleet ${Date.now()}-${++n}`,
  contactName: 'Mina',
  contactPhone: '+9779812345678',
  contactEmail: 'ops@fleet.example.com',
  status: 'ACTIVE',
  reason: 'Set up the fleet',
  ...over,
});
async function makeFleet(token: string, over: Record<string, unknown> = {}) {
  const r = await post(token, '/fleets', fleetBody(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; name: string };
}

/** A driver who went through the real verification flow, put in a fleet. */
async function fleetDriver(token: string, fleetId: string | null) {
  const { driver } = await createVerifiedDriver();
  if (fleetId) {
    const r = await post(token, `/drivers/${driver.user.id}/fleet`, {
      fleetId,
      reason: 'Joined the fleet',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
  return driver;
}

async function fleetVehicle(token: string, fleetId: string, over: Record<string, unknown> = {}) {
  const r = await post(token, '/vehicles', {
    fleetId,
    categoryId: await categoryId(),
    make: 'Suzuki',
    model: 'Alto',
    year: 2022,
    color: 'Blue',
    registrationNumber: `BA-${Date.now() % 1000}-FL-${++n}${Math.floor(Math.random() * 90 + 10)}`,
    registrationExpiryDate: '2099-01-01',
    insuranceExpiryDate: '2099-01-01',
    ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string; registrationNumber: string };
}

const eligible = async (driverId: string) =>
  (await findEligibleDrivers({ pickup: THAMEL, vehicleCategoryId: await categoryId() })).some(
    (c) => c.driverId === driverId,
  );

// ---------------------------------------------------------------- the models, once

describe('state models and expiry rules', () => {
  it('has lifecycle and operational tables that agree with themselves', () => {
    for (const to of VEHICLE_LIFECYCLE_STATES) {
      for (const from of vehicleLifecycleLeadingTo(to))
        expect(VEHICLE_LIFECYCLE_TRANSITIONS[from]).toContain(to);
    }
    expect(VEHICLE_LIFECYCLE_TRANSITIONS.RETIRED).toEqual([]);
    for (const s of VEHICLE_LIFECYCLE_STATES) expect(canVehicleTransition(s, s)).toBe(false);
    for (const s of OPERATIONAL_STATES) expect(canOperationalTransition(s, s)).toBe(false);
    expect(OPERATIONAL_TRANSITIONS.SUSPENDED).toContain('ACTIVE'); // reinstatement
    expect(describeVehicleLifecycle('BA 1', 'MAINTENANCE')).toContain('in maintenance');
    expect(describeOperationalStatus('SUSPENDED', 'ACTIVE', null, null)).toContain('reinstated');
    expect(describeOperationalStatus('ACTIVE', 'RESTRICTED', 'Two complaints', null)).toContain(
      'Two complaints',
    );
  });

  it('names the state of any date the same way: valid through the day, expired the next', () => {
    expect(daysUntil('2026-10-10', '2026-10-05')).toBe(5);
    expect(daysUntil('2026-10-01', '2026-10-05')).toBe(-4);
    expect(expiryState('2026-10-05', '2026-10-05', 30)).toBe('EXPIRING_SOON'); // the last valid day
    expect(expiryState('2026-10-04', '2026-10-05', 30)).toBe('EXPIRED');
    expect(expiryState('2026-12-31', '2026-10-05', 30)).toBe('VALID');
    expect(expiryState('2026-11-04', '2026-10-05', 30)).toBe('EXPIRING_SOON'); // exactly 30 days
    expect(expiryState('2026-11-05', '2026-10-05', 30)).toBe('VALID');
    expect(expiryState(null, '2026-10-05', 30)).toBe('MISSING');
    expect(reminderStage(20, [30, 14, 7, 1])).toBe(30);
    expect(reminderStage(10, [30, 14, 7, 1])).toBe(14);
    expect(reminderStage(1, [30, 14, 7, 1])).toBe(1);
    expect(reminderStage(31, [30, 14, 7, 1])).toBeNull();
    expect(
      describeExpiry({
        label: 'Insurance',
        state: 'EXPIRING_SOON',
        expiresOn: '2026-10-10',
        daysLeft: 5,
        subject: 'Vehicle BA 1',
      }),
    ).toContain('in 5 days');
    expect(
      describeExpiry({
        label: 'Insurance',
        state: 'EXPIRED',
        expiresOn: '2026-10-01',
        daysLeft: -4,
        subject: 'Vehicle BA 1',
      }),
    ).toContain('expired');
    expect(
      describeExpiry({
        label: 'Licence',
        state: 'MISSING',
        expiresOn: null,
        daysLeft: null,
        subject: 'Mina',
      }),
    ).toContain('missing');
  });
});

// ---------------------------------------------------------------- fleets

describe('fleets', () => {
  it('creates, updates and lists fleets with validation, audit and RBAC', async () => {
    const a = await admin();
    const viewer = await admin(['FLEET_VIEW']);
    const none = await admin(['SETTINGS_VIEW']);
    const p = await onboardUser('PASSENGER');
    expect((await api.get('/api/v1/admin/fleet/fleets')).status).toBe(401);
    expect((await get(p.accessToken, '/fleets')).status).toBe(403);
    expect((await get(none.token, '/fleets')).status).toBe(403);
    expect((await post(viewer.token, '/fleets', fleetBody())).status).toBe(403); // view does not manage

    const f = await makeFleet(a.token, { name: 'Himal Cabs' });
    expect((await post(a.token, '/fleets', fleetBody({ name: 'Himal Cabs' }))).status).toBe(409);
    for (const bad of [
      { name: 'x' },
      { contactPhone: '9812345678' },
      { contactEmail: 'not-an-email' },
      { status: 'GONE' },
      { reason: 'x' },
      { extra: 1 },
    ]) {
      expect((await post(a.token, '/fleets', fleetBody(bad))).status, JSON.stringify(bad)).toBe(
        400,
      );
    }
    const upd = await put(
      a.token,
      `/fleets/${f.id}`,
      fleetBody({ name: 'Himal Cabs', contactName: 'Sita', reason: 'New contact' }),
    );
    expect(upd.body.data.contactName).toBe('Sita');
    const list = (await get(viewer.token, '/fleets')).body.data as Array<{ name: string }>;
    expect(list.map((x) => x.name)).toContain('Himal Cabs');
    const detail = (await get(viewer.token, `/fleets/${f.id}`)).body.data;
    expect(detail.audit.map((e: { action: string }) => e.action)).toEqual([
      'FLEET_CREATED',
      'FLEET_UPDATED',
    ]);
    expect(
      (await put(a.token, '/fleets/00000000-0000-4000-8000-000000000000', fleetBody())).status,
    ).toBe(404);
  });

  it('lists a fleet with its drivers and vehicles, from the records that point at it', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const d = await fleetDriver(a.token, f.id);
    const v = await fleetVehicle(a.token, f.id);
    const detail = (await get(a.token, `/fleets/${f.id}`)).body.data;
    expect(detail.driverCount).toBe(1);
    expect(detail.vehicleCount).toBe(1);
    expect(detail.drivers.map((x: { id: string }) => x.id)).toEqual([d.user.id]);
    expect(detail.vehicles.map((x: { id: string }) => x.id)).toEqual([v.id]);
    expect(detail.vehicles[0]).toMatchObject({
      lifecycle: 'ACTIVE',
      driverId: null,
      eligible: false,
    });
    const options = (await get(a.token, '/options')).body.data;
    expect(options.fleets.map((x: { id: string }) => x.id)).toContain(f.id);
    expect(options.categories.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- assignment

describe('assigning vehicles to drivers', () => {
  it('assigns a fleet vehicle to a driver of the same fleet, tells the driver, and records it', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const d = await fleetDriver(a.token, f.id);
    const v = await fleetVehicle(a.token, f.id);
    const res = await post(a.token, `/vehicles/${v.id}/assign`, { driverId: d.user.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data).toMatchObject({ driverId: d.user.id, assignable: false });
    const row = (await pool.query('SELECT driver_user_id FROM vehicles WHERE id = $1', [v.id]))
      .rows[0];
    expect(row.driver_user_id).toBe(d.user.id); // the ONE record of the relationship
    expect((await notes(d.user.id as string, 'FLEET_VEHICLE_ASSIGNED')).length).toBe(1);
    expect(res.body.data.audit.map((e: { action: string }) => e.action)).toContain(
      'VEHICLE_ASSIGNED',
    );
    // the driver's own list of vehicles shows it (the same column)
    const vehicles = await api.get('/api/v1/vehicles').set(auth(d.accessToken));
    expect((vehicles.body.data as Array<{ id: string }>).map((x) => x.id)).toContain(v.id);
    // it waits for review: a vehicle with no driver could not be reviewed, now it can
    const reviewer = await loginTestAdmin(
      `rev-${Date.now()}@example.com`,
      'a-strong-test-password-1',
      ['DRIVERS_REVIEW'],
    );
    const review = await api
      .post(`/api/v1/admin/vehicles/${v.id}/approve`)
      .set(auth(reviewer))
      .send({});
    expect(review.status).toBe(200);
  });

  it('refuses to review a vehicle that has no driver yet', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const v = await fleetVehicle(a.token, f.id);
    const reviewer = await loginTestAdmin(
      `rev-${Date.now()}@example.com`,
      'a-strong-test-password-1',
      ['DRIVERS_REVIEW'],
    );
    const res = await api
      .post(`/api/v1/admin/vehicles/${v.id}/approve`)
      .set(auth(reviewer))
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VEHICLE_NOT_ASSIGNED');
    // the legacy vehicle list still works with an unassigned vehicle in it
    const list = await api.get('/api/v1/admin/vehicles').set(auth(reviewer));
    expect(list.status).toBe(200);
  });

  it('refuses every conflict and every ineligible vehicle or driver, in words', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const other = await makeFleet(a.token);
    const d = await fleetDriver(a.token, f.id);
    const outsider = await fleetDriver(a.token, other.id);
    const independent = await fleetDriver(a.token, null);
    const v = await fleetVehicle(a.token, f.id);
    const assign = (vehicleId: string, driverId: string) =>
      post(a.token, `/vehicles/${vehicleId}/assign`, { driverId });
    const problem = async (vehicleId: string, driverId: string) => {
      const r = await assign(vehicleId, driverId);
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error.code).toBe('ASSIGNMENT_NOT_ALLOWED');
      return (r.body.error.details.problems as string[]).join(' | ');
    };

    // a driver of another fleet, or of none
    expect(await problem(v.id, outsider.user.id as string)).toContain('different fleet');
    expect(await problem(v.id, independent.user.id as string)).toContain('different fleet');
    // the driver's own vehicle cannot be handed to another driver (it is not a fleet vehicle)
    expect(await problem(independent.vehicleId, d.user.id as string)).toContain(
      'already assigned to another driver',
    );
    // a driver who is not verified, suspended by operations, or whose licence or papers ran out
    const fresh = await onboardUser('DRIVER');
    await pool.query(
      `INSERT INTO driver_profiles (user_id, status) VALUES ($1, 'IN_PROGRESS') ON CONFLICT DO NOTHING`,
      [fresh.user.id],
    );
    await post(a.token, `/drivers/${fresh.user.id}/fleet`, { fleetId: f.id, reason: 'Joined' });
    expect(await problem(v.id, fresh.user.id as string)).toContain('not verified');
    await post(a.token, `/drivers/${d.user.id}/operational`, {
      to: 'SUSPENDED',
      reason: 'Pending review',
    });
    expect(await problem(v.id, d.user.id as string)).toContain('suspended by operations');
    await post(a.token, `/drivers/${d.user.id}/operational`, { to: 'ACTIVE', reason: 'Cleared' });
    await pool.query(
      `UPDATE driver_details SET license_expiry_date = current_date - 1 WHERE user_id = $1`,
      [d.user.id],
    );
    expect(await problem(v.id, d.user.id as string)).toContain('licence has expired');
    await pool.query(
      `UPDATE driver_details SET license_expiry_date = '2099-01-01' WHERE user_id = $1`,
      [d.user.id],
    );
    await pool.query(
      `UPDATE documents SET status = 'EXPIRED' WHERE driver_user_id = $1 AND owner_type = 'DRIVER'`,
      [d.user.id],
    );
    expect(await problem(v.id, d.user.id as string)).toContain('missing, rejected, or expired');
    await pool.query(
      `UPDATE documents SET status = 'APPROVED' WHERE driver_user_id = $1 AND owner_type = 'DRIVER'`,
      [d.user.id],
    );

    // the vehicle: expired registration or insurance, rejected, retired, suspended
    await pool.query(
      `UPDATE vehicles SET registration_expiry_date = current_date - 1 WHERE id = $1`,
      [v.id],
    );
    expect(await problem(v.id, d.user.id as string)).toContain('registration');
    await pool.query(
      `UPDATE vehicles SET registration_expiry_date = '2099-01-01', insurance_expiry_date = current_date - 1 WHERE id = $1`,
      [v.id],
    );
    expect(await problem(v.id, d.user.id as string)).toContain('insurance');
    await pool.query(
      `UPDATE vehicles SET insurance_expiry_date = '2099-01-01', verification_status = 'REJECTED' WHERE id = $1`,
      [v.id],
    );
    expect(await problem(v.id, d.user.id as string)).toContain('rejected');
    await pool.query(`UPDATE vehicles SET verification_status = 'PENDING' WHERE id = $1`, [v.id]);
    for (const state of ['SUSPENDED', 'RETIRED']) {
      await pool.query(`UPDATE vehicles SET lifecycle_status = $2 WHERE id = $1`, [v.id, state]);
      expect(await problem(v.id, d.user.id as string)).toContain('cannot be assigned');
    }
    await pool.query(`UPDATE vehicles SET lifecycle_status = 'ACTIVE' WHERE id = $1`, [v.id]);
    expect((await assign(v.id, d.user.id as string)).status).toBe(200);
    // a second assignment, to the same or another driver, is a conflict
    expect(await problem(v.id, d.user.id as string)).toContain('already assigned to this driver');
    const colleague = await fleetDriver(a.token, f.id);
    expect(await problem(v.id, colleague.user.id as string)).toContain(
      'already assigned to another driver',
    );
    expect((await assign('00000000-0000-4000-8000-000000000000', d.user.id as string)).status).toBe(
      404,
    );
    expect((await assign(v.id, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('gives a vehicle to only one of two simultaneous assignments', async () => {
    const a = await admin();
    const b = await admin();
    const f = await makeFleet(a.token);
    const d1 = await fleetDriver(a.token, f.id);
    const d2 = await fleetDriver(a.token, f.id);
    const v = await fleetVehicle(a.token, f.id);
    const results = await Promise.all([
      post(a.token, `/vehicles/${v.id}/assign`, { driverId: d1.user.id }),
      post(b.token, `/vehicles/${v.id}/assign`, { driverId: d2.user.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const owner = (await pool.query('SELECT driver_user_id FROM vehicles WHERE id = $1', [v.id]))
      .rows[0].driver_user_id;
    const winner = results[0].status === 200 ? d1 : d2;
    expect(owner).toBe(winner.user.id);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM audit_log WHERE action = 'VEHICLE_ASSIGNED'`,
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('unassigns a fleet vehicle, never a driver’s own, and never while the driver is on a ride', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const d = await fleetDriver(a.token, f.id);
    const v = await fleetVehicle(a.token, f.id);
    await post(a.token, `/vehicles/${v.id}/assign`, { driverId: d.user.id });
    const independent = await fleetDriver(a.token, null);
    const own = await post(a.token, `/vehicles/${independent.vehicleId}/unassign`, {
      reason: 'try it',
    });
    expect(own.status).toBe(409);
    expect(own.body.error.code).toBe('NOT_A_FLEET_VEHICLE');
    expect((await post(a.token, `/vehicles/${v.id}/unassign`, {})).status).toBe(400); // a reason is needed

    // the driver is on a ride
    const p = await onboardUser('PASSENGER');
    const locs = await pool.query(
      `INSERT INTO locations (latitude, longitude, address) VALUES (27.7, 85.3, 'x'), (27.71, 85.31, 'y') RETURNING id`,
    );
    const trip = await pool.query(
      `INSERT INTO trips (passenger_id, driver_id, pickup_location_id, destination_location_id, status)
       VALUES ($1, $2, $3, $4, 'DRIVER_EN_ROUTE') RETURNING id`,
      [p.user.id, d.user.id, locs.rows[0].id, locs.rows[1].id],
    );
    const busy = await post(a.token, `/vehicles/${v.id}/unassign`, { reason: 'Reassigning' });
    expect(busy.status).toBe(409);
    expect(busy.body.error.code).toBe('DRIVER_ON_RIDE');
    await pool.query(`UPDATE trips SET status = 'CANCELLED' WHERE id = $1`, [trip.rows[0].id]);

    const done = await post(a.token, `/vehicles/${v.id}/unassign`, { reason: 'Reassigning' });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ driverId: null, assignable: true });
    expect(
      (await pool.query('SELECT driver_user_id FROM vehicles WHERE id = $1', [v.id])).rows[0]
        .driver_user_id,
    ).toBeNull();
    expect((await notes(d.user.id as string, 'FLEET_VEHICLE_UNASSIGNED')).length).toBe(1);
    expect(
      (await post(a.token, `/vehicles/${v.id}/unassign`, { reason: 'Again again' })).status,
    ).toBe(409);
    // a driver with a vehicle of this fleet cannot be moved out of it
    const again = await post(a.token, `/vehicles/${v.id}/assign`, { driverId: d.user.id });
    expect(again.status).toBe(200);
    const move = await post(a.token, `/drivers/${d.user.id}/fleet`, {
      fleetId: null,
      reason: 'Leaving',
    });
    expect(move.status).toBe(409);
    expect(move.body.error.code).toBe('DRIVER_HAS_FLEET_VEHICLE');
  });
});

// ---------------------------------------------------------------- lifecycle

describe('the vehicle lifecycle', () => {
  it('allows only the legal moves, says which, and gives the driver the new state in words', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const d = await fleetDriver(a.token, f.id);
    const v = await fleetVehicle(a.token, f.id);
    await post(a.token, `/vehicles/${v.id}/assign`, { driverId: d.user.id });
    const move = (to: string, reason = 'Because') =>
      post(a.token, `/vehicles/${v.id}/lifecycle`, { to, reason });
    const same = await move('ACTIVE');
    expect(same.status).toBe(409);
    expect(same.body.error.code).toBe('INVALID_VEHICLE_TRANSITION');
    expect(same.body.error.message).toContain('can only become');
    expect((await move('MOON')).status).toBe(400);
    expect((await move('INACTIVE', 'x')).status).toBe(400);
    const inactive = await move('INACTIVE');
    expect(inactive.body.data.allowedNext).toEqual(VEHICLE_LIFECYCLE_TRANSITIONS.INACTIVE);
    expect((await notes(d.user.id as string, 'FLEET_VEHICLE_STATUS')).at(-1)?.body).toContain(
      'inactive',
    );
    await move('ACTIVE');
    const retired = await move('RETIRED', 'Sold');
    expect(retired.body.data.lifecycle).toBe('RETIRED');
    for (const to of VEHICLE_LIFECYCLE_STATES) expect((await move(to)).status, to).toBe(409); // final
    expect(retired.body.data.audit.map((e: { action: string }) => e.action)).toContain(
      'VEHICLE_LIFECYCLE_CHANGED',
    );
    expect(
      (
        await post(a.token, '/vehicles/00000000-0000-4000-8000-000000000000/lifecycle', {
          to: 'ACTIVE',
          reason: 'test',
        })
      ).status,
    ).toBe(404);
  });

  it('applies two simultaneous identical moves once', async () => {
    const a = await admin();
    const b = await admin();
    const f = await makeFleet(a.token);
    const v = await fleetVehicle(a.token, f.id);
    const moves = await Promise.all([
      post(a.token, `/vehicles/${v.id}/lifecycle`, { to: 'SUSPENDED', reason: 'Accident' }),
      post(b.token, `/vehicles/${v.id}/lifecycle`, {
        to: 'SUSPENDED',
        reason: 'Accident reported',
      }),
    ]);
    expect(moves.map((m) => m.status).sort()).toEqual([200, 409]);
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM audit_log WHERE action = 'VEHICLE_LIFECYCLE_CHANGED'`,
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it('keeps a vehicle that is not active out of rides, and takes its online driver offline', async () => {
    const a = await admin();
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    await putDriverOnline(id);
    expect(await eligible(id)).toBe(true);
    const move = (to: string) =>
      post(a.token, `/vehicles/${driver.vehicleId}/lifecycle`, { to, reason: 'Test' });
    for (const to of ['MAINTENANCE', 'INACTIVE', 'SUSPENDED']) {
      await move('ACTIVE').catch(() => undefined);
      await putDriverOnline(id);
      expect(await eligible(id)).toBe(true);
      expect((await move(to)).status, to).toBe(200);
      expect(await eligible(id), to).toBe(false); // never offered a ride
      const state = (
        await pool.query('SELECT state FROM driver_availability WHERE driver_id = $1', [id])
      ).rows[0].state;
      expect(state, to).toBe('OFFLINE'); // taken offline at once
      const why = await evaluateDriverEligibility(id);
      expect(why.eligible).toBe(false);
      expect(why.reasons.join(' ')).toContain('Vehicle');
    }
    expect((await notes(id, 'FLEET_ELIGIBILITY_LOST')).length).toBeGreaterThanOrEqual(3);
    await move('ACTIVE');
    expect((await evaluateDriverEligibility(id)).eligible).toBe(true);
    await putDriverOnline(id);
    expect(await eligible(id)).toBe(true);
  });

  it('matches the written explanation to the matching query for every reason a vehicle is out', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    const vid = driver.vehicleId;
    await putDriverOnline(id);
    const check = async (label: string, expectOk: boolean) => {
      await putDriverOnline(id);
      const words = await vehicleRideProblems(vid);
      expect(words.eligible, `${label}: words`).toBe(expectOk);
      expect(await eligible(id), `${label}: query`).toBe(expectOk);
    };
    await check('baseline', true);
    await pool.query(
      `UPDATE vehicles SET registration_expiry_date = current_date - 1 WHERE id = $1`,
      [vid],
    );
    await check('registration expired', false);
    await pool.query(`UPDATE vehicles SET registration_expiry_date = '2099-01-01' WHERE id = $1`, [
      vid,
    ]);
    await pool.query(`UPDATE vehicles SET insurance_expiry_date = current_date - 1 WHERE id = $1`, [
      vid,
    ]);
    await check('insurance expired', false);
    await pool.query(`UPDATE vehicles SET insurance_expiry_date = '2099-01-01' WHERE id = $1`, [
      vid,
    ]);
    await pool.query(`UPDATE documents SET expiry_date = current_date - 1 WHERE vehicle_id = $1`, [
      vid,
    ]);
    await check('vehicle document expired', false);
    await pool.query(
      `UPDATE documents SET expiry_date = '2099-01-01', status = 'APPROVED' WHERE vehicle_id = $1`,
      [vid],
    );
    await check('renewed', true);
    await pool.query(`UPDATE vehicles SET verification_status = 'PENDING' WHERE id = $1`, [vid]);
    await check('not approved', false);
    await pool.query(`UPDATE vehicles SET verification_status = 'APPROVED' WHERE id = $1`, [vid]);
    await check('approved again', true);
    const a = await admin();
    const f = await makeFleet(a.token);
    await pool.query(`UPDATE vehicles SET fleet_id = $2 WHERE id = $1`, [vid, f.id]);
    await check('in an active fleet', true);
    await put(
      a.token,
      `/fleets/${f.id}`,
      fleetBody({ name: f.name, status: 'SUSPENDED', reason: 'Audit' }),
    );
    await check('in a suspended fleet', false);
  });
});

// ---------------------------------------------------------------- expiry and reminders

describe('document, licence and registration expiry', () => {
  it('turns an expired required document into lost eligibility, at once and through the monitor', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    await putDriverOnline(id);
    expect(await eligible(id)).toBe(true);
    await pool.query(`UPDATE documents SET expiry_date = current_date - 1 WHERE id = $1`, [
      driver.documentIds.DRIVING_LICENSE,
    ]);
    // matching stops offering rides before any job runs
    expect(await eligible(id)).toBe(false);
    const items = await expiryItems({ driverId: id });
    const hit = items.find((i) => i.itemKey === driver.documentIds.DRIVING_LICENSE);
    expect(hit).toMatchObject({ state: 'EXPIRED', kind: 'DRIVER_DOCUMENT', driverId: id });
    // the monitor takes the online driver offline and reminds them once
    const first = await runFleetMonitor();
    expect(first.takenOffline).toBe(1);
    expect(
      (await pool.query('SELECT state FROM driver_availability WHERE driver_id = $1', [id])).rows[0]
        .state,
    ).toBe('OFFLINE');
    const expired = await notes(id, 'FLEET_DOCUMENT_EXPIRED');
    expect(expired).toHaveLength(1);
    expect(expired[0]?.body).toContain('expired');
    expect((await notes(id, 'FLEET_ELIGIBILITY_LOST')).length).toBe(1);
    const second = await runFleetMonitor();
    expect(second.reminders).toBe(0);
    expect(await notes(id, 'FLEET_DOCUMENT_EXPIRED')).toHaveLength(1); // not again
    // they cannot go online until it is renewed
    const why = await evaluateDriverEligibility(id);
    expect(why.eligible).toBe(false);
    await pool.query(
      `UPDATE documents SET expiry_date = '2099-01-01', status = 'APPROVED' WHERE id = $1`,
      [driver.documentIds.DRIVING_LICENSE],
    );
    expect((await evaluateDriverEligibility(id)).eligible).toBe(true);
  });

  it('watches the licence date, registration and insurance the same way', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    await pool.query(
      `UPDATE driver_details SET license_expiry_date = current_date - 3 WHERE user_id = $1`,
      [id],
    );
    await pool.query(
      `UPDATE vehicles SET registration_expiry_date = current_date + 5, insurance_expiry_date = current_date - 1 WHERE id = $1`,
      [driver.vehicleId],
    );
    const items = await expiryItems({ driverId: id });
    const by = (kind: string) => items.find((i) => i.kind === kind);
    expect(by('DRIVER_LICENCE')).toMatchObject({ state: 'EXPIRED', daysLeft: -3 });
    expect(by('VEHICLE_REGISTRATION')).toMatchObject({ state: 'EXPIRING_SOON', daysLeft: 5 });
    expect(by('VEHICLE_INSURANCE')).toMatchObject({ state: 'EXPIRED' });
    expect((await evaluateDriverEligibility(id)).reasons.join(' ')).toContain(
      'licence has expired',
    );
    const run = await runFleetMonitor();
    expect(run.reminders).toBeGreaterThanOrEqual(3);
    expect((await notes(id, 'FLEET_DOCUMENT_EXPIRING')).map((x) => x.body).join(' ')).toContain(
      'Registration',
    );
  });

  it('reminds at each configured threshold once, and again after a renewal with a new date', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    const setDate = (days: number) =>
      pool.query(
        `UPDATE vehicles SET registration_expiry_date = current_date + $2::int WHERE id = $1`,
        [driver.vehicleId, days],
      );
    const reminders = async () => (await notes(id, 'FLEET_DOCUMENT_EXPIRING')).length;
    await setDate(40);
    await runFleetMonitor();
    expect(await reminders()).toBe(0); // further out than the largest threshold
    await setDate(25);
    await runFleetMonitor();
    expect(await reminders()).toBe(1); // the 30-day reminder
    await runFleetMonitor();
    expect(await reminders()).toBe(1); // not twice
    await setDate(12);
    await runFleetMonitor();
    expect(await reminders()).toBe(2); // the 14-day reminder
    await setDate(6);
    await runFleetMonitor();
    await setDate(1);
    await runFleetMonitor();
    expect(await reminders()).toBe(4); // 7 and 1
    // renewed to another date: reminded afresh
    await setDate(28);
    await runFleetMonitor();
    expect(await reminders()).toBe(5);
    // the thresholds are a setting, not code
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('EXPIRY_REMINDER_DAYS', '[60]'::jsonb) ON CONFLICT (key) DO UPDATE SET value = '[60]'::jsonb`,
    );
    await refreshSettings();
    try {
      await setDate(50);
      await runFleetMonitor();
      expect(await reminders()).toBe(6);
    } finally {
      await pool.query(`DELETE FROM platform_settings WHERE key = 'EXPIRY_REMINDER_DAYS'`);
      await refreshSettings();
    }
  });

  it('reports a required document that is missing, once, without storing a second document system', async () => {
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    await pool.query(`DELETE FROM documents WHERE id = $1`, [driver.documentIds.IDENTITY_DOCUMENT]);
    const items = await expiryItems({ driverId: id, states: ['MISSING'] });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: 'MISSING', kind: 'DRIVER_DOCUMENT' });
    expect(items[0]?.text).toContain('missing');
    await runFleetMonitor();
    await runFleetMonitor();
    expect(await notes(id, 'FLEET_DOCUMENT_MISSING')).toHaveLength(1);
    const tables = (
      await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
      )
    ).rows.map((r) => r.table_name as string);
    expect(tables.filter((t) => /document/.test(t)).sort()).toEqual([
      'document_types',
      'documents',
    ]);
  });

  it('lists what needs attention for administrators, filtered, and needs FLEET_VIEW', async () => {
    const a = await admin(['FLEET_VIEW']);
    const m = await admin();
    const f = await makeFleet(m.token);
    const { driver } = await createVerifiedDriver();
    await post(m.token, `/drivers/${driver.user.id}/fleet`, { fleetId: f.id, reason: 'Joined' });
    await pool.query(`UPDATE vehicles SET insurance_expiry_date = current_date - 2 WHERE id = $1`, [
      driver.vehicleId,
    ]);
    await pool.query(
      `UPDATE driver_details SET license_expiry_date = current_date + 10 WHERE user_id = $1`,
      [driver.user.id],
    );
    const all = (await get(a.token, `/expiring?fleetId=${f.id}`)).body.data as Array<{
      state: string;
      kind: string;
    }>;
    expect(all.map((i) => `${i.kind}:${i.state}`)).toEqual([
      'VEHICLE_INSURANCE:EXPIRED',
      'DRIVER_LICENCE:EXPIRING_SOON',
    ]);
    expect((await get(a.token, `/expiring?fleetId=${f.id}&state=EXPIRED`)).body.data).toHaveLength(
      1,
    );
    expect(
      (await get(a.token, `/expiring?fleetId=${f.id}&kind=DRIVER_LICENCE`)).body.data,
    ).toHaveLength(1);
    expect((await get(a.token, '/expiring?state=NOPE')).status).toBe(400);
    const none = await admin(['SETTINGS_VIEW']);
    expect((await get(none.token, '/expiring')).status).toBe(403);
  });
});

// ---------------------------------------------------------------- operational status

describe('driver operational status', () => {
  it('keeps the five models apart: suspending operations changes none of the others', async () => {
    const a = await admin();
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    const before = (await get(a.token, `/drivers/${id}`)).body.data;
    expect(before.axes).toMatchObject({
      account: 'ACTIVE',
      verification: 'VERIFIED',
      operational: 'ACTIVE',
      availability: 'OFFLINE',
      ride: 'NONE',
    });
    const res = await post(a.token, `/drivers/${id}/operational`, {
      to: 'SUSPENDED',
      reason: 'Complaint under review',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.axes).toMatchObject({
      account: 'ACTIVE',
      verification: 'VERIFIED',
      operational: 'SUSPENDED',
      availability: 'OFFLINE',
    });
    const user = (
      await pool.query(
        `SELECT u.status::text AS account, dp.status::text AS verification FROM users u JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.id = $1`,
        [id],
      )
    ).rows[0];
    expect(user).toEqual({ account: 'ACTIVE', verification: 'VERIFIED' });
    expect(res.body.data.eligibility.reasons.join(' ')).toContain('suspended by operations');
  });

  it('suspends, restricts and reinstates with the legal moves, words, notices and audit', async () => {
    const a = await admin();
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    await putDriverOnline(id);
    expect(await eligible(id)).toBe(true);
    const move = (to: string, reason = 'Because', extra: object = {}) =>
      post(a.token, `/drivers/${id}/operational`, { to, reason, ...extra });
    expect((await move('ACTIVE')).status).toBe(409); // already active
    expect((await move('MOON')).status).toBe(400);
    expect((await move('SUSPENDED', 'x')).status).toBe(400);
    expect((await move('SUSPENDED', 'Reason here', { until: '2020-01-01T00:00:00Z' })).status).toBe(
      400,
    );
    const s = await move('SUSPENDED', 'Safety complaint');
    expect(s.status).toBe(200);
    expect(await eligible(id)).toBe(false); // never offered a ride
    expect(
      (await pool.query('SELECT state FROM driver_availability WHERE driver_id = $1', [id])).rows[0]
        .state,
    ).toBe('OFFLINE');
    expect((await notes(id, 'FLEET_DRIVER_SUSPENDED'))[0]?.body).toContain('Safety complaint');
    expect((await move('SUSPENDED')).status).toBe(409);
    const r = await move('RESTRICTED', 'Probation');
    expect(r.body.data.allowedNext).toEqual(OPERATIONAL_TRANSITIONS.RESTRICTED);
    expect((await notes(id, 'FLEET_DRIVER_RESTRICTED'))[0]?.body).toContain(
      'limited number of rides',
    );
    const back = await move('ACTIVE', 'Cleared');
    expect(back.body.data.operationalStatus).toBe('ACTIVE');
    expect((await notes(id, 'FLEET_DRIVER_REINSTATED'))[0]?.body).toContain('reinstated');
    await putDriverOnline(id);
    expect(await eligible(id)).toBe(true);
    const actions = back.body.data.audit.map((e: { action: string }) => e.action);
    expect(actions.filter((x: string) => x === 'DRIVER_OPERATIONAL_STATUS_CHANGED')).toHaveLength(
      3,
    );
  });

  it('applies the restricted daily cap, and lifts a timed restriction by itself', async () => {
    const a = await admin();
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    await post(a.token, `/drivers/${id}/operational`, {
      to: 'RESTRICTED',
      reason: 'Probation',
      until: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ('RESTRICTED_DRIVER_MAX_RIDES_PER_DAY', '1'::jsonb) ON CONFLICT (key) DO UPDATE SET value = '1'::jsonb`,
    );
    await refreshSettings();
    try {
      await putDriverOnline(id);
      expect(await eligible(id)).toBe(true); // restricted, but under the cap
      const p = await onboardUser('PASSENGER');
      const locs = await pool.query(
        `INSERT INTO locations (latitude, longitude, address) VALUES (27.7, 85.3, 'x'), (27.71, 85.31, 'y') RETURNING id`,
      );
      await pool.query(
        `INSERT INTO trips (passenger_id, driver_id, pickup_location_id, destination_location_id, status, ended_at)
         VALUES ($1, $2, $3, $4, 'COMPLETED', now())`,
        [p.user.id, id, locs.rows[0].id, locs.rows[1].id],
      );
      expect(await eligible(id)).toBe(false); // one ride done: the cap is reached
      expect((await evaluateDriverEligibility(id)).reasons.join(' ')).toContain(
        'restricted to 1 rides a day',
      );
      // the time limit ends: the system reinstates and tells the driver
      await pool.query(
        `UPDATE driver_profiles SET operational_until = now() - interval '1 minute' WHERE user_id = $1`,
        [id],
      );
      const run = await runFleetMonitor();
      expect(run.lifted).toBe(1);
      expect(
        (
          await pool.query('SELECT operational_status FROM driver_profiles WHERE user_id = $1', [
            id,
          ])
        ).rows[0].operational_status,
      ).toBe('ACTIVE');
      expect((await notes(id, 'FLEET_DRIVER_REINSTATED')).length).toBe(1);
      expect(await eligible(id)).toBe(true);
    } finally {
      await pool.query(
        `DELETE FROM platform_settings WHERE key = 'RESTRICTED_DRIVER_MAX_RIDES_PER_DAY'`,
      );
      await refreshSettings();
    }
  });

  it('applies two simultaneous identical changes once, and needs FLEET_MANAGE', async () => {
    const a = await admin();
    const b = await admin();
    const viewer = await admin(['FLEET_VIEW']);
    const { driver } = await createVerifiedDriver();
    const id = driver.user.id as string;
    expect(
      (await post(viewer.token, `/drivers/${id}/operational`, { to: 'SUSPENDED', reason: 'Nope' }))
        .status,
    ).toBe(403);
    const moves = await Promise.all([
      post(a.token, `/drivers/${id}/operational`, { to: 'RESTRICTED', reason: 'First admin' }),
      post(b.token, `/drivers/${id}/operational`, { to: 'RESTRICTED', reason: 'Second admin' }),
    ]);
    expect(moves.map((m) => m.status).sort()).toEqual([200, 409]);
    expect((await notes(id, 'FLEET_DRIVER_RESTRICTED')).length).toBe(1);
  });

  it('lists drivers by operational status for the suspensions view', async () => {
    const a = await admin();
    const d1 = await fleetDriver(a.token, null);
    await fleetDriver(a.token, null);
    await post(a.token, `/drivers/${d1.user.id}/operational`, {
      to: 'SUSPENDED',
      reason: 'Complaint',
    });
    const list = (await get(a.token, '/drivers?operational=SUSPENDED')).body.data;
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      id: d1.user.id,
      operationalStatus: 'SUSPENDED',
      eligible: false,
    });
    const all = (await get(a.token, '/drivers')).body.data;
    expect(all.total).toBe(2);
    expect(all.items.filter((x: { eligible: boolean }) => x.eligible)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- maintenance

describe('inspections and maintenance', () => {
  it('runs the maintenance workflow: out of service while in progress, back when completed', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const d = await fleetDriver(a.token, f.id);
    const v = await fleetVehicle(a.token, f.id);
    await post(a.token, `/vehicles/${v.id}/assign`, { driverId: d.user.id });
    const start = await post(a.token, `/vehicles/${v.id}/maintenance`, { notes: 'Brake pads' });
    expect(start.status).toBe(201);
    expect(start.body.data).toMatchObject({ kind: 'MAINTENANCE', status: 'IN_PROGRESS' });
    let detail = (await get(a.token, `/vehicles/${v.id}`)).body.data;
    expect(detail.lifecycle).toBe('MAINTENANCE');
    expect((await notes(d.user.id as string, 'FLEET_VEHICLE_MAINTENANCE')).at(-1)?.body).toContain(
      'in maintenance',
    );
    // a second piece of maintenance cannot be opened, even together
    const twice = await Promise.all([
      post(a.token, `/vehicles/${v.id}/maintenance`, {}),
      post(a.token, `/vehicles/${v.id}/maintenance`, {}),
    ]);
    expect(twice.map((r) => r.status)).toEqual([409, 409]);
    const bad = (over: object) =>
      post(a.token, `/service-records/${start.body.data.id}/complete`, {
        performedOn: today(),
        returnTo: 'ACTIVE',
        ...over,
      });
    expect((await bad({ nextDueOn: plusDays(-1) })).status).toBe(400); // the next service must be after this one
    expect((await bad({ returnTo: 'RETIRED' })).status).toBe(400);
    expect((await bad({ performedOn: '31/10/2026' })).status).toBe(400);
    const done = await bad({ nextDueOn: plusDays(90), notes: 'Replaced pads' });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({
      status: 'COMPLETED',
      nextDueOn: plusDays(90),
      performedOn: today(),
    });
    detail = (await get(a.token, `/vehicles/${v.id}`)).body.data;
    expect(detail.lifecycle).toBe('ACTIVE');
    expect(detail.service).toHaveLength(1);
    expect((await bad({})).status).toBe(409); // already completed
    const audited = detail.audit.map((e: { action: string }) => e.action);
    expect(audited).toEqual(expect.arrayContaining(['VEHICLE_LIFECYCLE_CHANGED']));
    // returning to INACTIVE instead
    const again = await post(a.token, `/vehicles/${v.id}/maintenance`, {});
    await post(a.token, `/service-records/${again.body.data.id}/complete`, {
      performedOn: today(),
      returnTo: 'INACTIVE',
    });
    expect((await get(a.token, `/vehicles/${v.id}`)).body.data.lifecycle).toBe('INACTIVE');
    // the list of records, with the ones in progress first
    const records = (await get(a.token, '/service-records')).body.data;
    expect(records.total).toBe(2);
    expect((await get(a.token, '/service-records?status=IN_PROGRESS')).body.data.total).toBe(0);
  });

  it('records inspections: a pass with its next date, a failure that takes the vehicle off the road', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const v = await fleetVehicle(a.token, f.id);
    const pass = await post(a.token, `/vehicles/${v.id}/inspections`, {
      performedOn: today(),
      result: 'PASSED',
      nextDueOn: plusDays(180),
      notes: 'All good',
    });
    expect(pass.status).toBe(201);
    expect(pass.body.data).toMatchObject({
      kind: 'INSPECTION',
      result: 'PASSED',
      status: 'COMPLETED',
    });
    expect((await get(a.token, `/vehicles/${v.id}`)).body.data.lifecycle).toBe('ACTIVE');
    expect(
      (
        await post(a.token, `/vehicles/${v.id}/inspections`, {
          performedOn: today(),
          result: 'PASSED',
          nextDueOn: plusDays(-5),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(a.token, `/vehicles/${v.id}/inspections`, {
          performedOn: today(),
          result: 'MAYBE',
        })
      ).status,
    ).toBe(400);
    const fail = await post(a.token, `/vehicles/${v.id}/inspections`, {
      performedOn: today(),
      result: 'FAILED',
      notes: 'Worn tyres',
    });
    expect(fail.status).toBe(201);
    const detail = (await get(a.token, `/vehicles/${v.id}`)).body.data;
    expect(detail.lifecycle).toBe('MAINTENANCE');
    expect(
      detail.service.map((s: { kind: string; status: string }) => `${s.kind}:${s.status}`).sort(),
    ).toEqual(['INSPECTION:COMPLETED', 'INSPECTION:COMPLETED', 'MAINTENANCE:IN_PROGRESS']);
    // a failed inspection while a repair is already open adds no second repair
    expect(
      (
        await post(a.token, `/vehicles/${v.id}/inspections`, {
          performedOn: today(),
          result: 'FAILED',
        })
      ).status,
    ).toBe(201);
    expect(
      (await get(a.token, `/vehicles/${v.id}`)).body.data.service.filter(
        (s: { status: string }) => s.status === 'IN_PROGRESS',
      ),
    ).toHaveLength(1);
    expect(
      (
        await post(a.token, '/vehicles/00000000-0000-4000-8000-000000000000/inspections', {
          performedOn: today(),
          result: 'PASSED',
        })
      ).status,
    ).toBe(404);
  });

  it('logs a service without taking the vehicle off the road, and reminds the driver when the next one is due', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const d = await fleetDriver(a.token, f.id);
    const v = await fleetVehicle(a.token, f.id);
    await post(a.token, `/vehicles/${v.id}/assign`, { driverId: d.user.id });
    const log = await post(a.token, `/vehicles/${v.id}/services`, {
      performedOn: plusDays(-170),
      nextDueOn: plusDays(3),
      notes: 'Oil change',
    });
    expect(log.status).toBe(201);
    expect((await get(a.token, `/vehicles/${v.id}`)).body.data.lifecycle).toBe('ACTIVE');
    const run = await runFleetMonitor();
    expect(run.reminders).toBeGreaterThanOrEqual(1);
    const reminder = (await notes(d.user.id as string, 'FLEET_VEHICLE_MAINTENANCE')).at(-1);
    expect(reminder?.body).toContain('Next service');
    await runFleetMonitor();
    expect((await notes(d.user.id as string, 'FLEET_VEHICLE_MAINTENANCE')).length).toBe(1);
  });

  it('cannot reach or change rides, payments or refunds: a record points only at its vehicle', async () => {
    const cols = (
      await pool.query(
        `SELECT column_name, column_default FROM information_schema.columns WHERE table_name = 'vehicle_service_records'`,
      )
    ).rows.map((r) => r.column_name as string);
    for (const c of [
      'trip_id',
      'payment_id',
      'refund_id',
      'amount_npr',
      'fare_npr',
      'driver_id',
      'passenger_id',
    ]) {
      expect(cols).not.toContain(c);
    }
    const fks = (
      await pool.query(
        `SELECT ccu.table_name AS target FROM information_schema.table_constraints tc
         JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
         WHERE tc.table_name = 'vehicle_service_records' AND tc.constraint_type = 'FOREIGN KEY'`,
      )
    ).rows.map((r) => r.target as string);
    expect(fks.sort()).toEqual(['users', 'vehicles']);
    // doing all the work on a vehicle leaves every ride and money record exactly as it was
    const a = await admin();
    const { driver } = await createVerifiedDriver();
    const snapshot = async () =>
      JSON.stringify([
        (await pool.query('SELECT * FROM trips ORDER BY id')).rows,
        (await pool.query('SELECT * FROM trip_payments ORDER BY id')).rows,
        (await pool.query('SELECT * FROM refunds ORDER BY id')).rows,
      ]);
    const before = await snapshot();
    const m = await post(a.token, `/vehicles/${driver.vehicleId}/maintenance`, {
      notes: 'Service',
    });
    await post(a.token, `/service-records/${m.body.data.id}/complete`, {
      performedOn: today(),
      returnTo: 'ACTIVE',
      nextDueOn: plusDays(60),
    });
    await post(a.token, `/vehicles/${driver.vehicleId}/inspections`, {
      performedOn: today(),
      result: 'PASSED',
    });
    await post(a.token, `/vehicles/${driver.vehicleId}/services`, { performedOn: today() });
    expect(await snapshot()).toBe(before);
  });
});

// ---------------------------------------------------------------- authorization, history, accessibility of data

describe('authorization and history', () => {
  it('opens reads to FLEET_VIEW, changes to FLEET_MANAGE, and nothing to anyone else', async () => {
    const manager = await admin();
    const viewer = await admin(['FLEET_VIEW']);
    const other = await admin(['SUPPORT_MANAGE', 'OPERATIONS_VIEW']);
    const passenger = await onboardUser('PASSENGER');
    const driver = await onboardUser('DRIVER');
    const f = await makeFleet(manager.token);
    const v = await fleetVehicle(manager.token, f.id);
    const reads = [
      '/fleets',
      `/fleets/${f.id}`,
      '/vehicles',
      `/vehicles/${v.id}`,
      '/drivers',
      '/expiring',
      '/service-records',
      '/history',
      '/options',
    ];
    for (const path of reads) {
      expect((await get(manager.token, path)).status, `manager ${path}`).toBe(200); // MANAGE implies VIEW
      expect((await get(viewer.token, path)).status, `viewer ${path}`).toBe(200);
      for (const [who, token] of [
        ['other admin', other.token],
        ['passenger', passenger.accessToken],
        ['driver', driver.accessToken],
      ] as const) {
        expect((await get(token, path)).status, `${who} ${path}`).toBe(403);
      }
      expect((await api.get(`/api/v1/admin/fleet${path}`)).status, `anonymous ${path}`).toBe(401);
    }
    const writes: Array<[string, object]> = [
      ['/fleets', fleetBody()],
      [`/vehicles/${v.id}/lifecycle`, { to: 'INACTIVE', reason: 'Test' }],
      [`/vehicles/${v.id}/assign`, { driverId: driver.user.id }],
      [`/vehicles/${v.id}/unassign`, { reason: 'Test' }],
      [`/vehicles/${v.id}/maintenance`, {}],
      [`/vehicles/${v.id}/inspections`, { performedOn: today(), result: 'PASSED' }],
      [`/vehicles/${v.id}/services`, { performedOn: today() }],
      [`/drivers/${driver.user.id}/operational`, { to: 'SUSPENDED', reason: 'Test' }],
      [`/drivers/${driver.user.id}/fleet`, { fleetId: null, reason: 'Test' }],
      ['/monitor/run', {}],
    ];
    for (const [path, body] of writes) {
      expect((await post(viewer.token, path, body)).status, `viewer ${path}`).toBe(403);
      expect((await post(passenger.accessToken, path, body)).status, `passenger ${path}`).toBe(403);
    }
    expect((await put(viewer.token, `/fleets/${f.id}`, fleetBody())).status).toBe(403);
    expect((await post(manager.token, '/monitor/run')).status).toBe(200);
  });

  it('keeps an operational history of who changed what and why, newest first', async () => {
    const a = await admin();
    const f = await makeFleet(a.token);
    const v = await fleetVehicle(a.token, f.id);
    const { driver } = await createVerifiedDriver(); // its own reviews are in the history too, so make it first
    await post(a.token, `/vehicles/${v.id}/lifecycle`, {
      to: 'INACTIVE',
      reason: 'Parked for winter',
    });
    await post(a.token, `/drivers/${driver.user.id}/operational`, {
      to: 'RESTRICTED',
      reason: 'Probation',
    });
    const h = (await get(a.token, '/history')).body.data;
    const actions = h.items.map((e: { action: string }) => e.action);
    expect(actions.slice(0, 2)).toEqual([
      'DRIVER_OPERATIONAL_STATUS_CHANGED',
      'VEHICLE_LIFECYCLE_CHANGED',
    ]);
    expect(actions).toContain('FLEET_CREATED');
    expect(h.items[0]).toMatchObject({ subjectType: 'driver_operations', actorRole: 'ADMIN' });
    expect(h.items[0].detail).toMatchObject({
      from: 'ACTIVE',
      to: 'RESTRICTED',
      reason: 'Probation',
    });
    expect(h.items[0].actorName).toBe('Test Admin');
    expect((await get(a.token, '/history?pageSize=1&page=2')).body.data.items).toHaveLength(1);
  });
});
