import { haversineMeters, type LiveTripSnapshot } from '@yatri/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { getRedisClient } from '../config/redis';
import { setLocationProviderForTests } from '../modules/location/providers';
import { StaticLocationProvider } from '../modules/location/providers/static-provider';
import { sweepDispatch } from '../modules/dispatch/dispatch.service';
import { buildSnapshot, loadMeta } from '../modules/tracking/tracking.service';
import { api, onboardUser } from './helpers';
import {
  THAMEL,
  arriveAtPickup,
  auth,
  forceDriverOnline,
  north,
  requestRide,
  rideWorld,
  type RideWorld,
} from './rides';
import { Client, login, startTestServer, type Msg } from './wsClient';

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
beforeEach(() => setLocationProviderForTests(new StaticLocationProvider()));

const NEW_ROAD = { latitude: 27.7043, longitude: 85.3132 };
const snap = (m: Msg) => m.snapshot as LiveTripSnapshot;
let deviceClock = Date.now();
let lastPos: { latitude: number; longitude: number } = north(THAMEL, 300);
/**
 * A presence location message. Device time advances by however long the move would really take
 * (at ~40 m/s), so realistic movement passes the server's plausibility rules.
 */
const fix = (p: { latitude: number; longitude: number }, extra: Record<string, unknown> = {}) => {
  const meters = haversineMeters(lastPos, p);
  deviceClock += Math.max(2_000, Math.ceil((meters / 40) * 1000));
  lastPos = p;
  return { type: 'location', ...p, accuracyMeters: 8, deviceTimeMs: deviceClock, ...extra };
};

async function joined(token: string, tripId: string): Promise<Client> {
  const c = await login(port, token);
  c.send({ type: 'subscribe', tripId });
  await c.waitFor((m) => m.type === 'snapshot');
  return c;
}
async function world(): Promise<RideWorld> {
  deviceClock = Date.now();
  lastPos = north(THAMEL, 300);
  return rideWorld();
}

describe('driver offers over the socket', () => {
  it('pushes an offer to the nearest online driver and re-shows it after a reconnect', async () => {
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    let dc = await login(port, d.accessToken);
    const p = await onboardUser('PASSENGER');
    await requestRide(p.accessToken);
    const pushed = await dc.waitFor((m) => m.type === 'trip_offer');
    expect(pushed.offer).toMatchObject({
      pickup: { name: 'Thamel' },
      destination: { name: 'Patan Durbar Square' },
    });
    expect(new Date(pushed.offer.expiresAt).getTime()).toBeGreaterThan(Date.now());

    await dc.close(); // network blip mid-offer
    dc = await login(port, d.accessToken);
    const again = await dc.waitFor((m) => m.type === 'trip_offer');
    expect(again.offer.offerId).toBe(pushed.offer.offerId);
  });

  it('tells the driver when an offer expires', async () => {
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    const dc = await login(port, d.accessToken);
    const p = await onboardUser('PASSENGER');
    await requestRide(p.accessToken);
    const offer = (await dc.waitFor((m) => m.type === 'trip_offer')).offer;
    await pool.query(
      "UPDATE trip_offers SET expires_at = now() - interval '1 second' WHERE id = $1",
      [offer.offerId],
    );
    await sweepDispatch();
    const closed = await dc.waitFor((m) => m.type === 'trip_offer_closed');
    expect(closed).toMatchObject({ offerId: offer.offerId, reason: 'EXPIRED' });
  });
});

describe('trip subscription & authorization', () => {
  it('lets the passenger watch the search, and gives strangers the same answer as "missing"', async () => {
    const p = await onboardUser('PASSENGER');
    const trip = (await requestRide(p.accessToken)).body.data;
    const pc = await joined(p.accessToken, trip.id);
    expect(pc.msgs.find((m) => m.type === 'snapshot')!.snapshot).toMatchObject({
      status: 'SEARCHING',
      driver: null,
    });

    const stranger = await onboardUser('PASSENGER');
    const s = await login(port, stranger.accessToken);
    s.send({ type: 'subscribe', tripId: trip.id });
    const denied = await s.waitFor((m) => m.type === 'error');
    s.send({ type: 'subscribe', tripId: '11111111-1111-4111-8111-111111111111' });
    const missing = await s.waitFor((m) => m.type === 'error');
    expect(denied).toEqual(missing);
  });

  it('accepts a driver position ONLY through presence — the old trip-scoped path is gone', async () => {
    const w = await world();
    const dc = await joined(w.driver.accessToken, w.tripId);
    dc.send({
      type: 'driver_location',
      tripId: w.tripId,
      ...north(THAMEL, 200),
      deviceTimeMs: Date.now(),
    });
    await dc.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE');
    // a passenger cannot report a driver position either
    const pc = await joined(w.passenger.accessToken, w.tripId);
    pc.send(fix(north(THAMEL, 200)));
    expect((await pc.waitFor((m) => m.type === 'availability_error')).code).toBe('FORBIDDEN');
  });
});

describe('live location, distance, ETA, place name and direction', () => {
  it('pushes the driver’s presence fixes into the trip: distance, ETA, place, heading — no refresh', async () => {
    const w = await world();
    const pc = await joined(w.passenger.accessToken, w.tripId);
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');

    dc.send(fix(NEW_ROAD, { headingDegrees: 45, speedMps: 6 }));
    const live = snap(
      await pc.waitFor((m) => m.type === 'snapshot' && m.snapshot.driver?.placeName === 'New Road'),
    );
    expect(live.status).toBe('DRIVER_EN_ROUTE');
    expect(live.driver).toMatchObject({ freshness: 'live', placeKind: 'road', headingDegrees: 45 });
    expect(live.driverArrival!.distanceMeters).toBeGreaterThan(1100);
    expect(live.driverArrival!.distanceMeters).toBeLessThan(1400);
    expect(live.driverArrival!.etaSeconds).toBeGreaterThan(0);
    expect(live.trip).toBeNull(); // arrival ETA and trip ETA are never mixed
    expect(live.waiting?.passenger).not.toBeNull();

    dc.send(fix(north(THAMEL, -400)));
    const closer = snap(
      await pc.waitFor(
        (m) => m.type === 'snapshot' && m.snapshot.driverArrival?.distanceMeters < 500,
      ),
    );
    expect(closer.driverArrival!.etaSeconds!).toBeLessThan(live.driverArrival!.etaSeconds!);
    expect(closer.version).toBeGreaterThan(live.version);
  });

  it('announces "driver is N away" once per threshold, as a persisted, numbered event', async () => {
    const w = await world();
    const pc = await joined(w.passenger.accessToken, w.tripId);
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');

    dc.send(fix(north(THAMEL, 900)));
    const first = await pc.waitFor(
      (m) => m.type === 'trip_event' && m.event.type === 'DRIVER_NEARBY',
    );
    expect(first.event.payload).toMatchObject({ thresholdMeters: 1000 });
    expect(first.important).toBe(false);
    dc.send(fix(north(THAMEL, 880))); // same band: nothing new
    dc.send(fix(north(THAMEL, 450)));
    const second = await pc.waitFor(
      (m) => m.type === 'trip_event' && m.event.type === 'DRIVER_NEARBY',
    );
    expect(second.event.payload.thresholdMeters).toBe(500);
    expect(second.event.seq).toBeGreaterThan(first.event.seq);
    const nearby = (
      await pool.query(
        "SELECT count(*)::int AS n FROM trip_events WHERE trip_id = $1 AND type = 'DRIVER_NEARBY'",
        [w.tripId],
      )
    ).rows[0].n;
    expect(nearby).toBe(2);
  });

  it('lets the passenger opt in to sharing their location — only until the driver arrives', async () => {
    const w = await world();
    const pc = await joined(w.passenger.accessToken, w.tripId);
    const dc = await joined(w.driver.accessToken, w.tripId);
    pc.send({
      type: 'passenger_location',
      tripId: w.tripId,
      ...THAMEL,
      accuracyMeters: 10,
      deviceTimeMs: Date.now(),
    });
    const shared = snap(await dc.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.passenger));
    expect(shared.passenger?.accuracyMeters).toBe(10);
    pc.send({ type: 'stop_sharing', tripId: w.tripId });
    await dc.waitFor((m) => m.type === 'snapshot' && m.snapshot.passenger === null);

    await arriveAtPickup(w);
    pc.send({
      type: 'passenger_location',
      tripId: w.tripId,
      ...THAMEL,
      deviceTimeMs: Date.now() + 1000,
    });
    expect((await pc.waitFor((m) => m.type === 'rejected')).reason).toBe('not_shared_now');
  });

  it('marks the driver feed stale, then lost, from the server clock', async () => {
    const w = await world();
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');
    dc.send(fix(north(THAMEL, 400)));
    const pc = await joined(w.passenger.accessToken, w.tripId);
    const meta = (await loadMeta(w.tripId))!;
    const t0 = Date.now();
    expect((await buildSnapshot(meta, 'PASSENGER', t0 + 5_000)).driver?.freshness).toBe('live');
    const stale = await buildSnapshot(meta, 'PASSENGER', t0 + 45_000);
    expect(stale.driver?.freshness).toBe('stale');
    expect(stale.driver?.ageSeconds).toBeGreaterThanOrEqual(44);
    expect((await buildSnapshot(meta, 'PASSENGER', t0 + 90_000)).driver?.freshness).toBe('lost');
    void pc;
  });
});

describe('ride events reach both people, once, in order', () => {
  it('delivers each lifecycle step as one numbered event, with "important" only where it matters', async () => {
    const w = await world();
    const pc = await login(port, w.passenger.accessToken);
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');
    dc.send(fix(north(THAMEL, 20)));
    await dc.waitFor((m) => m.type === 'location_ack');

    await api.post(`/api/v1/trips/${w.tripId}/arrived`).set(auth(w.driver.accessToken));
    const arrived = await pc.waitFor(
      (m) => m.type === 'trip_event' && m.event.type === 'DRIVER_ARRIVED',
    );
    expect(arrived.important).toBe(true);
    await dc.waitFor((m) => m.type === 'trip_event' && m.event.type === 'DRIVER_ARRIVED'); // the driver's own devices too

    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));
    const done = await pc.waitFor(
      (m) => m.type === 'trip_event' && m.event.type === 'TRIP_COMPLETED',
    );
    expect(done.important).toBe(true);
    const seqs = pc.msgs.filter((m) => m.type === 'trip_event').map((m) => m.event.seq as number);
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs); // in order
  });

  it('a reconnecting client catches up from the last event it saw', async () => {
    const w = await world();
    const pc1 = await login(port, w.passenger.accessToken);
    await pc1.close(); // passenger is offline while the driver arrives and starts
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));

    const pc2 = await joined(w.passenger.accessToken, w.tripId);
    expect(snap(pc2.msgs.find((m) => m.type === 'snapshot')!).status).toBe('IN_PROGRESS');
    const missed = (
      await api.get(`/api/v1/trips/${w.tripId}/events?after=3`).set(auth(w.passenger.accessToken))
    ).body.data;
    expect(missed.map((e: { type: string }) => e.type)).toEqual([
      'DRIVER_NEARBY',
      'DRIVER_ARRIVED',
      'TRIP_STARTED',
    ]);
  });

  it('deletes live positions when the ride ends and reveals nothing afterwards', async () => {
    const w = await world();
    const dc = await login(port, w.driver.accessToken);
    await dc.waitFor((m) => m.type === 'availability');
    dc.send(fix(north(THAMEL, 20)));
    await dc.waitFor((m) => m.type === 'location_ack');
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    const pc = await joined(w.passenger.accessToken, w.tripId);
    await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));
    const final = snap(
      await pc.waitFor((m) => m.type === 'snapshot' && m.snapshot.status === 'COMPLETED'),
    );
    expect(final.driver).toBeNull();
    expect(final.passenger).toBeNull();
    expect(final.waiting).toBeNull();

    const keys = await getRedisClient().keys(`trk:${w.tripId}:*`);
    expect(keys.filter((k) => /:(driver|passenger|eta)/.test(k))).toEqual([]);
    expect(
      (await api.get(`/api/v1/trips/${w.tripId}/live`).set(auth(w.passenger.accessToken))).status,
    ).toBe(409);
    const late = await login(port, w.passenger.accessToken);
    late.send({ type: 'subscribe', tripId: w.tripId });
    expect((await late.waitFor((m) => m.type === 'error')).code).toBe('NOT_FOUND');
  });
});

describe('the passenger’s waiting is authoritative and identical on both sides', () => {
  it('pushes the same waiting state to passenger and driver after arrival', async () => {
    const w = await world();
    const pc = await joined(w.passenger.accessToken, w.tripId);
    const dc = await joined(w.driver.accessToken, w.tripId);
    await arriveAtPickup(w);
    const p = snap(
      await pc.waitFor((m) => m.type === 'snapshot' && m.snapshot.status === 'DRIVER_ARRIVED'),
    );
    const d = snap(
      await dc.waitFor((m) => m.type === 'snapshot' && m.snapshot.status === 'DRIVER_ARRIVED'),
    );
    expect(p.waiting!.driver!.startedAt).toBe(d.waiting!.driver!.startedAt);
    expect(p.waiting!.driver!.notifiedAt).toEqual(expect.any(String));
    expect(p.waiting!.rule).toEqual(d.waiting!.rule);
  });
});

void Client;
