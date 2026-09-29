import { describeTripEvent, haversineMeters, type LiveTripSnapshot } from '@yatri/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { setLocationProviderForTests } from '../modules/location/providers';
import { StaticLocationProvider } from '../modules/location/providers/static-provider';
import { api, loginTestAdmin, onboardUser } from './helpers';
import {
  THAMEL,
  acceptCurrentOffer,
  auth,
  backdate,
  currentOffer,
  forceDriverOnline,
  north,
  requestRide,
} from './rides';
import { login, startTestServer, type Client, type Msg } from './wsClient';
import { pool } from '../config/database';

let port = 0;
let stop: () => Promise<void>;
beforeAll(async () => {
  setLocationProviderForTests(new StaticLocationProvider());
  const s = await startTestServer();
  port = s.port;
  stop = s.close;
});
afterAll(async () => {
  await stop();
});

/** Waits for a message anywhere in what the client has received (arrival order across kinds is not guaranteed). */
async function seen(c: Client, pred: (m: Msg) => boolean, timeoutMs = 4000): Promise<Msg> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = c.msgs.find(pred);
    if (m) return m;
    if (Date.now() > deadline) throw new Error('timeout; got ' + JSON.stringify(c.msgs.slice(-5)));
    await new Promise((r) => setTimeout(r, 25));
  }
}
const snap = (m: Msg) => m.snapshot as LiveTripSnapshot;
const event = (type: string) => (m: Msg) => m.type === 'trip_event' && m.event.type === type;

let clock = Date.now();
let last = north(THAMEL, 1500);
const fix = (p: { latitude: number; longitude: number }) => {
  clock += Math.max(2_000, Math.ceil((haversineMeters(last, p) / 40) * 1000));
  last = p;
  return { type: 'location', ...p, accuracyMeters: 8, deviceTimeMs: clock };
};

describe('the whole ride, from passenger, driver and admin', () => {
  it('request → match → live location → chat → call → arrive → wait → start → complete → pay → rate → history → admin', async () => {
    // ---- people
    const passenger = await onboardUser('PASSENGER');
    const driver = await onboardUser('DRIVER');
    const driverId = driver.user.id as string;
    await forceDriverOnline(driverId);

    const pc = await login(port, passenger.accessToken);
    const dc = await login(port, driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');

    // ---- request and match (server picks the driver, driver accepts before the offer expires)
    const requested = await requestRide(passenger.accessToken);
    expect(requested.status).toBe(201);
    const tripId = requested.body.data.id as string;
    expect(requested.body.data.status).toBe('SEARCHING');
    pc.send({ type: 'subscribe', tripId });
    expect(requested.body.data.fare.estimateNpr).toBeGreaterThan(0);

    const offer = (await currentOffer(driver.accessToken)).body.data;
    expect(offer).toMatchObject({ tripId });
    expect(offer.fareEstimateNpr).toBe(requested.body.data.fare.estimateNpr);
    expect((await acceptCurrentOffer(driver.accessToken)).status).toBe(200);
    const assigned = await seen(pc, event('DRIVER_ASSIGNED'));
    expect(describeTripEvent(assigned.event, 'PASSENGER')).toBe('Driver has accepted your ride.');

    // ---- live location: driver approaches, passenger's snapshot carries distance + ETA
    dc.send(fix(north(THAMEL, 900)));
    const far = snap(
      await seen(
        pc,
        (m) => m.type === 'snapshot' && m.snapshot.driverArrival?.distanceMeters < 1000,
      ),
    );
    expect(far.status).toBe('DRIVER_EN_ROUTE');
    expect(far.driverArrival!.etaSeconds).toBeGreaterThan(0);
    expect(far.waiting?.passenger).not.toBeNull(); // the passenger is the one waiting
    dc.send(fix(north(THAMEL, 300)));
    const near = snap(
      await seen(
        pc,
        (m) => m.type === 'snapshot' && m.snapshot.driverArrival?.distanceMeters < 400,
      ),
    );
    expect(near.driverArrival!.distanceMeters).toBeLessThan(far.driverArrival!.distanceMeters);

    // ---- chat, both directions, with receipts
    pc.send({
      type: 'chat_send',
      tripId,
      clientMessageId: `j-${Date.now()}-1`,
      body: 'I am at the blue gate',
    });
    const got = await dc.waitFor((m) => m.type === 'chat_message');
    expect(got.message.body).toBe('I am at the blue gate');
    dc.send({ type: 'chat_read', tripId, upToSeq: got.message.seq });
    await pc.waitFor((m) => m.type === 'chat_receipt' && m.kind === 'read');
    dc.send({
      type: 'chat_send',
      tripId,
      clientMessageId: `j-${Date.now()}-2`,
      body: '2 minutes away',
    });
    await pc.waitFor((m) => m.type === 'chat_message' && m.message.senderRole === 'DRIVER');

    // ---- call: rings, answers, connects, ends — addressed by role, no phone numbers
    pc.send({ type: 'call_start', tripId, kind: 'AUDIO' });
    const ringing = await dc.waitFor((m) => m.type === 'call_state' && m.call.state === 'RINGING');
    expect(JSON.stringify(ringing)).not.toContain(passenger.phoneNumber);
    dc.send({ type: 'call_answer', callId: ringing.call.id });
    await pc.waitFor((m) => m.type === 'call_state' && m.call.state === 'CONNECTING');
    pc.send({ type: 'call_connected', callId: ringing.call.id });
    await dc.waitFor((m) => m.type === 'call_state' && m.call.state === 'CONNECTED');
    dc.send({ type: 'call_end', callId: ringing.call.id });
    await pc.waitFor((m) => m.type === 'call_state' && m.call.state === 'ENDED');

    // ---- arrival needs to be seen near the pickup; then the driver waits and the passenger is told
    dc.send(fix(north(THAMEL, 20)));
    await seen(pc, (m) => m.type === 'snapshot' && m.snapshot.driverArrival?.distanceMeters < 40);
    const arrived = await api.post(`/api/v1/trips/${tripId}/arrived`).set(auth(driver.accessToken));
    expect(arrived.status).toBe(200);
    const told = await seen(pc, event('DRIVER_ARRIVED'));
    expect(describeTripEvent(told.event, 'PASSENGER')).toBe('Your driver has arrived.');
    const waiting = snap(
      await seen(pc, (m) => m.type === 'snapshot' && m.snapshot.status === 'DRIVER_ARRIVED'),
    );
    expect(waiting.waiting?.driver).not.toBeNull(); // now the driver is the one waiting

    // ---- waiting time comes from the server's clock, and only beyond the free period costs money
    await backdate(tripId, 'arrived_at', 5 * 60);
    const midWait = (await api.get(`/api/v1/trips/${tripId}/live`).set(auth(passenger.accessToken)))
      .body.data;
    expect(midWait.waiting.driver.seconds).toBeGreaterThanOrEqual(300);
    expect(midWait.waiting.chargeNpr).toBeGreaterThan(0);
    expect(midWait.waiting.affectsFare).toBe(true);

    // ---- start, ride, complete
    expect(
      (await api.post(`/api/v1/trips/${tripId}/start`).set(auth(driver.accessToken))).status,
    ).toBe(200);
    const started = await seen(pc, event('TRIP_STARTED'));
    expect(describeTripEvent(started.event, 'PASSENGER')).toBe('Your ride has started.');
    dc.send(fix(north(THAMEL, 800)));
    const inRide = snap(
      await seen(
        pc,
        (m) => m.type === 'snapshot' && m.snapshot.status === 'IN_PROGRESS' && !!m.snapshot.trip,
      ),
    );
    expect(inRide.trip!.distanceRemainingMeters).toBeGreaterThan(0);
    expect(inRide.driverArrival).toBeNull(); // arrival and trip figures are never mixed
    const done = await api.post(`/api/v1/trips/${tripId}/complete`).set(auth(driver.accessToken));
    expect(done.status).toBe(200);
    const fare = done.body.data.fare;
    expect(fare.finalNpr).toBe(fare.estimateNpr + fare.waitingChargeNpr);
    expect(fare.waitingChargeNpr).toBeGreaterThan(0);

    // ---- payment (cash, confirmed by the driver) then ratings
    expect(
      (
        await api
          .post(`/api/v1/trips/${tripId}/rating`)
          .set(auth(passenger.accessToken))
          .send({ stars: 5 })
      ).status,
    ).toBe(409);
    const paid = await api
      .post(`/api/v1/trips/${tripId}/payment/confirm`)
      .set(auth(driver.accessToken));
    expect(paid.body.data).toMatchObject({ status: 'PAID', amountNpr: fare.finalNpr });
    expect(
      (
        await api
          .post(`/api/v1/trips/${tripId}/rating`)
          .set(auth(passenger.accessToken))
          .send({ stars: 5, comment: 'Kind driver' })
      ).status,
    ).toBe(201);
    expect(
      (
        await api
          .post(`/api/v1/trips/${tripId}/rating`)
          .set(auth(driver.accessToken))
          .send({ stars: 4 })
      ).status,
    ).toBe(201);

    // ---- history on both sides
    for (const [who, role] of [
      [passenger, 'PASSENGER'],
      [driver, 'DRIVER'],
    ] as const) {
      const h = (await api.get('/api/v1/trips/history').set(auth(who.accessToken))).body.data;
      const item = h.items.find((i: { id: string }) => i.id === tripId);
      expect(item).toMatchObject({
        status: 'COMPLETED',
        viewerRole: role,
        paymentStatus: 'PAID',
        rated: true,
      });
      expect(item.fare.finalNpr).toBe(fare.finalNpr);
    }

    // ---- the same records, seen by an admin
    const email = `journey-admin-${Date.now()}@example.com`;
    const adminToken = await loginTestAdmin(email, 'a-strong-test-password-1');
    await pool.query(
      "UPDATE users SET admin_permissions = ARRAY['TRIP_CHAT_VIEW'] WHERE email = $1",
      [email],
    );
    const d = (await api.get(`/api/v1/admin/trips/${tripId}`).set(auth(adminToken))).body.data;
    expect(d).toMatchObject({ status: 'COMPLETED' });
    expect(d.payment).toMatchObject({ status: 'PAID' });
    expect(d.ratings).toHaveLength(2);
    expect(d.offers[0].status).toBe('ACCEPTED');
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]).toMatchObject({ state: 'ENDED', endReason: 'COMPLETED' });
    expect(d.chat.messageCount).toBe(2);
    expect(d.waiting).toBeNull(); // nobody is waiting any more
    const types = d.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'TRIP_REQUESTED',
        'DRIVER_ASSIGNED',
        'DRIVER_ARRIVED',
        'TRIP_STARTED',
        'TRIP_COMPLETED',
      ]),
    );
    // the event log is gap-free and ordered, which is what lets clients detect a missed one
    const seqs = d.events.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual(seqs.map((_: number, i: number) => i + 1));
    const chat = (await api.get(`/api/v1/admin/trips/${tripId}/chat`).set(auth(adminToken))).body
      .data;
    expect(chat.items.filter((i: { kind: string }) => i.kind === 'message')).toHaveLength(2);
  });
});
