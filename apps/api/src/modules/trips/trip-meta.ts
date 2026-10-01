import type { TripMeta } from '../tracking/tracking.service';
import { destinationOf, pickupOf, type TripRow } from './trips.repository';

/**
 * The cached, per-ride facts the live-tracking code reads (who is on the ride, where it goes, when the
 * driver arrived). The database row is the record; this is its cache-shaped view, and it is the ONE place
 * that turns a row into one, both when a status changes and when the cache has been lost and must be
 * rebuilt (`loadMeta` in tracking.service).
 */
export function metaFromRow(t: TripRow): TripMeta {
  return {
    tripId: t.id,
    status: t.status,
    passengerId: t.passenger_id,
    driverId: t.driver_id,
    pickup: pickupOf(t),
    destination: destinationOf(t),
    distanceMeters: t.distance_meters,
    matchedAtMs: t.matched_at?.getTime() ?? null,
    arrivedAtMs: t.arrived_at?.getTime() ?? null,
    passengerNotifiedAtMs: t.passenger_notified_at?.getTime() ?? null,
    driverNotifiedAtMs: null,
    cityId: t.city_id,
  };
}
