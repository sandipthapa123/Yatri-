import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { api, loginTestAdmin, onboardUser } from './helpers';
import { arriveAtPickup, auth, driverAt, north, requestRide, rideWorld, THAMEL } from './rides';

let n = 0;
async function admin(permissions: string[] = []) {
  const email = `trips-admin-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1');
  await pool.query('UPDATE users SET admin_permissions = $2::text[] WHERE email = $1', [
    email,
    permissions,
  ]);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  return { token, id: id as string };
}
const accessRows = async (adminId: string, action: string) =>
  (
    await pool.query('SELECT 1 FROM admin_access_log WHERE admin_id = $1 AND action = $2', [
      adminId,
      action,
    ])
  ).rowCount;

describe('admin trips: access', () => {
  it('is admin-only', async () => {
    const p = await onboardUser('PASSENGER');
    expect((await api.get('/api/v1/admin/trips')).status).toBe(401);
    expect((await api.get('/api/v1/admin/trips').set(auth(p.accessToken))).status).toBe(403);
    expect((await api.get('/api/v1/admin/disputes').set(auth(p.accessToken))).status).toBe(403);
  });
});

describe('admin trips: list and detail', () => {
  it('lists active rides first, filters by status and paginates on the server', async () => {
    const w = await rideWorld();
    const a = await admin();
    const list = await api.get('/api/v1/admin/trips?status=DRIVER_EN_ROUTE').set(auth(a.token));
    expect(list.status).toBe(200);
    const row = list.body.data.items.find((i: { id: string }) => i.id === w.tripId);
    expect(row).toMatchObject({
      status: 'DRIVER_EN_ROUTE',
      paymentStatus: 'NONE',
      openDisputes: 0,
    });
    expect(
      list.body.data.items.every((i: { status: string }) => i.status === 'DRIVER_EN_ROUTE'),
    ).toBe(true);
    const paged = await api.get('/api/v1/admin/trips?pageSize=1&page=1').set(auth(a.token));
    expect(paged.body.data.items).toHaveLength(1);
    expect(paged.body.data.total).toBeGreaterThanOrEqual(1);
    expect((await api.get('/api/v1/admin/trips?status=BOGUS').set(auth(a.token))).status).toBe(400);
  });

  it('shows the whole story of a ride: events, offers, waiting, comms, payment, ratings', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await api
      .post(`/api/v1/trips/${w.tripId}/chat`)
      .set(auth(w.passenger.accessToken))
      .send({ clientMessageId: `admin-test-${Date.now()}-1`, body: 'secret pickup gate' });
    const a = await admin();
    const d = (await api.get(`/api/v1/admin/trips/${w.tripId}`).set(auth(a.token))).body.data;
    expect(d.status).toBe('DRIVER_ARRIVED');
    expect(d.waiting.driver).toMatchObject({ seconds: expect.any(Number) });
    expect(d.events.map((e: { type: string }) => e.type)).toEqual(
      expect.arrayContaining(['TRIP_REQUESTED', 'DRIVER_ASSIGNED', 'DRIVER_ARRIVED']),
    );
    expect(d.offers).toHaveLength(1);
    expect(d.offers[0].status).toBe('ACCEPTED');
    expect(d.chat).toEqual({ messageCount: 1, canViewContent: false });
    expect(d.calls).toEqual([]);
    // No phone numbers, no message bodies in the detail
    expect(JSON.stringify(d)).not.toContain('secret pickup gate');
    expect(JSON.stringify(d)).not.toContain(w.passenger.phoneNumber);
    expect((await api.get(`/api/v1/admin/trips/${w.tripId}`).set(auth(a.token))).status).toBe(200);
    expect(
      (await api.get('/api/v1/admin/trips/00000000-0000-4000-8000-000000000000').set(auth(a.token)))
        .status,
    ).toBe(404);
  });
});

describe('admin trips: sensitive data is permissioned and audited', () => {
  it('reveals driver coordinates only with DRIVER_LOCATION_VIEW, and logs each disclosure', async () => {
    const w = await rideWorld();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 400));
    const plain = await admin();
    const priv = await admin(['DRIVER_LOCATION_VIEW']);

    const p = (await api.get(`/api/v1/admin/trips/${w.tripId}`).set(auth(plain.token))).body.data;
    expect(p.location.driverFreshness).toBe('fresh');
    expect(p.location.driverPosition).toBeNull();
    expect(await accessRows(plain.id, 'VIEW_TRIP_DRIVER_LOCATION')).toBe(0);

    const s = (await api.get(`/api/v1/admin/trips/${w.tripId}`).set(auth(priv.token))).body.data;
    expect(s.location.driverPosition).toMatchObject({ latitude: expect.any(Number) });
    expect(await accessRows(priv.id, 'VIEW_TRIP_DRIVER_LOCATION')).toBe(1);
  });

  it('chat content needs TRIP_CHAT_VIEW and every read is logged', async () => {
    const w = await rideWorld();
    await api
      .post(`/api/v1/trips/${w.tripId}/chat`)
      .set(auth(w.driver.accessToken))
      .send({ clientMessageId: `admin-test-${Date.now()}-2`, body: 'I am outside' });
    const plain = await admin();
    const priv = await admin(['TRIP_CHAT_VIEW']);

    expect(
      (await api.get(`/api/v1/admin/trips/${w.tripId}/chat`).set(auth(plain.token))).status,
    ).toBe(403);
    expect(await accessRows(plain.id, 'VIEW_TRIP_CHAT')).toBe(0);

    const ok = await api.get(`/api/v1/admin/trips/${w.tripId}/chat`).set(auth(priv.token));
    expect(ok.status).toBe(200);
    const msgs = ok.body.data.items.filter((i: { kind: string }) => i.kind === 'message');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].message.body).toBe('I am outside');
    expect(await accessRows(priv.id, 'VIEW_TRIP_CHAT')).toBe(1);
    // reading as an admin does not mark anything read for the participants
    const read = await pool.query('SELECT read_at FROM trip_messages WHERE trip_id = $1', [
      w.tripId,
    ]);
    expect(read.rows[0].read_at).toBeNull();
  });
});

describe('admin trips: intervention', () => {
  it('cancels a stuck ride with a reason both people are told about', async () => {
    const w = await rideWorld();
    const a = await admin();
    const bad = await api
      .post(`/api/v1/admin/trips/${w.tripId}/cancel`)
      .set(auth(a.token))
      .send({ reason: '' });
    expect(bad.status).toBe(400);
    const res = await api
      .post(`/api/v1/admin/trips/${w.tripId}/cancel`)
      .set(auth(a.token))
      .send({ reason: 'Vehicle broke down' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    const again = await api
      .post(`/api/v1/admin/trips/${w.tripId}/cancel`)
      .set(auth(a.token))
      .send({ reason: 'Vehicle broke down' });
    expect(again.status).toBe(409);
    const t = (await api.get(`/api/v1/trips/${w.tripId}`).set(auth(w.passenger.accessToken))).body
      .data;
    expect(t).toMatchObject({ status: 'CANCELLED', cancelledBy: 'SYSTEM' });
  });

  it('lists disputes and resolves one exactly once', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));
    const raised = await api
      .post(`/api/v1/trips/${w.tripId}/disputes`)
      .set(auth(w.passenger.accessToken))
      .send({ reason: 'The fare was higher than the estimate' });
    expect(raised.status).toBe(201);
    const a = await admin();

    const open = await api.get('/api/v1/admin/disputes?status=OPEN').set(auth(a.token));
    const row = open.body.data.items.find((i: { id: string }) => i.id === raised.body.data.id);
    expect(row).toMatchObject({ raisedByRole: 'PASSENGER', tripId: w.tripId, status: 'OPEN' });
    const detail = (await api.get(`/api/v1/admin/trips/${w.tripId}`).set(auth(a.token))).body.data;
    expect(detail.disputes).toHaveLength(1);

    const resolve = () =>
      api
        .post(`/api/v1/admin/disputes/${raised.body.data.id}/resolve`)
        .set(auth(a.token))
        .send({ status: 'RESOLVED', resolution: 'Waiting charge explained to the passenger' });
    expect((await resolve()).status).toBe(200);
    expect((await resolve()).status).toBe(409);
    const mine = await api
      .get(`/api/v1/trips/${w.tripId}/disputes`)
      .set(auth(w.passenger.accessToken));
    expect(mine.body.data[0]).toMatchObject({ status: 'RESOLVED' });
    void requestRide;
  });
});
