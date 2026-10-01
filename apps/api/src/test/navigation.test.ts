import {
  ROUTE_DEVIATION_RIDE_MIN_DEVIATIONS,
  approachPhase,
  haversineMeters,
  nearestOnPolyline,
  simplifyPolyline,
  type AdminPermission,
  type LiveTripSnapshot,
  type NavigationMetrics,
  type NavigationRouteResponse,
} from '@yatri/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { getRedisClient } from '../config/redis';
import { LocationProviderError } from '../modules/location/providers/location-provider';
import { setRouteProviderForTests } from '../modules/location/providers';
import type { RouteProvider } from '../modules/location/providers/route-provider';
import { runRiskSweep } from '../modules/risk/sweep';
import { buildSnapshot, loadMeta } from '../modules/tracking/tracking.service';
import { api, loginTestAdmin, onboardUser } from './helpers';
import { login, startTestServer } from './wsClient';
import {
  PATAN,
  THAMEL,
  arriveAtPickup,
  auth,
  driverAt,
  finishedRide,
  north,
  rideWorld,
  type RideWorld,
} from './rides';

// ---------------------------------------------------------------- a routing engine we control

interface Fake {
  traffic?: boolean;
  duration: () => number;
  fail?: boolean;
  calls: number;
}
const fake: Fake = { duration: () => 600, calls: 0 };

const provider: RouteProvider = {
  name: 'fake-nav',
  get capabilities() {
    return { steps: true, traffic: !!fake.traffic };
  },
  async calculateETA() {
    return fake.duration();
  },
  async calculateRoute(from, to, opts) {
    fake.calls += 1;
    if (fake.fail) throw new LocationProviderError('UNAVAILABLE', 'down');
    const mid = {
      latitude: (from.latitude + to.latitude) / 2,
      longitude: (from.longitude + to.longitude) / 2,
    };
    const distance = haversineMeters(from, to) * 1.1;
    return {
      distanceMeters: distance,
      durationSeconds: fake.duration(),
      method: 'route' as const,
      trafficAware: !!fake.traffic,
      ...(opts?.geometry
        ? {
            geometry: [
              [from.longitude, from.latitude],
              [mid.longitude, mid.latitude],
              [to.longitude, to.latitude],
            ] as Array<[number, number]>,
          }
        : {}),
      ...(opts?.steps
        ? {
            steps: [
              step('Head out.', 'depart', distance / 2, from),
              step('Turn left onto New Road.', 'left', distance / 2, mid),
              step('You have arrived.', 'arrive', 0, to),
            ],
          }
        : {}),
    };
  },
};
function step(
  instruction: string,
  maneuver: 'depart' | 'left' | 'arrive',
  d: number,
  p: { latitude: number; longitude: number },
) {
  return {
    instruction,
    maneuver,
    distanceMeters: d,
    durationSeconds: d / 8,
    road: maneuver === 'left' ? 'New Road' : null,
    location: [p.latitude, p.longitude] as [number, number],
  };
}

beforeEach(() => {
  fake.traffic = false;
  fake.fail = false;
  fake.calls = 0;
  fake.duration = () => 600;
  setRouteProviderForTests(provider);
});
afterEach(() => setRouteProviderForTests(undefined));

// ---------------------------------------------------------------- helpers

const east = (p: { latitude: number; longitude: number }, meters: number) => ({
  latitude: p.latitude,
  longitude: p.longitude + meters / (111_195 * Math.cos((p.latitude * Math.PI) / 180)),
});
/** A point `meters` from `to`, on the straight line towards `from`. */
function toward(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  meters: number,
) {
  const total = haversineMeters(from, to);
  const f = Math.min(1, meters / total);
  return {
    latitude: to.latitude + (from.latitude - to.latitude) * f,
    longitude: to.longitude + (from.longitude - to.longitude) * f,
  };
}
const snapshotOf = async (tripId: string, viewer: 'DRIVER' | 'PASSENGER' = 'DRIVER') =>
  buildSnapshot((await loadMeta(tripId))!, viewer) as Promise<LiveTripSnapshot>;
const routeOf = (w: RideWorld, version?: number) =>
  api
    .get(
      `/api/v1/trips/${w.tripId}/navigation${version !== undefined ? `?version=${version}` : ''}`,
    )
    .set(auth(w.driver.accessToken));
const tripRow = async (id: string) =>
  (
    await pool.query(
      'SELECT route_deviations, reroutes, nav_eta_seconds, fare_estimate_npr FROM trips WHERE id = $1',
      [id],
    )
  ).rows[0];
const metric = async (name: string) =>
  Number(
    (
      await pool.query(
        `SELECT COALESCE(sum(value), 0)::text AS v FROM navigation_metrics WHERE metric = $1`,
        [name],
      )
    ).rows[0].v,
  );
const START = north(THAMEL, 1500);

/** A ride with the driver's first location in, 1.5 km from the pickup. */
async function onTheWay(): Promise<RideWorld> {
  const w = await rideWorld();
  await driverAt(w.tripId, w.driverId, START);
  return w;
}

// ---------------------------------------------------------------- the pure rules

describe('geometry and phases', () => {
  const line: Array<[number, number]> = [
    [27.7, 85.3],
    [27.7, 85.31],
    [27.71, 85.31],
  ];
  it('measures how far from a route, and how far along it, a point is', () => {
    const on = nearestOnPolyline({ latitude: 27.7, longitude: 85.305 }, line)!;
    expect(on.distanceMeters).toBeLessThan(1);
    expect(on.segmentIndex).toBe(0);
    const off = nearestOnPolyline({ latitude: 27.7009, longitude: 85.305 }, line)!;
    expect(Math.round(off.distanceMeters)).toBeGreaterThan(95);
    expect(Math.round(off.distanceMeters)).toBeLessThan(105);
    const later = nearestOnPolyline({ latitude: 27.705, longitude: 85.31 }, line)!;
    expect(later.alongMeters).toBeGreaterThan(on.alongMeters);
    expect(later.segmentIndex).toBe(1);
  });

  it('keeps the shape of a route when it is simplified, with fewer points', () => {
    const wiggly: Array<[number, number]> = Array.from({ length: 200 }, (_, i) => [
      27.7 + i * 0.0001,
      85.3 + (i % 2) * 0.00001,
    ]);
    const simple = simplifyPolyline(wiggly, 5);
    expect(simple.length).toBeLessThan(wiggly.length);
    expect(simple[0]).toEqual(wiggly[0]);
    expect(simple[simple.length - 1]).toEqual(wiggly[wiggly.length - 1]);
    expect(simplifyPolyline(wiggly, 0, 20).length).toBeLessThanOrEqual(20);
  });

  const t = { approachingMeters: 500, nearMeters: 150, atMeters: 40, leavingMeters: 80 };
  it('names the phase from the distance, and distrusts an inaccurate reading near a stop', () => {
    const p = (
      d: number,
      acc: number | null,
      target: 'PICKUP' | 'DESTINATION' = 'PICKUP',
      fromPickup: number | null = null,
    ) =>
      approachPhase({
        target,
        distanceToTargetMeters: d,
        fromPickupMeters: fromPickup,
        accuracyMeters: acc,
        thresholds: t,
      });
    expect(p(2000, 8)).toBe('HEADING_TO_PICKUP');
    expect(p(400, 8)).toBe('APPROACHING_PICKUP');
    expect(p(100, 8)).toBe('NEAR_PICKUP');
    expect(p(20, 8)).toBe('AT_PICKUP');
    expect(p(20, 100)).toBe('NEAR_PICKUP'); // 100 m of doubt cannot prove "at" a 40 m radius
    expect(p(20, 300)).toBe('APPROACHING_PICKUP'); // nor "near" a 150 m one
    expect(p(3000, 8, 'DESTINATION', 40)).toBe('LEAVING_PICKUP');
    expect(p(3000, 8, 'DESTINATION', 900)).toBe('HEADING_TO_DESTINATION');
    expect(p(450, 8, 'DESTINATION', 3000)).toBe('APPROACHING_DESTINATION');
    expect(p(30, 8, 'DESTINATION', 3000)).toBe('AT_DESTINATION');
  });
});

// ---------------------------------------------------------------- route creation

describe('the route', () => {
  it("is planned from the driver's first location through the route provider, with steps and a line", async () => {
    const w = await onTheWay();
    const res = await routeOf(w);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { route, unchanged } = res.body.data as NavigationRouteResponse;
    expect(unchanged).toBe(false);
    expect(route).toMatchObject({
      version: 1,
      target: 'PICKUP',
      basis: 'route',
      trafficAware: false,
    });
    expect(route!.geometry.length).toBeGreaterThanOrEqual(2);
    expect(route!.steps.map((s) => s.maneuver)).toEqual(['depart', 'left', 'arrive']);
    expect(route!.steps[1]!.instruction).toBe('Turn left onto New Road.');
    expect(route!.distanceMeters).toBeGreaterThan(1500);
    expect(route!.provider).toEqual({ name: 'fake-nav', steps: true, traffic: false });
  });

  it('is not sent again to an app that already holds it', async () => {
    const w = await onTheWay();
    const res = await routeOf(w, 1);
    expect(res.body.data).toEqual({ route: null, unchanged: true });
  });

  it("is the driver's alone: not the passenger's, not a stranger's, not an anonymous caller's", async () => {
    const w = await onTheWay();
    expect(
      (await api.get(`/api/v1/trips/${w.tripId}/navigation`).set(auth(w.passenger.accessToken)))
        .status,
    ).toBe(403);
    const otherDriver = await onboardUser('DRIVER');
    expect(
      (await api.get(`/api/v1/trips/${w.tripId}/navigation`).set(auth(otherDriver.accessToken)))
        .status,
    ).toBeGreaterThanOrEqual(403);
    expect((await api.get(`/api/v1/trips/${w.tripId}/navigation`)).status).toBe(401);
    const admin = await loginTestAdmin(
      `nav-admin-${Date.now()}@example.com`,
      'a-strong-test-password-1',
      ['OPERATIONS_VIEW'],
    );
    expect((await api.get(`/api/v1/trips/${w.tripId}/navigation`).set(auth(admin))).status).toBe(
      403,
    );
  });

  it('is gone with the ride: nothing is kept, and the ride refuses to give it out', async () => {
    const w = await onTheWay();
    await api.post(`/api/v1/trips/${w.tripId}/cancel`).set(auth(w.passenger.accessToken)).send({});
    expect(await getRedisClient().get(`nav:${w.tripId}:route`)).toBeNull();
    expect(await getRedisClient().get(`nav:${w.tripId}:state`)).toBeNull();
    expect((await routeOf(w)).status).toBe(409);
  });

  it("puts guidance in the driver's snapshot only, and the route's line nowhere else", async () => {
    const w = await onTheWay();
    const driver = await snapshotOf(w.tripId, 'DRIVER');
    expect(driver.navigation).toMatchObject({
      routeVersion: 1,
      target: 'PICKUP',
      phase: 'HEADING_TO_PICKUP',
      offRoute: false,
    });
    expect(driver.navigation!.next?.maneuver).toBe('left');
    const passenger = await snapshotOf(w.tripId, 'PASSENGER');
    expect(passenger.navigation).toBeNull();
    expect(JSON.stringify(passenger)).not.toContain('New Road');
  });

  it('shows the distance left along the route and an ETA scaled by it', async () => {
    const w = await onTheWay();
    const first = await snapshotOf(w.tripId, 'PASSENGER');
    expect(first.driverArrival!.basis).toBe('route');
    const eta1 = first.driverArrival!.etaSeconds!;
    await driverAt(w.tripId, w.driverId, north(THAMEL, 750));
    const half = await snapshotOf(w.tripId, 'PASSENGER');
    expect(half.driverArrival!.distanceMeters).toBeLessThan(first.driverArrival!.distanceMeters);
    expect(half.driverArrival!.etaSeconds!).toBeLessThan(eta1);
    expect(half.driverArrival!.etaSeconds!).toBeGreaterThan(eta1 * 0.3);
  });
});

// ---------------------------------------------------------------- approaching and arriving

describe('approach and arrival', () => {
  it('walks through approaching, near and at the pickup, and counts the arrival once', async () => {
    const w = await onTheWay();
    const phase = async () => (await snapshotOf(w.tripId)).navigation!.phase;
    await driverAt(w.tripId, w.driverId, north(THAMEL, 420));
    expect(await phase()).toBe('APPROACHING_PICKUP');
    await driverAt(w.tripId, w.driverId, north(THAMEL, 110));
    expect(await phase()).toBe('NEAR_PICKUP');
    const before = await metric('ARRIVALS_AT_PICKUP');
    await driverAt(w.tripId, w.driverId, north(THAMEL, 15));
    expect(await phase()).toBe('AT_PICKUP');
    await driverAt(w.tripId, w.driverId, north(THAMEL, 12));
    expect(await metric('ARRIVALS_AT_PICKUP')).toBe(before + 1);
  });

  it('does not call a poor reading an arrival', async () => {
    const w = await onTheWay();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 15), { accuracyMeters: 120 });
    const s = await snapshotOf(w.tripId);
    // A reading this vague cannot prove "at" or "near" the pickup.
    expect(['HEADING_TO_PICKUP', 'APPROACHING_PICKUP', 'NEAR_PICKUP']).toContain(
      s.navigation!.phase,
    );
    expect(s.navigation!.phase).not.toBe('AT_PICKUP');
  });

  it('leaves the pickup, then tells both people once each as the destination comes close', async () => {
    const w = await rideWorld();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 20));
    expect((await arriveAtPickup(w)).status).toBe(200);
    expect(
      (await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken))).status,
    ).toBe(200);

    await driverAt(w.tripId, w.driverId, north(THAMEL, 30));
    expect((await snapshotOf(w.tripId)).navigation).toMatchObject({
      target: 'DESTINATION',
      phase: 'LEAVING_PICKUP',
    });
    // Far moves take time (the server rejects an impossible jump), so each is given the minutes it would really take.
    await driverAt(w.tripId, w.driverId, toward(THAMEL, PATAN, 1500), { deltaMs: 180_000 });
    expect((await snapshotOf(w.tripId)).navigation!.phase).toBe('HEADING_TO_DESTINATION');

    const events = async () =>
      (
        await pool.query(
          `SELECT payload FROM trip_events WHERE trip_id = $1 AND type = 'DESTINATION_NEARBY' ORDER BY seq`,
          [w.tripId],
        )
      ).rows.map((r) => r.payload.milestone as string);
    await driverAt(w.tripId, w.driverId, toward(THAMEL, PATAN, 450), { deltaMs: 120_000 });
    await driverAt(w.tripId, w.driverId, toward(THAMEL, PATAN, 120), { deltaMs: 30_000 });
    await driverAt(w.tripId, w.driverId, PATAN, { deltaMs: 20_000 }); // at the destination
    const done = await events();
    expect(done).toEqual(['APPROACHING_DESTINATION', 'NEAR_DESTINATION', 'AT_DESTINATION']);
    // Repeating the same readings adds no second notice of any milestone.
    await driverAt(w.tripId, w.driverId, PATAN, { deltaMs: 10_000 });
    await driverAt(w.tripId, w.driverId, PATAN, { deltaMs: 10_000 });
    const after = await events();
    expect(after.length).toBe(new Set(after).size);
    expect(after.length).toBe(done.length);
    expect(await metric('ARRIVALS_AT_DESTINATION')).toBeGreaterThanOrEqual(1);
    // Arrival detection tells people; it never ends the ride by itself.
    const status = (await pool.query('SELECT status FROM trips WHERE id = $1', [w.tripId])).rows[0]
      .status;
    expect(status).toBe('IN_PROGRESS');
  });

  it('words the milestones for each person, without a notification', async () => {
    const w = await rideWorld();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 20));
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await driverAt(w.tripId, w.driverId, toward(THAMEL, PATAN, 2000), { deltaMs: 180_000 });
    await driverAt(w.tripId, w.driverId, PATAN, { deltaMs: 120_000 });
    const ev = await api.get(`/api/v1/trips/${w.tripId}/events`).set(auth(w.passenger.accessToken));
    const texts = (ev.body.data as Array<{ type: string }>).filter(
      (e) => e.type === 'DESTINATION_NEARBY',
    );
    expect(texts.length).toBeGreaterThanOrEqual(1);
    const notes = await pool.query(`SELECT 1 FROM notifications WHERE type = 'DESTINATION_NEARBY'`);
    expect(notes.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------- deviation and rerouting

describe('leaving the route', () => {
  const off = (n: number) => east(north(THAMEL, 1450), n); // beside the route, near where the driver was

  it('does nothing about one stray reading, and forgets it when the driver is back on the route', async () => {
    const w = await onTheWay();
    await driverAt(w.tripId, w.driverId, off(300));
    await driverAt(w.tripId, w.driverId, north(THAMEL, 700)); // back on the route
    await driverAt(w.tripId, w.driverId, off(300));
    await driverAt(w.tripId, w.driverId, north(THAMEL, 650));
    const row = await tripRow(w.tripId);
    expect(row.route_deviations).toBe(0);
    expect(row.reroutes).toBe(0);
    expect((await snapshotOf(w.tripId)).navigation!.routeVersion).toBe(1);
  });

  it('confirms a deviation after several accurate readings in a row, and plans a new route', async () => {
    const w = await onTheWay();
    const calls = fake.calls;
    await driverAt(w.tripId, w.driverId, off(300));
    await driverAt(w.tripId, w.driverId, off(310));
    expect((await tripRow(w.tripId)).route_deviations).toBe(0); // two are not enough
    await driverAt(w.tripId, w.driverId, off(320));
    const row = await tripRow(w.tripId);
    expect(row).toMatchObject({ route_deviations: 1, reroutes: 1 });
    const guidance = (await snapshotOf(w.tripId)).navigation!;
    expect(guidance.routeVersion).toBe(2);
    expect(guidance.offRoute).toBe(false); // already on the new route
    expect(fake.calls).toBeGreaterThan(calls);
    const res = (await routeOf(w, 1)).body.data as NavigationRouteResponse;
    expect(res.route!.version).toBe(2);
    expect(await metric('REROUTES')).toBeGreaterThanOrEqual(1);
    expect(await metric('DEVIATIONS_CONFIRMED')).toBeGreaterThanOrEqual(1);
  });

  it('asks for a new route no more often than the interval, and says the driver is off it meanwhile', async () => {
    const w = await onTheWay();
    // Readings every 5 s: the third confirms the deviation, but the last plan was only ~10 s ago.
    await driverAt(w.tripId, w.driverId, off(300), { deltaMs: 5000 });
    await driverAt(w.tripId, w.driverId, off(310), { deltaMs: 5000 });
    await driverAt(w.tripId, w.driverId, off(320), { deltaMs: 5000 });
    const mid = await snapshotOf(w.tripId);
    expect(mid.navigation).toMatchObject({ offRoute: true, routeVersion: 1 });
    expect((await tripRow(w.tripId)).route_deviations).toBe(1); // counted once, not per reading
    await driverAt(w.tripId, w.driverId, off(330), { deltaMs: 20_000 });
    const later = await snapshotOf(w.tripId);
    expect(later.navigation).toMatchObject({ offRoute: false, routeVersion: 2 });
    expect((await tripRow(w.tripId)).route_deviations).toBe(1);
  });

  it('does not judge a deviation from an inaccurate reading', async () => {
    const w = await onTheWay();
    for (let i = 0; i < 4; i += 1)
      await driverAt(w.tripId, w.driverId, off(400 + i), { accuracyMeters: 120 });
    const row = await tripRow(w.tripId);
    expect(row).toMatchObject({ route_deviations: 0, reroutes: 0 });
  });

  it('never changes the fare: the route may change, the price comes from the fare engine only', async () => {
    const w = await onTheWay();
    const before = await tripRow(w.tripId);
    await driverAt(w.tripId, w.driverId, off(300));
    await driverAt(w.tripId, w.driverId, off(310));
    await driverAt(w.tripId, w.driverId, off(320));
    expect((await tripRow(w.tripId)).fare_estimate_npr).toBe(before.fare_estimate_npr);
  });

  it("counts a driver's deviations privately: counts on the ride, no track anywhere", async () => {
    const w = await onTheWay();
    await driverAt(w.tripId, w.driverId, off(300));
    await driverAt(w.tripId, w.driverId, off(310));
    await driverAt(w.tripId, w.driverId, off(320));
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'navigation_metrics'`,
    );
    expect(cols.rows.map((c) => c.column_name).sort()).toEqual(['day', 'metric', 'value']);
    const keys = await getRedisClient().keys(`nav:${w.tripId}:*`);
    expect(keys.length).toBeGreaterThan(0); // live only
  });
});

// ---------------------------------------------------------------- the pattern, in the risk system

describe('deviation and the risk system', () => {
  async function ridesWithDeviations(
    driver: Awaited<ReturnType<typeof onboardUser>>,
    count: number,
    deviations: number,
  ) {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const w = await finishedRide(true, driver);
      ids.push(w.tripId);
      await pool.query('UPDATE trips SET route_deviations = $2 WHERE id = $1', [
        w.tripId,
        deviations,
      ]);
    }
    return ids;
  }

  it('raises one low-weight signal only for a pattern across rides, never for one deviation', async () => {
    const pattern = await onboardUser('DRIVER');
    await ridesWithDeviations(pattern, 3, ROUTE_DEVIATION_RIDE_MIN_DEVIATIONS);
    const oneOff = await onboardUser('DRIVER');
    await ridesWithDeviations(oneOff, 3, 1);
    const few = await onboardUser('DRIVER');
    await ridesWithDeviations(few, 2, ROUTE_DEVIATION_RIDE_MIN_DEVIATIONS);

    await runRiskSweep();
    const events = await pool.query(
      `SELECT user_id, points, category FROM risk_events WHERE rule_code = 'ROUTE_DEVIATION_PATTERN'`,
    );
    expect(events.rows.map((r) => r.user_id)).toEqual([pattern.user.id]);
    expect(events.rows[0].points).toBeLessThanOrEqual(5);
    expect(events.rows[0].category).toBe('GPS');
    // And nothing restricts or suspends anyone because of it.
    const status = await pool.query('SELECT status FROM users WHERE id = $1', [pattern.user.id]);
    expect(status.rows[0].status).toBe('ACTIVE');
    const restr = await pool
      .query('SELECT 1 FROM risk_restrictions WHERE user_id = $1', [pattern.user.id])
      .catch(() => ({ rowCount: 0 }));
    expect(restr.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------- traffic, failures, recovery

describe('estimates that follow traffic, and routing that fails', () => {
  it('keeps the arrival time fresh when the provider follows traffic, and says so', async () => {
    fake.traffic = true;
    fake.duration = () => 600;
    const w = await onTheWay();
    const first = (await snapshotOf(w.tripId)).navigation!;
    expect(first.trafficAware).toBe(true);
    const eta1 = first.etaSeconds!;
    fake.duration = () => 1500; // traffic builds up
    await driverAt(w.tripId, w.driverId, north(THAMEL, 1400), { deltaMs: 61_000 });
    const later = (await snapshotOf(w.tripId)).navigation!;
    expect(later.routeVersion).toBe(1); // a fresher duration is not a new route
    expect(later.etaSeconds!).toBeGreaterThan(eta1);
  });

  it('does not claim traffic awareness when the provider cannot', async () => {
    const w = await onTheWay();
    expect((await snapshotOf(w.tripId)).navigation!.trafficAware).toBe(false);
    expect(((await routeOf(w)).body.data as NavigationRouteResponse).route!.provider.traffic).toBe(
      false,
    );
  });

  it('falls back to a straight-line guide in words when routing fails, and counts it', async () => {
    fake.fail = true;
    const before = await metric('ROUTE_FALLBACKS');
    const w = await onTheWay();
    const route = ((await routeOf(w)).body.data as NavigationRouteResponse).route!;
    expect(route.basis).toBe('estimate');
    expect(route.steps[0]!.instruction).toMatch(
      /^Head (north|north-east|east|south-east|south|south-west|west|north-west) toward /,
    );
    const g = (await snapshotOf(w.tripId)).navigation!;
    expect(g.basis).toBe('estimate');
    expect(g.etaSeconds).not.toBeNull();
    expect(await metric('ROUTE_FALLBACKS')).toBeGreaterThan(before);
    // A straight guide cannot be "off": there is no road line to leave.
    await driverAt(w.tripId, w.driverId, east(north(THAMEL, 700), 400));
    await driverAt(w.tripId, w.driverId, east(north(THAMEL, 650), 400));
    await driverAt(w.tripId, w.driverId, east(north(THAMEL, 600), 400));
    expect((await tripRow(w.tripId)).route_deviations).toBe(0);
  });

  it('recovers when the cache is lost (a Redis restart): the next reading plans the route again', async () => {
    const w = await onTheWay();
    await getRedisClient().flushdb();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 1400));
    const res = await routeOf(w);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((res.body.data as NavigationRouteResponse).route).not.toBeNull();
    expect((await snapshotOf(w.tripId)).navigation).not.toBeNull();
  });

  it('plans one route per ride move, not one per reading (saves data and routing capacity)', async () => {
    const w = await onTheWay();
    const calls = fake.calls;
    for (let m = 1400; m > 1000; m -= 100) await driverAt(w.tripId, w.driverId, north(THAMEL, m));
    expect(fake.calls).toBe(calls); // on the route: no new call
  });
});

// ---------------------------------------------------------------- operations view

describe('administrator figures', () => {
  const admin = (permissions: AdminPermission[]) =>
    loginTestAdmin(
      `nav-ops-${Date.now()}-${Math.random()}@example.com`,
      'a-strong-test-password-1',
      permissions,
    );

  it('shows counts and percentages with OPERATIONS_VIEW, and nothing about places or people', async () => {
    const w = await onTheWay();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 15));
    const ops = await admin(['OPERATIONS_VIEW']);
    const res = await api.get('/api/v1/admin/navigation/metrics?range=7d').set(auth(ops));
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const m = res.body.data as NavigationMetrics;
    expect(m.routesPlanned).toBeGreaterThanOrEqual(1);
    expect(m.arrivalsAtPickup).toBeGreaterThanOrEqual(1);
    expect(m.provider).toEqual({ name: 'fake-nav', steps: true, traffic: false });
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/latitude|longitude|"geometry"|New Road/);
    const none = await admin(['RISK_VIEW']);
    expect((await api.get('/api/v1/admin/navigation/metrics').set(auth(none))).status).toBe(403);
    const passenger = await onboardUser('PASSENGER');
    expect(
      (await api.get('/api/v1/admin/navigation/metrics').set(auth(passenger.accessToken))).status,
    ).toBe(403);
  });

  it('measures how good the first arrival estimate was against the actual ride', async () => {
    const w = await rideWorld();
    await driverAt(w.tripId, w.driverId, north(THAMEL, 20));
    await arriveAtPickup(w);
    await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
    await driverAt(w.tripId, w.driverId, north(THAMEL, 30));
    expect((await tripRow(w.tripId)).nav_eta_seconds).toBe(600);
    await pool.query('UPDATE trips SET actual_duration_seconds = 640, status = $2 WHERE id = $1', [
      w.tripId,
      'COMPLETED',
    ]);
    const ops = await admin(['OPERATIONS_VIEW']);
    const m = (await api.get('/api/v1/admin/navigation/metrics?range=7d').set(auth(ops))).body
      .data as NavigationMetrics;
    expect(m.eta.samples).toBeGreaterThanOrEqual(1);
    expect(m.eta.withinTwentyPercent).not.toBeNull();
  });
});

// ---------------------------------------------------------------- one system, not two

describe('one location and routing system', () => {
  it('has no second route planner or geospatial maths, and never touches the fare', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(__dirname, '..', 'modules', 'navigation');
    const text = readdirSync(dir)
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
    // Routes come from the provider abstraction, distances from the shared geo module.
    expect(text).not.toMatch(/fetch\(|osrm|graphhopper|valhalla/i);
    expect(text).not.toMatch(/Math\.(sin|cos|atan2|asin)/);
    // Prices come from the fare engine alone.
    expect(text).not.toMatch(/pricing|estimateFare|fare_final|fare_estimate/i);
  });
});

// ---------------------------------------------------------------- over the socket, and back again

describe('the live socket', () => {
  let port = 0;
  let stop: () => Promise<void>;
  beforeAll(async () => {
    const server = await startTestServer();
    port = server.port;
    stop = server.close;
  });
  afterAll(async () => {
    await stop();
  });

  it('carries guidance to the driver only, and gives the same guidance again after a reconnect', async () => {
    const w = await onTheWay();
    const first = await login(port, w.driver.accessToken);
    first.send({ type: 'subscribe', tripId: w.tripId });
    const s1 = (await first.waitFor((m) => m.type === 'snapshot')).snapshot as LiveTripSnapshot;
    expect(s1.navigation).toMatchObject({ target: 'PICKUP', routeVersion: 1 });
    first.ws.close();

    // The driver's phone loses the connection and comes back: a full snapshot, the same route version, nothing replayed.
    const again = await login(port, w.driver.accessToken);
    again.send({ type: 'subscribe', tripId: w.tripId });
    const s2 = (await again.waitFor((m) => m.type === 'snapshot')).snapshot as LiveTripSnapshot;
    expect(s2.navigation?.routeVersion).toBe(1);
    expect(s2.version).toBeGreaterThanOrEqual(s1.version);
    again.ws.close();

    const rider = await login(port, w.passenger.accessToken);
    rider.send({ type: 'subscribe', tripId: w.tripId });
    const s3 = (await rider.waitFor((m) => m.type === 'snapshot')).snapshot as LiveTripSnapshot;
    expect(s3.navigation).toBeNull();
    expect(JSON.stringify(s3)).not.toContain('New Road');
    rider.ws.close();
  });
});

// ---------------------------------------------------------------- performance

describe('performance', () => {
  it('follows 60 readings on one route with a single routing request and in a few seconds', async () => {
    const w = await onTheWay();
    const calls = fake.calls;
    const started = Date.now();
    for (let i = 0; i < 60; i += 1) {
      await driverAt(w.tripId, w.driverId, north(THAMEL, 1490 - i * 8), { deltaMs: 3000 });
    }
    expect(fake.calls).toBe(calls);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect((await snapshotOf(w.tripId)).navigation!.routeVersion).toBe(1);
  });

  it('simplifies a long route quickly and keeps it within a few metres of itself', () => {
    const long: Array<[number, number]> = Array.from({ length: 5000 }, (_, i) => [
      27.7 + i * 0.00002,
      85.3 + Math.sin(i / 40) * 0.0004,
    ]);
    const t0 = Date.now();
    const simple = simplifyPolyline(long, 5, 400);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(simple.length).toBeLessThanOrEqual(400);
    const worst = Math.max(
      ...long
        .filter((_, i) => i % 50 === 0)
        .map((p) => nearestOnPolyline({ latitude: p[0], longitude: p[1] }, simple)!.distanceMeters),
    );
    expect(worst).toBeLessThan(60);
  });
});
