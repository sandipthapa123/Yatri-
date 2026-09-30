import {
  ADMIN_PERMISSIONS,
  INCIDENT_CATEGORIES,
  INCIDENT_STATES,
  INCIDENT_TRANSITIONS,
  SOS_STATES,
  SOS_TRANSITIONS,
  canIncidentTransition,
  canSosTransition,
  describeIncidentStatus,
  describeRatingSummary,
  describeSosStatus,
  incidentStatesLeadingTo,
  sosStatesLeadingTo,
} from '@yatri/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { pool } from '../config/database';
import { getSmsProvider } from '../modules/auth/sms';
import { ratingSummary } from '../modules/trips/ratings.service';
import { api, loginTestAdmin, onboardUser } from './helpers';
import {
  THAMEL,
  arriveAtPickup,
  auth,
  driverAt,
  north,
  requestRide,
  rideWorld,
  type RideWorld,
} from './rides';
import { login, startTestServer, type Msg } from './wsClient';

let port = 0;
let stop: () => Promise<void>;
beforeAll(async () => {
  const s = await startTestServer();
  port = s.port;
  stop = s.close;
});
afterAll(async () => {
  await stop();
});

let n = 0;
async function safetyAdmin(permissions: string[] = ['SAFETY_REVIEW']) {
  const email = `safety-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1');
  await pool.query('UPDATE users SET admin_permissions = $2::text[] WHERE email = $1', [
    email,
    permissions,
  ]);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0]
    .id as string;
  return { token, id };
}
const post = (token: string, path: string, body: object = {}) =>
  api.post(path).set(auth(token)).send(body);
const get = (token: string, path: string) => api.get(path).set(auth(token));
const sos = (token: string, tripId: string, body: object = {}) =>
  post(token, `/api/v1/trips/${tripId}/sos`, body);
const notes = async (userId: string, type: string) =>
  (
    await pool.query(
      'SELECT body, metadata FROM notifications WHERE user_id = $1 AND type = $2 ORDER BY created_at',
      [userId, type],
    )
  ).rows as Array<{
    body: string;
    metadata: Record<string, unknown>;
  }>;
const audit = async (subjectId: string) =>
  (
    await pool.query('SELECT action, actor_role FROM audit_log WHERE subject_id = $1 ORDER BY id', [
      subjectId,
    ])
  ).rows as Array<{
    action: string;
    actor_role: string | null;
  }>;
const dbSos = async (tripId: string) =>
  (await pool.query('SELECT * FROM sos_events WHERE trip_id = $1 ORDER BY created_at', [tripId]))
    .rows;

async function completed(w: RideWorld) {
  await arriveAtPickup(w);
  await post(w.driver.accessToken, `/api/v1/trips/${w.tripId}/start`);
  await post(w.driver.accessToken, `/api/v1/trips/${w.tripId}/complete`);
}

// ================================================================= ratings

describe('ratings', () => {
  it('open only once the ride is completed, and only for the two people on it', async () => {
    const w = await rideWorld();
    const rate = (token: string, body: object) =>
      post(token, `/api/v1/trips/${w.tripId}/rating`, body);
    expect((await rate(w.passenger.accessToken, { stars: 5 })).body.error.code).toBe(
      'TRIP_NOT_COMPLETED',
    );
    await completed(w);
    const stranger = await onboardUser('PASSENGER');
    expect((await rate(stranger.accessToken, { stars: 5 })).status).toBe(404);
    expect(
      (await rate(w.passenger.accessToken, { stars: 5, comment: 'Kind and on time' })).status,
    ).toBe(201);
    expect((await rate(w.driver.accessToken, { stars: 4 })).status).toBe(201); // the driver rates the passenger
    // whom each rating is about
    const rows = (
      await pool.query(
        'SELECT rater_role, ratee_id, stars, comment FROM trip_ratings WHERE trip_id = $1 ORDER BY stars DESC',
        [w.tripId],
      )
    ).rows;
    expect(rows).toEqual([
      { rater_role: 'PASSENGER', ratee_id: w.driverId, stars: 5, comment: 'Kind and on time' },
      { rater_role: 'DRIVER', ratee_id: w.passengerId, stars: 4, comment: null },
    ]);
  });

  it('accepts only 1 to 5 whole stars and a bounded comment', async () => {
    const w = await rideWorld();
    await completed(w);
    const rate = (body: object) =>
      post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/rating`, body);
    for (const bad of [
      { stars: 0 },
      { stars: 6 },
      { stars: 3.5 },
      { stars: '5' },
      { stars: 3, comment: 'x'.repeat(501) },
      { stars: 3, driverId: 'x' },
      {},
    ]) {
      expect((await rate(bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
    expect((await rate({ stars: 3, comment: 'x'.repeat(500) })).status).toBe(201);
  });

  it('counts a person once per ride, even when several submissions arrive at the same moment', async () => {
    const w = await rideWorld();
    await completed(w);
    const results = await Promise.all(
      [5, 4, 3, 2, 1].map((stars) =>
        post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/rating`, { stars }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'ALREADY_RATED'),
    ).toBe(true);
    const count = await pool.query(
      'SELECT count(*)::int AS n FROM trip_ratings WHERE trip_id = $1 AND rater_id = $2',
      [w.tripId, w.passengerId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('aggregates in one place: average to one decimal and a count, the same for everyone who asks', async () => {
    const a = await rideWorld();
    const b = await rideWorld();
    for (const [w, stars] of [
      [a, 5],
      [b, 2],
    ] as const) {
      await completed(w);
      await post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/rating`, { stars });
    }
    await pool.query('UPDATE trip_ratings SET ratee_id = $1 WHERE trip_id = $2', [
      a.driverId,
      b.tripId,
    ]); // b's rating is about a's driver too
    expect(await ratingSummary(a.driverId)).toEqual({ average: 3.5, count: 2 });
    expect(describeRatingSummary({ average: 3.5, count: 2 })).toBe(
      'Rating 3.5 out of 5, from 2 ratings',
    );
    expect(describeRatingSummary({ average: null, count: 0 })).toBe('No ratings yet');

    expect((await get(a.driver.accessToken, '/api/v1/users/me/rating')).body.data).toEqual({
      average: 3.5,
      count: 2,
    });
    const seen = (await get(a.passenger.accessToken, `/api/v1/trips/${a.tripId}`)).body.data
      .counterpart;
    expect(seen).toMatchObject({ rating: 3.5, ratingCount: 2 });
    expect((await get(a.passenger.accessToken, '/api/v1/users/me/rating')).body.data).toEqual({
      average: null,
      count: 0,
    });
    expect((await api.get('/api/v1/users/me/rating')).status).toBe(401);
  });

  it('keeps written feedback away from the person it is about, and shows low ratings to the safety team only', async () => {
    const w = await rideWorld();
    await completed(w);
    await post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/rating`, {
      stars: 1,
      comment: 'Drove dangerously',
    });
    const driverView = JSON.stringify([
      (await get(w.driver.accessToken, `/api/v1/trips/${w.tripId}`)).body,
      (await get(w.driver.accessToken, `/api/v1/trips/${w.tripId}/events`)).body,
      (await get(w.driver.accessToken, '/api/v1/users/me/rating')).body,
    ]);
    expect(driverView).not.toContain('dangerously');

    const plain = await safetyAdmin(['TRIP_CHAT_VIEW']);
    expect((await get(plain.token, '/api/v1/admin/ratings/low')).status).toBe(403);
    const team = await safetyAdmin();
    const low = (await get(team.token, '/api/v1/admin/ratings/low')).body.data;
    expect(low.items[0]).toMatchObject({
      tripId: w.tripId,
      stars: 1,
      comment: 'Drove dangerously',
      raterRole: 'PASSENGER',
    });
    expect((await audit(team.id)).map((a) => a.action)).toContain('VIEW_LOW_RATINGS');
  });
});

// ================================================================= emergency contacts

describe('emergency contacts', () => {
  const add = (token: string, name: string, phoneNumber: string) =>
    post(token, '/api/v1/users/me/emergency-contacts', { name, phoneNumber });

  it('are added, listed and removed by their owner, with validation', async () => {
    const p = await onboardUser('PASSENGER');
    expect((await get(p.accessToken, '/api/v1/users/me/emergency-contacts')).body.data).toEqual({
      contacts: [],
      limit: 5,
      emergencyNumber: '100',
    });
    const a = await add(p.accessToken, '  Mother  ', '+9779811111111');
    expect(a.status).toBe(201);
    expect(a.body.data).toMatchObject({ name: 'Mother', phoneNumber: '+9779811111111' });
    for (const bad of [
      { name: '', phoneNumber: '+9779822222222' },
      { name: 'X', phoneNumber: '9822222222' },
      { name: 'X', phoneNumber: 'not a number' },
      { name: 'X'.repeat(61), phoneNumber: '+9779822222222' },
      { name: 'X', phoneNumber: '+9779822222222', userId: 'y' },
    ]) {
      expect(
        (await post(p.accessToken, '/api/v1/users/me/emergency-contacts', bad)).status,
        JSON.stringify(bad).slice(0, 40),
      ).toBe(400);
    }
    expect((await add(p.accessToken, 'Again', '+9779811111111')).body.error.code).toBe(
      'DUPLICATE_CONTACT',
    );
    expect((await add(p.accessToken, 'Me', p.phoneNumber)).status).toBe(422);
    const list = (await get(p.accessToken, '/api/v1/users/me/emergency-contacts')).body.data
      .contacts;
    expect(list).toHaveLength(1);
    expect(
      (
        await api
          .delete(`/api/v1/users/me/emergency-contacts/${a.body.data.id}`)
          .set(auth(p.accessToken))
      ).status,
    ).toBe(200);
    expect(
      (await get(p.accessToken, '/api/v1/users/me/emergency-contacts')).body.data.contacts,
    ).toEqual([]);
    const acts = (await audit(p.user.id as string)).map((x) => x.action);
    expect(acts).toEqual(
      expect.arrayContaining(['EMERGENCY_CONTACT_ADDED', 'EMERGENCY_CONTACT_REMOVED']),
    );
  });

  it('are private: nobody else can list, remove or even detect them, and the audit never holds the number', async () => {
    const owner = await onboardUser('PASSENGER');
    const other = await onboardUser('DRIVER');
    const c = (await add(owner.accessToken, 'Sister', '+9779833333333')).body.data;
    expect(
      (await get(other.accessToken, '/api/v1/users/me/emergency-contacts')).body.data.contacts,
    ).toEqual([]);
    expect(
      (await api.delete(`/api/v1/users/me/emergency-contacts/${c.id}`).set(auth(other.accessToken)))
        .status,
    ).toBe(404);
    expect(
      (await get(owner.accessToken, '/api/v1/users/me/emergency-contacts')).body.data.contacts,
    ).toHaveLength(1); // still there
    expect((await api.get('/api/v1/users/me/emergency-contacts')).status).toBe(401);
    const admin = await safetyAdmin();
    expect((await get(admin.token, '/api/v1/users/me/emergency-contacts')).status).toBe(403); // an admin has no route to them
    const log = JSON.stringify((await pool.query('SELECT * FROM audit_log')).rows);
    expect(log).not.toContain('9833333333');
  });

  it('keep a person to the limit, even under a burst', async () => {
    const p = await onboardUser('PASSENGER');
    const burst = await Promise.all(
      Array.from({ length: 9 }, (_, i) =>
        add(p.accessToken, `C${i}`, `+97798100000${String(i).padStart(2, '0')}`),
      ),
    );
    expect(burst.filter((r) => r.status === 201)).toHaveLength(5);
    expect(burst.find((r) => r.status === 409)?.body.error.code).toBe('EMERGENCY_CONTACT_LIMIT');
  });
});

// ================================================================= SOS

describe('SOS: raising an alert', () => {
  it('records the person, the ride, the time, the position and the status — at once', async () => {
    const w = await rideWorld();
    const at = north(THAMEL, 60);
    const res = await sos(w.passenger.accessToken, w.tripId, {
      latitude: at.latitude,
      longitude: at.longitude,
      accuracyMeters: 12,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      tripId: w.tripId,
      status: 'ACTIVE',
      locationRecorded: true,
      contactsNotified: 0,
      emergencyNumber: '100',
    });
    const [row] = await dbSos(w.tripId);
    expect(row).toMatchObject({
      user_id: w.passengerId,
      role: 'PASSENGER',
      status: 'ACTIVE',
      location_source: 'DEVICE',
    });
    expect(Number(row.latitude)).toBeCloseTo(at.latitude, 5);
    expect(row.accuracy_meters).toBe(12);
    expect(Math.abs(Date.now() - row.created_at.getTime())).toBeLessThan(10_000);
    expect((await audit(row.id)).map((a) => `${a.action}:${a.actor_role}`)).toEqual([
      'SOS_TRIGGERED:PASSENGER',
    ]);
    expect(describeSosStatus(res.body.data)).toBe(
      'Emergency alert sent. The Yatri safety team has been notified.',
    );
  });

  it('takes a driver’s position from the server’s own feed, never from the request', async () => {
    const w = await rideWorld();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 250));
    const res = await sos(w.driver.accessToken, w.tripId, { latitude: 10, longitude: 10 }); // a forged position
    expect(res.status).toBe(201);
    const [row] = await dbSos(w.tripId);
    expect(row).toMatchObject({ role: 'DRIVER', location_source: 'DRIVER_FEED' });
    expect(Number(row.latitude)).toBeCloseTo(north(THAMEL, 250).latitude, 4);
  });

  it('still raises the alert with no usable position, using the driver feed once they are together', async () => {
    const w = await rideWorld();
    const a = await sos(w.passenger.accessToken, w.tripId, { latitude: 0, longitude: 0 }); // null island is not a position
    expect(a.status).toBe(201);
    expect(a.body.data.locationRecorded).toBe(false);
    expect((await dbSos(w.tripId))[0].location_source).toBe('NONE');

    const w2 = await rideWorld();
    await arriveAtPickup(w2); // now with the driver: the feed stands in
    const b = await sos(w2.passenger.accessToken, w2.tripId);
    expect(b.status).toBe(201);
    expect((await dbSos(w2.tripId))[0].location_source).toBe('DRIVER_FEED');
  });

  it('is only for the two people on an active, assigned ride', async () => {
    const w = await rideWorld();
    const stranger = await onboardUser('PASSENGER');
    expect((await sos(stranger.accessToken, w.tripId)).status).toBe(404);
    expect((await api.post(`/api/v1/trips/${w.tripId}/sos`).send({})).status).toBe(401);
    for (const bad of [
      { userId: w.driverId },
      { status: 'RESOLVED' },
      { tripId: 'x' },
      { latitude: 91 },
    ]) {
      expect((await sos(w.passenger.accessToken, w.tripId, bad)).status, JSON.stringify(bad)).toBe(
        400,
      );
    }
    const p2 = await onboardUser('PASSENGER');
    const searching = await requestRide(p2.accessToken); // nobody has accepted yet
    const early = await sos(p2.accessToken, searching.body.data.id);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('SOS_NOT_AVAILABLE');
    expect(early.body.error.message).toContain('call 100');
    await completed(w);
    expect((await sos(w.passenger.accessToken, w.tripId)).status).toBe(409);
  });

  it('is one alert however many times, or from how many phones, it is pressed', async () => {
    const w = await rideWorld();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => sos(w.passenger.accessToken, w.tripId)),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    expect(new Set(results.map((r) => r.body.data.id)).size).toBe(1);
    expect(await dbSos(w.tripId)).toHaveLength(1);
    expect(
      (await audit(results[0]?.body.data.id)).filter((a) => a.action === 'SOS_TRIGGERED'),
    ).toHaveLength(1);
    // the other person raising their own alert is a separate alert
    expect((await sos(w.driver.accessToken, w.tripId)).status).toBe(201);
    expect(await dbSos(w.tripId)).toHaveLength(2);
  });

  it('hands the person their alert again after a reconnect, and the other person never sees it', async () => {
    const w = await rideWorld();
    await sos(w.passenger.accessToken, w.tripId);
    const mine = (await get(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/sos`)).body.data;
    expect(mine).toMatchObject({ status: 'ACTIVE' });
    expect(JSON.stringify(mine)).not.toMatch(/latitude|longitude/); // the position stays with the safety team
    expect((await get(w.driver.accessToken, `/api/v1/trips/${w.tripId}/sos`)).body.data).toBeNull();
  });
});

describe('SOS: who is told, and who is not', () => {
  it('tells the person’s own devices and the safety team — and NEVER the other person on the ride', async () => {
    const w = await rideWorld();
    const team = await safetyAdmin();
    const bystander = await safetyAdmin(['TRIP_CHAT_VIEW']); // an admin without the permission
    const phone = await login(port, w.passenger.accessToken);
    const tablet = await login(port, w.passenger.accessToken);
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');

    const res = await sos(w.passenger.accessToken, w.tripId);
    const isState = (m: Msg) => m.type === 'sos_state';
    const a = await phone.waitFor(isState);
    const b = await tablet.waitFor(isState);
    expect(a.sos).toMatchObject({ id: res.body.data.id, status: 'ACTIVE' });
    expect(b.sos.id).toBe(a.sos.id);

    // the other person hears nothing: no alert, no ride event, no notification
    await dc.expectNothing(
      (m) => isState(m) || (m.type === 'trip_event' && /SOS|SHARE/.test(m.event.type)),
      600,
    );
    const events = (await get(w.driver.accessToken, `/api/v1/trips/${w.tripId}/events`)).body.data;
    expect(events.map((e: { type: string }) => e.type).join()).not.toMatch(/SOS|SHARE/);
    expect(
      (
        await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type LIKE 'SOS%'", [
          w.driverId,
        ])
      ).rowCount,
    ).toBe(0);

    // the safety team is told (without a name, a place or a description); others are not
    const teamNotes = await notes(team.id, 'SOS_TRIGGERED');
    expect(teamNotes).toHaveLength(1);
    expect(teamNotes[0]?.body).toBe('An SOS alert needs attention.');
    expect(teamNotes[0]?.metadata).toEqual({ sosId: res.body.data.id, tripId: w.tripId });
    expect(await notes(bystander.id, 'SOS_TRIGGERED')).toHaveLength(0);
  });

  it('texts each emergency contact a link to follow the trip — quietly, and only what they need', async () => {
    const w = await rideWorld();
    await pool.query('UPDATE users SET full_name = $2 WHERE id = $1', [
      w.passengerId,
      'Sita Sharma',
    ]);
    for (const [name, phone] of [
      ['Mother', '+9779811111111'],
      ['Brother', '+9779822222222'],
    ]) {
      await post(w.passenger.accessToken, '/api/v1/users/me/emergency-contacts', {
        name,
        phoneNumber: phone,
      });
    }
    const send = vi.spyOn(getSmsProvider(), 'send').mockResolvedValue(undefined);
    try {
      const res = await sos(w.passenger.accessToken, w.tripId);
      expect(res.body.data.contactsNotified).toBe(2);
      expect(describeSosStatus(res.body.data)).toContain(
        '2 emergency contacts have been sent a link',
      );
      expect(send).toHaveBeenCalledTimes(2);
      const msgs = send.mock.calls.map((c) => c[0]);
      expect(msgs.map((m) => m.toPhoneNumber).sort()).toEqual(['+9779811111111', '+9779822222222']);
      const link = /(http\S+\/share\/[A-Za-z0-9_-]{43})/.exec(msgs[0]?.body ?? '')?.[1] as string;
      expect(link).toBeTruthy();
      expect(msgs[0]?.body).toContain('Sita may need help during a Yatri ride');
      expect(msgs[0]?.body).toContain('call 100');
      // nothing more than the first name and the link: no surname, phone, pickup or destination
      for (const secret of ['Sharma', 'Thamel', 'Patan', w.passengerId, w.tripId])
        expect(msgs[0]?.body).not.toContain(secret);

      // the link works, shows the ride the way any trusted contact would see it, and reveals no passenger identity
      const view = await api.get(`/share/${link.split('/share/')[1]}/data`);
      expect(view.status).toBe(200);
      expect(JSON.stringify(view.body)).not.toMatch(/Sita|Sharma|\+977981/);

      // quiet: the driver is not told a link exists; the passenger's own share list and limit are untouched
      const events = (await get(w.driver.accessToken, `/api/v1/trips/${w.tripId}/events`)).body
        .data;
      expect(events.map((e: { type: string }) => e.type).join()).not.toMatch(/SHARE|SOS/);
      expect(
        (await get(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/shares`)).body.data,
      ).toEqual([]);
      for (let i = 0; i < 3; i++)
        expect(
          (await post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/shares`)).status,
        ).toBe(201);
      const purposes = await pool.query(
        'SELECT purpose, count(*)::int AS n FROM trip_shares WHERE trip_id = $1 GROUP BY purpose ORDER BY purpose',
        [w.tripId],
      );
      expect(purposes.rows).toEqual([
        { purpose: 'SOS', n: 1 },
        { purpose: 'TRIP', n: 3 },
      ]);
    } finally {
      send.mockRestore();
    }
  });

  it('is not held up by a contact who cannot be reached, and does not text twice for a repeat press', async () => {
    const w = await rideWorld();
    for (const [name, phone] of [
      ['A', '+9779811111111'],
      ['B', '+9779822222222'],
    ]) {
      await post(w.passenger.accessToken, '/api/v1/users/me/emergency-contacts', {
        name,
        phoneNumber: phone,
      });
    }
    const send = vi
      .spyOn(getSmsProvider(), 'send')
      .mockRejectedValueOnce(new Error('carrier down'))
      .mockResolvedValue(undefined);
    try {
      const results = await Promise.all(
        [1, 2, 3].map(() => sos(w.passenger.accessToken, w.tripId)),
      );
      expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
      expect(send).toHaveBeenCalledTimes(2); // once per contact, however many presses
      expect((await dbSos(w.tripId))[0].contacts_notified).toBe(1); // the one that got through
    } finally {
      send.mockRestore();
    }
  });
});

describe('SOS: moving an alert through its states', () => {
  it('lets the person say they are safe, tells the team, and cannot be repeated', async () => {
    const w = await rideWorld();
    const team = await safetyAdmin();
    const phone = await login(port, w.passenger.accessToken);
    const id = (await sos(w.passenger.accessToken, w.tripId)).body.data.id;
    const stateMsg = (m: Msg) => m.type === 'sos_state' && m.sos.status === 'CANCELLED';

    const done = await post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/sos/cancel`);
    expect(done.status).toBe(200);
    expect(done.body.data.status).toBe('CANCELLED');
    expect(describeSosStatus(done.body.data)).toBe('You cancelled the emergency alert.');
    await phone.waitFor(stateMsg);
    expect((await notes(team.id, 'SOS_CANCELLED'))[0]?.body).toBe(
      'A person says they are safe and cancelled their SOS alert.',
    );
    expect(
      (await post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/sos/cancel`)).status,
    ).toBe(404);
    expect((await post(w.driver.accessToken, `/api/v1/trips/${w.tripId}/sos/cancel`)).status).toBe(
      404,
    ); // theirs to cancel, not the driver's
    expect((await audit(id)).map((a) => a.action)).toEqual(['SOS_TRIGGERED', 'SOS_CANCELLED']);
    // once it has ended, a new alert is a new alert
    expect((await sos(w.passenger.accessToken, w.tripId)).status).toBe(201);
    expect(await dbSos(w.tripId)).toHaveLength(2);
  });

  it('is acknowledged and resolved by the safety team, who alone see the position, each step audited', async () => {
    const w = await rideWorld();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 120));
    await arriveAtPickup(w);
    const at = north(THAMEL, 40);
    const id = (
      await sos(w.passenger.accessToken, w.tripId, {
        latitude: at.latitude,
        longitude: at.longitude,
      })
    ).body.data.id;
    const team = await safetyAdmin();
    const phone = await login(port, w.passenger.accessToken);

    const plain = await safetyAdmin(['DRIVER_LOCATION_VIEW', 'TRIP_CHAT_VIEW']);
    for (const path of ['/api/v1/admin/sos', `/api/v1/admin/sos/${id}`])
      expect((await get(plain.token, path)).status, path).toBe(403);
    expect((await post(plain.token, `/api/v1/admin/sos/${id}/acknowledge`)).status).toBe(403);

    const list = (await get(team.token, '/api/v1/admin/sos')).body.data;
    expect(list.items[0]).toMatchObject({
      id,
      status: 'ACTIVE',
      role: 'PASSENGER',
      locationRecorded: true,
    });
    const detail = (await get(team.token, `/api/v1/admin/sos/${id}`)).body.data;
    expect(detail.location).toMatchObject({ source: 'DEVICE' });
    expect(detail.location.latitude).toBeCloseTo(at.latitude, 5);
    expect(detail.trip).toMatchObject({ passengerName: null, pickup: 'Thamel' });
    expect(detail.trip.vehicle).toBe('White Toyota Corolla');

    const ack = await post(team.token, `/api/v1/admin/sos/${id}/acknowledge`, {
      note: 'Calling the driver',
    });
    expect(ack.body.data.status).toBe('ACKNOWLEDGED');
    const heard = await phone.waitFor(
      (m) => m.type === 'sos_state' && m.sos.status === 'ACKNOWLEDGED',
    );
    expect(describeSosStatus(heard.sos)).toBe(
      'The Yatri safety team has seen your alert and is responding.',
    );
    expect((await notes(w.passengerId, 'SOS_UPDATE'))[0]?.body).toBe(
      'The Yatri safety team has seen your alert and is responding.',
    );
    expect(
      (
        await pool.query("SELECT 1 FROM notifications WHERE user_id = $1 AND type LIKE 'SOS%'", [
          w.driverId,
        ])
      ).rowCount,
    ).toBe(0);

    expect((await post(team.token, `/api/v1/admin/sos/${id}/resolve`, {})).status).toBe(400); // a note is required
    const resolved = await post(team.token, `/api/v1/admin/sos/${id}/resolve`, {
      note: 'Rider is safe; driver spoken to',
    });
    expect(resolved.body.data.status).toBe('RESOLVED');
    expect(
      (await post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/sos/cancel`)).status,
    ).toBe(404); // nothing open to cancel
    const after = (await get(team.token, `/api/v1/admin/sos/${id}`)).body.data;
    expect(after).toMatchObject({
      status: 'RESOLVED',
      resolutionNote: 'Rider is safe; driver spoken to',
    });

    // every step, and every look at the position, is in the one audit log
    const trail = after.audit.map(
      (a: { action: string; actorRole: string }) => `${a.action}:${a.actorRole}`,
    );
    expect(trail).toEqual([
      'SOS_TRIGGERED:PASSENGER',
      'VIEW_SOS:ADMIN',
      'SOS_ACKNOWLEDGED:ADMIN',
      'SOS_RESOLVED:ADMIN',
      'VIEW_SOS:ADMIN',
    ]);
  });

  it('follows the state machine and cannot be moved backwards or twice', async () => {
    const w = await rideWorld();
    const id = (await sos(w.passenger.accessToken, w.tripId)).body.data.id;
    const team = await safetyAdmin();
    await post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/sos/cancel`);
    for (const path of ['acknowledge', 'resolve']) {
      const res = await post(team.token, `/api/v1/admin/sos/${id}/${path}`, { note: 'too late' });
      expect(res.status, path).toBe(409);
      expect(res.body.error.code).toBe('SOS_STATE_CONFLICT');
    }
    expect(
      (await post(team.token, '/api/v1/admin/sos/00000000-0000-4000-8000-000000000000/acknowledge'))
        .status,
    ).toBe(404);
  });

  it('stays consistent when the team and the person act at the same moment', async () => {
    for (let i = 0; i < 3; i++) {
      const w = await rideWorld();
      const id = (await sos(w.passenger.accessToken, w.tripId)).body.data.id;
      const team = await safetyAdmin();
      const [ack, cancel, resolve] = await Promise.all([
        post(team.token, `/api/v1/admin/sos/${id}/acknowledge`),
        post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/sos/cancel`),
        post(team.token, `/api/v1/admin/sos/${id}/resolve`, { note: 'closing it' }),
      ]);
      const final = (await pool.query('SELECT status FROM sos_events WHERE id = $1', [id])).rows[0]
        .status;
      expect(['ACKNOWLEDGED', 'RESOLVED', 'CANCELLED']).toContain(final);
      // exactly one of the two ENDING moves can have won, and never both
      expect([cancel.status, resolve.status].filter((s) => s === 200).length).toBeLessThanOrEqual(
        1,
      );
      // whatever happened is a legal path through the table, and every success is in the audit
      const acts = (await audit(id)).map((a) => a.action);
      expect(
        acts.filter((a) => a === 'SOS_RESOLVED' || a === 'SOS_CANCELLED').length,
      ).toBeLessThanOrEqual(1);
      void ack;
    }
  });
});

// ================================================================= incident reports

describe('incident reports', () => {
  const report = (token: string, tripId: string, body: object) =>
    post(token, `/api/v1/trips/${tripId}/incidents`, body);

  it('take every category, from either person, about a ride with a driver — and are validated', async () => {
    const w = await rideWorld();
    for (const category of INCIDENT_CATEGORIES) {
      const res = await report(w.passenger.accessToken, w.tripId, {
        category,
        description: `Something happened: ${category}`,
      });
      expect(res.status, category).toBe(201);
      expect(res.body.data).toMatchObject({ tripId: w.tripId, category, status: 'OPEN' });
    }
    const fromDriver = await report(w.driver.accessToken, w.tripId, {
      category: 'HARASSMENT',
      description: 'The passenger was abusive',
    });
    expect(fromDriver.status).toBe(201);
    expect(
      (
        await pool.query('SELECT reporter_role FROM incident_reports WHERE id = $1', [
          fromDriver.body.data.id,
        ])
      ).rows[0].reporter_role,
    ).toBe('DRIVER');
    for (const bad of [
      { category: 'NOPE', description: 'long enough text' },
      { category: 'OTHER', description: 'short' },
      { category: 'OTHER', description: 'x'.repeat(2001) },
      { category: 'OTHER', description: 'long enough text', status: 'RESOLVED' },
      { description: 'no category here' },
    ]) {
      expect(
        (await report(w.driver.accessToken, w.tripId, bad)).status,
        JSON.stringify(bad).slice(0, 50),
      ).toBe(400);
    }
  });

  it('are private to the reporter and the ride, and need a driver to report about', async () => {
    const w = await rideWorld();
    const stranger = await onboardUser('PASSENGER');
    const body = { category: 'SAFETY_ISSUE', description: 'The driver was speeding' };
    expect((await report(stranger.accessToken, w.tripId, body)).status).toBe(404);
    expect((await api.post(`/api/v1/trips/${w.tripId}/incidents`).send(body)).status).toBe(401);
    const p2 = await onboardUser('PASSENGER');
    const searching = await requestRide(p2.accessToken);
    expect((await report(p2.accessToken, searching.body.data.id, body)).body.error.code).toBe(
      'INCIDENT_NOT_AVAILABLE',
    );

    await report(w.passenger.accessToken, w.tripId, body);
    expect(
      (await get(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/incidents`)).body.data,
    ).toHaveLength(1);
    expect(
      (await get(w.driver.accessToken, `/api/v1/trips/${w.tripId}/incidents`)).body.data,
    ).toEqual([]); // the other person does not see it
    expect((await get(stranger.accessToken, `/api/v1/trips/${w.tripId}/incidents`)).status).toBe(
      404,
    );
  });

  it('tell the team something needs review — without saying what — and the reporter hears each change', async () => {
    const w = await rideWorld();
    const team = await safetyAdmin();
    const res = await report(w.passenger.accessToken, w.tripId, {
      category: 'FRAUD',
      description: 'They charged me twice in cash',
    });
    const id = res.body.data.id;
    const t = await notes(team.id, 'INCIDENT_REPORTED');
    expect(t).toHaveLength(1);
    expect(t[0]?.body).toBe('A fraud report needs review.');
    expect(JSON.stringify(t)).not.toContain('charged me twice');

    await post(team.token, `/api/v1/admin/incidents/${id}/status`, { status: 'UNDER_REVIEW' });
    const update = await notes(w.passengerId, 'INCIDENT_UPDATE');
    expect(update[0]?.body).toBe(describeIncidentStatus('FRAUD', 'UNDER_REVIEW'));
    expect(update[0]?.body).toBe('Your fraud report is being reviewed.');
    const mine = (await get(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/incidents`)).body
      .data[0];
    expect(mine.status).toBe('UNDER_REVIEW');
    expect(await notes(w.driverId, 'INCIDENT_UPDATE')).toHaveLength(0);
  });
});

describe('incident review by the safety team', () => {
  async function open(category = 'HARASSMENT') {
    const w = await rideWorld();
    const res = await post(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/incidents`, {
      category,
      description: 'The driver kept asking personal questions',
    });
    return { w, id: res.body.data.id as string };
  }

  it('needs SAFETY_REVIEW for everything, and lists and filters on the server', async () => {
    const { id } = await open('ACCIDENT');
    await open('FRAUD');
    const plain = await safetyAdmin(['TRIP_CHAT_VIEW']);
    for (const path of ['/api/v1/admin/incidents', `/api/v1/admin/incidents/${id}`])
      expect((await get(plain.token, path)).status, path).toBe(403);
    expect(
      (await post(plain.token, `/api/v1/admin/incidents/${id}/status`, { status: 'UNDER_REVIEW' }))
        .status,
    ).toBe(403);
    expect(
      (await post(plain.token, `/api/v1/admin/incidents/${id}/notes`, { kind: 'NOTE', body: 'hi' }))
        .status,
    ).toBe(403);
    const p = await onboardUser('PASSENGER');
    expect((await get(p.accessToken, '/api/v1/admin/incidents')).status).toBe(403);

    const team = await safetyAdmin();
    const all = (await get(team.token, '/api/v1/admin/incidents')).body.data;
    expect(all.total).toBe(2);
    const acc = (await get(team.token, '/api/v1/admin/incidents?category=ACCIDENT')).body.data;
    expect(acc.items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect((await get(team.token, '/api/v1/admin/incidents?status=RESOLVED')).body.data.total).toBe(
      0,
    );
    expect((await get(team.token, '/api/v1/admin/incidents?status=NOPE')).status).toBe(400);
  });

  it('moves a report only along the legal states, records internal notes and actions, and hides them from the reporter', async () => {
    const { w, id } = await open();
    const team = await safetyAdmin();
    const status = (to: string, note?: string) =>
      post(team.token, `/api/v1/admin/incidents/${id}/status`, {
        status: to,
        ...(note ? { note } : {}),
      });

    const illegal = await status('RESOLVED'); // straight from OPEN is not allowed
    expect(illegal.status).toBe(409);
    expect(illegal.body.error.code).toBe('INVALID_INCIDENT_TRANSITION');
    expect(illegal.body.error.message).toContain('can only become');

    expect((await status('UNDER_REVIEW', 'Picked up by the night team')).status).toBe(200);
    expect(
      (
        await post(team.token, `/api/v1/admin/incidents/${id}/notes`, {
          kind: 'NOTE',
          body: 'Driver has one earlier complaint',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post(team.token, `/api/v1/admin/incidents/${id}/notes`, {
          kind: 'ACTION',
          body: 'Warned the driver by phone',
        })
      ).status,
    ).toBe(201);
    expect((await status('ACTION_TAKEN')).status).toBe(200);
    expect((await status('UNDER_REVIEW')).status).toBe(200); // legal: taken back for more review
    expect((await status('ACTION_TAKEN')).status).toBe(200);
    expect((await status('RESOLVED', 'Closed after the warning')).status).toBe(200);
    for (const to of INCIDENT_STATES)
      expect((await status(to)).status, `after resolved -> ${to}`).toBe(409); // final
    expect(
      (
        await post(team.token, `/api/v1/admin/incidents/${id}/notes`, {
          kind: 'NOTE',
          body: 'Follow-up call done',
        })
      ).status,
    ).toBe(201); // notes can still be added
    expect(
      (await post(team.token, `/api/v1/admin/incidents/${id}/notes`, { kind: 'STATUS', body: 'x' }))
        .status,
    ).toBe(400); // history cannot be forged

    const detail = (await get(team.token, `/api/v1/admin/incidents/${id}`)).body.data;
    expect(detail.status).toBe('RESOLVED');
    expect(
      detail.notes.map(
        (x: { kind: string; toStatus: string | null }) => `${x.kind}:${x.toStatus ?? ''}`,
      ),
    ).toEqual([
      'STATUS:UNDER_REVIEW',
      'NOTE:',
      'ACTION:',
      'STATUS:ACTION_TAKEN',
      'STATUS:UNDER_REVIEW',
      'STATUS:ACTION_TAKEN',
      'STATUS:RESOLVED',
      'NOTE:',
    ]);
    expect(detail.notes[0]).toMatchObject({
      body: 'Picked up by the night team',
      fromStatus: 'OPEN',
    });
    // the reporter sees the status and nothing the team wrote
    const seen = JSON.stringify(
      (await get(w.passenger.accessToken, `/api/v1/trips/${w.tripId}/incidents`)).body,
    );
    expect(seen).toContain('RESOLVED');
    for (const internal of ['night team', 'earlier complaint', 'Warned the driver', 'Follow-up'])
      expect(seen).not.toContain(internal);

    // audited: who did what, and every look at the report
    const actions = detail.audit.map((a: { action: string }) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'INCIDENT_CREATED',
        'VIEW_INCIDENT',
        'INCIDENT_STATUS_CHANGED',
        'INCIDENT_NOTE_ADDED',
        'INCIDENT_ACTION_RECORDED',
      ]),
    );
    expect(actions.filter((a: string) => a === 'INCIDENT_STATUS_CHANGED')).toHaveLength(5);
  });

  it('applies two admins’ simultaneous moves one after the other, never both', async () => {
    const { id } = await open();
    const a = await safetyAdmin();
    const b = await safetyAdmin();
    const [r1, r2] = await Promise.all([
      post(a.token, `/api/v1/admin/incidents/${id}/status`, { status: 'UNDER_REVIEW' }),
      post(b.token, `/api/v1/admin/incidents/${id}/status`, { status: 'UNDER_REVIEW' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    const moves = await pool.query(
      "SELECT count(*)::int AS n FROM incident_notes WHERE incident_id = $1 AND kind = 'STATUS'",
      [id],
    );
    expect(moves.rows[0].n).toBe(1);
  });
});

// ================================================================= one definition of each state machine

describe('the state machines are defined once and are consistent', () => {
  it('SOS: every state is covered, ended states are final, and "leading to" agrees with the table', () => {
    for (const s of SOS_STATES) expect(SOS_TRANSITIONS[s]).toBeDefined();
    expect(SOS_TRANSITIONS.RESOLVED).toEqual([]);
    expect(SOS_TRANSITIONS.CANCELLED).toEqual([]);
    for (const to of SOS_STATES) {
      for (const from of SOS_STATES)
        expect(sosStatesLeadingTo(to).includes(from)).toBe(canSosTransition(from, to));
    }
    expect(canSosTransition('ACTIVE', 'ACTIVE')).toBe(false);
    expect(canSosTransition('RESOLVED', 'ACTIVE')).toBe(false);
    // every state has words
    for (const status of SOS_STATES)
      expect(describeSosStatus({ status, contactsNotified: 1 }).length).toBeGreaterThan(10);
  });

  it('incidents: every state is covered, ended states are final, nothing skips review', () => {
    for (const s of INCIDENT_STATES) expect(INCIDENT_TRANSITIONS[s]).toBeDefined();
    expect(INCIDENT_TRANSITIONS.RESOLVED).toEqual([]);
    expect(INCIDENT_TRANSITIONS.DISMISSED).toEqual([]);
    for (const to of INCIDENT_STATES) {
      for (const from of INCIDENT_STATES)
        expect(incidentStatesLeadingTo(to).includes(from)).toBe(canIncidentTransition(from, to));
    }
    expect(canIncidentTransition('OPEN', 'RESOLVED')).toBe(false);
    expect(canIncidentTransition('OPEN', 'ACTION_TAKEN')).toBe(false);
    for (const c of INCIDENT_CATEGORIES)
      for (const s of INCIDENT_STATES)
        expect(describeIncidentStatus(c, s).length).toBeGreaterThan(10);
  });

  it('there is one audit log and one permission list', async () => {
    expect(
      (await pool.query("SELECT to_regclass('public.admin_access_log') AS t")).rows[0].t,
    ).toBeNull(); // renamed, not duplicated
    expect(
      (await pool.query("SELECT to_regclass('public.audit_log') AS t")).rows[0].t,
    ).not.toBeNull();
    expect(ADMIN_PERMISSIONS).toContain('SAFETY_REVIEW');
  });
});
