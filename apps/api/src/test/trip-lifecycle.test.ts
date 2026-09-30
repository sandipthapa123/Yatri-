import { describe, expect, it } from 'vitest';

import { describeTripEvent } from '@yatri/types';
import { pool } from '../config/database';
import { setLiveFix } from '../modules/availability/presence.state';
import { sweepDispatch } from '../modules/dispatch/dispatch.service';
import { estimateFare } from '../modules/pricing/pricing';
import { pricingConfig } from '../modules/pricing/pricing.config';
import { sweepTrips } from '../modules/trips/trip-maintenance';
import { api, loginTestAdmin, onboardUser } from './helpers';
import {
  PATAN,
  THAMEL,
  acceptCurrentOffer,
  arriveAtPickup,
  auth,
  backdate,
  currentOffer,
  driverAt,
  finalFareFor,
  forceDriverOnline,
  north,
  requestRide,
  rideWorld,
} from './rides';

const get = (token: string, path: string) => api.get(`/api/v1/trips${path}`).set(auth(token));
const post = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/trips${path}`).set(auth(token)).send(body);
const events = async (token: string, id: string, after = 0) =>
  (await get(token, `/${id}/events?after=${after}`)).body.data as Array<{
    seq: number;
    type: string;
    payload: Record<string, unknown>;
  }>;
const status = async (token: string, id: string) =>
  (await get(token, `/${id}`)).body.data.status as string;

async function startedRide() {
  const w = await rideWorld();
  expect((await arriveAtPickup(w)).status).toBe(200);
  expect((await post(w.driver.accessToken, `/${w.tripId}/start`)).status).toBe(200);
  return w;
}
async function completedRide() {
  const w = await startedRide();
  expect((await post(w.driver.accessToken, `/${w.tripId}/complete`)).status).toBe(200);
  return w;
}
async function paidRide() {
  const w = await completedRide();
  expect((await post(w.driver.accessToken, `/${w.tripId}/payment/confirm`)).status).toBe(200);
  return w;
}

describe('fare estimate & ride request', () => {
  it('prices a ride on the server, with a breakdown and the waiting rule', async () => {
    const p = await onboardUser('PASSENGER');
    const res = await post(p.accessToken, '/estimate', {
      pickup: THAMEL,
      destination: PATAN,
      vehicleCategory: 'CAR',
    });
    expect(res.status).toBe(200);
    const fare = res.body.data.fare;
    expect(fare.currency).toBe('NPR');
    expect(fare.totalNpr).toBe(
      Math.max(fare.baseNpr + fare.distanceNpr + fare.timeNpr, pricingConfig().minimumNpr),
    );
    expect(fare.distanceMeters).toBeGreaterThan(4000);
    expect(fare.distanceMeters).toBeLessThan(6000);
    expect(res.body.data.waitingRule).toEqual({ freeSeconds: 180, perMinuteNpr: 5 });
    // exactly what the pure pricing function says for those inputs
    expect(fare).toEqual(
      estimateFare(
        {
          distanceMeters: fare.distanceMeters,
          durationSeconds: fare.durationSeconds,
          routeBased: false,
        },
        pricingConfig(),
      ),
    );
  });

  it('applies the minimum fare to a very short ride', async () => {
    const p = await onboardUser('PASSENGER');
    const res = await post(p.accessToken, '/estimate', {
      pickup: THAMEL,
      destination: { ...north(THAMEL, 200), address: 'Nearby' },
      vehicleCategory: 'CAR',
    });
    expect(res.body.data.fare.minimumFareApplied).toBe(true);
    expect(res.body.data.fare.totalNpr).toBe(pricingConfig().minimumNpr);
  });

  it('never accepts a client-supplied distance, fare or ETA, and validates coordinates', async () => {
    const p = await onboardUser('PASSENGER');
    for (const extra of [{ distanceMeters: 1 }, { fare: 5 }, { etaSeconds: 1 }]) {
      const res = await post(p.accessToken, '/estimate', {
        pickup: THAMEL,
        destination: PATAN,
        vehicleCategory: 'CAR',
        ...extra,
      });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    for (const bad of [
      { pickup: { ...THAMEL, latitude: 91 }, destination: PATAN, vehicleCategory: 'CAR' },
      { pickup: THAMEL, destination: { ...PATAN, longitude: 'x' }, vehicleCategory: 'CAR' },
      {
        pickup: { ...THAMEL, latitude: 0, longitude: 0 },
        destination: PATAN,
        vehicleCategory: 'CAR',
      },
      { pickup: THAMEL, vehicleCategory: 'CAR' },
    ]) {
      expect((await post(p.accessToken, '/estimate', bad)).status).toBe(400);
    }
    expect(
      (
        await post(p.accessToken, '/estimate', {
          pickup: THAMEL,
          destination: THAMEL,
          vehicleCategory: 'CAR',
        })
      ).status,
    ).toBe(422);
  });

  it('is passenger-only and needs sign-in', async () => {
    const d = await onboardUser('DRIVER');
    expect(
      (
        await post(d.accessToken, '/estimate', {
          pickup: THAMEL,
          destination: PATAN,
          vehicleCategory: 'CAR',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api
          .post('/api/v1/trips/request')
          .send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR' })
      ).status,
    ).toBe(401);
  });

  it('creates a SEARCHING trip with the server-calculated fare and a TRIP_REQUESTED event', async () => {
    const p = await onboardUser('PASSENGER');
    const res = await requestRide(p.accessToken);
    expect(res.status).toBe(201);
    const t = res.body.data;
    expect(t).toMatchObject({
      status: 'SEARCHING',
      viewerRole: 'PASSENGER',
      paymentStatus: 'NONE',
      counterpart: null,
    });
    expect(t.fare.estimateNpr).toBeGreaterThan(0);
    expect(t.fare.finalNpr).toBeNull();
    expect((await events(p.accessToken, t.id)).map((e) => e.type)).toEqual(['TRIP_REQUESTED']);
    expect((await get(p.accessToken, '/active')).body.data.id).toBe(t.id);
  });

  it('allows one active ride per passenger', async () => {
    const p = await onboardUser('PASSENGER');
    expect((await requestRide(p.accessToken)).status).toBe(201);
    const again = await requestRide(p.accessToken);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('TRIP_ALREADY_ACTIVE');
  });
});

describe('dispatch (matching)', () => {
  it('offers the nearest eligible driver, one offer at a time, and only trip essentials', async () => {
    const p = await onboardUser('PASSENGER');
    const near = await onboardUser('DRIVER');
    const far = await onboardUser('DRIVER');
    await forceDriverOnline(near.user.id as string, north(THAMEL, 300));
    await forceDriverOnline(far.user.id as string, north(THAMEL, 1800));
    await requestRide(p.accessToken);

    const offer = (await currentOffer(near.accessToken)).body.data;
    expect(offer).toMatchObject({
      pickup: { name: 'Thamel' },
      destination: { name: 'Patan Durbar Square' },
    });
    expect(offer.pickupDistanceMeters).toBeGreaterThan(250);
    expect(offer.pickupDistanceMeters).toBeLessThan(350);
    expect(offer.fareEstimateNpr).toBeGreaterThan(0);
    // No passenger identity leaks into the offer.
    expect(JSON.stringify(offer)).not.toMatch(/passenger|phone|userId/i);
    expect((await currentOffer(far.accessToken)).body.data).toBeNull();
  });

  it('moves to the next driver when the first declines, and never re-offers to the decliner', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await onboardUser('DRIVER');
    const b = await onboardUser('DRIVER');
    await forceDriverOnline(a.user.id as string, north(THAMEL, 300));
    await forceDriverOnline(b.user.id as string, north(THAMEL, 900));
    const trip = (await requestRide(p.accessToken)).body.data;

    const offerA = (await currentOffer(a.accessToken)).body.data;
    const decline = await post(a.accessToken, `/offers/${offerA.offerId}/decline`);
    expect(decline.status).toBe(200);
    expect(decline.body.data.accepted).toBe(false);

    expect((await currentOffer(b.accessToken)).body.data.tripId).toBe(trip.id);
    expect((await currentOffer(a.accessToken)).body.data).toBeNull();
    await sweepDispatch();
    expect((await currentOffer(a.accessToken)).body.data).toBeNull(); // still not re-offered
    // declining twice is harmless
    expect((await post(a.accessToken, `/offers/${offerA.offerId}/decline`)).status).toBe(200);
  });

  it('expires an unanswered offer and offers the ride to the next driver', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await onboardUser('DRIVER');
    const b = await onboardUser('DRIVER');
    await forceDriverOnline(a.user.id as string, north(THAMEL, 300));
    await forceDriverOnline(b.user.id as string, north(THAMEL, 900));
    await requestRide(p.accessToken);
    const offerA = (await currentOffer(a.accessToken)).body.data;

    await pool.query(
      "UPDATE trip_offers SET expires_at = now() - interval '1 second' WHERE id = $1",
      [offerA.offerId],
    );
    const swept = await sweepDispatch();
    expect(swept.expiredOffers).toBe(1);
    expect((await currentOffer(b.accessToken)).body.data).not.toBeNull();
    const late = await post(a.accessToken, `/offers/${offerA.offerId}/accept`);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('OFFER_EXPIRED');
  });

  it('skips drivers who are far, stale, offline, or already on a ride', async () => {
    const p = await onboardUser('PASSENGER');
    const far = await onboardUser('DRIVER');
    const stale = await onboardUser('DRIVER');
    const offline = await onboardUser('DRIVER');
    await forceDriverOnline(far.user.id as string, north(THAMEL, 20_000));
    await forceDriverOnline(stale.user.id as string, north(THAMEL, 200));
    await setLiveFix(stale.user.id as string, {
      fix: {
        latitude: THAMEL.latitude,
        longitude: THAMEL.longitude,
        accuracyMeters: 8,
        deviceTimeMs: 1,
        receivedAtMs: Date.now() - 120_000,
      },
      headingDegrees: null,
      speedMps: null,
    });
    await forceDriverOnline(offline.user.id as string, north(THAMEL, 200));
    await pool.query("UPDATE driver_availability SET state = 'OFFLINE' WHERE driver_id = $1", [
      offline.user.id,
    ]);
    await requestRide(p.accessToken);
    for (const d of [far, stale, offline]) {
      expect((await currentOffer(d.accessToken)).body.data).toBeNull();
    }
  });

  it('gives the ride to exactly one driver when accepts race', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await onboardUser('DRIVER');
    await forceDriverOnline(a.user.id as string);
    const trip = (await requestRide(p.accessToken)).body.data;
    const offer = (await currentOffer(a.accessToken)).body.data;
    const results = await Promise.all([
      post(a.accessToken, `/offers/${offer.offerId}/accept`),
      post(a.accessToken, `/offers/${offer.offerId}/accept`),
      post(a.accessToken, `/offers/${offer.offerId}/accept`),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await status(p.accessToken, trip.id)).toBe('DRIVER_EN_ROUTE');
    const assigned = await pool.query(
      "SELECT count(*)::int AS n FROM trip_events WHERE trip_id = $1 AND type = 'DRIVER_ASSIGNED'",
      [trip.id],
    );
    expect(assigned.rows[0].n).toBe(1);
  });

  it('stays consistent when the passenger cancels while a driver is accepting', async () => {
    for (let i = 0; i < 3; i++) {
      const p = await onboardUser('PASSENGER');
      const d = await onboardUser('DRIVER');
      await forceDriverOnline(d.user.id as string);
      const trip = (await requestRide(p.accessToken)).body.data;
      const offer = (await currentOffer(d.accessToken)).body.data;
      const [accept, cancel] = await Promise.all([
        post(d.accessToken, `/offers/${offer.offerId}/accept`),
        post(p.accessToken, `/${trip.id}/cancel`),
      ]);
      const finalStatus = await status(p.accessToken, trip.id);
      // Either the driver won (then the passenger's cancel of an assigned ride is also valid) or the cancel did.
      expect(['CANCELLED', 'DRIVER_EN_ROUTE']).toContain(finalStatus);
      if (accept.status === 200 && cancel.status === 200) expect(finalStatus).toBe('CANCELLED');
      const active = await pool.query(
        "SELECT count(*)::int AS n FROM trips WHERE id = $1 AND status IN ('SEARCHING','DRIVER_EN_ROUTE')",
        [trip.id],
      );
      expect(active.rows[0].n).toBe(finalStatus === 'CANCELLED' ? 0 : 1);
      await pool.query("UPDATE driver_availability SET state = 'OFFLINE'"); // keep iterations independent
    }
  });

  it('rejects offers for the wrong driver, and needs the driver to be online', async () => {
    const p = await onboardUser('PASSENGER');
    const a = await onboardUser('DRIVER');
    const other = await onboardUser('DRIVER');
    await forceDriverOnline(a.user.id as string);
    await requestRide(p.accessToken);
    const offer = (await currentOffer(a.accessToken)).body.data;
    expect((await post(other.accessToken, `/offers/${offer.offerId}/accept`)).status).toBe(404);
    expect((await post(p.accessToken, `/offers/${offer.offerId}/accept`)).status).toBe(403);
    await pool.query("UPDATE driver_availability SET state = 'OFFLINE' WHERE driver_id = $1", [
      a.user.id,
    ]);
    const res = await post(a.accessToken, `/offers/${offer.offerId}/accept`);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NOT_ONLINE');
  });

  it('ends the search with NO_DRIVERS after the deadline, and lets the passenger try again', async () => {
    const p = await onboardUser('PASSENGER');
    const trip = (await requestRide(p.accessToken)).body.data;
    await pool.query(
      "UPDATE trips SET search_deadline_at = now() - interval '1 second' WHERE id = $1",
      [trip.id],
    );
    const swept = await sweepDispatch();
    expect(swept.noDrivers).toBe(1);
    expect(await status(p.accessToken, trip.id)).toBe('NO_DRIVERS');
    expect((await events(p.accessToken, trip.id)).map((e) => e.type)).toContain('NO_DRIVERS_FOUND');
    expect((await requestRide(p.accessToken)).status).toBe(201);
  });

  it('cancelling during the search closes the open offer', async () => {
    const p = await onboardUser('PASSENGER');
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string);
    const trip = (await requestRide(p.accessToken)).body.data;
    const offer = (await currentOffer(d.accessToken)).body.data;
    expect(
      (await post(p.accessToken, `/${trip.id}/cancel`, { reason: 'Changed my mind' })).status,
    ).toBe(200);
    expect((await currentOffer(d.accessToken)).body.data).toBeNull();
    const res = await post(d.accessToken, `/offers/${offer.offerId}/accept`);
    expect(res.status).toBe(409);
    expect(await status(p.accessToken, trip.id)).toBe('CANCELLED');
  });
});

describe('the ride lifecycle', () => {
  it('assignment gives each side the other party (never a phone number)', async () => {
    const w = await rideWorld();
    const mine = (await get(w.passenger.accessToken, `/${w.tripId}`)).body.data;
    expect(mine).toMatchObject({ status: 'DRIVER_EN_ROUTE', viewerRole: 'PASSENGER' });
    expect(mine.matchedAt).toEqual(expect.any(String));
    expect(JSON.stringify(mine)).not.toMatch(/\+977|phone/i);
    const theirs = (await get(w.driver.accessToken, `/${w.tripId}`)).body.data;
    expect(theirs.viewerRole).toBe('DRIVER');
    expect(JSON.stringify(theirs)).not.toMatch(/\+977|phone/i);
    expect((await events(w.passenger.accessToken, w.tripId)).map((e) => e.type)).toEqual([
      'TRIP_REQUESTED',
      'DRIVER_REQUESTED',
      'DRIVER_ASSIGNED',
    ]);
  });

  it('accepts "arrived" only when the server sees the driver at the pickup', async () => {
    const w = await rideWorld();
    const early = await post(w.driver.accessToken, `/${w.tripId}/arrived`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('NOT_AT_PICKUP');
    await driverAt(w.tripId, w.driverId, north(THAMEL, 900));
    expect((await post(w.driver.accessToken, `/${w.tripId}/arrived`)).status).toBe(409);
    const ok = await arriveAtPickup(w);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('DRIVER_ARRIVED');
    expect(ok.body.data.arrivedAt).toEqual(expect.any(String));
  });

  it('enforces who may do what, and in what order', async () => {
    const w = await rideWorld();
    const stranger = await onboardUser('DRIVER');
    expect((await post(w.passenger.accessToken, `/${w.tripId}/arrived`)).status).toBe(403);
    expect((await post(stranger.accessToken, `/${w.tripId}/arrived`)).status).toBe(404);
    expect((await post(w.driver.accessToken, `/${w.tripId}/start`)).status).toBe(409); // not arrived yet
    expect((await post(w.driver.accessToken, `/${w.tripId}/complete`)).status).toBe(409);
    await arriveAtPickup(w);
    expect((await post(w.driver.accessToken, `/${w.tripId}/arrived`)).status).toBe(409); // twice
    expect((await post(w.driver.accessToken, `/${w.tripId}/complete`)).status).toBe(409); // not started
    expect((await post(w.passenger.accessToken, `/${w.tripId}/start`)).status).toBe(403);
  });

  it('runs a whole ride and records each step once, in order', async () => {
    const w = await completedRide();
    const types = (await events(w.passenger.accessToken, w.tripId)).map((e) => e.type);
    expect(types).toEqual([
      'TRIP_REQUESTED',
      'DRIVER_REQUESTED',
      'DRIVER_ASSIGNED',
      'DRIVER_NEARBY',
      'DRIVER_ARRIVED',
      'TRIP_STARTED',
      'TRIP_COMPLETED',
    ]);
    const seqs = (await events(w.passenger.accessToken, w.tripId)).map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7]); // gap-free for participants
    const t = (await get(w.passenger.accessToken, `/${w.tripId}`)).body.data;
    expect(t.status).toBe('COMPLETED');
    expect(t.fare.finalNpr).toBe(finalFareFor(t.fare));
    expect(t.paymentStatus).toBe('PENDING');
    expect((await post(w.driver.accessToken, `/${w.tripId}/complete`)).status).toBe(409);
  });

  it('lets a client fetch just the events it missed', async () => {
    const w = await completedRide();
    const missed = await events(w.passenger.accessToken, w.tripId, 4);
    expect(missed.map((e) => e.seq)).toEqual([5, 6, 7]);
  });

  it('a passenger cannot cancel a ride that has started; a driver cannot either', async () => {
    const w = await startedRide();
    expect((await post(w.passenger.accessToken, `/${w.tripId}/cancel`)).status).toBe(409);
    expect((await post(w.driver.accessToken, `/${w.tripId}/cancel`)).status).toBe(409);
  });

  it('a passenger can cancel before pickup, with an announced, worded event', async () => {
    const w = await rideWorld();
    const res = await post(w.passenger.accessToken, `/${w.tripId}/cancel`, {
      reason: 'Plans changed',
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: 'PASSENGER',
      cancelReason: 'Plans changed',
    });
    const ev = (await events(w.driver.accessToken, w.tripId)).at(-1)!;
    expect(ev.type).toBe('TRIP_CANCELLED');
    expect(describeTripEvent(ev as never, 'DRIVER')).toBe(
      'The ride was cancelled by the passenger. Reason: Plans changed.',
    );
  });
});

describe('waiting', () => {
  it('shows the passenger waiting while the driver approaches (never charged)', async () => {
    const w = await rideWorld();
    const live = (await get(w.passenger.accessToken, `/${w.tripId}/live`)).body.data;
    expect(live.waiting.passenger).toMatchObject({ seconds: expect.any(Number) });
    expect(live.waiting.driver).toBeNull();
    expect(live.waiting.affectsFare).toBe(false);
    expect(live.waiting.rule).toMatchObject({
      freeSeconds: 180,
      perMinuteNpr: 5,
      noShowAfterSeconds: 300,
    });
    // both sides see the SAME authoritative state
    const driversView = (await get(w.driver.accessToken, `/${w.tripId}/live`)).body.data;
    expect(driversView.waiting.passenger.startedAt).toBe(live.waiting.passenger.startedAt);
  });

  it('shows the driver waiting after arrival, with a start time and whether it affects the fare', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    const p = (await get(w.passenger.accessToken, `/${w.tripId}/live`)).body.data;
    expect(p.status).toBe('DRIVER_ARRIVED');
    expect(p.waiting.driver.startedAt).toEqual(expect.any(String));
    expect(p.waiting.driver.notifiedAt).toEqual(expect.any(String)); // the passenger was told
    expect(p.waiting.passenger).toBeNull();
    expect(p.waiting.affectsFare).toBe(false); // still inside the free period

    await backdate(w.tripId, 'arrived_at', 250);
    const later = (await get(w.driver.accessToken, `/${w.tripId}/live`)).body.data;
    expect(later.waiting.driver.seconds).toBeGreaterThanOrEqual(249);
    expect(later.waiting).toMatchObject({
      affectsFare: true,
      chargeableSeconds: expect.any(Number),
    });
    expect(later.waiting.chargeableSeconds).toBeGreaterThanOrEqual(69);
    expect(later.waiting.chargeNpr).toBe(10); // two started minutes beyond the free three
  });

  it('notifies the other party at each waiting milestone, once, with the right words', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await pool.query("UPDATE trips SET arrived_at = now() - interval '250 seconds' WHERE id = $1", [
      w.tripId,
    ]);

    const first = await sweepTrips();
    expect(first.waitingEvents).toBe(1);
    const ev = (await events(w.passenger.accessToken, w.tripId)).find(
      (e) => e.type === 'DRIVER_WAITING',
    )!;
    expect(ev.payload.seconds).toBe(240);
    expect(describeTripEvent(ev as never, 'PASSENGER')).toBe(
      'Your driver has been waiting for 4 minutes.',
    );
    expect(describeTripEvent(ev as never, 'DRIVER')).toBe('You have been waiting for 4 minutes.');

    expect((await sweepTrips()).waitingEvents).toBe(0); // no repeat
    await pool.query("UPDATE trips SET arrived_at = now() - interval '370 seconds' WHERE id = $1", [
      w.tripId,
    ]);
    expect((await sweepTrips()).waitingEvents).toBe(1);
    const p = (await get(w.passenger.accessToken, `/${w.tripId}/live`)).body.data;
    expect(p.waiting.driver.notifiedAt).toEqual(expect.any(String));
  });

  it('tells the driver when the passenger has been waiting for them', async () => {
    const w = await rideWorld();
    await pool.query("UPDATE trips SET matched_at = now() - interval '190 seconds' WHERE id = $1", [
      w.tripId,
    ]);
    expect((await sweepTrips()).waitingEvents).toBe(1);
    const ev = (await events(w.driver.accessToken, w.tripId)).find(
      (e) => e.type === 'PASSENGER_WAITING',
    )!;
    expect(describeTripEvent(ev as never, 'PASSENGER')).toBe(
      'You have been waiting for 2 minutes.',
    );
    expect(describeTripEvent(ev as never, 'DRIVER')).toBe(
      'The passenger has been waiting for 2 minutes.',
    );
    const live = (await get(w.passenger.accessToken, `/${w.tripId}/live`)).body.data;
    expect(live.waiting.passenger.notifiedAt).toEqual(expect.any(String));
  });

  it('adds the waiting charge to the fare when the ride starts (server timestamps only)', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await pool.query("UPDATE trips SET arrived_at = now() - interval '480 seconds' WHERE id = $1", [
      w.tripId,
    ]);
    const started = await post(w.driver.accessToken, `/${w.tripId}/start`);
    expect(started.body.data.fare.waitingChargeNpr).toBe(25); // (480-180)s = 5 min x NPR 5
    const done = await post(w.driver.accessToken, `/${w.tripId}/complete`);
    expect(done.body.data.fare.waitingChargeNpr).toBe(25);
    expect(done.body.data.fare.finalNpr).toBe(finalFareFor(done.body.data.fare));
    const payment = (await get(w.passenger.accessToken, `/${w.tripId}/payment`)).body.data;
    expect(payment.amountNpr).toBe(done.body.data.fare.finalNpr);
  });

  it('lets a driver report a no-show only after the configured wait', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    const early = await post(w.driver.accessToken, `/${w.tripId}/no-show`);
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('NO_SHOW_TOO_EARLY');
    await pool.query("UPDATE trips SET arrived_at = now() - interval '6 minutes' WHERE id = $1", [
      w.tripId,
    ]);
    const ok = await post(w.driver.accessToken, `/${w.tripId}/no-show`);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: 'DRIVER',
      cancelReason: 'PASSENGER_NO_SHOW',
    });
    expect((await post(w.passenger.accessToken, `/${w.tripId}/no-show`)).status).toBe(403);
  });
});

describe('re-matching', () => {
  it('sends a ride back to the search when the driver cancels, and offers it to someone else', async () => {
    const w = await rideWorld();
    const backup = await onboardUser('DRIVER');
    await forceDriverOnline(backup.user.id as string, north(THAMEL, 700));

    const res = await post(w.driver.accessToken, `/${w.tripId}/cancel`);
    expect(res.status).toBe(200);
    const t = (await get(w.passenger.accessToken, `/${w.tripId}`)).body.data;
    expect(t).toMatchObject({ status: 'SEARCHING', counterpart: null });
    const types = (await events(w.passenger.accessToken, w.tripId)).map((e) => e.type);
    expect(types).toContain('DRIVER_REMATCHING');
    expect(describeTripEvent({ type: 'DRIVER_REMATCHING', payload: {} }, 'PASSENGER')).toBe(
      'Your driver is no longer available. Finding you another driver.',
    );

    expect((await currentOffer(backup.accessToken)).body.data.tripId).toBe(w.tripId);
    expect((await currentOffer(w.driver.accessToken)).body.data).toBeNull(); // not re-offered to the one who left
    // the old driver is free again
    expect((await get(w.driver.accessToken, '/active')).body.data).toBeNull();
    expect((await acceptCurrentOffer(backup.accessToken)).status).toBe(200);
    expect(await status(w.passenger.accessToken, w.tripId)).toBe('DRIVER_EN_ROUTE');
  });

  it('replaces an assigned driver who went unreachable', async () => {
    const w = await rideWorld();
    const backup = await onboardUser('DRIVER');
    await forceDriverOnline(backup.user.id as string, north(THAMEL, 700));
    await pool.query(
      "UPDATE driver_availability SET state = 'UNAVAILABLE', state_changed_at = now() - interval '10 minutes' WHERE driver_id = $1",
      [w.driverId],
    );
    const swept = await sweepTrips();
    expect(swept.rematched).toContain(w.tripId);
    const reason = (await events(w.passenger.accessToken, w.tripId)).find(
      (e) => e.type === 'DRIVER_REMATCHING',
    )!;
    expect(reason.payload.reason).toBe('DRIVER_LOST');
    expect((await currentOffer(backup.accessToken)).body.data.tripId).toBe(w.tripId);
  });
});

describe('payment, rating, disputes, history', () => {
  it('only the driver can settle a cash payment, and only after the ride ends; it is idempotent', async () => {
    const w = await startedRide();
    expect((await post(w.driver.accessToken, `/${w.tripId}/payment/confirm`)).status).toBe(409); // ride not over yet
    await post(w.driver.accessToken, `/${w.tripId}/complete`);
    expect((await post(w.passenger.accessToken, `/${w.tripId}/payment/confirm`)).status).toBe(403);
    expect((await get(w.passenger.accessToken, `/${w.tripId}/payment`)).body.data.status).toBe(
      'PENDING',
    );
    const paid = await post(w.driver.accessToken, `/${w.tripId}/payment/confirm`);
    expect(paid.status).toBe(200);
    expect(paid.body.data).toMatchObject({ status: 'PAID', method: 'CASH' });
    expect((await post(w.driver.accessToken, `/${w.tripId}/payment/confirm`)).status).toBe(200);
    const paidEvents = (await events(w.passenger.accessToken, w.tripId)).filter(
      (e) => e.type === 'PAYMENT_RECEIVED',
    );
    expect(paidEvents).toHaveLength(1);
    expect(describeTripEvent(paidEvents[0] as never, 'PASSENGER')).toMatch(
      /^Payment of NPR \d+ received\.$/,
    );
    expect((await get(w.passenger.accessToken, `/${w.tripId}`)).body.data.paymentStatus).toBe(
      'PAID',
    );
  });

  it('opens ratings when the ride is completed (not before, not gated on payment), one per person, 1 to 5 stars', async () => {
    const running = await startedRide();
    const early = await post(running.passenger.accessToken, `/${running.tripId}/rating`, {
      stars: 5,
    });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('TRIP_NOT_COMPLETED');

    const w = await completedRide(); // the cash has NOT been confirmed: rating is open anyway
    expect((await get(w.passenger.accessToken, `/${w.tripId}`)).body.data.paymentStatus).toBe(
      'PENDING',
    );

    for (const bad of [
      { stars: 0 },
      { stars: 6 },
      { stars: 4.5 },
      { stars: 'five' },
      { stars: 3, extra: 1 },
    ]) {
      expect(
        (await post(w.passenger.accessToken, `/${w.tripId}/rating`, bad)).status,
        JSON.stringify(bad),
      ).toBe(400);
    }
    expect(
      (
        await post(w.passenger.accessToken, `/${w.tripId}/rating`, {
          stars: 5,
          comment: 'Great ride',
        })
      ).status,
    ).toBe(201);
    const twice = await post(w.passenger.accessToken, `/${w.tripId}/rating`, { stars: 1 });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('ALREADY_RATED');
    expect((await post(w.driver.accessToken, `/${w.tripId}/rating`, { stars: 4 })).status).toBe(
      201,
    );
    expect((await get(w.passenger.accessToken, `/${w.tripId}`)).body.data.rated).toBe(true);
    const stranger = await onboardUser('PASSENGER');
    expect((await post(stranger.accessToken, `/${w.tripId}/rating`, { stars: 5 })).status).toBe(
      404,
    );
  });

  it('shows the average rating on the next ride', async () => {
    const w = await paidRide();
    await post(w.passenger.accessToken, `/${w.tripId}/rating`, { stars: 5 });
    const passenger2 = await onboardUser('PASSENGER');
    await forceDriverOnline(w.driverId);
    await requestRide(passenger2.accessToken);
    await acceptCurrentOffer(w.driver.accessToken);
    const t = (await get(passenger2.accessToken, '/active')).body.data;
    expect(t.counterpart.rating).toBe(5);
  });

  it('lets a participant open one dispute at a time; strangers cannot', async () => {
    const w = await completedRide();
    expect(
      (await post(w.passenger.accessToken, `/${w.tripId}/disputes`, { reason: 'x' })).status,
    ).toBe(400);
    const d = await post(w.passenger.accessToken, `/${w.tripId}/disputes`, {
      reason: 'The fare was higher than quoted',
    });
    expect(d.status).toBe(201);
    expect(d.body.data).toMatchObject({ status: 'OPEN', tripId: w.tripId });
    expect(
      (
        await post(w.passenger.accessToken, `/${w.tripId}/disputes`, {
          reason: 'Another problem entirely',
        })
      ).status,
    ).toBe(409);
    expect((await get(w.passenger.accessToken, `/${w.tripId}/disputes`)).body.data).toHaveLength(1);
    expect((await get(w.driver.accessToken, `/${w.tripId}/disputes`)).body.data).toHaveLength(0); // yours only
    const stranger = await onboardUser('DRIVER');
    expect(
      (await post(stranger.accessToken, `/${w.tripId}/disputes`, { reason: 'Not my ride at all' }))
        .status,
    ).toBe(404);
    // no dispute on a search that never found a driver
    const p = await onboardUser('PASSENGER');
    const searching = (await requestRide(p.accessToken)).body.data;
    expect(
      (await post(p.accessToken, `/${searching.id}/disputes`, { reason: 'Nothing happened yet' }))
        .status,
    ).toBe(409);
  });

  it('lists each person’s finished rides, newest first, paginated', async () => {
    const w = await paidRide();
    const p = (await get(w.passenger.accessToken, '/history')).body.data;
    expect(p.total).toBe(1);
    expect(p.items[0]).toMatchObject({
      id: w.tripId,
      status: 'COMPLETED',
      paymentStatus: 'PAID',
      viewerRole: 'PASSENGER',
    });
    const d = (await get(w.driver.accessToken, '/history')).body.data;
    expect(d.items[0]).toMatchObject({ id: w.tripId, viewerRole: 'DRIVER' });
    const stranger = await onboardUser('PASSENGER');
    expect((await get(stranger.accessToken, '/history')).body.data).toEqual({
      items: [],
      total: 0,
    });
    expect((await get(w.passenger.accessToken, '/history?pageSize=500')).status).toBe(400);
    expect((await get(w.passenger.accessToken, '/history?page=0')).status).toBe(400);
    // an active ride is not history
    const active = await onboardUser('PASSENGER');
    await requestRide(active.accessToken);
    expect((await get(active.accessToken, '/history')).body.data.total).toBe(0);
  });
});

describe('privacy: trips belong to their participants', () => {
  it('hides every trip endpoint from other people (404, not 403)', async () => {
    const w = await paidRide();
    const stranger = await onboardUser('PASSENGER');
    const strangerDriver = await onboardUser('DRIVER');
    for (const token of [stranger.accessToken, strangerDriver.accessToken]) {
      for (const path of ['', '/live', '/events', '/payment', '/disputes']) {
        expect((await get(token, `/${w.tripId}${path}`)).status, path).toBe(404);
      }
      expect((await post(token, `/${w.tripId}/cancel`)).status).toBe(404);
      expect((await post(token, `/${w.tripId}/rating`, { stars: 5 })).status).toBe(404);
    }
    expect((await api.get(`/api/v1/trips/${w.tripId}`)).status).toBe(401);
    expect((await get(stranger.accessToken, '/not-a-uuid')).status).toBe(400);
  });

  it('shows admins no trip through passenger/driver endpoints either', async () => {
    const w = await rideWorld();
    const admin = await loginTestAdmin(
      `peek-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );
    expect((await get(admin, `/${w.tripId}`)).status).toBe(403); // trips router is for passengers/drivers
  });
});
