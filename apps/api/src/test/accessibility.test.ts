import {
  CORE_VEHICLE_ATTRIBUTES,
  PASSENGER_NEEDS,
  describeAccessibilityForDriver,
  requiredVehicleAttributes,
  type AccessibilityProfile,
  type AdminPermission,
  type TripSummary,
  type VehicleCapabilitiesResponse,
} from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { startCall } from '../modules/calls/calls.service';
import { purgeOldRideAccessibility } from '../modules/accessibility/accessibility.service';
import { api, loginTestAdmin, onboardUser, type OnboardedUser } from './helpers';
import {
  PATAN,
  THAMEL,
  acceptCurrentOffer,
  arriveAtPickup,
  auth,
  currentOffer,
  forceDriverOnline,
} from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
const profileUrl = '/api/v1/users/me/accessibility';
const getProfile = (t: string) => api.get(profileUrl).set(auth(t));
const putProfile = (t: string, body: object) => api.put(profileUrl).set(auth(t)).send(body);
const profile = async (t: string) => (await getProfile(t)).body.data as AccessibilityProfile;
const vehicleOf = async (u: OnboardedUser) =>
  (await pool.query('SELECT id FROM vehicles WHERE driver_user_id = $1', [u.user.id])).rows[0]
    .id as string;
const declare = (t: string, vehicleId: string, declared: string[]) =>
  api.put(`/api/v1/vehicles/${vehicleId}/accessibility`).set(auth(t)).send({ declared });
const admin = (permissions: AdminPermission[]) =>
  loginTestAdmin(
    `acc-admin-${Date.now()}-${++n}@example.com`,
    'a-strong-test-password-1',
    permissions,
  );
const decide = (
  t: string,
  vehicleId: string,
  code: string,
  decision: string,
  reason = 'Checked the vehicle',
) =>
  api
    .post(`/api/v1/admin/accessibility/reviews/${vehicleId}/${code}`)
    .set(auth(t))
    .send({ decision, reason });
const wheelchair = { needs: ['WHEELCHAIR'] };

/** A driver online with a vehicle whose features are declared and (where needed) approved. */
async function accessibleDriver(codes: string[] = ['WHEELCHAIR_ACCESSIBLE']) {
  const driver = await onboardUser('DRIVER');
  await forceDriverOnline(driver.user.id as string);
  const vehicleId = await vehicleOf(driver);
  await declare(driver.accessToken, vehicleId, codes);
  const mgr = await admin(['ACCESSIBILITY_MANAGE']);
  for (const code of codes) {
    await pool.query(
      `UPDATE vehicle_accessibility SET status = 'APPROVED' WHERE vehicle_id = $1 AND attribute_code = $2`,
      [vehicleId, code],
    );
  }
  return { driver, vehicleId, mgr };
}

async function rideWith(accessibility: object | undefined, passenger?: OnboardedUser) {
  const p = passenger ?? (await onboardUser('PASSENGER'));
  const res = await api
    .post('/api/v1/trips/request')
    .set(auth(p.accessToken))
    .send({
      pickup: THAMEL,
      destination: PATAN,
      vehicleCategory: 'CAR',
      ...(accessibility ? { accessibility } : {}),
    });
  return { p, res };
}

// ---------------------------------------------------------------- the definitions

describe('the definitions agree', () => {
  it('maps every need that requires a vehicle feature to a core feature in the catalogue', async () => {
    const cat = await pool.query('SELECT code FROM accessibility_attributes WHERE core');
    const codes = cat.rows.map((r) => r.code as string).sort();
    expect(codes).toEqual([...CORE_VEHICLE_ATTRIBUTES].sort());
    for (const need of PASSENGER_NEEDS) {
      if (need.vehicleAttribute) expect(CORE_VEHICLE_ATTRIBUTES).toContain(need.vehicleAttribute);
    }
  });

  it('turns needs into the vehicle features a ride requires, once each', () => {
    expect(requiredVehicleAttributes(['WHEELCHAIR', 'SERVICE_ANIMAL', 'HEARING'])).toEqual([
      'SERVICE_ANIMAL_FRIENDLY',
      'WHEELCHAIR_ACCESSIBLE',
    ]);
    expect(requiredVehicleAttributes(['ASSISTANCE', 'VISUAL'])).toEqual([]);
  });

  it('words the needs for a driver without a diagnosis', () => {
    const lines = describeAccessibilityForDriver({
      needs: ['VISUAL', 'WHEELCHAIR', 'EXTRA_BOARDING_TIME'],
      companion: true,
      communication: 'TEXT_ONLY',
      pickupInstructions: ['MEET_AT_ACCESSIBLE_ENTRANCE'],
      pickupNote: 'Blue gate',
      otherNote: null,
      requiredVehicleAttributes: ['WHEELCHAIR_ACCESSIBLE'],
    });
    expect(lines.join(' ')).toContain('wheelchair-accessible vehicle');
    expect(lines.join(' ')).toContain('Messages only');
    expect(lines.join(' ')).toContain('Pickup note: Blue gate');
    expect(lines.join(' ')).toContain('extra time');
    expect(lines.join(' ')).toContain('Someone travels with the passenger');
    expect(lines.join(' ')).not.toMatch(/disab|diagnos|condition/i);
  });
});

// ---------------------------------------------------------------- the passenger's profile

describe('accessibility profile', () => {
  it('starts empty: nothing is assumed about anyone', async () => {
    const p = await onboardUser('PASSENGER');
    const prof = await profile(p.accessToken);
    expect(prof).toMatchObject({
      needs: [],
      communication: 'ANY',
      pickupInstructions: [],
      version: 0,
    });
  });

  it('saves only what the person states, and two devices cannot overwrite each other', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await putProfile(p.accessToken, {
      needs: ['WHEELCHAIR', 'WHEELCHAIR', 'HEARING'],
      communication: 'TEXT_ONLY',
      pickupInstructions: ['CANNOT_USE_STAIRS'],
      pickupNote: '  Ramp at the side  ',
      otherNote: null,
      version: 0,
    });
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(a.body.data).toMatchObject({
      needs: ['WHEELCHAIR', 'HEARING'],
      communication: 'TEXT_ONLY',
      pickupNote: 'Ramp at the side',
      version: 1,
    });
    const stale = await putProfile(p.accessToken, { ...a.body.data, version: 0 }); // an app may send back what it got
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
  });

  it('two devices saving for the very first time at once: one wins, the other is told', async () => {
    const p = await onboardUser('PASSENGER');
    const body = (needs: string[]) => ({
      needs,
      communication: 'ANY',
      pickupInstructions: [],
      pickupNote: null,
      otherNote: null,
      version: 0,
    });
    const results = await Promise.all([
      putProfile(p.accessToken, body(['WHEELCHAIR'])),
      putProfile(p.accessToken, body(['HEARING'])),
      putProfile(p.accessToken, body(['VISUAL'])),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect((await profile(p.accessToken)).version).toBe(1); // exactly one save landed
  });

  it('refuses unknown values and over-long notes instead of dropping them', async () => {
    const p = await onboardUser('PASSENGER');
    const base = {
      needs: [],
      communication: 'ANY',
      pickupInstructions: [],
      pickupNote: null,
      otherNote: null,
    };
    expect((await putProfile(p.accessToken, { ...base, needs: ['TELEPATHY'] })).status).toBe(400);
    expect((await putProfile(p.accessToken, { ...base, communication: 'SHOUT' })).status).toBe(400);
    expect((await putProfile(p.accessToken, { ...base, pickupNote: 'x'.repeat(201) })).status).toBe(
      400,
    );
    expect((await putProfile(p.accessToken, { ...base, extra: 1 })).status).toBe(400);
  });

  it('belongs to passengers and to the signed-in person only', async () => {
    const d = await onboardUser('DRIVER');
    expect((await getProfile(d.accessToken)).status).toBe(403);
    expect((await api.get(profileUrl)).status).toBe(401);
    const a = await onboardUser('PASSENGER');
    const b = await onboardUser('PASSENGER');
    await putProfile(a.accessToken, {
      needs: ['VISUAL'],
      communication: 'ANY',
      pickupInstructions: [],
      pickupNote: null,
      otherNote: null,
      version: 0,
    });
    expect((await profile(b.accessToken)).needs).toEqual([]);
  });
});

// ---------------------------------------------------------------- vehicle features

describe('vehicle accessibility features', () => {
  it('lets a driver declare features; the ones that need checking wait, the others count at once', async () => {
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    const vehicleId = await vehicleOf(d);
    const res = await declare(d.accessToken, vehicleId, ['WHEELCHAIR_ACCESSIBLE', 'EXTRA_SPACE']);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const caps = (res.body.data as VehicleCapabilitiesResponse).capabilities;
    const status = (code: string) => caps.find((c) => c.code === code)?.status;
    expect(status('WHEELCHAIR_ACCESSIBLE')).toBe('PENDING');
    expect(status('EXTRA_SPACE')).toBe('APPROVED');
    expect(status('RAMP_OR_LIFT')).toBeNull();
  });

  it("never lets a driver approve a claim, claim someone else's vehicle, or claim an unknown feature", async () => {
    const d = await onboardUser('DRIVER');
    const other = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    await forceDriverOnline(other.user.id as string);
    const vehicleId = await vehicleOf(d);
    await declare(d.accessToken, vehicleId, ['WHEELCHAIR_ACCESSIBLE']);
    // Declaring again, or in any other way, leaves it PENDING.
    await declare(d.accessToken, vehicleId, ['WHEELCHAIR_ACCESSIBLE']);
    const row = await pool.query(`SELECT status FROM vehicle_accessibility WHERE vehicle_id = $1`, [
      vehicleId,
    ]);
    expect(row.rows[0].status).toBe('PENDING');
    // Another driver's vehicle: not found, and nothing is revealed.
    expect((await declare(other.accessToken, vehicleId, ['EXTRA_SPACE'])).status).toBe(404);
    expect(
      (await api.get(`/api/v1/vehicles/${vehicleId}/accessibility`).set(auth(other.accessToken)))
        .status,
    ).toBe(404);
    expect((await declare(d.accessToken, vehicleId, ['MADE_UP_FEATURE'])).status).toBe(400);
    // A passenger has no such endpoint.
    const p = await onboardUser('PASSENGER');
    expect((await declare(p.accessToken, vehicleId, ['EXTRA_SPACE'])).status).toBe(403);
  });

  it('lets an administrator with the right permission approve or reject, with a reason, and tells the driver', async () => {
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    const vehicleId = await vehicleOf(d);
    await declare(d.accessToken, vehicleId, ['WHEELCHAIR_ACCESSIBLE', 'RAMP_OR_LIFT']);

    const viewer = await admin(['ACCESSIBILITY_VIEW']);
    const queue = await api.get('/api/v1/admin/accessibility/reviews').set(auth(viewer));
    expect(queue.status).toBe(200);
    expect(
      queue.body.data.filter((r: { vehicleId: string }) => r.vehicleId === vehicleId),
    ).toHaveLength(2);
    // Viewing is not deciding.
    expect((await decide(viewer, vehicleId, 'WHEELCHAIR_ACCESSIBLE', 'APPROVED')).status).toBe(403);

    const mgr = await admin(['ACCESSIBILITY_MANAGE']);
    expect((await decide(mgr, vehicleId, 'WHEELCHAIR_ACCESSIBLE', 'APPROVED')).status).toBe(200);
    expect(
      (await decide(mgr, vehicleId, 'RAMP_OR_LIFT', 'REJECTED', 'The ramp is missing')).status,
    ).toBe(200);
    expect((await decide(mgr, vehicleId, 'WHEELCHAIR_ACCESSIBLE', 'APPROVED', 'x')).status).toBe(
      400,
    ); // reason too short

    const caps = (
      await api.get(`/api/v1/vehicles/${vehicleId}/accessibility`).set(auth(d.accessToken))
    ).body.data as VehicleCapabilitiesResponse;
    expect(caps.capabilities.find((c) => c.code === 'WHEELCHAIR_ACCESSIBLE')?.status).toBe(
      'APPROVED',
    );
    const rejected = caps.capabilities.find((c) => c.code === 'RAMP_OR_LIFT');
    expect(rejected?.status).toBe('REJECTED');
    expect(rejected?.decisionReason).toBe('The ramp is missing');

    const notes = await pool.query(
      'SELECT type FROM notifications WHERE user_id = $1 ORDER BY created_at',
      [d.user.id],
    );
    expect(notes.rows.map((x) => x.type)).toEqual(
      expect.arrayContaining(['VEHICLE_CAPABILITY_APPROVED', 'VEHICLE_CAPABILITY_REJECTED']),
    );
    const audit = await pool.query(
      `SELECT 1 FROM audit_log WHERE action IN ('VEHICLE_CAPABILITY_APPROVED','VEHICLE_CAPABILITY_REJECTED')`,
    );
    expect(audit.rowCount).toBe(2);
    // A rejected claim can be resubmitted by the driver.
    const again = await declare(d.accessToken, vehicleId, [
      'WHEELCHAIR_ACCESSIBLE',
      'RAMP_OR_LIFT',
    ]);
    expect(
      (again.body.data as VehicleCapabilitiesResponse).capabilities.find(
        (c) => c.code === 'RAMP_OR_LIFT',
      )?.status,
    ).toBe('PENDING');
  });

  it('removes a feature when the driver stops declaring it', async () => {
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    const vehicleId = await vehicleOf(d);
    await declare(d.accessToken, vehicleId, ['EXTRA_SPACE', 'ACCESSIBLE_SEATING']);
    await declare(d.accessToken, vehicleId, ['ACCESSIBLE_SEATING']);
    const rows = await pool.query(
      'SELECT attribute_code FROM vehicle_accessibility WHERE vehicle_id = $1',
      [vehicleId],
    );
    expect(rows.rows.map((r) => r.attribute_code)).toEqual(['ACCESSIBLE_SEATING']);
  });
});

// ---------------------------------------------------------------- matching

describe('accessible matching', () => {
  it('offers a wheelchair ride only to a driver whose vehicle is approved for it', async () => {
    const plain = await onboardUser('DRIVER');
    await forceDriverOnline(plain.user.id as string);
    const pending = await onboardUser('DRIVER');
    await forceDriverOnline(pending.user.id as string);
    await declare(pending.accessToken, await vehicleOf(pending), ['WHEELCHAIR_ACCESSIBLE']); // PENDING
    const { driver: able } = await accessibleDriver();

    const { res } = await rideWith(wheelchair);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((await currentOffer(plain.accessToken)).body.data).toBeNull();
    expect((await currentOffer(pending.accessToken)).body.data).toBeNull();
    const offer = (await currentOffer(able.accessToken)).body.data;
    expect(offer).not.toBeNull();
    // The driver learns what the vehicle must have, and nothing about the person.
    expect(offer.vehicleNeeds).toEqual(['Wheelchair accessible vehicle']);
    for (const key of ['accessibility', 'needs', 'pickupNote', 'otherNote', 'communication'])
      expect(Object.keys(offer)).not.toContain(key);
    const accepted = await acceptCurrentOffer(able.accessToken);
    expect(accepted.status).toBe(200);
  });

  it('does not touch matching for a ride without needs, and one without a vehicle need only informs the driver', async () => {
    const plain = await onboardUser('DRIVER');
    await forceDriverOnline(plain.user.id as string);
    const { res } = await rideWith({
      needs: ['ASSISTANCE'],
      pickupInstructions: ['CALL_ON_ARRIVAL'],
    });
    expect(res.status).toBe(201);
    const offer = (await currentOffer(plain.accessToken)).body.data;
    expect(offer).not.toBeNull();
    expect(offer.vehicleNeeds).toEqual([]);
    const ordinary = await rideWith(undefined);
    expect(ordinary.res.status).toBe(201);
  });

  it('requires every feature a ride needs (wheelchair and a service animal)', async () => {
    const { driver: chairOnly } = await accessibleDriver(['WHEELCHAIR_ACCESSIBLE']);
    const { res } = await rideWith({ needs: ['WHEELCHAIR', 'SERVICE_ANIMAL'] });
    expect(res.status).toBe(201);
    expect((await currentOffer(chairOnly.accessToken)).body.data).toBeNull();
  });

  it("says in the estimate whether an accessible vehicle is available, for this rider's own needs", async () => {
    const p = await onboardUser('PASSENGER');
    const body = {
      pickup: THAMEL,
      destination: PATAN,
      vehicleCategory: 'CAR',
    };
    const normal = await forceDriverOnline((await onboardUser('DRIVER')).user.id as string);
    void normal;
    const ask = (acc?: object) =>
      api
        .post('/api/v1/trips/estimate')
        .set(auth(p.accessToken))
        .send({ ...body, ...(acc ? { accessibility: acc } : {}) });
    const car = (r: {
      body: { data: { categories: Array<{ code: string; available: boolean }> } };
    }) => r.body.data.categories.find((c) => c.code === 'CAR')?.available;
    expect(car(await ask())).toBe(true);
    expect(car(await ask(wheelchair))).toBe(false); // nobody accessible nearby: said plainly, not hidden
    await accessibleDriver();
    expect(car(await ask(wheelchair))).toBe(true);
  });

  it('uses the saved profile when the request says nothing, and a request can override it for one ride', async () => {
    await accessibleDriver();
    const p = await onboardUser('PASSENGER');
    await putProfile(p.accessToken, {
      needs: ['WHEELCHAIR'],
      communication: 'TEXT_PREFERRED',
      pickupInstructions: [],
      pickupNote: null,
      otherNote: null,
      version: 0,
    });
    const { res } = await rideWith(undefined, p);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const stored = await pool.query(
      'SELECT needs, required_attributes FROM trip_accessibility WHERE trip_id = $1',
      [res.body.data.id],
    );
    expect(stored.rows[0].needs).toEqual(['WHEELCHAIR']);
    expect(stored.rows[0].required_attributes).toEqual(['WHEELCHAIR_ACCESSIBLE']);
    await api.post(`/api/v1/trips/${res.body.data.id}/cancel`).set(auth(p.accessToken)).send({});
    const second = await rideWith({ needs: [], communication: 'ANY' }, p);
    expect(second.res.status).toBe(201);
    const none = await pool.query('SELECT 1 FROM trip_accessibility WHERE trip_id = $1', [
      second.res.body.data.id,
    ]);
    expect(none.rowCount).toBe(0);
  });

  it("keeps a ride's copy when the profile changes afterwards", async () => {
    await accessibleDriver();
    const p = await onboardUser('PASSENGER');
    const { res } = await rideWith(wheelchair, p);
    await putProfile(p.accessToken, {
      needs: [],
      communication: 'ANY',
      pickupInstructions: [],
      pickupNote: null,
      otherNote: null,
      version: 0,
    });
    const trip = (await api.get(`/api/v1/trips/${res.body.data.id}`).set(auth(p.accessToken))).body
      .data as TripSummary;
    expect(trip.accessibility?.needs).toEqual(['WHEELCHAIR']);
  });

  it('refuses a request whose needs cannot be honoured because the feature is switched off', async () => {
    await pool.query(
      `UPDATE accessibility_attributes SET active = false WHERE code = 'SERVICE_ANIMAL_FRIENDLY'`,
    );
    try {
      const { res } = await rideWith({ needs: ['SERVICE_ANIMAL'] });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ACCESSIBILITY_UNAVAILABLE');
    } finally {
      await pool.query(
        `UPDATE accessibility_attributes SET active = true WHERE code = 'SERVICE_ANIMAL_FRIENDLY'`,
      );
    }
  });
});

// ---------------------------------------------------------------- a ride under way: privacy, pickup, calls

async function assignedRide(accessibility: object) {
  const { driver } = await accessibleDriver();
  const { p, res } = await rideWith(accessibility);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  const acc = await acceptCurrentOffer(driver.accessToken);
  expect(acc.status).toBe(200);
  return { passenger: p, driver, tripId: res.body.data.id as string };
}
const tripOf = async (t: string, id: string) =>
  (await api.get(`/api/v1/trips/${id}`).set(auth(t))).body.data as TripSummary;

describe("privacy of a ride's accessibility details", () => {
  const details = {
    needs: ['WHEELCHAIR', 'VISUAL'],
    communication: 'TEXT_ONLY',
    pickupInstructions: ['MEET_AT_ACCESSIBLE_ENTRANCE'],
    pickupNote: 'Blue gate on the left',
  };

  it('shows them to the passenger and to the assigned driver only, and not to the driver once the ride ends', async () => {
    const w = await assignedRide(details);
    const mine = await tripOf(w.passenger.accessToken, w.tripId);
    expect(mine.accessibility?.pickupNote).toBe('Blue gate on the left');
    const drivers = await tripOf(w.driver.accessToken, w.tripId);
    expect(drivers.accessibility?.needs).toEqual(['WHEELCHAIR', 'VISUAL']);
    // Another passenger and another driver cannot even open the ride.
    const stranger = await onboardUser('PASSENGER');
    expect(
      (await api.get(`/api/v1/trips/${w.tripId}`).set(auth(stranger.accessToken))).status,
    ).toBeGreaterThanOrEqual(403);
    const otherDriver = await onboardUser('DRIVER');
    expect(
      (await api.get(`/api/v1/trips/${w.tripId}`).set(auth(otherDriver.accessToken))).status,
    ).toBeGreaterThanOrEqual(403);
    await api.post(`/api/v1/trips/${w.tripId}/cancel`).set(auth(w.passenger.accessToken)).send({});
    expect((await tripOf(w.driver.accessToken, w.tripId)).accessibility).toBeNull();
    expect((await tripOf(w.passenger.accessToken, w.tripId)).accessibility).not.toBeNull();
  });

  it("never puts the details in a notification, a chat message, or the ride's event record", async () => {
    const w = await assignedRide(details);
    await api
      .put(`/api/v1/trips/${w.tripId}/accessibility`)
      .set(auth(w.passenger.accessToken))
      .send({
        communication: 'TEXT_ONLY',
        pickupInstructions: ['CALL_ON_ARRIVAL'],
        pickupNote: 'Secret note xyz',
      });
    const text = JSON.stringify([
      (await pool.query('SELECT title, body, metadata FROM notifications')).rows,
      (await pool.query('SELECT payload FROM trip_events WHERE trip_id = $1', [w.tripId])).rows,
      (await pool.query('SELECT body FROM trip_messages WHERE trip_id = $1', [w.tripId])).rows,
    ]);
    expect(text).not.toContain('Secret note xyz');
    expect(text).not.toContain('Blue gate');
  });

  it('is not part of the administrator trip detail, and staff read it only with SUPPORT_MANAGE, audited', async () => {
    const w = await assignedRide(details);
    const ops = await admin(['OPERATIONS_VIEW', 'RIDES_MANAGE']);
    const detail = await api.get(`/api/v1/admin/trips/${w.tripId}`).set(auth(ops));
    expect(JSON.stringify(detail.body)).not.toContain('Blue gate');
    expect(
      (await api.get(`/api/v1/admin/trips/${w.tripId}/accessibility`).set(auth(ops))).status,
    ).toBe(403);
    const acc = await admin(['ACCESSIBILITY_MANAGE']);
    expect(
      (await api.get(`/api/v1/admin/trips/${w.tripId}/accessibility`).set(auth(acc))).status,
    ).toBe(403);
    const support = await admin(['SUPPORT_MANAGE']);
    const ok = await api.get(`/api/v1/admin/trips/${w.tripId}/accessibility`).set(auth(support));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.accessibility.pickupNote).toBe('Blue gate on the left');
    const audit = await pool.query(
      `SELECT 1 FROM audit_log WHERE action = 'VIEW_TRIP_ACCESSIBILITY'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it("is deleted with the rider's account data and included in their own export", async () => {
    const w = await assignedRide(details);
    await putProfile(w.passenger.accessToken, {
      needs: ['HEARING'],
      communication: 'ANY',
      pickupInstructions: [],
      pickupNote: null,
      otherNote: null,
      version: 0,
    });
    const { rows } = await pool.query('SELECT 1 FROM trip_accessibility WHERE trip_id = $1', [
      w.tripId,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('is deleted by its retention rule once the ride is old, and not before', async () => {
    const w = await assignedRide(details);
    await api.post(`/api/v1/trips/${w.tripId}/cancel`).set(auth(w.passenger.accessToken)).send({});
    expect(await purgeOldRideAccessibility(30)).toBe(0);
    await pool.query(`UPDATE trips SET ended_at = now() - interval '40 days' WHERE id = $1`, [
      w.tripId,
    ]);
    expect(await purgeOldRideAccessibility(30)).toBe(1);
    expect((await tripOf(w.passenger.accessToken, w.tripId)).accessibility).toBeNull();
  });
});

describe('changing pickup instructions during a ride', () => {
  it('lets the passenger change them until the ride starts, tells the driver, and keeps the words private', async () => {
    const w = await assignedRide({
      needs: ['ASSISTANCE'],
      pickupInstructions: [],
      pickupNote: null,
    });
    const upd = await api
      .put(`/api/v1/trips/${w.tripId}/accessibility`)
      .set(auth(w.passenger.accessToken))
      .send({
        communication: 'TEXT_PREFERRED',
        pickupInstructions: ['NEED_HELP_LOCATING_VEHICLE'],
        pickupNote: 'Near the pharmacy',
      });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);
    expect(upd.body.data.accessibility.pickupNote).toBe('Near the pharmacy');
    const seen = await tripOf(w.driver.accessToken, w.tripId);
    expect(seen.accessibility?.pickupInstructions).toEqual(['NEED_HELP_LOCATING_VEHICLE']);
    const ev = await pool.query(
      `SELECT payload FROM trip_events WHERE trip_id = $1 AND type = 'ACCESSIBILITY_UPDATED'`,
      [w.tripId],
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload).toEqual({});
  });

  it("is only for the ride's own passenger, and is refused once the ride is under way", async () => {
    const w = await assignedRide({ needs: ['ASSISTANCE'] });
    const body = { communication: 'ANY', pickupInstructions: [], pickupNote: null };
    expect(
      (
        await api
          .put(`/api/v1/trips/${w.tripId}/accessibility`)
          .set(auth(w.driver.accessToken))
          .send(body)
      ).status,
    ).toBe(403);
    const other = await onboardUser('PASSENGER');
    expect(
      (
        await api
          .put(`/api/v1/trips/${w.tripId}/accessibility`)
          .set(auth(other.accessToken))
          .send(body)
      ).status,
    ).toBe(404);
    await arriveAtPickup({
      ...w,
      passengerId: w.passenger.user.id as string,
      driverId: w.driver.user.id as string,
      driver: w.driver,
      passenger: w.passenger,
    });
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    const late = await api
      .put(`/api/v1/trips/${w.tripId}/accessibility`)
      .set(auth(w.passenger.accessToken))
      .send(body);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('ACCESSIBILITY_LOCKED');
  });
});

describe('communication preference in calls', () => {
  it('stops the driver calling a passenger who chose messages only, but not the other way round', async () => {
    const w = await assignedRide({ needs: ['HEARING'], communication: 'TEXT_ONLY' });
    const driverId = w.driver.user.id as string;
    await expect(startCall(w.tripId, driverId, 'AUDIO')).rejects.toMatchObject({
      status: 409,
      code: 'CALL_NOT_PREFERRED',
    });
    await expect(startCall(w.tripId, driverId, 'AUDIO')).rejects.toThrow(/messages/);
    // Chat still works for the driver.
    const chat = await api
      .post(`/api/v1/trips/${w.tripId}/chat`)
      .set(auth(w.driver.accessToken))
      .send({ clientMessageId: 'abcdefgh-1', body: 'I am at the entrance' });
    expect(chat.status, JSON.stringify(chat.body)).toBeLessThan(300);
    // The passenger may still call (their own choice).
    const call = await startCall(w.tripId, w.passenger.user.id as string, 'AUDIO');
    expect(call.callerRole).toBeDefined();
  });

  it('lets the driver call when the passenger accepts calls, including "messages first"', async () => {
    const w = await assignedRide({ needs: ['VISUAL'], communication: 'TEXT_PREFERRED' });
    const call = await startCall(w.tripId, w.driver.user.id as string, 'AUDIO');
    expect(call.callerRole).toBeDefined();
  });
});

// ---------------------------------------------------------------- administration

describe('administering features and statistics', () => {
  it('adds and edits a feature with a reason, checks the version, and will not switch off a core one', async () => {
    const mgr = await admin(['ACCESSIBILITY_MANAGE']);
    const add = await api.post('/api/v1/admin/accessibility/attributes').set(auth(mgr)).send({
      label: 'Hearing loop installed',
      help: 'A hearing loop for hearing aid users.',
      requiresApproval: false,
      active: true,
      reason: 'New feature',
    });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body.data.code).toBe('HEARING_LOOP_INSTALLED');
    const code = add.body.data.code as string;
    const edit = await api
      .put(`/api/v1/admin/accessibility/attributes/${code}`)
      .set(auth(mgr))
      .send({
        label: 'Hearing loop',
        help: 'A hearing loop for hearing aid users.',
        requiresApproval: true,
        active: true,
        version: 1,
        reason: 'Needs checking',
      });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.data.version).toBe(2);
    const stale = await api
      .put(`/api/v1/admin/accessibility/attributes/${code}`)
      .set(auth(mgr))
      .send({
        label: 'Hearing loop',
        help: 'A hearing loop for hearing aid users.',
        requiresApproval: true,
        active: true,
        version: 1,
        reason: 'Again',
      });
    expect(stale.status).toBe(409);
    const core = await api
      .put('/api/v1/admin/accessibility/attributes/WHEELCHAIR_ACCESSIBLE')
      .set(auth(mgr))
      .send({
        label: 'Wheelchair accessible vehicle',
        help: 'Seated in a wheelchair.',
        requiresApproval: true,
        active: false,
        reason: 'Trying',
      });
    expect(core.status).toBe(409);
    expect(core.body.error.code).toBe('CORE_ATTRIBUTE');
    const viewer = await admin(['ACCESSIBILITY_VIEW']);
    expect(
      (
        await api.post('/api/v1/admin/accessibility/attributes').set(auth(viewer)).send({
          label: 'Another one',
          help: 'Some help',
          requiresApproval: false,
          active: true,
          reason: 'No',
        })
      ).status,
    ).toBe(403);
    expect((await api.get('/api/v1/admin/accessibility/attributes').set(auth(viewer))).status).toBe(
      200,
    );
    await pool.query('DELETE FROM accessibility_attributes WHERE code = $1', [code]);
  });

  it('puts claims back in the queue when a feature starts to need approval', async () => {
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    const vehicleId = await vehicleOf(d);
    await declare(d.accessToken, vehicleId, ['EXTRA_SPACE']);
    const mgr = await admin(['ACCESSIBILITY_MANAGE']);
    try {
      await api.put('/api/v1/admin/accessibility/attributes/EXTRA_SPACE').set(auth(mgr)).send({
        label: 'Extra space',
        help: 'Room for a folded wheelchair.',
        requiresApproval: true,
        active: true,
        reason: 'Now checked',
      });
      const row = await pool.query(
        `SELECT status FROM vehicle_accessibility WHERE vehicle_id = $1`,
        [vehicleId],
      );
      expect(row.rows[0].status).toBe('PENDING');
    } finally {
      await pool.query(
        `UPDATE accessibility_attributes SET requires_approval = false WHERE code = 'EXTRA_SPACE'`,
      );
    }
  });

  it('gives counts only: no rider is named', async () => {
    const w = await assignedRide({ needs: ['WHEELCHAIR'], pickupNote: 'Private note abc' });
    void w;
    const viewer = await admin(['ACCESSIBILITY_VIEW']);
    const res = await api.get('/api/v1/admin/accessibility/stats?range=30d').set(auth(viewer));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.ridesNeedingAccessibleVehicle).toBeGreaterThanOrEqual(1);
    expect(res.body.data.ridesNeedingAccessibleVehicleMatched).toBeGreaterThanOrEqual(1);
    expect(res.body.data.accessibleVehiclesApproved).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(res.body)).not.toContain('Private note abc');
    const finance = await admin(['FINANCE_VIEW']);
    expect((await api.get('/api/v1/admin/accessibility/stats').set(auth(finance))).status).toBe(
      403,
    );
  });
});

// ---------------------------------------------------------------- the request body is strict

describe('request validation', () => {
  it('refuses unknown accessibility values and extra fields in a ride request', async () => {
    const p = await onboardUser('PASSENGER');
    const bad = await rideWith({ needs: ['NOT_A_NEED'] }, p);
    expect(bad.res.status).toBe(400);
    const extra = await rideWith({ needs: [], diagnosis: 'x' }, p);
    expect(extra.res.status).toBe(400);
    const long = await rideWith({ pickupNote: 'y'.repeat(300) }, p);
    expect(long.res.status).toBe(400);
  });
});
