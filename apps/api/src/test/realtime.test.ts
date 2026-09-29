import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { LiveTripSnapshot } from '@yatri/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { getRedisClient } from '../config/redis';
import { setLocationProviderForTests } from '../modules/location/providers';
import { StaticLocationProvider } from '../modules/location/providers/static-provider';
import {
  attachRealtimeGateway,
  REALTIME_PATH,
  type RealtimeGateway,
} from '../modules/realtime/gateway';
import { buildSnapshot, loadMeta } from '../modules/tracking/tracking.service';
import { api, app, loginTestAdmin, onboardUser, type OnboardedUser } from './helpers';

let server: Server;
let gateway: RealtimeGateway;
let port = 0;

beforeAll(async () => {
  server = createServer(app);
  gateway = await attachRealtimeGateway(server);
  await new Promise<void>((r) => server.listen(0, r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await gateway.close();
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => setLocationProviderForTests(new StaticLocationProvider()));

// ---------- helpers ----------
type Msg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

class Client {
  msgs: Msg[] = [];
  closed: { code: number } | null = null;
  private cursor = 0;
  private waiters: Array<() => void> = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.msgs.push(JSON.parse(d.toString()));
      this.waiters.forEach((w) => w());
    });
    ws.on('close', (code) => {
      this.closed = { code };
      this.waiters.forEach((w) => w());
    });
  }
  static async connect(): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_PATH}`);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    return new Client(ws);
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor(pred: (m: Msg) => boolean, timeoutMs = 4000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.msgs.length) {
        const m = this.msgs[this.cursor++] as Msg;
        if (pred(m)) return m;
      }
      if (this.closed) throw new Error(`socket closed (${this.closed.code}) while waiting`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout; got ${JSON.stringify(this.msgs.slice(-4))}`);
      await new Promise<void>((res) => {
        const t = setTimeout(res, left);
        this.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }
  async expectNothing(pred: (m: Msg) => boolean, ms = 400) {
    const from = this.msgs.length;
    await new Promise((r) => setTimeout(r, ms));
    expect(this.msgs.slice(from).filter(pred)).toEqual([]);
  }
  async close() {
    if (this.closed) return;
    this.ws.close();
    await new Promise((r) => setTimeout(r, 50));
  }
}

const PICKUP = {
  latitude: 27.7154,
  longitude: 85.3123,
  address: 'Thamel, Kathmandu',
  name: 'Thamel',
};
const DEST = {
  latitude: 27.6727,
  longitude: 85.325,
  address: 'Patan Durbar Square, Lalitpur',
  name: 'Patan Durbar Square',
};
const NEW_ROAD = { latitude: 27.7043, longitude: 85.3132 }; // ~1.2 km from pickup, inside the "New Road" gazetteer cell
const north = (p: { latitude: number; longitude: number }, m: number) => ({
  latitude: p.latitude + m / 111_195,
  longitude: p.longitude,
});

interface World {
  passenger: OnboardedUser;
  driver: OnboardedUser;
  stranger: OnboardedUser;
  tripId: string;
  admin: string;
}
async function world(): Promise<World> {
  clock = Date.now(); // fresh device clock per scenario
  const passenger = await onboardUser('PASSENGER');
  const driver = await onboardUser('DRIVER');
  const stranger = await onboardUser('PASSENGER');
  const admin = await loginTestAdmin(`admin-${Date.now()}@yatri.test`, 'a-long-test-password-1');
  const res = await api.post('/api/v1/admin/trips').set('Authorization', `Bearer ${admin}`).send({
    passengerId: passenger.user.id,
    driverId: driver.user.id,
    pickup: PICKUP,
    destination: DEST,
  });
  if (res.status !== 201) throw new Error(`create trip failed ${JSON.stringify(res.body)}`);
  return { passenger, driver, stranger, tripId: res.body.data.id, admin };
}

async function login(token: string): Promise<Client> {
  const c = await Client.connect();
  c.send({ type: 'auth', token });
  await c.waitFor((m) => m.type === 'authed');
  return c;
}
async function joined(token: string, tripId: string): Promise<Client> {
  const c = await login(token);
  c.send({ type: 'subscribe', tripId });
  await c.waitFor((m) => m.type === 'snapshot');
  return c;
}
let clock = Date.now();
const driverFix = (tripId: string, p: { latitude: number; longitude: number }, extra = {}) => ({
  type: 'driver_location',
  tripId,
  ...p,
  accuracyMeters: 8,
  deviceTimeMs: (clock += 1500),
  ...extra,
});
const snap = (m: Msg) => m.snapshot as LiveTripSnapshot;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

// ---------- tests ----------
describe('realtime: connection & authorization', () => {
  it('closes unauthenticated sockets and rejects anything before auth', async () => {
    const c = await Client.connect();
    c.send({ type: 'subscribe', tripId: '00000000-0000-4000-8000-000000000000' });
    await c.waitFor((m) => m.type === 'error' && m.code === 'UNAUTHENTICATED');
    await c.waitFor(() => false).catch(() => undefined);
    expect(c.closed?.code).toBe(4401);
  });

  it('rejects a bad token', async () => {
    const c = await Client.connect();
    c.send({ type: 'auth', token: 'not-a-real-token-at-all' });
    await c.waitFor((m) => m.type === 'error').catch(() => undefined);
    await c.waitFor(() => false).catch(() => undefined);
    expect(c.closed?.code).toBe(4401);
  });

  it('rejects malformed and oversized messages without crashing', async () => {
    const w = await world();
    const c = await login(w.passenger.accessToken);
    c.ws.send('not json');
    await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE');
    c.send({ type: 'subscribe', tripId: 'nope' });
    await c.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE');
    c.send({ type: 'ping' });
    await c.waitFor((m) => m.type === 'pong');
  });

  it('lets a trip’s passenger and driver subscribe, but nobody else — with an identical answer to "missing"', async () => {
    const w = await world();
    for (const t of [w.passenger.accessToken, w.driver.accessToken]) {
      const c = await joined(t, w.tripId);
      await c.close();
    }
    const s = await login(w.stranger.accessToken);
    s.send({ type: 'subscribe', tripId: w.tripId });
    const denied = await s.waitFor((m) => m.type === 'error');
    s.send({ type: 'subscribe', tripId: '11111111-1111-4111-8111-111111111111' });
    const missing = await s.waitFor((m) => m.type === 'error');
    expect(denied).toEqual(missing);
    expect(denied.code).toBe('NOT_FOUND');
  });
});

describe('realtime: driver -> passenger live updates', () => {
  it('pushes the driver position, distance, ETA and place name to the passenger without any refresh', async () => {
    const w = await world();
    const passenger = await joined(w.passenger.accessToken, w.tripId);
    const driver = await joined(w.driver.accessToken, w.tripId);

    driver.send(driverFix(w.tripId, north(PICKUP, 500)));
    const live = snap(await passenger.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.driver));

    expect(live.status).toBe('DRIVER_EN_ROUTE');
    expect(live.driver?.freshness).toBe('live');
    expect(live.driver?.accuracyMeters).toBe(8);
    expect(live.driverArrival?.distanceMeters).toBeGreaterThan(480);
    expect(live.driverArrival?.distanceMeters).toBeLessThan(520);
    expect(live.driverArrival?.etaSeconds).toBeGreaterThan(0);
    expect(live.driverArrival?.basis).toBe('estimate');
    // Distinct concepts are never mixed up:
    expect(live.trip).toBeNull();
    expect(live.waitingSeconds).toBeNull();

    // Closer -> distance and ETA shrink, again with no request from the passenger.
    driver.send(driverFix(w.tripId, north(PICKUP, 85), { deviceTimeMs: (clock += 12_000) }));
    const closer = snap(
      await passenger.waitFor(
        (m) =>
          m.type === 'snapshot' &&
          (m.snapshot as LiveTripSnapshot).driverArrival!.distanceMeters < 100,
      ),
    );
    expect(closer.driverArrival!.distanceMeters).toBeGreaterThan(70);
    expect(closer.driverArrival!.etaSeconds!).toBeLessThan(live.driverArrival!.etaSeconds!);
    expect(closer.eventId).toBeGreaterThan(live.eventId);
  });

  it('identifies the road the driver is on and updates it when it changes', async () => {
    const w = await world();
    const passenger = await joined(w.passenger.accessToken, w.tripId);
    const driver = await joined(w.driver.accessToken, w.tripId);

    driver.send(driverFix(w.tripId, NEW_ROAD));
    const onRoad = snap(
      await passenger.waitFor(
        (m) => m.type === 'snapshot' && m.snapshot.driver?.placeName === 'New Road',
      ),
    );
    expect(onRoad.driver?.placeKind).toBe('road');
    expect(onRoad.driver?.placeStale).toBe(false);

    // ~1 km away, next to Kathmandu Durbar Square.
    driver.send(
      driverFix(
        w.tripId,
        { latitude: 27.7048, longitude: 85.3076 },
        { deviceTimeMs: (clock += 15_000) },
      ),
    );
    const nowNear = snap(
      await passenger.waitFor(
        (m) => m.type === 'snapshot' && m.snapshot.driver?.placeName === 'Kathmandu Durbar Square',
        6000,
      ),
    );
    expect(nowNear.driver?.placeKind).toBe('place');
  });

  it('rejects impossible jumps, duplicates and out-of-order fixes; state is not corrupted', async () => {
    const w = await world();
    const passenger = await joined(w.passenger.accessToken, w.tripId);
    const driver = await joined(w.driver.accessToken, w.tripId);

    const good = driverFix(w.tripId, north(PICKUP, 300));
    driver.send(good);
    await passenger.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.driver);

    driver.send(driverFix(w.tripId, north(PICKUP, 30_000))); // 30 km in 1.5 s
    expect((await driver.waitFor((m) => m.type === 'rejected')).reason).toBe('impossible_jump');

    driver.send(good); // exact duplicate
    expect((await driver.waitFor((m) => m.type === 'rejected')).reason).toBe('duplicate');

    driver.send(driverFix(w.tripId, north(PICKUP, 290), { deviceTimeMs: good.deviceTimeMs - 500 }));
    expect((await driver.waitFor((m) => m.type === 'rejected')).reason).toBe('out_of_order');

    const stale = driverFix(w.tripId, north(PICKUP, 290), { deviceTimeMs: Date.now() - 120_000 });
    driver.send(stale);
    expect((await driver.waitFor((m) => m.type === 'rejected')).reason).toBe('stale');

    const res = await api.get(`/api/v1/trips/${w.tripId}/live`).set(auth(w.passenger.accessToken));
    expect(res.body.data.driverArrival.distanceMeters).toBeLessThan(320); // still the good fix
  });

  it('rejects invalid coordinates at the protocol level', async () => {
    const w = await world();
    const driver = await joined(w.driver.accessToken, w.tripId);
    for (const bad of [
      { latitude: 91 },
      { longitude: 181 },
      { latitude: 'x' },
      { latitude: null },
    ]) {
      driver.send(driverFix(w.tripId, north(PICKUP, 100), bad));
      await driver.waitFor((m) => m.type === 'error' && m.code === 'BAD_MESSAGE');
    }
  });

  it('only the trip’s driver can report the driver position, only its passenger the passenger’s', async () => {
    const w = await world();
    const passenger = await joined(w.passenger.accessToken, w.tripId);
    const driver = await joined(w.driver.accessToken, w.tripId);

    passenger.send(driverFix(w.tripId, north(PICKUP, 100)));
    expect((await passenger.waitFor((m) => m.type === 'rejected')).reason).toBe('forbidden');
    driver.send({ ...driverFix(w.tripId, north(PICKUP, 100)), type: 'passenger_location' });
    expect((await driver.waitFor((m) => m.type === 'rejected')).reason).toBe('forbidden');

    // Unsubscribed sockets cannot write either.
    const s = await login(w.stranger.accessToken);
    s.send(driverFix(w.tripId, north(PICKUP, 100)));
    expect((await s.waitFor((m) => m.type === 'rejected')).reason).toBe('not_subscribed');
  });
});

describe('realtime: reconnect, staleness and GPS loss', () => {
  it('a reconnecting client receives the full current state (no replay needed) and duplicates are harmless', async () => {
    const w = await world();
    let passenger = await joined(w.passenger.accessToken, w.tripId);
    const driver = await joined(w.driver.accessToken, w.tripId);
    driver.send(driverFix(w.tripId, north(PICKUP, 400)));
    await passenger.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.driver);

    await passenger.close(); // network drop
    driver.send(driverFix(w.tripId, north(PICKUP, 250), { deviceTimeMs: (clock += 12_000) })); // while offline

    passenger = await joined(w.passenger.accessToken, w.tripId);
    const back = snap(passenger.msgs.find((m) => m.type === 'snapshot') as Msg);
    expect(back.driver).not.toBeNull();
    expect(back.driverArrival!.distanceMeters).toBeLessThan(270); // the latest, not the one it last saw

    // Subscribing twice is idempotent: same state, not doubled fan-out.
    passenger.send({ type: 'subscribe', tripId: w.tripId });
    driver.send(driverFix(w.tripId, north(PICKUP, 200), { deviceTimeMs: (clock += 12_000) }));
    await passenger.waitFor(
      (m) => m.type === 'snapshot' && m.snapshot.driverArrival?.distanceMeters < 220,
    );
    const ids = passenger.msgs.filter((m) => m.type === 'snapshot').map((m) => m.snapshot.eventId);
    expect(new Set(ids).size).toBeGreaterThan(1);
    expect(ids.every((id: number, i: number) => i === 0 || id >= ids[i - 1])).toBe(true);
  });

  it('marks the driver feed stale, then lost, from the server clock (no fix needed to notice)', async () => {
    const w = await world();
    const driver = await joined(w.driver.accessToken, w.tripId);
    driver.send(driverFix(w.tripId, north(PICKUP, 400)));
    await driver.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.driver);

    const meta = (await loadMeta(w.tripId))!;
    const t0 = Date.now();
    expect((await buildSnapshot(meta, 'PASSENGER', t0 + 5_000)).driver?.freshness).toBe('live');
    const stale = await buildSnapshot(meta, 'PASSENGER', t0 + 30_000);
    expect(stale.driver?.freshness).toBe('stale');
    expect(stale.driver?.ageSeconds).toBeGreaterThanOrEqual(29);
    const lost = await buildSnapshot(meta, 'PASSENGER', t0 + 90_000);
    expect(lost.driver?.freshness).toBe('lost');
    expect(lost.driver?.updatedAt).toEqual(expect.any(String)); // timestamp of last update stays available
  });
});

describe('realtime: trip lifecycle, privacy and retention', () => {
  it('announces arrival as an important event and switches from arrival ETA to waiting time', async () => {
    const w = await world();
    const passenger = await joined(w.passenger.accessToken, w.tripId);
    const driver = await joined(w.driver.accessToken, w.tripId);
    driver.send(driverFix(w.tripId, north(PICKUP, 20)));
    await passenger.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.driver);

    const res = await api.post(`/api/v1/trips/${w.tripId}/arrived`).set(auth(w.driver.accessToken));
    expect(res.status).toBe(200);

    const ev = await passenger.waitFor((m) => m.type === 'event');
    expect(ev).toMatchObject({ event: 'DRIVER_ARRIVED', important: true });
    const s = snap(
      await passenger.waitFor(
        (m) => m.type === 'snapshot' && m.snapshot.status === 'DRIVER_ARRIVED',
      ),
    );
    expect(s.driverArrival).toBeNull();
    expect(s.trip).toBeNull();
    expect(s.waitingSeconds).toEqual(expect.any(Number));
  });

  it('uses trip ETA (not arrival ETA) once the ride is in progress', async () => {
    const w = await world();
    const passenger = await joined(w.passenger.accessToken, w.tripId);
    const driver = await joined(w.driver.accessToken, w.tripId);
    driver.send(driverFix(w.tripId, north(PICKUP, 10)));
    await passenger.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.driver);
    await api.post(`/api/v1/trips/${w.tripId}/arrived`).set(auth(w.driver.accessToken));
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await passenger.waitFor((m) => m.type === 'event' && m.event === 'TRIP_STARTED');

    driver.send(driverFix(w.tripId, north(PICKUP, 600), { deviceTimeMs: (clock += 15_000) }));
    const s = snap(await passenger.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.trip));
    expect(s.status).toBe('IN_PROGRESS');
    expect(s.driverArrival).toBeNull();
    expect(s.trip!.distanceRemainingMeters).toBeGreaterThan(3000);
    expect(s.waitingSeconds).toBeNull();
  });

  it('shares the passenger position with the driver only before pickup, and only if the passenger opts in', async () => {
    const w = await world();
    const passenger = await joined(w.passenger.accessToken, w.tripId);
    const driver = await joined(w.driver.accessToken, w.tripId);

    // Nothing shared by default.
    driver.send(driverFix(w.tripId, north(PICKUP, 400)));
    const before = snap(await driver.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.driver));
    expect(before.passenger).toBeNull();

    passenger.send({
      type: 'passenger_location',
      tripId: w.tripId,
      ...PICKUP,
      accuracyMeters: 12,
      deviceTimeMs: (clock += 1500),
    });
    const shared = snap(
      await driver.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.passenger),
    );
    expect(shared.passenger?.accuracyMeters).toBe(12);

    // The passenger can withdraw.
    passenger.send({ type: 'stop_sharing', tripId: w.tripId });
    await driver.waitFor((m) => m.type === 'snapshot' && m.snapshot.passenger === null);

    // After the driver arrives, passenger updates are refused and nothing is shown to the driver.
    await api.post(`/api/v1/trips/${w.tripId}/arrived`).set(auth(w.driver.accessToken));
    await passenger.waitFor((m) => m.type === 'snapshot' && m.snapshot.status === 'DRIVER_ARRIVED');
    passenger.send({
      type: 'passenger_location',
      tripId: w.tripId,
      ...PICKUP,
      deviceTimeMs: (clock += 1500),
    });
    expect((await passenger.waitFor((m) => m.type === 'rejected')).reason).toBe('not_shared_now');
  });

  it('deletes live positions when the trip ends and refuses to reveal them afterwards', async () => {
    const w = await world();
    const passenger = await joined(w.passenger.accessToken, w.tripId);
    const driver = await joined(w.driver.accessToken, w.tripId);
    driver.send(driverFix(w.tripId, north(PICKUP, 100)));
    await passenger.waitFor((m) => m.type === 'snapshot' && !!m.snapshot.driver);
    for (const step of ['arrived', 'start', 'complete']) {
      const r = await api.post(`/api/v1/trips/${w.tripId}/${step}`).set(auth(w.driver.accessToken));
      expect(r.status).toBe(200);
    }
    const done = await passenger.waitFor((m) => m.type === 'event' && m.event === 'TRIP_COMPLETED');
    expect(done.important).toBe(true);
    const final = snap(
      await passenger.waitFor((m) => m.type === 'snapshot' && m.snapshot.status === 'COMPLETED'),
    );
    expect(final.driver).toBeNull();
    expect(final.passenger).toBeNull();

    // Retention: nothing left in Redis, nothing in Postgres.
    const keys = await getRedisClient().keys(`trk:${w.tripId}:*`);
    expect(keys.filter((k) => /:(driver|passenger|eta)/.test(k))).toEqual([]);

    // No historical access for the passenger, over REST or a new socket.
    const rest = await api.get(`/api/v1/trips/${w.tripId}/live`).set(auth(w.passenger.accessToken));
    expect(rest.status).toBe(409);
    const late = await login(w.passenger.accessToken);
    late.send({ type: 'subscribe', tripId: w.tripId });
    expect((await late.waitFor((m) => m.type === 'error')).code).toBe('NOT_FOUND');
    // Updates after the end are refused.
    driver.send(driverFix(w.tripId, north(PICKUP, 100)));
    await driver.expectNothing((m) => m.type === 'snapshot' && !!m.snapshot.driver);
  });

  it('cancellation is an important event and ends live sharing', async () => {
    const w = await world();
    const passenger = await joined(w.passenger.accessToken, w.tripId);
    const r = await api.post(`/api/v1/trips/${w.tripId}/cancel`).set(auth(w.passenger.accessToken));
    expect(r.status).toBe(200);
    expect(await passenger.waitFor((m) => m.type === 'event')).toMatchObject({
      event: 'TRIP_CANCELLED',
      important: true,
    });
  });
});

describe('trip REST endpoints: authorization', () => {
  it('hides trips and live data from non-participants (404, not 403)', async () => {
    const w = await world();
    const t = w.stranger.accessToken;
    expect((await api.get(`/api/v1/trips/${w.tripId}`).set(auth(t))).status).toBe(404);
    expect((await api.get(`/api/v1/trips/${w.tripId}/live`).set(auth(t))).status).toBe(404);
    expect((await api.post(`/api/v1/trips/${w.tripId}/cancel`).set(auth(t))).status).toBe(404);
    expect((await api.get(`/api/v1/trips/${w.tripId}/live`)).status).toBe(401);
  });

  it('only the driver can move the trip forward; invalid transitions are 409', async () => {
    const w = await world();
    expect(
      (await api.post(`/api/v1/trips/${w.tripId}/arrived`).set(auth(w.passenger.accessToken)))
        .status,
    ).toBe(403);
    expect(
      (await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken))).status,
    ).toBe(409);
    expect(
      (await api.post(`/api/v1/trips/${w.tripId}/arrived`).set(auth(w.driver.accessToken))).status,
    ).toBe(200);
    expect(
      (await api.post(`/api/v1/trips/${w.tripId}/arrived`).set(auth(w.driver.accessToken))).status,
    ).toBe(409);
  });

  it('returns the active trip for each participant and null otherwise', async () => {
    const w = await world();
    const mine = await api.get('/api/v1/trips/active').set(auth(w.driver.accessToken));
    expect(mine.body.data).toMatchObject({ id: w.tripId, viewerRole: 'DRIVER' });
    const pax = await api.get('/api/v1/trips/active').set(auth(w.passenger.accessToken));
    expect(pax.body.data.viewerRole).toBe('PASSENGER');
    const none = await api.get('/api/v1/trips/active').set(auth(w.stranger.accessToken));
    expect(none.body.data).toBeNull();
  });

  it('creating trips is admin-only and refuses double-booking', async () => {
    const w = await world();
    const body = {
      passengerId: w.passenger.user.id,
      driverId: w.driver.user.id,
      pickup: PICKUP,
      destination: DEST,
    };
    expect(
      (await api.post('/api/v1/admin/trips').set(auth(w.passenger.accessToken)).send(body)).status,
    ).toBe(403);
    expect((await api.post('/api/v1/admin/trips').set(auth(w.admin)).send(body)).status).toBe(409);
    expect(
      (
        await api
          .post('/api/v1/admin/trips')
          .set(auth(w.admin))
          .send({ ...body, pickup: { ...PICKUP, latitude: 200 } })
      ).status,
    ).toBe(400);
  });
});
