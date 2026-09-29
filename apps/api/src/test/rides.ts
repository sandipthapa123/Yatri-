import { pool } from '../config/database';
import { getRedisClient } from '../config/redis';
import { setLiveFix, setStateMirror } from '../modules/availability/presence.state';
import { applyLocationUpdate, saveMeta } from '../modules/tracking/tracking.service';
import { getTrip } from '../modules/trips/trips.repository';
import { metaFromRow } from '../modules/trips/trips.service';
import type { Response as SupertestResponse } from 'supertest';

import { api, onboardUser, type OnboardedUser } from './helpers';

export const THAMEL = {
  latitude: 27.7154,
  longitude: 85.3123,
  address: 'Thamel, Kathmandu',
  name: 'Thamel',
};
export const PATAN = {
  latitude: 27.6727,
  longitude: 85.325,
  address: 'Patan Durbar Square, Lalitpur',
  name: 'Patan Durbar Square',
};

/** A point `meters` due north of `p` (1° latitude ≈ 111 195 m). */
export const north = (p: { latitude: number; longitude: number }, meters: number) => ({
  latitude: p.latitude + meters / 111_195,
  longitude: p.longitude,
});

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * Puts a driver ONLINE with a fresh location without going through verification. Availability
 * eligibility has its own thorough tests; ride tests just need a matchable driver.
 */
export async function forceDriverOnline(
  driverId: string,
  at: { latitude: number; longitude: number } = north(THAMEL, 300),
) {
  await pool.query(
    `INSERT INTO driver_availability (driver_id, state, online_since) VALUES ($1, 'ONLINE', now())
     ON CONFLICT (driver_id) DO UPDATE SET state = 'ONLINE', online_since = now()`,
    [driverId],
  );
  await setStateMirror(driverId, 'ONLINE');
  const now = Date.now();
  await setLiveFix(driverId, {
    fix: {
      latitude: at.latitude,
      longitude: at.longitude,
      accuracyMeters: 8,
      deviceTimeMs: now,
      receivedAtMs: now,
    },
    headingDegrees: null,
    speedMps: null,
  });
  await pool.query(
    `INSERT INTO driver_last_locations (driver_id, latitude, longitude, accuracy_meters, recorded_at)
     VALUES ($1, $2, $3, 8, now())
     ON CONFLICT (driver_id) DO UPDATE SET latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude, accuracy_meters = 8, recorded_at = now()`,
    [driverId, at.latitude, at.longitude],
  );
}

export const requestRide = (token: string, pickup = THAMEL, destination = PATAN) =>
  api.post('/api/v1/trips/request').set(auth(token)).send({ pickup, destination });

export const currentOffer = (token: string) =>
  api.get('/api/v1/trips/offers/current').set(auth(token));

export async function acceptCurrentOffer(driverToken: string): Promise<SupertestResponse> {
  const offer = await currentOffer(driverToken);
  if (!offer.body.data) throw new Error('no current offer');
  return api.post(`/api/v1/trips/offers/${offer.body.data.offerId}/accept`).set(auth(driverToken));
}

let simClock = Date.now();
/**
 * Feeds a driver position straight into the trip (what presence does for a real device). Time is
 * simulated so a realistic move ("900 m in 20 s") is expressible without waiting.
 */
export async function driverAt(
  tripId: string,
  driverId: string,
  p: { latitude: number; longitude: number },
  extra: { headingDegrees?: number; deltaMs?: number } = {},
) {
  simClock = Math.max(simClock, Date.now()) + (extra.deltaMs ?? 20_000);
  return applyLocationUpdate({
    tripId,
    userId: driverId,
    party: 'driver',
    fix: {
      latitude: p.latitude,
      longitude: p.longitude,
      accuracyMeters: 8,
      deviceTimeMs: simClock,
    },
    headingDegrees: extra.headingDegrees ?? null,
    nowMs: simClock,
  });
}

export interface RideWorld {
  passenger: OnboardedUser;
  driver: OnboardedUser;
  tripId: string;
  passengerId: string;
  driverId: string;
}

/** A passenger requests a ride and a nearby online driver accepts it: trip is DRIVER_EN_ROUTE. */
export async function rideWorld(): Promise<RideWorld> {
  const passenger = await onboardUser('PASSENGER');
  const driver = await onboardUser('DRIVER');
  await forceDriverOnline(driver.user.id as string);
  const req = await requestRide(passenger.accessToken);
  if (req.status !== 201) throw new Error(`request failed ${JSON.stringify(req.body)}`);
  const acc = await acceptCurrentOffer(driver.accessToken);
  if (acc.status !== 200) throw new Error(`accept failed ${JSON.stringify(acc.body)}`);
  return {
    passenger,
    driver,
    tripId: req.body.data.id as string,
    passengerId: passenger.user.id as string,
    driverId: driver.user.id as string,
  };
}

/** Moves the driver onto the pickup so "I have arrived" is accepted, then marks arrival. */
export async function arriveAtPickup(w: RideWorld): Promise<SupertestResponse> {
  await driverAt(w.tripId, w.driverId, north(THAMEL, 20));
  return api.post(`/api/v1/trips/${w.tripId}/arrived`).set(auth(w.driver.accessToken));
}

/** Pretend a moment happened `seconds` ago (DB timestamp + the cached meta both read it). */
export async function backdate(
  tripId: string,
  column: 'arrived_at' | 'matched_at',
  seconds: number,
) {
  await pool.query(
    `UPDATE trips SET ${column} = now() - ($2::int * interval '1 second') WHERE id = $1`,
    [tripId, seconds],
  );
  const row = await getTrip(tripId);
  if (row) await saveMeta(metaFromRow(row));
}

export async function clearRedis() {
  await getRedisClient().flushdb();
}
