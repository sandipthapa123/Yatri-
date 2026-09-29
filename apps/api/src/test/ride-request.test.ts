import { TRIP_EVENT_META, TRIP_EVENT_TYPES, TRIP_STATUSES, describeTripEvent } from '@yatri/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { sweepDispatch } from '../modules/dispatch/dispatch.service';
import {
  activeStrategy,
  findEligibleDrivers,
  matchDrivers,
  proximityStrategy,
} from '../modules/dispatch/matching';
import {
  getActiveCategoryByCode,
  listActiveCategories,
  pricingFor,
} from '../modules/pricing/categories';
import { estimateFare } from '../modules/pricing/pricing';
import { pricingConfig } from '../modules/pricing/pricing.config';
import { decidePassengerCancellation, type CancellationRules } from '../modules/trips/cancellation';
import { canTripTransition, statusesLeadingTo } from '../modules/trips/trip-machine';
import { api, loginTestAdmin, onboardUser } from './helpers';
import {
  PATAN,
  THAMEL,
  auth,
  backdate,
  currentOffer,
  forceDriverOnline,
  north,
  requestRide,
  rideWorld,
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

const post = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/trips${path}`).set(auth(token)).send(body);
const get = (token: string, path: string) => api.get(`/api/v1/trips${path}`).set(auth(token));
const REQUEST = { pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR' };
const events = async (token: string, id: string, after = 0) =>
  (await get(token, `/${id}/events?after=${after}`)).body.data as Array<{
    seq: number;
    type: string;
    payload: Record<string, unknown>;
  }>;

describe('vehicle category and the fare estimate', () => {
  it('prices every active category on the server and says whether one is available — nothing more', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string, north(THAMEL, 400), 'CAR');
    const res = await post(p.accessToken, '/estimate', REQUEST);
    expect(res.status).toBe(200);
    const data = res.body.data;

    expect(data.vehicleCategory).toEqual({ code: 'CAR', label: 'Car' });
    const byCode = Object.fromEntries(
      data.categories.map((c: { code: string }) => [c.code, c]),
    ) as Record<
      string,
      { available: boolean; fare: { totalNpr: number; durationSeconds: number } }
    >;
    expect(Object.keys(byCode).sort()).toEqual(['CAR', 'MOTORCYCLE', 'SCOOTER', 'SUV']);
    expect(byCode.CAR?.available).toBe(true);
    expect(byCode.SUV?.available).toBe(false);
    expect(byCode.MOTORCYCLE?.available).toBe(false);
    // a smaller vehicle is cheaper, a bigger one dearer (rates come from the category data)
    expect(byCode.MOTORCYCLE!.fare.totalNpr).toBeLessThan(byCode.CAR!.fare.totalNpr);
    expect(byCode.SUV!.fare.totalNpr).toBeGreaterThan(byCode.CAR!.fare.totalNpr);
    // distance AND duration are estimated by the server
    expect(data.fare.distanceMeters).toBeGreaterThan(4000);
    expect(data.fare.durationSeconds).toBeGreaterThan(0);
    // the selected category's fare is the same object the picker shows
    expect(data.fare).toEqual(byCode.CAR!.fare);

    // The driver database is not exposed: no ids, names, positions or counts anywhere.
    const text = JSON.stringify(data);
    expect(text).not.toContain(d.user.id);
    expect(text).not.toMatch(
      /driverId|latitude":27\.7[0-9]{4},"longitude":85\.31[0-9]{3},"accuracy|count|nearby/i,
    );
  });

  it('uses exactly the pure fare function with the category rules (defaults where a category has none)', async () => {
    const p = await onboardUser('PASSENGER');
    for (const code of ['CAR', 'SUV', 'MOTORCYCLE']) {
      const res = await post(p.accessToken, '/estimate', { ...REQUEST, vehicleCategory: code });
      const fare = res.body.data.fare;
      const category = await getActiveCategoryByCode(code);
      expect(fare).toEqual(
        estimateFare(
          {
            distanceMeters: fare.distanceMeters,
            durationSeconds: fare.durationSeconds,
            routeBased: false,
          },
          pricingFor(category),
        ),
      );
    }
    // CAR has no overrides: it is the platform default, stated once in configuration
    expect(pricingFor(await getActiveCategoryByCode('CAR'))).toEqual(pricingConfig());
  });

  it('rejects an unknown, inactive or missing category, and any client-supplied price, driver or status', async () => {
    const p = await onboardUser('PASSENGER');
    expect(
      (await post(p.accessToken, '/estimate', { ...REQUEST, vehicleCategory: 'ROCKET' })).status,
    ).toBe(422);
    expect(
      (await post(p.accessToken, '/request', { ...REQUEST, vehicleCategory: 'ROCKET' })).status,
    ).toBe(422);
    await pool.query("UPDATE vehicle_categories SET is_active = false WHERE code = 'SUV'");
    try {
      expect(
        (await post(p.accessToken, '/request', { ...REQUEST, vehicleCategory: 'SUV' })).status,
      ).toBe(422);
      const est = await post(p.accessToken, '/estimate', REQUEST);
      expect(est.body.data.categories.map((c: { code: string }) => c.code)).not.toContain('SUV');
    } finally {
      await pool.query("UPDATE vehicle_categories SET is_active = true WHERE code = 'SUV'");
    }
    const { vehicleCategory: _omit, ...noCategory } = REQUEST;
    void _omit;
    expect((await post(p.accessToken, '/request', noCategory)).status).toBe(400);
    for (const extra of [
      { fareNpr: 1 },
      { driverId: '00000000-0000-4000-8000-000000000000' },
      { status: 'DRIVER_EN_ROUTE' },
      { vehicleCategoryId: '00000000-0000-4000-8000-000000000000' },
      { passengerId: '00000000-0000-4000-8000-000000000000' },
    ]) {
      const res = await post(p.accessToken, '/request', { ...REQUEST, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
  });

  it('creates exactly one ride, in the requested category, with the estimate kept apart from the final fare', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string, north(THAMEL, 300), 'SUV');
    const res = await requestRide(p.accessToken, THAMEL, PATAN, 'SUV');
    expect(res.status).toBe(201);
    const trip = res.body.data;
    expect(trip).toMatchObject({
      status: 'SEARCHING',
      vehicleCategory: { code: 'SUV', label: 'SUV' },
    });
    expect(trip.fare.finalNpr).toBeNull(); // the estimate is not the final fare
    const suv = await getActiveCategoryByCode('SUV');
    const stored = await pool.query('SELECT duration_seconds FROM trips WHERE id = $1', [trip.id]);
    expect(trip.fare.estimateNpr).toBe(
      estimateFare(
        {
          distanceMeters: trip.fare.distanceMeters,
          durationSeconds: stored.rows[0].duration_seconds,
          routeBased: false,
        },
        pricingFor(suv),
      ).totalNpr,
    );
    const rows = await pool.query('SELECT count(*)::int AS n FROM trips WHERE passenger_id = $1', [
      p.user.id,
    ]);
    expect(rows.rows[0].n).toBe(1);
    // a second request is refused, not duplicated
    expect((await requestRide(p.accessToken, THAMEL, PATAN, 'SUV')).status).toBe(409);
  });
});

describe('driver eligibility (matching)', () => {
  async function rig() {
    const car = (await getActiveCategoryByCode('CAR'))!;
    const make = async (
      mutate?: (driverId: string) => Promise<unknown>,
      at = north(THAMEL, 300),
      category: string | null = 'CAR',
    ) => {
      const d = await onboardUser('DRIVER');
      await forceDriverOnline(d.user.id as string, at, category);
      if (mutate) await mutate(d.user.id as string);
      return d.user.id as string;
    };
    const eligible = async () =>
      (await findEligibleDrivers({ pickup: THAMEL, vehicleCategoryId: car.id })).map(
        (c) => c.driverId,
      );
    return { car, make, eligible };
  }

  it('considers only verified, active, online, location-fresh drivers with an approved vehicle of the category', async () => {
    const { make, eligible } = await rig();
    const good = await make();
    const unverified = await make((id) =>
      pool.query("UPDATE driver_profiles SET status = 'UNDER_REVIEW' WHERE user_id = $1", [id]),
    );
    const suspendedAccount = await make((id) =>
      pool.query("UPDATE users SET status = 'SUSPENDED' WHERE id = $1", [id]),
    );
    const offline = await make((id) =>
      pool.query("UPDATE driver_availability SET state = 'OFFLINE' WHERE driver_id = $1", [id]),
    );
    const staleLocation = await make((id) =>
      pool.query(
        "UPDATE driver_last_locations SET recorded_at = now() - interval '10 minutes' WHERE driver_id = $1",
        [id],
      ),
    );
    const noVehicle = await make(undefined, north(THAMEL, 300), null);
    const pendingVehicle = await make((id) =>
      pool.query("UPDATE vehicles SET verification_status = 'PENDING' WHERE driver_user_id = $1", [
        id,
      ]),
    );
    const wrongCategory = await make(undefined, north(THAMEL, 300), 'MOTORCYCLE');
    const tooFar = await make(undefined, north(THAMEL, 20_000));

    const found = await eligible();
    expect(found).toEqual([good]);
    for (const excluded of [
      unverified,
      suspendedAccount,
      offline,
      staleLocation,
      noVehicle,
      pendingVehicle,
      wrongCategory,
      tooFar,
    ]) {
      expect(found).not.toContain(excluded);
    }
  });

  it('excludes a driver already on a ride, or already holding another offer', async () => {
    const { eligible } = await rig();
    const w = await rideWorld(); // its driver is now assigned to a ride, and still online nearby
    const free = await onboardUser('DRIVER');
    await forceDriverOnline(free.user.id as string, north(THAMEL, 300));
    // the assigned driver is online and near, yet not eligible; only the free one is
    expect(await eligible()).toEqual([free.user.id]);
    const p2 = await onboardUser('PASSENGER');
    await requestRide(p2.accessToken);
    expect((await currentOffer(free.accessToken)).body.data).not.toBeNull();
    expect(await eligible()).toEqual([]); // `free` now holds an open offer
    void w;
  });

  it('is ranked by the configured strategy, kept separate from eligibility', async () => {
    const { car, make } = await rig();
    const far = await make(undefined, north(THAMEL, 1500));
    const near = await make(undefined, north(THAMEL, 200));
    const mid = await make(undefined, north(THAMEL, 700));
    const ranked = await matchDrivers({ pickup: THAMEL, vehicleCategoryId: car.id });
    expect(ranked.map((c) => c.driverId)).toEqual([near, mid, far]);
    expect(activeStrategy().name).toBe('proximity');

    // a strategy only orders: it cannot add or drop candidates, and it is a pure function
    const sample = [
      { driverId: 'a', distanceMeters: 500 },
      { driverId: 'b', distanceMeters: 100 },
      { driverId: 'c', distanceMeters: 300 },
    ];
    const req = { pickup: THAMEL, vehicleCategoryId: null };
    const out = proximityStrategy.rank(sample, req);
    expect(out.map((c) => c.driverId)).toEqual(['b', 'c', 'a']);
    expect(sample.map((c) => c.driverId)).toEqual(['a', 'b', 'c']); // input untouched
  });

  it('offers a ride only to drivers of its category, and the offer says which category', async () => {
    const p = await onboardUser('PASSENGER');
    const car = await onboardUser('DRIVER');
    const suv = await onboardUser('DRIVER');
    await forceDriverOnline(car.user.id as string, north(THAMEL, 200), 'CAR');
    await forceDriverOnline(suv.user.id as string, north(THAMEL, 900), 'SUV');
    await requestRide(p.accessToken, THAMEL, PATAN, 'SUV');
    expect((await currentOffer(car.accessToken)).body.data).toBeNull(); // nearer, but wrong category
    const offer = (await currentOffer(suv.accessToken)).body.data;
    expect(offer.vehicleCategory).toEqual({ code: 'SUV', label: 'SUV' });
    expect(JSON.stringify(offer)).not.toMatch(/passenger|phone|userId/i);
  });
});

describe('what the passenger hears while the search runs', () => {
  it('gets Driver found, then Searching for another driver after a decline, then Driver accepted — over the socket', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await onboardUser('DRIVER');
    const b = await onboardUser('DRIVER');
    await forceDriverOnline(a.user.id as string, north(THAMEL, 450));
    await forceDriverOnline(b.user.id as string, north(THAMEL, 900));
    const pc = await login(port, p.accessToken); // listening before the search starts

    const trip = (await requestRide(p.accessToken)).body.data;
    const found = await pc.waitFor(
      (m) => m.type === 'trip_event' && m.event.type === 'DRIVER_REQUESTED',
    );
    expect(describeTripEvent(found.event, 'PASSENGER')).toBe(
      'Driver found, 450 meters away. Waiting for the driver to accept.',
    );
    expect(found.important).toBe(false);
    expect(JSON.stringify(found)).not.toContain(a.user.id);

    const offerA = (await currentOffer(a.accessToken)).body.data;
    await post(a.accessToken, `/offers/${offerA.offerId}/decline`);
    const declined = await pc.waitFor(
      (m) => m.type === 'trip_event' && m.event.type === 'DRIVER_DECLINED',
    );
    expect(describeTripEvent(declined.event, 'PASSENGER')).toBe(
      'That driver could not take your ride. Searching for another driver.',
    );
    const second = await pc.waitFor(
      (m) =>
        m.type === 'trip_event' &&
        m.event.type === 'DRIVER_REQUESTED' &&
        m.event.seq > found.event.seq,
    );
    expect(second.event.payload.pickupDistanceMeters).toBe(900);

    const offerB = (await currentOffer(b.accessToken)).body.data;
    expect((await post(b.accessToken, `/offers/${offerB.offerId}/accept`)).status).toBe(200);
    const accepted = await pc.waitFor(
      (m) => m.type === 'trip_event' && m.event.type === 'DRIVER_ASSIGNED',
    );
    expect(describeTripEvent(accepted.event, 'PASSENGER')).toBe('Driver has accepted your ride.');
    expect(accepted.important).toBe(true);

    // the persisted sequence is exactly this story, gap-free
    const list = await events(p.accessToken, trip.id);
    expect(list.map((e) => e.type)).toEqual([
      'TRIP_REQUESTED',
      'DRIVER_REQUESTED',
      'DRIVER_DECLINED',
      'DRIVER_REQUESTED',
      'DRIVER_ASSIGNED',
    ]);
    expect(list.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('treats an unanswered offer like a decline (reassigns) and ends with No driver available', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await onboardUser('DRIVER');
    await forceDriverOnline(a.user.id as string, north(THAMEL, 300));
    const trip = (await requestRide(p.accessToken)).body.data;
    const offer = (await currentOffer(a.accessToken)).body.data;
    await pool.query(
      "UPDATE trip_offers SET expires_at = now() - interval '1 second' WHERE id = $1",
      [offer.offerId],
    );
    await sweepDispatch(); // expires the offer; nobody else is eligible
    await pool.query(
      "UPDATE trips SET search_deadline_at = now() - interval '1 second' WHERE id = $1",
      [trip.id],
    );
    await sweepDispatch();

    const list = await events(p.accessToken, trip.id);
    expect(list.map((e) => e.type)).toEqual([
      'TRIP_REQUESTED',
      'DRIVER_REQUESTED',
      'DRIVER_DECLINED',
      'NO_DRIVERS_FOUND',
    ]);
    expect(list[2]?.payload.reason).toBe('EXPIRED');
    expect(describeTripEvent(list[2] as never, 'ADMIN')).toBe('Driver did not answer.');
    expect(describeTripEvent(list[3] as never, 'PASSENGER')).toMatch(/no drivers are available/i);
    expect((await get(p.accessToken, `/${trip.id}`)).body.data.status).toBe('NO_DRIVERS');
  });

  it('lets only the driver who won a contested ride keep it (an expired offer cannot be accepted late)', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await onboardUser('DRIVER');
    const b = await onboardUser('DRIVER');
    await forceDriverOnline(a.user.id as string, north(THAMEL, 300));
    await forceDriverOnline(b.user.id as string, north(THAMEL, 900));
    const trip = (await requestRide(p.accessToken)).body.data;
    const offerA = (await currentOffer(a.accessToken)).body.data;
    await pool.query(
      "UPDATE trip_offers SET expires_at = now() - interval '1 second' WHERE id = $1",
      [offerA.offerId],
    );
    await sweepDispatch(); // A's offer expires; B is offered the ride
    const offerB = (await currentOffer(b.accessToken)).body.data;

    const [late, win] = await Promise.all([
      post(a.accessToken, `/offers/${offerA.offerId}/accept`),
      post(b.accessToken, `/offers/${offerB.offerId}/accept`),
    ]);
    expect(late.status).toBe(409);
    expect(win.status).toBe(200);
    const row = await pool.query('SELECT driver_id, status FROM trips WHERE id = $1', [trip.id]);
    expect(row.rows[0]).toMatchObject({ driver_id: b.user.id, status: 'DRIVER_EN_ROUTE' });
    const accepted = await pool.query(
      "SELECT count(*)::int AS n FROM trip_offers WHERE trip_id = $1 AND status = 'ACCEPTED'",
      [trip.id],
    );
    expect(accepted.rows[0].n).toBe(1);
  });
});

describe('cancellation rules and the cancellation record', () => {
  const rules: CancellationRules = { freeSeconds: 120, feeNpr: 50 };
  const at = (secondsAgo: number) => new Date(Date.now() - secondsAgo * 1000);

  it('is one pure decision: free while searching or soon after assignment, a fee later, never mid-ride', () => {
    const now = new Date();
    expect(
      decidePassengerCancellation({ status: 'SEARCHING', matchedAt: null }, now, rules),
    ).toEqual({ allowed: true, feeNpr: 0 });
    expect(
      decidePassengerCancellation({ status: 'DRIVER_EN_ROUTE', matchedAt: at(30) }, now, rules)
        .feeNpr,
    ).toBe(0);
    expect(
      decidePassengerCancellation({ status: 'DRIVER_EN_ROUTE', matchedAt: at(300) }, now, rules)
        .feeNpr,
    ).toBe(50);
    expect(
      decidePassengerCancellation({ status: 'DRIVER_ARRIVED', matchedAt: at(300) }, now, rules)
        .feeNpr,
    ).toBe(50);
    expect(
      decidePassengerCancellation({ status: 'DRIVER_EN_ROUTE', matchedAt: at(300) }, now, {
        ...rules,
        feeNpr: 0,
      }).feeNpr,
    ).toBe(0);
    for (const status of ['IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'NO_DRIVERS'] as const) {
      expect(
        decidePassengerCancellation({ status, matchedAt: at(5) }, now, rules).allowed,
        status,
      ).toBe(false);
    }
  });

  it('records who, why, when, from which state and the fee — for a cancel while searching', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    const trip = (await requestRide(p.accessToken)).body.data;
    expect((await get(p.accessToken, `/${trip.id}`)).body.data.cancelFeeNpr).toBe(0);
    const res = await post(p.accessToken, `/${trip.id}/cancel`, { reason: 'Plans changed' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: 'PASSENGER',
      cancelReason: 'Plans changed',
      cancellation: { fromStatus: 'SEARCHING', feeNpr: 0 },
    });
    const row = await pool.query(
      'SELECT ended_at, cancelled_from_status FROM trips WHERE id = $1',
      [trip.id],
    );
    expect(row.rows[0].ended_at).not.toBeNull();
    expect(row.rows[0].cancelled_from_status).toBe('SEARCHING');
    const ev = (await events(p.accessToken, trip.id)).find((e) => e.type === 'TRIP_CANCELLED');
    expect(ev?.payload).toMatchObject({
      by: 'PASSENGER',
      reason: 'Plans changed',
      fromStatus: 'SEARCHING',
      feeNpr: 0,
    });
    // the open offer was withdrawn
    expect((await currentOffer(d.accessToken)).body.data).toBeNull();
  });

  it('records a fee for a late cancellation, tells the passenger before and after, and not the driver', async () => {
    const w = await rideWorld();
    expect((await get(w.passenger.accessToken, `/${w.tripId}`)).body.data.cancelFeeNpr).toBe(0); // inside the free window
    await backdate(w.tripId, 'matched_at', 600);
    const before = (await get(w.passenger.accessToken, `/${w.tripId}`)).body.data;
    expect(before.cancelFeeNpr).toBe(50);
    expect((await get(w.driver.accessToken, `/${w.tripId}`)).body.data.cancelFeeNpr).toBe(0);

    const res = await post(w.passenger.accessToken, `/${w.tripId}/cancel`, {});
    expect(res.body.data.cancellation).toEqual({ fromStatus: 'DRIVER_EN_ROUTE', feeNpr: 50 });
    const ev = (await events(w.passenger.accessToken, w.tripId)).find(
      (e) => e.type === 'TRIP_CANCELLED',
    )!;
    expect(ev.payload).toMatchObject({ fromStatus: 'DRIVER_EN_ROUTE', feeNpr: 50 });
    expect(describeTripEvent(ev as never, 'PASSENGER')).toContain(
      'A cancellation fee of NPR 50 applies.',
    );
    expect(describeTripEvent(ev as never, 'DRIVER')).not.toMatch(/fee/i);

    const admin = await loginTestAdmin(
      `cancel-${Date.now()}@example.com`,
      'a-strong-test-password-1',
    );
    const detail = (await api.get(`/api/v1/admin/trips/${w.tripId}`).set(auth(admin))).body.data;
    expect(detail).toMatchObject({
      cancelledFromStatus: 'DRIVER_EN_ROUTE',
      cancellationFeeNpr: 50,
      vehicleCategory: { code: 'CAR' },
    });
  });

  it('refuses a cancel mid-ride and a cancel by someone who is not the passenger', async () => {
    const w = await rideWorld();
    const stranger = await onboardUser('PASSENGER');
    expect((await post(stranger.accessToken, `/${w.tripId}/cancel`)).status).toBe(404);
    await pool.query("UPDATE trips SET status = 'IN_PROGRESS', started_at = now() WHERE id = $1", [
      w.tripId,
    ]);
    const res = await post(w.passenger.accessToken, `/${w.tripId}/cancel`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CANNOT_CANCEL_IN_PROGRESS');
  });

  it('sends the ride back to matching when the driver cancels, recording the state it left', async () => {
    const w = await rideWorld();
    const backup = await onboardUser('DRIVER');
    await forceDriverOnline(backup.user.id as string, north(THAMEL, 700));
    const res = await post(w.driver.accessToken, `/${w.tripId}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SEARCHING');
    const ev = (await events(w.passenger.accessToken, w.tripId)).find(
      (e) => e.type === 'DRIVER_REMATCHING',
    )!;
    expect(ev.payload).toMatchObject({ fromStatus: 'DRIVER_EN_ROUTE', reason: 'DRIVER_CANCELLED' });
    expect((await currentOffer(backup.accessToken)).body.data.tripId).toBe(w.tripId);
  });
});

describe('one state machine, one event model', () => {
  it('the machine, the status list and the event tables agree', () => {
    // every status has an entry, terminal states lead nowhere, and CANCELLED is reachable only from live states
    for (const s of TRIP_STATUSES) {
      expect(statusesLeadingTo(s).every((from) => canTripTransition(from, s))).toBe(true);
    }
    for (const terminal of ['COMPLETED', 'CANCELLED', 'NO_DRIVERS'] as const) {
      for (const to of TRIP_STATUSES)
        expect(canTripTransition(terminal, to), `${terminal}->${to}`).toBe(false);
    }
    expect(statusesLeadingTo('CANCELLED').sort()).toEqual(
      ['DRIVER_ARRIVED', 'DRIVER_EN_ROUTE', 'IN_PROGRESS', 'SEARCHING'].sort(),
    );
    expect(statusesLeadingTo('DRIVER_EN_ROUTE')).toEqual(['SEARCHING']); // only a search can assign a driver
    // every event type has metadata and words for every audience
    for (const type of TRIP_EVENT_TYPES) {
      expect(TRIP_EVENT_META[type], type).toBeDefined();
      for (const viewer of ['PASSENGER', 'DRIVER', 'ADMIN'] as const) {
        expect(describeTripEvent({ type, payload: {} }, viewer).length).toBeGreaterThan(3);
      }
    }
    // the category list a passenger sees is the one operations maintain
    return listActiveCategories().then((cs) => expect(cs.length).toBeGreaterThanOrEqual(4));
  });

  it('a passenger can neither fake a status nor act as the driver', async () => {
    const w = await rideWorld();
    for (const path of ['/arrived', '/start', '/complete', '/no-show', '/payment/confirm']) {
      expect((await post(w.passenger.accessToken, `/${w.tripId}${path}`)).status, path).toBe(403);
    }
    const other = await onboardUser('DRIVER');
    for (const path of ['/arrived', '/start', '/complete']) {
      expect((await post(other.accessToken, `/${w.tripId}${path}`)).status, path).toBe(404);
    }
  });
});
