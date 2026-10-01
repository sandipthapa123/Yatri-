import type { TripOfferInfo, TripRequestBody } from '@yatri/types';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { getOrCreateAvailability } from '../availability/availability.repository';
import { publishToUser } from '../realtime/bus';
import { recordTripEvent } from '../trips/trip-events.service';
import {
  getTrip,
  pickupOf,
  destinationOf,
  type BusinessRequest,
  type TripRow,
} from '../trips/trips.repository';
import { assignDriver, markNoDrivers, requestTrip } from '../trips/trips.service';
import { matchDrivers, searchRadius } from './matching';
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
 * Dispatch: turns a SEARCHING trip into an assigned driver. WHO may be offered the ride and in
 * what order is matching.ts (eligibility + the configured ranking strategy); this module only
 * schedules: one offer at a time, DISPATCH_OFFER_TTL_SECONDS to accept, and declining or timing
 * out moves on to the next driver, searching farther each time (`searchRadius`).
 * The accept race is decided by two guarded UPDATEs (offer, then trip), never by the client.
 */

function toOfferInfo(o: OfferRow, trip: TripRow): TripOfferInfo {
  return {
    offerId: o.id,
    tripId: trip.id,
    pickup: pickupOf(trip),
    destination: destinationOf(trip),
    pickupDistanceMeters: o.pickup_distance_meters,
    tripDistanceMeters: trip.distance_meters ?? 0,
    vehicleCategory:
      trip.vehicle_category_code && trip.vehicle_category_label
        ? { code: trip.vehicle_category_code, label: trip.vehicle_category_label }
        : null,
    fareEstimateNpr: trip.fare_estimate_npr ?? 0,
    expiresAt: o.expires_at.toISOString(),
    serverTime: new Date().toISOString(),
  };
}

export type OfferOutcome = 'offered' | 'waiting' | 'no_drivers' | 'not_searching';

/** Offer the trip to the next best driver (or finish the search). Safe to call repeatedly. */
/**
 * A ride request and its first offer, as ONE step: every way of requesting a ride (a rider's own request, a
 * business booking, an approved booking) goes through here, so none can create a ride that is never offered.
 */
export async function requestAndOffer(
  passengerId: string,
  body: TripRequestBody,
  business?: BusinessRequest,
): Promise<TripRow> {
  const trip = await requestTrip(passengerId, body, business);
  await offerNext(trip.id); // the dispatch sweeper carries on from here
  return trip;
}

export async function offerNext(tripId: string): Promise<OfferOutcome> {
  const trip = await getTrip(tripId);
  if (!trip || trip.status !== 'SEARCHING') return 'not_searching';

  if (trip.search_deadline_at && trip.search_deadline_at.getTime() <= Date.now()) {
    await markNoDrivers(tripId);
    return 'no_drivers';
  }
  if (await openOfferForTrip(tripId)) return 'offered'; // one open offer at a time
  const offersSoFar = await countOffers(tripId);
  if (offersSoFar >= env.DISPATCH_MAX_OFFERS) {
    await markNoDrivers(tripId);
    return 'no_drivers';
  }

  // Retry and fallback: every offer that was not taken widens the next search (up to a configured limit),
  // so a ride nobody nearby wants is offered farther out instead of waiting for the deadline.
  const ranked = await matchDrivers({
    tripId,
    pickup: pickupOf(trip),
    vehicleCategoryId: trip.vehicle_category_id,
    radiusMeters: searchRadius(offersSoFar),
  });
  for (const c of ranked.slice(0, 5)) {
    const offer = await insertOffer({
      tripId,
      driverId: c.driverId,
      pickupDistanceMeters: c.distanceMeters,
      ttlSeconds: env.DISPATCH_OFFER_TTL_SECONDS,
    });
    if (!offer) continue; // another dispatcher run took this driver: try the next one
    await publishToUser(c.driverId, { type: 'trip_offer', offer: toOfferInfo(offer, trip) });
    // The passenger hears that a driver was found (a distance only, never who).
    await recordTripEvent({
      tripId,
      type: 'DRIVER_REQUESTED',
      payload: { pickupDistanceMeters: Math.round(c.distanceMeters) },
      dedupeKey: `req:${offer.id}`,
    });
    return 'offered';
  }
  return 'waiting'; // nobody suitable right now; the sweeper tries again until the deadline
}

/** Tell the passenger the driver they were waiting on will not take the ride (only while still searching). */
async function announceOfferLost(tripId: string, offerId: string, reason: 'DECLINED' | 'EXPIRED') {
  const trip = await getTrip(tripId);
  if (!trip || trip.status !== 'SEARCHING') return;
  await recordTripEvent({
    tripId,
    type: 'DRIVER_DECLINED',
    payload: { reason },
    dedupeKey: `dec:${offerId}`,
  });
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
    if (declined) {
      await announceOfferLost(offer.trip_id, offerId, 'DECLINED');
      await offerNext(offer.trip_id);
    }
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
    await announceOfferLost(o.trip_id, o.id, 'EXPIRED');
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
