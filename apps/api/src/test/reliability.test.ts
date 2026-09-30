import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { pool } from '../config/database';
import { ConsoleNotificationProvider } from '../lib/notifications/console-provider';
import { sweepTrips } from '../modules/trips/trip-maintenance';
import { api, onboardUser } from './helpers';
import {
  THAMEL,
  arriveAtPickup,
  auth,
  backdate,
  clearRedis,
  driverAt,
  forceDriverOnline,
  north,
  requestRide,
  rideWorld,
  type RideWorld,
} from './rides';
import { login, startTestServer } from './wsClient';

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
afterEach(() => vi.restoreAllMocks());

const trip = (w: RideWorld, token: string) => api.get(`/api/v1/trips/${w.tripId}`).set(auth(token));
const act = (w: RideWorld, who: 'driver' | 'passenger', path: string, body: object = {}) =>
  api.post(`/api/v1/trips/${w.tripId}/${path}`).set(auth(w[who].accessToken)).send(body);
const eventCount = async (tripId: string, type: string) =>
  (
    await pool.query(
      'SELECT count(*)::int AS n FROM trip_events WHERE trip_id = $1 AND type = $2',
      [tripId, type],
    )
  ).rows[0].n as number;

// ============================================================ the server forgets everything cached

describe('recovery: the database is the record, everything cached can be rebuilt', () => {
  it('carries a ride through a complete loss of Redis (a restart, a failover)', async () => {
    const w = await rideWorld();
    await clearRedis(); // live positions, presence, cached ride state: all gone

    const active = await api.get('/api/v1/trips/active').set(auth(w.passenger.accessToken));
    expect(active.body.data).toMatchObject({ id: w.tripId, status: 'DRIVER_EN_ROUTE' });
    expect((await trip(w, w.driver.accessToken)).body.data.status).toBe('DRIVER_EN_ROUTE');

    // the driver's app simply sends its next position; the ride carries on from the database's state
    await forceDriverOnline(w.driverId);
    expect((await arriveAtPickup(w)).status).toBe(200);
    expect((await act(w, 'driver', 'start')).status).toBe(200);
    await clearRedis(); // and lose it again mid-ride
    // Ending a ride needs a live driver position, so until the driver's app sends its next one (seconds)
    // the server refuses, with a message that says why. It does not guess and it does not lose the ride.
    const early = await act(w, 'driver', 'complete');
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('LOCATION_UNAVAILABLE');
    expect((await trip(w, w.driver.accessToken)).body.data.status).toBe('IN_PROGRESS');
    await forceDriverOnline(w.driverId);
    await driverAt(w.tripId, w.driverId, north(THAMEL, 900)); // the app's next position arrives
    expect((await act(w, 'driver', 'complete')).status).toBe(200);
    expect((await act(w, 'driver', 'payment/confirm')).status).toBe(200);
    const done = (await trip(w, w.passenger.accessToken)).body.data;
    expect(done).toMatchObject({ status: 'COMPLETED', paymentStatus: 'PAID' });
  });

  it('gives a reconnecting client the current state, not what it last saw', async () => {
    const w = await rideWorld();
    const first = await login(port, w.passenger.accessToken);
    first.send({ type: 'subscribe', tripId: w.tripId });
    const before = await first.waitFor((m) => m.type === 'snapshot');
    expect(before.snapshot.status).toBe('DRIVER_EN_ROUTE');
    await first.close(); // the passenger's network drops

    expect((await arriveAtPickup(w)).status).toBe(200); // the ride moves on while they are away
    expect((await act(w, 'driver', 'start')).status).toBe(200);

    const second = await login(port, w.passenger.accessToken); // reconnect
    second.send({ type: 'subscribe', tripId: w.tripId });
    const after = await second.waitFor((m) => m.type === 'snapshot');
    expect(after.snapshot.status).toBe('IN_PROGRESS'); // the server's truth, in the first message
    await second.close();
  });

  it("lets a client replay the ride's events from the start and get them in order, once each", async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await act(w, 'driver', 'start');
    const all = (
      await api.get(`/api/v1/trips/${w.tripId}/events?after=0`).set(auth(w.passenger.accessToken))
    ).body.data as Array<{ seq: number; type: string }>;
    const seqs = all.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b)); // ordered
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicates
    expect(seqs[0]).toBe(1);
    expect(seqs.every((s, i) => s === i + 1)).toBe(true); // no gaps: a client can tell if it missed one
    // resuming from the middle returns exactly the rest
    const mid = seqs[Math.floor(seqs.length / 2)] as number;
    const rest = (
      await api
        .get(`/api/v1/trips/${w.tripId}/events?after=${mid}`)
        .set(auth(w.passenger.accessToken))
    ).body.data as Array<{ seq: number }>;
    expect(rest.map((e) => e.seq)).toEqual(seqs.filter((s) => s > mid));
  });
});

// ============================================================ the same request twice

describe('duplicate requests', () => {
  it('turns simultaneous ride requests into one ride', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    const results = await Promise.all([1, 2, 3, 4].map(() => requestRide(p.accessToken)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
    const n = (
      await pool.query('SELECT count(*)::int AS n FROM trips WHERE passenger_id = $1', [p.user.id])
    ).rows[0].n;
    expect(n).toBe(1);
  });

  it('applies a repeated arrival, start or completion once, and answers the repeat with a clear refusal', async () => {
    const w = await rideWorld();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 20));
    const arrivals = await Promise.all([act(w, 'driver', 'arrived'), act(w, 'driver', 'arrived')]);
    expect(arrivals.map((r) => r.status).sort()).toEqual([200, 409]);
    const starts = await Promise.all([
      act(w, 'driver', 'start'),
      act(w, 'driver', 'start'),
      act(w, 'driver', 'start'),
    ]);
    expect(starts.filter((r) => r.status === 200)).toHaveLength(1);
    expect(starts.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
    const completes = await Promise.all([
      act(w, 'driver', 'complete'),
      act(w, 'driver', 'complete'),
    ]);
    expect(completes.filter((r) => r.status === 200)).toHaveLength(1);
    // each milestone is in the record once
    expect(await eventCount(w.tripId, 'DRIVER_ARRIVED')).toBe(1);
    expect(await eventCount(w.tripId, 'TRIP_STARTED')).toBe(1);
    expect(await eventCount(w.tripId, 'TRIP_COMPLETED')).toBe(1);
  });
});

describe('ordering under simultaneous writes', () => {
  it("never lets a message's time disagree with its sequence number", async () => {
    const w = await rideWorld();
    const sendChat = (who: 'driver' | 'passenger', i: number) =>
      api
        .post(`/api/v1/trips/${w.tripId}/chat`)
        .set(auth(w[who].accessToken))
        .send({ clientMessageId: `reliab-msg-${Date.now()}-${i}`, body: `message ${i}` });
    const res = await Promise.all(
      Array.from({ length: 12 }, (_, i) => sendChat(i % 2 ? 'driver' : 'passenger', i)),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    const rows = (
      await pool.query(
        'SELECT seq, created_at FROM trip_messages WHERE trip_id = $1 ORDER BY seq',
        [w.tripId],
      )
    ).rows as Array<{ seq: number; created_at: Date }>;
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.created_at.getTime()).toBeGreaterThanOrEqual(
        rows[i - 1]!.created_at.getTime(),
      );
    }
    const history = (
      await api.get(`/api/v1/trips/${w.tripId}/chat`).set(auth(w.driver.accessToken))
    ).body.data.items as Array<{ kind: string; message?: { seq: number } }>;
    const seqs = history.filter((i) => i.kind === 'message').map((i) => i.message!.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('keeps ride events in time order as well as sequence order', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await act(w, 'driver', 'start');
    const rows = (
      await pool.query('SELECT seq, created_at FROM trip_events WHERE trip_id = $1 ORDER BY seq', [
        w.tripId,
      ])
    ).rows as Array<{ seq: number; created_at: Date }>;
    expect(rows.length).toBeGreaterThan(3);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.created_at.getTime()).toBeGreaterThanOrEqual(
        rows[i - 1]!.created_at.getTime(),
      );
    }
  });
});

// ============================================================ payments

describe('payment integrity', () => {
  async function completed() {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await act(w, 'driver', 'start');
    expect((await act(w, 'driver', 'complete')).status).toBe(200);
    return w;
  }

  it('records one payment however many times cash is confirmed, for the amount the server priced', async () => {
    const w = await completed();
    const fare = (
      await pool.query('SELECT fare_final_npr AS f FROM trips WHERE id = $1', [w.tripId])
    ).rows[0].f as number;
    // the driver's request cannot name the amount
    const results = await Promise.all(
      [1, 2, 3].map(() => act(w, 'driver', 'payment/confirm', { amountNpr: 1 })),
    );
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    const rows = (
      await pool.query('SELECT amount_npr, status FROM trip_payments WHERE trip_id = $1', [
        w.tripId,
      ])
    ).rows;
    expect(rows).toEqual([{ amount_npr: fare, status: 'PAID' }]);
    expect(await eventCount(w.tripId, 'PAYMENT_RECEIVED')).toBe(1);
  });

  it("refuses to confirm cash for anyone else's ride, before the ride ends, or by the passenger", async () => {
    const w = await rideWorld();
    expect((await act(w, 'driver', 'payment/confirm')).status).toBe(409); // not finished
    await arriveAtPickup(w);
    await act(w, 'driver', 'start');
    await act(w, 'driver', 'complete');
    expect((await act(w, 'passenger', 'payment/confirm')).status).toBeGreaterThanOrEqual(400);
    const other = await onboardUser('DRIVER');
    const stranger = await api
      .post(`/api/v1/trips/${w.tripId}/payment/confirm`)
      .set(auth(other.accessToken));
    expect(stranger.status).toBeGreaterThanOrEqual(400);
    const rows = (
      await pool.query('SELECT status FROM trip_payments WHERE trip_id = $1', [w.tripId])
    ).rows;
    expect(rows.every((r) => r.status !== 'PAID')).toBe(true);
  });
});

// ============================================================ things that fail underneath

describe('failures underneath', () => {
  it('never lets a failed notification undo a ride, and still keeps the record', async () => {
    vi.spyOn(ConsoleNotificationProvider.prototype, 'send').mockRejectedValue(
      new Error('push provider down'),
    );
    const w = await rideWorld(); // the driver-assigned notification fails to deliver
    expect((await trip(w, w.passenger.accessToken)).body.data.status).toBe('DRIVER_EN_ROUTE');
    expect((await arriveAtPickup(w)).status).toBe(200); // and so does every later step
    const stored = await pool.query('SELECT 1 FROM notifications WHERE user_id = $1', [
      w.passengerId,
    ]);
    expect(stored.rowCount).toBeGreaterThan(0); // the durable record exists although delivery failed
  });

  it('survives background sweeps running at the same moment (two instances, or a retry)', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await backdate(w.tripId, 'arrived_at', 130); // past the first waiting reminder
    await Promise.all([sweepTrips(), sweepTrips(), sweepTrips()]);
    await sweepTrips(); // and again later
    const reminders = (
      await pool.query(
        "SELECT count(*)::int AS n FROM trip_events WHERE trip_id = $1 AND type IN ('DRIVER_WAITING', 'PASSENGER_WAITING')",
        [w.tripId],
      )
    ).rows[0].n;
    expect(reminders).toBeLessThanOrEqual(2); // one reminder per person per threshold, never a flood
    expect((await trip(w, w.passenger.accessToken)).body.data.status).toBe('DRIVER_ARRIVED');
  });

  it("keeps answering when a sweep's database call fails", async () => {
    const w = await rideWorld();
    const real = pool.query.bind(pool);
    let failed = 0;
    vi.spyOn(pool, 'query').mockImplementation(((text: unknown, ...rest: unknown[]) => {
      if (
        typeof text === 'string' &&
        text.includes('FROM trips') &&
        text.includes('DRIVER_ARRIVED') &&
        failed < 1
      ) {
        failed++;
        return Promise.reject(new Error('deadlock detected'));
      }
      return (real as (...a: unknown[]) => unknown)(text, ...rest);
    }) as never);
    await expect(sweepTrips()).rejects.toThrow(); // the sweep reports its failure to its caller (which logs it and runs again)
    vi.restoreAllMocks();
    await expect(sweepTrips()).resolves.toBeDefined(); // the next run is unaffected
    expect((await trip(w, w.passenger.accessToken)).status).toBe(200);
  });
});
