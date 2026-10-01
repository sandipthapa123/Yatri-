import {
  approachPhase,
  haversineMeters,
  isDestinationMilestone,
  nearestOnPolyline,
  polylineLengthMeters,
  simplifyPolyline,
  directionWord,
  maneuverSentence,
  type ApproachPhase,
  type NavigationGuidance,
  type NavigationRoute,
  type NavigationStepProgress,
  type NavigationTarget,
  type NavigationThresholds,
  type RoutePoint,
  type RouteStep,
} from '@yatri/types';

import { getRedisClient } from '../../config/redis';
import { query } from '../../lib/db';
import { log } from '../../lib/logger';
import { getRouteProvider } from '../location/providers';
import { settingNumber } from '../settings/settings.service';
import { computeEta, estimateEta, planRoute } from '../tracking/eta';
import type { StoredFix } from '../tracking/tracking.rules';
import type { TripMeta } from '../tracking/tracking.service';
import { recordTripEvent } from '../trips/trip-events.service';

/**
 * Navigation for an active ride. It owns exactly four things and nothing else:
 *  1. the planned ROUTE for the ride's current target (pickup, then destination), planned through the existing
 *     RouteProvider abstraction (one call gives the route and the ETA; the tracking snapshot reads it from here);
 *  2. DEVIATION detection: several accurate readings in a row beyond a distance from the route (never one stray
 *     reading, never a poor reading), and a new route when that is confirmed, no more often than a set interval;
 *  3. the PHASE of the approach (approaching / near / at the pickup, leaving it, approaching / near / at the
 *     destination) from the one pure rule in @yatri/types, with milestone events at the destination;
 *  4. a few daily COUNTERS for the admin screen.
 * Positions come from the existing tracking pipeline (accepted fixes only); distances from @yatri/types geo; fares are
 * not touched here (the backend's fare engine alone prices a ride). Everything lives in Redis only while the ride is
 * active and is deleted with it; counts of deviations and new routes are kept on the ride, coordinates never.
 */

const STATE_TTL_SECONDS = 6 * 60 * 60;
/** A route this long on the wire is plenty for a phone; the line is simplified to within a few metres of itself. */
const GEOMETRY_TOLERANCE_METERS = 5;
const GEOMETRY_MAX_POINTS = 400;
/** A route that follows live traffic gets its duration refreshed this often (without a new route version). */
const TRAFFIC_REFRESH_MS = 60_000;

const k = {
  route: (id: string) => `nav:${id}:route`,
  state: (id: string) => `nav:${id}:state`,
};

export const NAV_METRICS = {
  ROUTES_PLANNED: 'ROUTES_PLANNED',
  ROUTE_FALLBACKS: 'ROUTE_FALLBACKS',
  DEVIATIONS_CONFIRMED: 'DEVIATIONS_CONFIRMED',
  REROUTES: 'REROUTES',
  ARRIVALS_AT_PICKUP: 'ARRIVALS_AT_PICKUP',
  ARRIVALS_AT_DESTINATION: 'ARRIVALS_AT_DESTINATION',
} as const;
export type NavMetric = (typeof NAV_METRICS)[keyof typeof NAV_METRICS];

/** The thresholds, from the platform settings (one place; the pure rules hold no numbers). */
export function navigationThresholds(): NavigationThresholds {
  return {
    approachingMeters: settingNumber('NAV_APPROACHING_METERS'),
    nearMeters: settingNumber('NAV_NEAR_METERS'),
    atMeters: settingNumber('NAV_AT_METERS'),
    leavingMeters: settingNumber('NAV_LEAVING_METERS'),
    deviationMeters: settingNumber('NAV_DEVIATION_METERS'),
    deviationConfirmFixes: settingNumber('NAV_DEVIATION_CONFIRM_FIXES'),
    maxAccuracyMeters: settingNumber('NAV_MAX_ACCURACY_METERS'),
    rerouteMinSeconds: settingNumber('NAV_REROUTE_MIN_SECONDS'),
  };
}

// ---------------------------------------------------------------- stored shapes

interface StoredRoute extends NavigationRoute {
  /** True when the line follows roads (the provider returned geometry); false for a two-point straight guide. */
  hasGeometry: boolean;
  /** Metres along the line at which each step's maneuver happens. */
  stepAlong: number[];
  /** The length of the line, for progress. */
  lineMeters: number;
  /** Straight-line distance from where it was planned to the target (the scale for a straight-line ETA). */
  straightAtPlanMeters: number;
  durationRefreshedAtMs: number;
}

interface NavState {
  target: NavigationTarget;
  offFixes: number;
  offRoute: boolean;
  deviationMeters: number | null;
  episodeCounted: boolean;
  lastPlanAtMs: number;
  phase: ApproachPhase | null;
  pickupArrivalCounted: boolean;
  destinationArrivalCounted: boolean;
  destinationRank: number;
  remainingMeters: number;
  etaSeconds: number | null;
  next: NavigationStepProgress | null;
}

async function getJson<T>(key: string): Promise<T | null> {
  const raw = await getRedisClient().get(key);
  return raw ? (JSON.parse(raw) as T) : null;
}
async function setJson(key: string, value: unknown) {
  await getRedisClient().set(key, JSON.stringify(value), 'EX', STATE_TTL_SECONDS);
}

export async function recordNavMetric(metric: NavMetric, by = 1): Promise<void> {
  try {
    await query(
      `INSERT INTO navigation_metrics (day, metric, value) VALUES (current_date, $1, $2)
       ON CONFLICT (day, metric) DO UPDATE SET value = navigation_metrics.value + EXCLUDED.value`,
      [metric, by],
    );
  } catch (err) {
    log.warn('Could not record a navigation metric', err);
  }
}

export async function clearNavigation(tripId: string): Promise<void> {
  await getRedisClient().del(k.route(tripId), k.state(tripId));
}

export const targetOf = (meta: Pick<TripMeta, 'status'>): NavigationTarget | null =>
  meta.status === 'DRIVER_EN_ROUTE'
    ? 'PICKUP'
    : meta.status === 'IN_PROGRESS'
      ? 'DESTINATION'
      : null;

// ---------------------------------------------------------------- planning

const toPoint = (p: { latitude: number; longitude: number }): RoutePoint => [
  p.latitude,
  p.longitude,
];

/** The steps of a straight-line guide, for when no routing engine answered: said honestly as a direction. */
function straightGuide(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  distanceMeters: number,
  durationSeconds: number,
  targetName: string,
): RouteStep[] {
  return [
    {
      instruction: `Head ${directionWord(from, to)} toward ${targetName}.`,
      maneuver: 'depart',
      distanceMeters,
      durationSeconds,
      road: null,
      location: toPoint(from),
    },
    {
      instruction: maneuverSentence('arrive', null),
      maneuver: 'arrive',
      distanceMeters: 0,
      durationSeconds: 0,
      road: null,
      location: toPoint(to),
    },
  ];
}

async function plan(
  meta: TripMeta,
  fix: StoredFix,
  target: NavigationTarget,
  speed: number | null,
  nowMs: number,
  version: number,
): Promise<StoredRoute> {
  const to = target === 'PICKUP' ? meta.pickup : meta.destination;
  const provider = getRouteProvider();
  const straight = haversineMeters(fix, to);
  const planned = await planRoute(fix, to, provider, speed, { geometry: true, steps: true });
  const result = planned.eta;
  const providerRoute = planned.route;
  await recordNavMetric(NAV_METRICS.ROUTES_PLANNED);
  if (result.basis !== 'route') await recordNavMetric(NAV_METRICS.ROUTE_FALLBACKS);

  const real = providerRoute?.geometry && providerRoute.geometry.length >= 2;
  const line: RoutePoint[] = real
    ? simplifyPolyline(
        (providerRoute?.geometry ?? []).map((p) => [p[1], p[0]] as [number, number]),
        GEOMETRY_TOLERANCE_METERS,
        GEOMETRY_MAX_POINTS,
      )
    : [toPoint(fix), toPoint(to)];
  const steps =
    providerRoute?.steps && providerRoute.steps.length > 0
      ? providerRoute.steps
      : straightGuide(fix, to, result.distanceMeters, result.etaSeconds ?? 0, to.name);
  const stepAlong = steps.map(
    (s) =>
      nearestOnPolyline({ latitude: s.location[0], longitude: s.location[1] }, line)?.alongMeters ??
      0,
  );

  return {
    version,
    tripId: meta.tripId,
    target,
    distanceMeters: result.distanceMeters,
    durationSeconds: result.etaSeconds,
    basis: result.basis,
    trafficAware: !!providerRoute?.trafficAware,
    geometry: line,
    steps,
    plannedAt: new Date(nowMs).toISOString(),
    provider: {
      name: provider.name,
      steps: provider.capabilities.steps,
      traffic: provider.capabilities.traffic,
    },
    hasGeometry: !!real,
    stepAlong,
    lineMeters: polylineLengthMeters(line),
    straightAtPlanMeters: Math.max(1, straight),
    durationRefreshedAtMs: nowMs,
  };
}

const publicRoute = (r: StoredRoute): NavigationRoute => ({
  version: r.version,
  tripId: r.tripId,
  target: r.target,
  distanceMeters: r.distanceMeters,
  durationSeconds: r.durationSeconds,
  basis: r.basis,
  trafficAware: r.trafficAware,
  geometry: r.geometry,
  steps: r.steps,
  plannedAt: r.plannedAt,
  provider: r.provider,
});

// ---------------------------------------------------------------- following the route

const DESTINATION_RANK = {
  APPROACHING_DESTINATION: 1,
  NEAR_DESTINATION: 2,
  AT_DESTINATION: 3,
} as const;

function blankState(target: NavigationTarget, nowMs: number): NavState {
  return {
    target,
    offFixes: 0,
    offRoute: false,
    deviationMeters: null,
    episodeCounted: false,
    lastPlanAtMs: nowMs,
    phase: null,
    pickupArrivalCounted: false,
    destinationArrivalCounted: false,
    destinationRank: 0,
    remainingMeters: 0,
    etaSeconds: null,
    next: null,
  };
}

/** Where along the route the driver is, which maneuver is next, and how much of the route is left. */
function follow(
  route: StoredRoute,
  fix: StoredFix,
  to: { latitude: number; longitude: number },
  speed: number | null,
): Pick<NavState, 'remainingMeters' | 'etaSeconds' | 'next'> & { alongMeters: number | null } {
  const straight = haversineMeters(fix, to);
  const near = route.hasGeometry ? nearestOnPolyline(fix, route.geometry) : null;
  // On a real route the distance left is what remains of it; with only a straight guide it is the straight line.
  const remaining = near
    ? Math.max(0, route.lineMeters - near.alongMeters) + near.distanceMeters
    : straight;
  let eta: number | null;
  if (route.basis === 'route' && route.durationSeconds !== null) {
    const scale = near
      ? remaining / Math.max(1, route.lineMeters)
      : straight / route.straightAtPlanMeters;
    eta = Math.max(0, Math.round(route.durationSeconds * Math.min(1.5, scale)));
  } else {
    eta = estimateEta(straight, speed).etaSeconds;
  }

  let next: NavigationStepProgress | null = null;
  if (near && route.steps.length > 0) {
    const idx = route.stepAlong.findIndex((a, i) => i > 0 && a > near.alongMeters + 1);
    const i = idx === -1 ? route.steps.length - 1 : idx;
    const step = route.steps[i] as RouteStep;
    next = {
      index: i,
      instruction: step.instruction,
      maneuver: step.maneuver,
      distanceToManeuverMeters: Math.max(
        0,
        Math.round((route.stepAlong[i] ?? route.lineMeters) - near.alongMeters),
      ),
    };
  } else if (route.steps.length > 0) {
    const last = route.steps[route.steps.length - 1] as RouteStep;
    next = {
      index: route.steps.length - 1,
      instruction:
        route.steps.length > 1 ? (route.steps[0] as RouteStep).instruction : last.instruction,
      maneuver: route.steps.length > 1 ? (route.steps[0] as RouteStep).maneuver : last.maneuver,
      distanceToManeuverMeters: Math.round(straight),
    };
  }
  return {
    remainingMeters: Math.round(remaining),
    etaSeconds: eta,
    next,
    alongMeters: near?.alongMeters ?? null,
  };
}

export interface NavigationUpdate {
  distanceMeters: number;
  etaSeconds: number | null;
  basis: 'route' | 'estimate';
  /** True when something a client should refetch changed (a new route, or the guidance). */
  changed: boolean;
}

/**
 * Called by the tracking pipeline for every ACCEPTED driver fix of an active ride (the one location path). Plans the
 * route when there is none for the current target, judges deviation, replans when it is confirmed, tracks the phase.
 * Returns the distance and ETA the snapshot shows. Never throws into the location path.
 */
export async function updateNavigation(
  meta: TripMeta,
  fix: StoredFix,
  speed: number | null,
  nowMs: number,
): Promise<NavigationUpdate | null> {
  const target = targetOf(meta);
  if (!target) return null;
  try {
    return await followFix(meta, fix, target, speed, nowMs);
  } catch (err) {
    log.error('Navigation update failed', err);
    return null;
  }
}

async function followFix(
  meta: TripMeta,
  fix: StoredFix,
  target: NavigationTarget,
  speed: number | null,
  nowMs: number,
): Promise<NavigationUpdate> {
  const th = navigationThresholds();
  const to = target === 'PICKUP' ? meta.pickup : meta.destination;
  let route = await getJson<StoredRoute>(k.route(meta.tripId));
  let state = await getJson<NavState>(k.state(meta.tripId));
  let changed = false;

  if (!route || route.target !== target) {
    route = await plan(meta, fix, target, speed, nowMs, (route?.version ?? 0) + 1);
    state = blankState(target, nowMs);
    changed = true;
    if (target === 'DESTINATION' && route.basis === 'route' && route.durationSeconds !== null) {
      // The first promise of arrival time for the ride itself, kept to measure how good estimates are.
      await query(
        'UPDATE trips SET nav_eta_seconds = $2 WHERE id = $1 AND nav_eta_seconds IS NULL',
        [meta.tripId, route.durationSeconds],
      );
    }
  }
  const st = state ?? blankState(target, nowMs);

  // ---- deviation: only accurate readings count, several in a row, against a line that follows roads
  const accurate = fix.accuracyMeters === null || fix.accuracyMeters <= th.maxAccuracyMeters;
  if (accurate && route.hasGeometry) {
    const near = nearestOnPolyline(fix, route.geometry);
    const limit = th.deviationMeters + (fix.accuracyMeters ?? 0);
    if (near && near.distanceMeters > limit) {
      st.offFixes += 1;
      st.deviationMeters = Math.round(near.distanceMeters);
    } else {
      st.offFixes = 0;
      st.offRoute = false;
      st.deviationMeters = null;
      st.episodeCounted = false;
    }
    if (st.offFixes >= th.deviationConfirmFixes) {
      if (!st.episodeCounted) {
        st.episodeCounted = true;
        await query('UPDATE trips SET route_deviations = route_deviations + 1 WHERE id = $1', [
          meta.tripId,
        ]);
        await recordNavMetric(NAV_METRICS.DEVIATIONS_CONFIRMED);
      }
      // Confirmed. Plan a new route, but not more often than the interval (data and routing capacity).
      if (nowMs - st.lastPlanAtMs >= th.rerouteMinSeconds * 1000) {
        route = await plan(meta, fix, target, speed, nowMs, route.version + 1);
        st.offFixes = 0;
        st.offRoute = false;
        st.deviationMeters = null;
        st.lastPlanAtMs = nowMs;
        await query('UPDATE trips SET reroutes = reroutes + 1 WHERE id = $1', [meta.tripId]);
        await recordNavMetric(NAV_METRICS.REROUTES);
        changed = true;
      } else {
        st.offRoute = true; // confirmed, and a new route is not due yet
      }
    }
  }

  // ---- a route that follows traffic keeps its duration fresh without becoming a new route
  if (route.trafficAware && !changed && nowMs - route.durationRefreshedAtMs >= TRAFFIC_REFRESH_MS) {
    const fresh = await computeEta(fix, to, getRouteProvider(), speed);
    if (fresh.basis === 'route') {
      route = { ...route, durationSeconds: fresh.etaSeconds, durationRefreshedAtMs: nowMs };
      // The refreshed figure describes the trip from here, so it re-bases the scale.
      route.distanceMeters = fresh.distanceMeters;
      route.lineMeters = route.hasGeometry ? route.lineMeters : fresh.distanceMeters;
      route.straightAtPlanMeters = Math.max(1, haversineMeters(fix, to));
      changed = true;
    }
  }

  const progress = follow(route, fix, to, speed);
  st.remainingMeters = progress.remainingMeters;
  st.etaSeconds = progress.etaSeconds;
  st.next = progress.next;

  // ---- phase, and what it triggers
  const fromPickup = target === 'DESTINATION' ? haversineMeters(fix, meta.pickup) : null;
  const phase = approachPhase({
    target,
    distanceToTargetMeters: haversineMeters(fix, to),
    fromPickupMeters: fromPickup,
    accuracyMeters: fix.accuracyMeters,
    thresholds: th,
  });
  if (phase !== st.phase) changed = true;
  st.phase = phase;
  if (phase === 'AT_PICKUP' && !st.pickupArrivalCounted) {
    st.pickupArrivalCounted = true;
    await recordNavMetric(NAV_METRICS.ARRIVALS_AT_PICKUP);
  }
  if (isDestinationMilestone(phase) && meta.status === 'IN_PROGRESS') {
    const rank = DESTINATION_RANK[phase];
    if (rank > st.destinationRank) {
      st.destinationRank = rank;
      await recordTripEvent({
        tripId: meta.tripId,
        type: 'DESTINATION_NEARBY',
        payload: { milestone: phase, distanceMeters: Math.round(haversineMeters(fix, to)) },
        dedupeKey: `dest:${phase}`,
      });
      if (phase === 'AT_DESTINATION' && !st.destinationArrivalCounted) {
        st.destinationArrivalCounted = true;
        await recordNavMetric(NAV_METRICS.ARRIVALS_AT_DESTINATION);
      }
    }
  }

  await setJson(k.route(meta.tripId), route);
  await setJson(k.state(meta.tripId), st);
  return {
    distanceMeters: st.remainingMeters,
    etaSeconds: st.etaSeconds,
    basis: route.basis,
    changed,
  };
}

// ---------------------------------------------------------------- what the apps read

/** The driver's guidance for the snapshot (null when there is no route yet). */
export async function readGuidance(tripId: string): Promise<NavigationGuidance | null> {
  const [route, st] = await Promise.all([
    getJson<StoredRoute>(k.route(tripId)),
    getJson<NavState>(k.state(tripId)),
  ]);
  if (!route || !st || st.target !== route.target) return null;
  return {
    routeVersion: route.version,
    target: route.target,
    phase: st.phase ?? (route.target === 'PICKUP' ? 'HEADING_TO_PICKUP' : 'HEADING_TO_DESTINATION'),
    offRoute: st.offRoute,
    deviationMeters: st.deviationMeters,
    next: st.next,
    distanceRemainingMeters: st.remainingMeters,
    etaSeconds: st.etaSeconds,
    basis: route.basis,
    trafficAware: route.trafficAware,
  };
}

/**
 * The distance and ETA the snapshot shows for the current target, from the one navigation state; null when navigation
 * has no figure yet (the snapshot then falls back to a straight-line estimate).
 */
export async function readProgress(
  tripId: string,
  target: NavigationTarget,
): Promise<{
  distanceMeters: number;
  etaSeconds: number | null;
  basis: 'route' | 'estimate';
} | null> {
  const [route, st] = await Promise.all([
    getJson<StoredRoute>(k.route(tripId)),
    getJson<NavState>(k.state(tripId)),
  ]);
  if (!route || !st || route.target !== target) return null;
  return { distanceMeters: st.remainingMeters, etaSeconds: st.etaSeconds, basis: route.basis };
}

/** The full route for the driver's own ride. `knownVersion` saves resending what the app already holds. */
export async function readRoute(
  tripId: string,
  knownVersion: number | null,
): Promise<{ route: NavigationRoute | null; unchanged: boolean }> {
  const route = await getJson<StoredRoute>(k.route(tripId));
  if (!route) return { route: null, unchanged: false };
  if (knownVersion !== null && knownVersion === route.version)
    return { route: null, unchanged: true };
  return { route: publicRoute(route), unchanged: false };
}
