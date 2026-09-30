import { ASSIGNED_TRIP_STATUSES, haversineMeters } from '@yatri/types';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { sqlIn } from '../../lib/sql';
import { availabilityConfig } from '../availability/availability.service';
import { isMatchable, locationFreshness } from '../availability/availability.machine';
import { getLiveFix } from '../availability/presence.state';

/**
 * Driver matching, kept independent of controllers, dispatch scheduling and the apps.
 *
 * Two separate concerns:
 *  1. ELIGIBILITY (`findEligibleDrivers`) decides who may be considered at all. It is the one
 *     definition, also used to say whether a category is available near a pickup:
 *       verified driver · active account · ONLINE with a FRESH location (`isMatchable`, owned by the
 *       availability module) · an APPROVED vehicle of the requested category · not on another ride ·
 *       not holding another open offer · never offered this ride before · inside the radius.
 *  2. RANKING (`MatchingStrategy`) decides in what order eligible drivers are offered the ride.
 *     Only proximity exists today. A new rule (ETA, rating, acceptance history…) is a new strategy
 *     registered below and selected by MATCHING_STRATEGY — nothing else changes.
 *
 * Nothing here is returned to a passenger: callers get driver ids for the dispatcher, or a yes/no
 * for availability. The driver database is never exposed.
 */

export interface MatchRequest {
  pickup: { latitude: number; longitude: number };
  /** Category the ride was requested in; null matches any (legacy rides only). */
  vehicleCategoryId: string | null;
  /** Ride being matched (its earlier offers are excluded); omit when only checking availability. */
  tripId?: string;
}

export interface MatchCandidate {
  driverId: string;
  distanceMeters: number;
}

export interface MatchingStrategy {
  readonly name: string;
  /** Order the eligible drivers, best first. Must not add or remove candidates. */
  rank(candidates: readonly MatchCandidate[], request: MatchRequest): MatchCandidate[];
}

export const proximityStrategy: MatchingStrategy = {
  name: 'proximity',
  rank: (candidates) => [...candidates].sort((a, b) => a.distanceMeters - b.distanceMeters),
};

const STRATEGIES: Record<(typeof env)['MATCHING_STRATEGY'], MatchingStrategy> = {
  proximity: proximityStrategy,
};

export function activeStrategy(): MatchingStrategy {
  return STRATEGIES[env.MATCHING_STRATEGY];
}

/** Every driver who may be offered this ride right now, unranked, each with their live distance. */
export async function findEligibleDrivers(req: MatchRequest): Promise<MatchCandidate[]> {
  const { pickup } = req;
  const cfg = availabilityConfig();
  // Coarse bounding box in SQL (indexed on last-location latitude/longitude); the exact distance
  // and freshness come from the live (Redis) fix below.
  const dLat = env.DISPATCH_RADIUS_METERS / 111_195;
  const dLon = dLat / Math.max(0.2, Math.cos((pickup.latitude * Math.PI) / 180));
  const r = await query<{ driver_id: string }>(
    `SELECT l.driver_id
     FROM driver_availability a
     JOIN driver_last_locations l ON l.driver_id = a.driver_id
     JOIN users u ON u.id = a.driver_id AND u.status = 'ACTIVE'
     JOIN driver_profiles dp ON dp.user_id = a.driver_id AND dp.status = 'VERIFIED'
     WHERE a.state = 'ONLINE'
       AND l.latitude BETWEEN $1 AND $2 AND l.longitude BETWEEN $3 AND $4
       AND l.recorded_at > now() - (($5::int + $6::int) * interval '1 second')
       AND ($8::uuid IS NULL OR EXISTS (
             SELECT 1 FROM vehicles v
             WHERE v.driver_user_id = l.driver_id AND v.category_id = $8
               AND v.verification_status = 'APPROVED'))
       AND NOT EXISTS (SELECT 1 FROM trips t
                       WHERE t.driver_id = l.driver_id AND t.status IN ${sqlIn(ASSIGNED_TRIP_STATUSES)})
       AND ($7::uuid IS NULL OR NOT EXISTS (
             SELECT 1 FROM trip_offers o WHERE o.trip_id = $7 AND o.driver_id = l.driver_id))
       AND NOT EXISTS (SELECT 1 FROM trip_offers o WHERE o.driver_id = l.driver_id AND o.status = 'OFFERED')
     LIMIT 50`,
    [
      pickup.latitude - dLat,
      pickup.latitude + dLat,
      pickup.longitude - dLon,
      pickup.longitude + dLon,
      cfg.freshSeconds,
      cfg.persistSeconds,
      req.tripId ?? null,
      req.vehicleCategoryId,
    ],
  );

  const now = Date.now();
  const out: MatchCandidate[] = [];
  for (const row of r.rows) {
    const live = await getLiveFix(row.driver_id);
    const freshness = locationFreshness(live?.fix.receivedAtMs ?? null, now, cfg.freshSeconds);
    if (!live || !isMatchable('ONLINE', freshness)) continue;
    const distanceMeters = haversineMeters(live.fix, pickup);
    if (distanceMeters <= env.DISPATCH_RADIUS_METERS) {
      out.push({ driverId: row.driver_id, distanceMeters });
    }
  }
  return out;
}

/** Eligible drivers for this ride, best first under the configured strategy. */
export async function matchDrivers(req: MatchRequest): Promise<MatchCandidate[]> {
  return activeStrategy().rank(await findEligibleDrivers(req), req);
}

/** "Is there someone who could take this ride?" — a yes/no, never who or how many. */
export async function isCategoryAvailable(
  pickup: MatchRequest['pickup'],
  vehicleCategoryId: string,
): Promise<boolean> {
  return (await findEligibleDrivers({ pickup, vehicleCategoryId })).length > 0;
}

/**
 * How many drivers could be offered a ride right now, anywhere: the same conditions as
 * `findEligibleDrivers` without a pickup (verified, active, ONLINE, a recent location, not on
 * another ride, no open offer). Counted from the persisted last location, so it can lag the live
 * fix by the persist interval; the operations dashboard says "as of the last saved location".
 * `matching.test.ts` keeps the two definitions in step.
 */
export async function countAvailableDrivers(): Promise<number> {
  const cfg = availabilityConfig();
  const r = await query<{ n: number }>(
    `SELECT count(*)::int AS n
     FROM driver_availability a
     JOIN driver_last_locations l ON l.driver_id = a.driver_id
     JOIN users u ON u.id = a.driver_id AND u.status = 'ACTIVE'
     JOIN driver_profiles dp ON dp.user_id = a.driver_id AND dp.status = 'VERIFIED'
     WHERE a.state = 'ONLINE'
       AND l.recorded_at > now() - (($1::int + $2::int) * interval '1 second')
       AND NOT EXISTS (SELECT 1 FROM trips t
                       WHERE t.driver_id = l.driver_id AND t.status IN ${sqlIn(ASSIGNED_TRIP_STATUSES)})
       AND NOT EXISTS (SELECT 1 FROM trip_offers o WHERE o.driver_id = l.driver_id AND o.status = 'OFFERED')`,
    [cfg.freshSeconds, cfg.persistSeconds],
  );
  return r.rows[0]?.n ?? 0;
}
