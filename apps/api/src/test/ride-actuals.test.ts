import { describeTripEvent, haversineMeters } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { estimateFare, finalFare } from '../modules/pricing/pricing';
import { pricingConfig } from '../modules/pricing/pricing.config';
import { clearLiveState, readOdometerMeters } from '../modules/tracking/tracking.service';
import {
  ODOMETER_MIN_STEP_METERS,
  measuredRideDistance,
  rideDurationSeconds,
} from '../modules/trips/ride-actuals';
import { secondsSince } from '../modules/trips/waiting';
import { api, onboardUser } from './helpers';
import {
  THAMEL,
  arriveAtPickup,
  auth,
  backdate,
  driverAt,
  finalFareFor,
  north,
  rideWorld,
} from './rides';

const post = (token: string, path: string, body: object = {}) =>
  api.post(`/api/v1/trips${path}`).set(auth(token)).send(body);
const get = (token: string, path: string) => api.get(`/api/v1/trips${path}`).set(auth(token));

describe('what a ride measured (pure)', () => {
  it('measures waiting with one function: whole seconds, never negative', () => {
    expect(secondsSince(1_000, 61_999)).toBe(60);
    expect(secondsSince(5_000, 1_000)).toBe(0);
  });

  it('takes the larger of the driven distance and the straight line, and never trusts less than the chord', () => {
    const a = THAMEL;
    const b = north(THAMEL, 1000);
    expect(measuredRideDistance(1400, a, b)).toBe(1400); // a winding route
    expect(measuredRideDistance(300, a, b)).toBe(Math.round(haversineMeters(a, b))); // sparse GPS under-counts
    expect(measuredRideDistance(500, null, b)).toBe(500); // no recorded start: the odometer alone
    expect(measuredRideDistance(0, a, a)).toBe(0);
  });

  it('measures duration from the server start time', () => {
    const start = new Date(1_000_000);
    expect(rideDurationSeconds(start, 1_000_000 + 754_400)).toBe(754);
    expect(rideDurationSeconds(null, 5)).toBe(0);
    expect(rideDurationSeconds(start, 1)).toBe(0); // never negative
  });

  it('prices the final fare with the SAME fare rules as the estimate, plus the waiting charge', () => {
    const cfg = pricingConfig();
    const actual = { distanceMeters: 7300, durationSeconds: 1260 };
    const out = finalFare(actual, cfg, 15);
    expect(out.fare).toEqual(estimateFare({ ...actual, routeBased: false }, cfg));
    expect(out.totalNpr).toBe(out.fare.totalNpr + 15);
    // a longer ride costs more, and the minimum fare still applies to a tiny one
    expect(
      finalFare({ distanceMeters: 12_000, durationSeconds: 1260 }, cfg, 0).totalNpr,
    ).toBeGreaterThan(out.totalNpr - 15);
    expect(finalFare({ distanceMeters: 10, durationSeconds: 5 }, cfg, 0).totalNpr).toBe(
      cfg.minimumNpr,
    );
  });
});

describe('the ride from arrival to completion, with actual data', () => {
  it('records where it started and ended, measures the drive, and prices the final fare from it', async () => {
    const w = await rideWorld();
    const before = (await get(w.passenger.accessToken, `/${w.tripId}`)).body.data;
    expect(before.fare.finalNpr).toBeNull();
    expect(before.fare.actualDistanceMeters).toBeNull();
    const estimate = before.fare.estimateNpr;

    expect((await arriveAtPickup(w)).status).toBe(200);
    await backdate(w.tripId, 'arrived_at', 5 * 60); // the driver waited five minutes
    expect((await post(w.driver.accessToken, `/${w.tripId}/start`)).status).toBe(200);

    // start location = where the server last saw the driver; the odometer starts from zero
    const row0 = (
      await pool.query(
        'SELECT started_latitude, started_longitude, started_at FROM trips WHERE id = $1',
        [w.tripId],
      )
    ).rows[0];
    expect(Number(row0.started_latitude)).toBeCloseTo(north(THAMEL, 20).latitude, 4);
    expect(row0.started_at).not.toBeNull();
    expect(await readOdometerMeters(w.tripId)).toBe(0);

    // drive 1.2 km north in 200 m legs, with two moves too small to count (GPS jitter)
    let last = north(THAMEL, 20);
    for (let i = 1; i <= 6; i++) {
      last = north(THAMEL, 20 + i * 200);
      expect((await driverAt(w.tripId, w.driverId, last)).accepted).toBe(true);
    }
    const nearlyStill = north(THAMEL, 20 + 6 * 200 + ODOMETER_MIN_STEP_METERS - 2);
    expect((await driverAt(w.tripId, w.driverId, nearlyStill)).accepted).toBe(true);
    const driven = await readOdometerMeters(w.tripId);
    expect(driven).toBeGreaterThan(1150);
    expect(driven).toBeLessThan(1250); // the jitter step was not added

    const done = await post(w.driver.accessToken, `/${w.tripId}/complete`);
    expect(done.status).toBe(200);
    const fare = done.body.data.fare;

    // the estimate is untouched; the final fare is a separate figure from measured inputs
    expect(fare.estimateNpr).toBe(estimate);
    expect(fare.actualDistanceMeters).toBeGreaterThanOrEqual(Math.round(driven));
    expect(fare.actualDistanceMeters).toBeLessThan(1300);
    expect(fare.actualDurationSeconds).toBeGreaterThanOrEqual(0);
    expect(fare.waitingChargeNpr).toBeGreaterThan(0);
    expect(fare.finalNpr).toBe(finalFareFor(fare));
    expect(fare.finalNpr).not.toBe(estimate); // priced from what happened, not from the request

    // recorded on the one ride record, with the completion location
    const row = (
      await pool.query(
        'SELECT ended_latitude, ended_longitude, actual_distance_meters, actual_duration_seconds, fare_final_npr, fare_estimate_npr FROM trips WHERE id = $1',
        [w.tripId],
      )
    ).rows[0];
    expect(Number(row.ended_latitude)).toBeCloseTo(nearlyStill.latitude, 4);
    expect(row.actual_distance_meters).toBe(fare.actualDistanceMeters);
    expect(row.fare_final_npr).toBe(fare.finalNpr);
    expect(row.fare_estimate_npr).toBe(estimate);

    // the passenger and the driver both see the same final fare and measurements in their history
    for (const who of [w.passenger, w.driver]) {
      const history = (await get(who.accessToken, '/history')).body.data;
      const item = history.items.find((i: { id: string }) => i.id === w.tripId);
      expect(item.fare).toMatchObject({
        estimateNpr: estimate,
        finalNpr: fare.finalNpr,
        actualDistanceMeters: fare.actualDistanceMeters,
      });
    }
    // the event carries the same numbers, worded per audience
    const ev = (await get(w.passenger.accessToken, `/${w.tripId}/events`)).body.data.find(
      (e: { type: string }) => e.type === 'TRIP_COMPLETED',
    );
    expect(ev.payload).toMatchObject({
      fareNpr: fare.finalNpr,
      distanceMeters: fare.actualDistanceMeters,
    });
    expect(describeTripEvent(ev, 'PASSENGER')).toBe(
      `Your ride is complete. Fare: NPR ${fare.finalNpr}.`,
    );
    expect(describeTripEvent(ev, 'DRIVER')).toBe(`Ride has ended. Fare: NPR ${fare.finalNpr}.`);
    // and the cash payment is for the FINAL fare
    expect((await get(w.passenger.accessToken, `/${w.tripId}/payment`)).body.data.amountNpr).toBe(
      fare.finalNpr,
    );
  });

  it('will not start or finish a ride the server cannot place, and says why', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await clearLiveState(w.tripId); // the driver's position is gone (signal lost long enough)
    const start = await post(w.driver.accessToken, `/${w.tripId}/start`);
    expect(start.status).toBe(409);
    expect(start.body.error.code).toBe('LOCATION_UNAVAILABLE');
    expect((await get(w.driver.accessToken, `/${w.tripId}`)).body.data.status).toBe(
      'DRIVER_ARRIVED',
    );

    await driverAt(w.tripId, w.driverId, north(THAMEL, 20));
    expect((await post(w.driver.accessToken, `/${w.tripId}/start`)).status).toBe(200);
    await clearLiveState(w.tripId);
    const finish = await post(w.driver.accessToken, `/${w.tripId}/complete`);
    expect(finish.status).toBe(409);
    expect(finish.body.error.code).toBe('LOCATION_UNAVAILABLE');
    expect((await get(w.driver.accessToken, `/${w.tripId}`)).body.data.status).toBe('IN_PROGRESS');
  });

  it('lets exactly one of two simultaneous start or complete requests win', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    const starts = await Promise.all(
      [1, 2, 3].map(() => post(w.driver.accessToken, `/${w.tripId}/start`)),
    );
    expect(starts.filter((r) => r.status === 200)).toHaveLength(1);
    expect(starts.filter((r) => r.status === 409)).toHaveLength(2);
    const ends = await Promise.all(
      [1, 2, 3].map(() => post(w.driver.accessToken, `/${w.tripId}/complete`)),
    );
    expect(ends.filter((r) => r.status === 200)).toHaveLength(1);
    const payments = await pool.query(
      'SELECT count(*)::int AS n FROM trip_payments WHERE trip_id = $1',
      [w.tripId],
    );
    expect(payments.rows[0].n).toBe(1);
    const fares = await pool.query('SELECT fare_final_npr FROM trips WHERE id = $1', [w.tripId]);
    expect(fares.rows[0].fare_final_npr).toBeGreaterThan(0);
  });

  it('cannot be started, finished or re-priced by the passenger or a stranger, and never takes a client fare', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    const stranger = await onboardUser('DRIVER');
    for (const path of ['/start', '/complete']) {
      expect((await post(w.passenger.accessToken, `/${w.tripId}${path}`)).status, path).toBe(403);
      expect((await post(stranger.accessToken, `/${w.tripId}${path}`)).status, path).toBe(404);
    }
    // the driver's own request cannot carry a fare, distance or location
    await post(w.driver.accessToken, `/${w.tripId}/start`);
    const forged = await post(w.driver.accessToken, `/${w.tripId}/complete`, {
      fareNpr: 1,
      distanceMeters: 1,
      latitude: 1,
      longitude: 1,
    });
    expect(forged.status).toBe(200); // extra body fields are ignored, not obeyed
    expect(forged.body.data.fare.finalNpr).not.toBe(1);
    const row = (await pool.query('SELECT ended_latitude FROM trips WHERE id = $1', [w.tripId]))
      .rows[0];
    expect(Number(row.ended_latitude)).toBeCloseTo(north(THAMEL, 20).latitude, 4); // where the SERVER saw the driver
  });

  it('cannot go backwards: no restart, no second completion, no cancel of a finished ride', async () => {
    const w = await rideWorld();
    await arriveAtPickup(w);
    await post(w.driver.accessToken, `/${w.tripId}/start`);
    await post(w.driver.accessToken, `/${w.tripId}/complete`);
    for (const path of ['/arrived', '/start', '/complete', '/no-show']) {
      expect((await post(w.driver.accessToken, `/${w.tripId}${path}`)).status, path).toBe(409);
    }
    expect((await post(w.passenger.accessToken, `/${w.tripId}/cancel`)).status).toBe(409);
    expect((await get(w.passenger.accessToken, `/${w.tripId}`)).body.data.status).toBe('COMPLETED');
  });
});

describe('who the passenger sees on the way', () => {
  it('gives the passenger the driver name, photo, vehicle, registration and rating placeholder — and the driver only the passenger name', async () => {
    const w = await rideWorld();
    await pool.query('UPDATE users SET full_name = $2, profile_picture_url = $3 WHERE id = $1', [
      w.driverId,
      'Ram Bahadur',
      'https://files.example/ram.jpg',
    ]);
    await pool.query('UPDATE users SET full_name = $2, profile_picture_url = $3 WHERE id = $1', [
      w.passengerId,
      'Sita Sharma',
      'https://files.example/sita.jpg',
    ]);

    const forPassenger = (await get(w.passenger.accessToken, `/${w.tripId}`)).body.data.counterpart;
    expect(forPassenger).toMatchObject({
      name: 'Ram Bahadur',
      photoUrl: 'https://files.example/ram.jpg',
      rating: null, // the placeholder until ratings exist
      vehicle: { description: 'White Toyota Corolla' },
    });
    expect(forPassenger.vehicle.registrationNumber).toMatch(/^T-/);

    const forDriver = (await get(w.driver.accessToken, `/${w.tripId}`)).body.data.counterpart;
    expect(forDriver.name).toBe('Sita Sharma');
    expect(forDriver.photoUrl).toBeNull();
    expect(forDriver.vehicle).toBeNull();
    expect(JSON.stringify([forPassenger, forDriver])).not.toMatch(/\+977|phone/i);
  });
});
