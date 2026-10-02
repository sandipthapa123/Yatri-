import { pool } from '../config/database';
import { finalFare } from '../modules/pricing/pricing';
import { pricingConfig } from '../modules/pricing/pricing.config';
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

/** The final fare the fare service must produce for what a ride measured (the rule, stated once). */
export const finalFareFor = (fare: {
  actualDistanceMeters: number;
  actualDurationSeconds: number;
  waitingChargeNpr: number;
}) =>
  finalFare(
    { distanceMeters: fare.actualDistanceMeters, durationSeconds: fare.actualDurationSeconds },
    pricingConfig(),
    fare.waitingChargeNpr,
  ).totalNpr;

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * What matching requires of a driver besides being online: a VERIFIED profile on an ACTIVE account
 * and (when `category` is given) an APPROVED vehicle of that category. Pass null to make the
 * driver ineligible for every category.
 */
export async function makeEligibleDriver(driverId: string, category: string | null = 'CAR') {
  await pool.query(
    `INSERT INTO driver_profiles (user_id, status) VALUES ($1, 'VERIFIED')
     ON CONFLICT (user_id) DO UPDATE SET status = 'VERIFIED'`,
    [driverId],
  );
  await pool.query('DELETE FROM vehicles WHERE driver_user_id = $1', [driverId]);
  if (category) {
    await pool.query(
      `INSERT INTO vehicles (driver_user_id, category_id, make, model, year, color,
                             registration_number, verification_status)
       SELECT $1, id, 'Toyota', 'Corolla', 2020, 'White', $3, 'APPROVED'
       FROM vehicle_categories WHERE code = $2`,
      [driverId, category, `T-${driverId.slice(0, 8)}-${Date.now() % 100000}`],
    );
  }
}

/**
 * Puts a driver ONLINE with a fresh location without going through verification. Availability
 * eligibility has its own thorough tests; ride tests just need a matchable driver.
 */
export async function forceDriverOnline(
  driverId: string,
  at: { latitude: number; longitude: number } = north(THAMEL, 300),
  category: string | null = 'CAR',
) {
  await makeEligibleDriver(driverId, category);
  await putDriverOnline(driverId, at);
}

/**
 * Marks a driver ONLINE with a fresh location and changes nothing else about them: for tests of a driver who
 * went through the real verification flow (their own vehicle and documents), which must not be replaced.
 */
export async function putDriverOnline(
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

export const requestRide = (
  token: string,
  pickup = THAMEL,
  destination = PATAN,
  vehicleCategory = 'CAR',
) =>
  api.post('/api/v1/trips/request').set(auth(token)).send({ pickup, destination, vehicleCategory });

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
  extra: { headingDegrees?: number; deltaMs?: number; accuracyMeters?: number } = {},
) {
  simClock = Math.max(simClock, Date.now()) + (extra.deltaMs ?? 20_000);
  return applyLocationUpdate({
    tripId,
    userId: driverId,
    party: 'driver',
    fix: {
      latitude: p.latitude,
      longitude: p.longitude,
      accuracyMeters: extra.accuracyMeters ?? 8,
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
export async function rideWorld(
  existingDriver?: OnboardedUser,
  existingPassenger?: OnboardedUser,
): Promise<RideWorld> {
  const passenger = existingPassenger ?? (await onboardUser('PASSENGER'));
  const driver = existingDriver ?? (await onboardUser('DRIVER'));
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

/** A ride taken to the end: arrived, started, completed and (when `paid`) the driver confirmed the cash. */
export async function finishedRide(paid = true, driver?: OnboardedUser): Promise<RideWorld> {
  const w = await rideWorld(driver);
  await arriveAtPickup(w);
  await api.post(`/api/v1/trips/${w.tripId}/start`).set(auth(w.driver.accessToken));
  await api.post(`/api/v1/trips/${w.tripId}/complete`).set(auth(w.driver.accessToken));
  if (paid)
    await api.post(`/api/v1/trips/${w.tripId}/payment/confirm`).set(auth(w.driver.accessToken));
  return w;
}
