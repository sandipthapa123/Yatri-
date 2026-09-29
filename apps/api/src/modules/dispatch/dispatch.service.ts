import { ASSIGNED_TRIP_STATUSES, haversineMeters, type TripOfferInfo } from '@yatri/types';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { sqlIn } from '../../lib/sql';
import { HttpError } from '../../middleware/errorHandler';
import { getOrCreateAvailability } from '../availability/availability.repository';
import { availabilityConfig } from '../availability/availability.service';
import { isMatchable, locationFreshness } from '../availability/availability.machine';
import { getLiveFix } from '../availability/presence.state';
import { publishToUser } from '../realtime/bus';
import { getTrip, pickupOf, destinationOf, type TripRow } from '../trips/trips.repository';
import { assignDriver, markNoDrivers } from '../trips/trips.service';
import {
  closeOffer,
  countOffers,
  expireDueOffers,
  getOffer,
  insertOffer,
  openOfferForTrip,
  respondToOffer,
  type OfferRow,
} from './offers.repository';

/**
 * Dispatch: turns a SEARCHING trip into an assigned driver. One offer at a time goes to the
 * nearest eligible driver — ONLINE with a FRESH location (`isMatchable`, the availability
 * module's single definition), inside the configured radius, not already on a trip, not
 * already holding another offer, never offered this trip before. The driver has
 * DISPATCH_OFFER_TTL_SECONDS to accept; declining or timing out moves on to the next driver.
 * The accept race is decided by two guarded UPDATEs (offer, then trip), never by the client.
 */

interface Candidate {
  driverId: string;
  distanceMeters: number;
}

async function findCandidates(trip: TripRow): Promise<Candidate[]> {
  const pickup = pickupOf(trip);
  const cfg = availabilityConfig();
  const dLat = env.DISPATCH_RADIUS_METERS / 111_195;
  const dLon = dLat / Math.max(0.2, Math.cos((pickup.latitude * Math.PI) / 180));
  const r = await query<{ driver_id: string }>(
    `SELECT l.driver_id
     FROM driver_availability a
     JOIN driver_last_locations l ON l.driver_id = a.driver_id
     WHERE a.state = 'ONLINE'
       AND l.latitude BETWEEN $1 AND $2 AND l.longitude BETWEEN $3 AND $4
       AND l.recorded_at > now() - (($5::int + $6::int) * interval '1 second')
       AND NOT EXISTS (SELECT 1 FROM trips t
                       WHERE t.driver_id = l.driver_id AND t.status IN ${sqlIn(ASSIGNED_TRIP_STATUSES)})
       AND NOT EXISTS (SELECT 1 FROM trip_offers o WHERE o.trip_id = $7 AND o.driver_id = l.driver_id)
       AND NOT EXISTS (SELECT 1 FROM trip_offers o WHERE o.driver_id = l.driver_id AND o.status = 'OFFERED')
     LIMIT 50`,
    [
      pickup.latitude - dLat,
      pickup.latitude + dLat,
      pickup.longitude - dLon,
      pickup.longitude + dLon,
      cfg.freshSeconds,
      cfg.persistSeconds,
      trip.id,
    ],
  );

  const now = Date.now();
  const out: Candidate[] = [];
  for (const row of r.rows) {
    // The DB row is a coarse pre-filter; the live (Redis) fix decides freshness and distance.
    const live = await getLiveFix(row.driver_id);
    const freshness = locationFreshness(live?.fix.receivedAtMs ?? null, now, cfg.freshSeconds);
    if (!live || !isMatchable('ONLINE', freshness)) continue;
    const distanceMeters = haversineMeters(live.fix, pickup);
    if (distanceMeters <= env.DISPATCH_RADIUS_METERS)
      out.push({ driverId: row.driver_id, distanceMeters });
  }
  return out.sort((a, b) => a.distanceMeters - b.distanceMeters);
}

function toOfferInfo(o: OfferRow, trip: TripRow): TripOfferInfo {
  return {
    offerId: o.id,
    tripId: trip.id,
    pickup: pickupOf(trip),
    destination: destinationOf(trip),
    pickupDistanceMeters: o.pickup_distance_meters,
    tripDistanceMeters: trip.distance_meters ?? 0,
    fareEstimateNpr: trip.fare_estimate_npr ?? 0,
    expiresAt: o.expires_at.toISOString(),
    serverTime: new Date().toISOString(),
  };
}

export type OfferOutcome = 'offered' | 'waiting' | 'no_drivers' | 'not_searching';

/** Offer the trip to the next best driver (or finish the search). Safe to call repeatedly. */
export async function offerNext(tripId: string): Promise<OfferOutcome> {
  const trip = await getTrip(tripId);
  if (!trip || trip.status !== 'SEARCHING') return 'not_searching';

  if (trip.search_deadline_at && trip.search_deadline_at.getTime() <= Date.now()) {
    await markNoDrivers(tripId);
    return 'no_drivers';
  }
  if (await openOfferForTrip(tripId)) return 'offered'; // one open offer at a time
  if ((await countOffers(tripId)) >= env.DISPATCH_MAX_OFFERS) {
    await markNoDrivers(tripId);
    return 'no_drivers';
  }

  for (const c of (await findCandidates(trip)).slice(0, 5)) {
    const offer = await insertOffer({
      tripId,
      driverId: c.driverId,
      pickupDistanceMeters: c.distanceMeters,
      ttlSeconds: env.DISPATCH_OFFER_TTL_SECONDS,
    });
    if (!offer) continue; // another dispatcher run took this driver: try the next one
    await publishToUser(c.driverId, { type: 'trip_offer', offer: toOfferInfo(offer, trip) });
    return 'offered';
  }
  return 'waiting'; // nobody suitable right now; the sweeper tries again until the deadline
}

/** The driver's current open offer, if any (so a reconnecting app can show it again). */
export async function currentOfferFor(driverId: string): Promise<TripOfferInfo | null> {
  const r = await query<{ id: string }>(
    `SELECT id FROM trip_offers WHERE driver_id = $1 AND status = 'OFFERED' AND expires_at > now()`,
    [driverId],
  );
  const id = r.rows[0]?.id;
  if (!id) return null;
  const offer = await getOffer(id);
  const trip = offer ? await getTrip(offer.trip_id) : null;
  return offer && trip ? toOfferInfo(offer, trip) : null;
}

export async function respondOffer(
  driverId: string,
  offerId: string,
  accept: boolean,
): Promise<{ accepted: boolean; tripId: string }> {
  const offer = await getOffer(offerId);
  if (!offer || offer.driver_id !== driverId) {
    throw new HttpError(404, 'NOT_FOUND', 'Offer not found.');
  }

  if (!accept) {
    const declined = await respondToOffer(offerId, driverId, 'DECLINED');
    if (declined) await offerNext(offer.trip_id);
    return { accepted: false, tripId: offer.trip_id }; // already closed: declining again is harmless
  }

  const availability = await getOrCreateAvailability(driverId);
  if (availability.state !== 'ONLINE') {
    throw new HttpError(409, 'NOT_ONLINE', 'Go online before accepting rides.');
  }
  // 1st guard: the offer must still be open and unexpired.
  const accepted = await respondToOffer(offerId, driverId, 'ACCEPTED');
  if (!accepted) {
    throw new HttpError(409, 'OFFER_EXPIRED', 'This ride offer is no longer available.');
  }
  // 2nd guard: the trip must still be SEARCHING (the passenger may have cancelled meanwhile).
  try {
    await assignDriver(offer.trip_id, driverId);
  } catch (err) {
    await closeOffer(offerId, 'CANCELLED');
    if (err instanceof HttpError && err.status === 409) {
      throw new HttpError(409, 'TRIP_UNAVAILABLE', 'This ride is no longer available.');
    }
    throw err;
  }
  return { accepted: true, tripId: offer.trip_id };
}

export interface DispatchSweepResult {
  expiredOffers: number;
  offered: number;
  noDrivers: number;
}

/** Expire stale offers, re-offer, and end searches that ran out of time. Safe on every instance. */
export async function sweepDispatch(): Promise<DispatchSweepResult> {
  const out: DispatchSweepResult = { expiredOffers: 0, offered: 0, noDrivers: 0 };

  for (const o of await expireDueOffers()) {
    out.expiredOffers++;
    await publishToUser(o.driver_id, {
      type: 'trip_offer_closed',
      offerId: o.id,
      reason: 'EXPIRED',
    });
  }

  const searching = await query<{ id: string }>(
    `SELECT id FROM trips WHERE status = 'SEARCHING' ORDER BY requested_at LIMIT 200`,
  );
  for (const t of searching.rows) {
    const r = await offerNext(t.id);
    if (r === 'offered') out.offered++;
    if (r === 'no_drivers') out.noDrivers++;
  }
  return out;
}
