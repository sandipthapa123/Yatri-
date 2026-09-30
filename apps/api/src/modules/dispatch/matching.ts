import {
  ASSIGNED_TRIP_STATUSES,
  haversineMeters,
  insideCoverage,
  type ZoneDef,
} from '@yatri/types';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { log } from '../../lib/logger';
import { sqlIn } from '../../lib/sql';
import { driversOverLimit } from '../availability/driver-limits';
import { availabilityConfig } from '../availability/availability.service';
import { isMatchable, locationFreshness } from '../availability/availability.machine';
import { getLiveFix } from '../availability/presence.state';
import { activeZones } from '../operations/zones.service';
import { settingNumber } from '../settings/settings.service';
import { estimateEta } from '../tracking/eta';

/**
 * Driver matching, kept independent of controllers, dispatch scheduling and the apps.
 *
 * Two separate concerns:
 *  1. ELIGIBILITY (`findEligibleDrivers`) decides who may be considered at all. It is the one
 *     definition, also used to say whether a category is available near a pickup:
 *       verified driver · active account · ONLINE with a FRESH location (`isMatchable`, owned by the
 *       availability module) · an APPROVED vehicle of the requested category · not on another ride ·
 *       not holding another open offer · never offered this ride before · inside the radius.
 *     Also: inside the service area while one is configured (service zones), and not over a driver
 *     limit (rides per day, time online: `driversOverLimit`).
 *  2. RANKING (`MatchingStrategy`) decides in what order eligible drivers are offered the ride:
 *     `proximity` (nearest first) or `eta_workload` (estimated arrival time plus a penalty for each ride the
 *     driver finished recently, so work is shared). A new rule is a new strategy registered below and
 *     selected by MATCHING_STRATEGY; if a strategy ever fails, matching falls back to proximity.
 *  3. The SEARCH RADIUS (`searchRadius`) starts at DISPATCH_RADIUS_METERS and widens with each offer that
 *     was not taken, up to a configured largest radius (dispatch retry and fallback).
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
  /** How far to look; defaults to the normal radius. Dispatch widens it on retries. */
  radiusMeters?: number;
}

export interface MatchCandidate {
  driverId: string;
  distanceMeters: number;
  /** Estimated seconds for the driver to reach the pickup (from the shared ETA rule and their speed). */
  etaSeconds: number;
  /** Rides the driver finished within the workload window. */
  recentRides: number;
}

/** The search radius for a ride that has already had `offersSoFar` offers: wider each time, capped. */
export function searchRadius(offersSoFar: number): number {
  const base = env.DISPATCH_RADIUS_METERS;
  const widened =
    base * (1 + (settingNumber('DISPATCH_RADIUS_EXPANSION_PERCENT') / 100) * offersSoFar);
  return Math.round(Math.max(base, Math.min(widened, settingNumber('DISPATCH_MAX_RADIUS_METERS'))));
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

/** Arrival time plus a penalty per recent ride; ties go to the nearer, then by id so the order is stable. */
export const etaWorkloadStrategy: MatchingStrategy = {
  name: 'eta_workload',
  rank: (candidates) => {
    const penalty = settingNumber('DISPATCH_WORKLOAD_PENALTY_SECONDS');
    const score = (c: MatchCandidate) => c.etaSeconds + c.recentRides * penalty;
    return [...candidates].sort(
      (a, b) =>
        score(a) - score(b) ||
        a.distanceMeters - b.distanceMeters ||
        a.driverId.localeCompare(b.driverId),
    );
  },
};

const STRATEGIES: Record<(typeof env)['MATCHING_STRATEGY'], MatchingStrategy> = {
  proximity: proximityStrategy,
  eta_workload: etaWorkloadStrategy,
};

export function activeStrategy(): MatchingStrategy {
  return STRATEGIES[env.MATCHING_STRATEGY];
}

/** Every driver who may be offered this ride right now, unranked, each with their live distance. */
export async function findEligibleDrivers(req: MatchRequest): Promise<MatchCandidate[]> {
  const { pickup } = req;
  const radius = req.radiusMeters ?? env.DISPATCH_RADIUS_METERS;
  const cfg = availabilityConfig();
  // Coarse bounding box in SQL (indexed on last-location latitude/longitude); the exact distance
  // and freshness come from the live (Redis) fix below.
  const dLat = radius / 111_195;
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
  const zones: ZoneDef[] = await activeZones();
  const inRange: Array<{ driverId: string; distanceMeters: number; etaSeconds: number }> = [];
  for (const row of r.rows) {
    const live = await getLiveFix(row.driver_id);
    const freshness = locationFreshness(live?.fix.receivedAtMs ?? null, now, cfg.freshSeconds);
    if (!live || !isMatchable('ONLINE', freshness)) continue;
    // A driver who has wandered outside the service area is not offered rides.
    if (!insideCoverage(zones, live.fix)) continue;
    const distanceMeters = haversineMeters(live.fix, pickup);
    if (distanceMeters <= radius) {
      inRange.push({
        driverId: row.driver_id,
        distanceMeters,
        etaSeconds: estimateEta(distanceMeters, live.speedMps).etaSeconds,
      });
    }
  }
  if (inRange.length === 0) return [];

  const ids = inRange.map((c) => c.driverId);
  const [limits, recent] = await Promise.all([
    driversOverLimit(ids),
    query<{ driver_id: string; n: number }>(
      `SELECT driver_id, count(*)::int AS n FROM trips
       WHERE driver_id = ANY($1::uuid[]) AND status = 'COMPLETED'
         AND ended_at > now() - ($2::int * interval '1 minute')
       GROUP BY driver_id`,
      [ids, settingNumber('DISPATCH_WORKLOAD_WINDOW_MINUTES')],
    ),
  ]);
  const recentBy = new Map(recent.rows.map((x) => [x.driver_id, x.n]));
  return inRange
    .filter((c) => !limits.over.has(c.driverId))
    .map((c) => ({ ...c, recentRides: recentBy.get(c.driverId) ?? 0 }));
}

/** Eligible drivers for this ride, best first under the configured strategy. */
export async function matchDrivers(req: MatchRequest): Promise<MatchCandidate[]> {
  const eligible = await findEligibleDrivers(req);
  try {
    return activeStrategy().rank(eligible, req);
  } catch (err) {
    // Fallback: a ranking that fails must never leave a ride without offers.
    log.error(`Matching strategy ${activeStrategy().name} failed; using proximity`, err);
    return proximityStrategy.rank(eligible, req);
  }
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
export async function availableDriverPositions(): Promise<
  Array<{ driverId: string; latitude: number; longitude: number }>
> {
  const cfg = availabilityConfig();
  const r = await query<{ driver_id: string; latitude: number; longitude: number }>(
    `SELECT l.driver_id, l.latitude::float8 AS latitude, l.longitude::float8 AS longitude
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
  return r.rows.map((x) => ({
    driverId: x.driver_id,
    latitude: x.latitude,
    longitude: x.longitude,
  }));
}

export async function countAvailableDrivers(): Promise<number> {
  return (await availableDriverPositions()).length;
}
