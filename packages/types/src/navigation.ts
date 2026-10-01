import { bearingDegrees } from './geo';
import { compassWord, formatDistance, formatDuration } from './format';
import type { LatLng } from './index';

/**
 * Navigation for an active ride: the ONE definition of the route shape, the phases of an approach, the thresholds'
 * names and the words. The API plans routes through the existing RouteProvider and decides everything about the ride;
 * the apps only present what it says. Nothing here is a second location or routing system: positions come from the
 * existing tracking pipeline, routes from the existing provider abstraction, distances from `geo.ts`.
 *
 * What is decided where:
 *  - the SERVER keeps the route, works out which step the driver is on, whether they are off it, the phase of the
 *    approach and when to plan a new route (so every device agrees and nothing depends on a phone's battery);
 *  - the CLIENT shows the guidance, speaks it sparingly, and may open a maps app. It never decides the ride.
 */

export type NavigationTarget = 'PICKUP' | 'DESTINATION';

export const MANEUVERS = [
  'depart',
  'straight',
  'slight-left',
  'left',
  'sharp-left',
  'slight-right',
  'right',
  'sharp-right',
  'uturn',
  'roundabout',
  'merge',
  'arrive',
  'other',
] as const;
export type Maneuver = (typeof MANEUVERS)[number];

/** A route point as [latitude, longitude] (compact on the wire). */
export type RoutePoint = [number, number];

export interface RouteStep {
  /** The sentence to read, from the provider or built from the maneuver ("Turn left onto New Road"). */
  instruction: string;
  maneuver: Maneuver;
  /** Length of this step, from its start to the next maneuver. */
  distanceMeters: number;
  durationSeconds: number;
  road: string | null;
  /** Where the maneuver happens. */
  location: RoutePoint;
}

/** What the driver's app needs to show a route. Only the driver of the active ride can ask for it. */
export interface NavigationRoute {
  /** Changes whenever a new route is planned (after a deviation, or when the ride moves on). */
  version: number;
  tripId: string;
  target: NavigationTarget;
  distanceMeters: number;
  durationSeconds: number | null;
  /** `route`: follows roads. `estimate`: no routing engine answered, so it is a straight-line guide only. */
  basis: 'route' | 'estimate';
  /** True only when the provider says the duration reflects live traffic. */
  trafficAware: boolean;
  geometry: RoutePoint[];
  steps: RouteStep[];
  plannedAt: string;
  /** What the route provider can do (so the screen can say what it cannot). */
  provider: { name: string; steps: boolean; traffic: boolean };
}

export interface NavigationRouteResponse {
  /** Null when no route exists yet (the driver's first location has not arrived) or `unchanged` is true. */
  route: NavigationRoute | null;
  /** True when the caller already has the version it asked about. */
  unchanged: boolean;
}

// ---------------------------------------------------------------- approach phases

export const APPROACH_PHASES = [
  'HEADING_TO_PICKUP',
  'APPROACHING_PICKUP',
  'NEAR_PICKUP',
  'AT_PICKUP',
  'LEAVING_PICKUP',
  'HEADING_TO_DESTINATION',
  'APPROACHING_DESTINATION',
  'NEAR_DESTINATION',
  'AT_DESTINATION',
] as const;
export type ApproachPhase = (typeof APPROACH_PHASES)[number];

export const APPROACH_PHASE_LABELS: Record<ApproachPhase, string> = {
  HEADING_TO_PICKUP: 'On the way to the pickup',
  APPROACHING_PICKUP: 'Approaching the pickup',
  NEAR_PICKUP: 'Near the pickup',
  AT_PICKUP: 'At the pickup',
  LEAVING_PICKUP: 'Leaving the pickup',
  HEADING_TO_DESTINATION: 'On the way to the destination',
  APPROACHING_DESTINATION: 'Approaching the destination',
  NEAR_DESTINATION: 'Near the destination',
  AT_DESTINATION: 'At the destination',
};

/** The distances (metres) that separate the phases. Platform settings (NAV_*); the pure rules hold no numbers. */
export interface NavigationThresholds {
  approachingMeters: number;
  nearMeters: number;
  atMeters: number;
  leavingMeters: number;
  /** How far from the route counts as "off it" (widened by the fix's own inaccuracy). */
  deviationMeters: number;
  /** In a row, so one stray reading never counts. */
  deviationConfirmFixes: number;
  /** A fix less accurate than this is not used to judge a deviation or an arrival. */
  maxAccuracyMeters: number;
  /** Planning a new route at most this often. */
  rerouteMinSeconds: number;
}

/**
 * Where the ride's approach stands. `fromPickupMeters` only matters on the ride itself (leaving the pickup). A fix whose
 * own accuracy is worse than the radius it would have to be inside never counts as "at" or "near": a poor reading near
 * a target is not proof of arrival.
 */
export function approachPhase(input: {
  target: NavigationTarget;
  distanceToTargetMeters: number;
  fromPickupMeters: number | null;
  accuracyMeters: number | null;
  thresholds: Pick<
    NavigationThresholds,
    'approachingMeters' | 'nearMeters' | 'atMeters' | 'leavingMeters'
  >;
}): ApproachPhase {
  const { target, distanceToTargetMeters: d, thresholds: t } = input;
  const acc = input.accuracyMeters ?? 0;
  const trust = (radius: number) => acc <= radius;
  if (target === 'PICKUP') {
    if (d <= t.atMeters && trust(t.atMeters)) return 'AT_PICKUP';
    if (d <= t.nearMeters && trust(t.nearMeters)) return 'NEAR_PICKUP';
    if (d <= t.approachingMeters) return 'APPROACHING_PICKUP';
    return 'HEADING_TO_PICKUP';
  }
  if (d <= t.atMeters && trust(t.atMeters)) return 'AT_DESTINATION';
  if (d <= t.nearMeters && trust(t.nearMeters)) return 'NEAR_DESTINATION';
  if (d <= t.approachingMeters) return 'APPROACHING_DESTINATION';
  if (input.fromPickupMeters !== null && input.fromPickupMeters <= t.leavingMeters) {
    return 'LEAVING_PICKUP';
  }
  return 'HEADING_TO_DESTINATION';
}

/** The destination milestones that become a ride event (once each); the pickup ones already have their own. */
export const DESTINATION_MILESTONES = [
  'APPROACHING_DESTINATION',
  'NEAR_DESTINATION',
  'AT_DESTINATION',
] as const;
export type DestinationMilestone = (typeof DESTINATION_MILESTONES)[number];
export const isDestinationMilestone = (p: ApproachPhase): p is DestinationMilestone =>
  (DESTINATION_MILESTONES as readonly string[]).includes(p);

/**
 * A ride counts towards the route-deviation pattern only when the driver was confirmed off the route at least this many
 * separate times on it. One deviation is an ordinary ride (roadworks, a passenger's request, a closed street).
 */
export const ROUTE_DEVIATION_RIDE_MIN_DEVIATIONS = 3;

// ---------------------------------------------------------------- guidance carried in the driver's snapshot

export interface NavigationStepProgress {
  index: number;
  instruction: string;
  maneuver: Maneuver;
  /** How far to the maneuver of this step. */
  distanceToManeuverMeters: number;
}

/**
 * What the server says about the driver's navigation right now. It rides in the existing live snapshot (driver only),
 * so there is no second channel: a changed `routeVersion` is the app's cue to fetch the new route.
 */
export interface NavigationGuidance {
  routeVersion: number;
  target: NavigationTarget;
  phase: ApproachPhase;
  /** Confirmed off the route (several accurate readings in a row). */
  offRoute: boolean;
  /** How far from the route the last accurate reading was; null when on it or unknown. */
  deviationMeters: number | null;
  /** The next maneuver; null when there is no step list (a straight-line guide) or the target is reached. */
  next: NavigationStepProgress | null;
  distanceRemainingMeters: number;
  etaSeconds: number | null;
  basis: 'route' | 'estimate';
  trafficAware: boolean;
}

// ---------------------------------------------------------------- words

/** A sentence for a maneuver when the provider gave none. */
export function maneuverSentence(m: Maneuver, road: string | null): string {
  const onto = road ? ` onto ${road}` : '';
  switch (m) {
    case 'depart':
      return `Head ${road ? `on ${road}` : 'out'}.`;
    case 'straight':
      return `Continue straight${road ? ` on ${road}` : ''}.`;
    case 'slight-left':
      return `Bear left${onto}.`;
    case 'left':
      return `Turn left${onto}.`;
    case 'sharp-left':
      return `Turn sharp left${onto}.`;
    case 'slight-right':
      return `Bear right${onto}.`;
    case 'right':
      return `Turn right${onto}.`;
    case 'sharp-right':
      return `Turn sharp right${onto}.`;
    case 'uturn':
      return `Make a U-turn${onto}.`;
    case 'roundabout':
      return `Enter the roundabout${onto}.`;
    case 'merge':
      return `Merge${onto}.`;
    case 'arrive':
      return 'You have arrived.';
    default:
      return `Continue${road ? ` on ${road}` : ''}.`;
  }
}

/** A maneuver is said "ahead" within this distance and "now" within the smaller one (spoken sparingly, never for jitter). */
export const STEP_AHEAD_METERS = 300;
export const STEP_NOW_METERS = 40;

/** "In 300 meters, turn left onto New Road." The one sentence for the next step. */
export function nextStepSentence(g: NavigationGuidance): string | null {
  if (!g.next) return null;
  const d = g.next.distanceToManeuverMeters;
  const lead = d <= STEP_NOW_METERS ? 'Now' : `In ${formatDistance(d)}`;
  const text = g.next.instruction.replace(/\.$/, '');
  return `${lead}, ${text.charAt(0).toLowerCase()}${text.slice(1)}.`;
}

/** The sentence the driver hears for the state of their route, in the order they need it. */
export function describeGuidance(g: NavigationGuidance, targetName: string): string {
  const parts: string[] = [];
  if (g.offRoute) parts.push('You are off the planned route. Finding a new route.');
  const step = nextStepSentence(g);
  if (step && !g.offRoute) parts.push(step);
  parts.push(
    `${APPROACH_PHASE_LABELS[g.phase]}. ${formatDistance(g.distanceRemainingMeters)} to ${targetName}${
      g.etaSeconds === null ? '' : `, about ${formatDuration(g.etaSeconds)}`
    }${g.basis === 'estimate' ? ' (estimate)' : ''}.`,
  );
  return parts.join(' ');
}

/**
 * The accessible, text-only picture of a ride in progress, for the passenger (and anyone who does not use the map). It
 * is a plain description, not an announcement: it is on screen to be read when asked for, while the live region speaks
 * only meaningful changes. Every figure is the server's.
 */
export function describeTripProgress(input: {
  placeName: string | null;
  destinationName: string;
  distanceRemainingMeters: number;
  etaSeconds: number | null;
  basis: 'route' | 'estimate';
  /** Direction of the destination from the driver, when known. */
  headingToward?: number | null;
}): string[] {
  const lines = ['You are travelling toward your destination.'];
  if (input.placeName) lines.push(`Current location: ${input.placeName}.`);
  lines.push(`Distance remaining: ${formatDistance(input.distanceRemainingMeters)}.`);
  if (input.etaSeconds !== null) {
    lines.push(
      `Estimated arrival: ${formatDuration(input.etaSeconds)}${input.basis === 'estimate' ? ' (estimate)' : ''}.`,
    );
  }
  lines.push(
    input.distanceRemainingMeters < 1000
      ? `You are approximately ${formatDistance(Math.round(input.distanceRemainingMeters / 10) * 10)} from ${input.destinationName}.`
      : `Your destination is ${input.destinationName}.`,
  );
  return lines;
}

/** Which way, in words, from one point to another ("north-east"). */
export function directionWord(from: LatLng, to: LatLng): string {
  return compassWord(bearingDegrees(from, to));
}

// ---------------------------------------------------------------- what administrators see

/**
 * Operational figures about routes and arrival times: counts and percentages across rides, never a place, a track or a
 * person. They answer "is routing working and are our estimates any good", not "where was this driver".
 */
export interface NavigationMetrics {
  rangeLabel: string;
  provider: { name: string; steps: boolean; traffic: boolean };
  routesPlanned: number;
  /** Routes that could not come from the routing engine and fell back to a straight-line guide. */
  routeFallbacks: number;
  fallbackPercent: number | null;
  reroutes: number;
  deviationsConfirmed: number;
  ridesTotal: number;
  ridesWithDeviation: number;
  arrivalsAtPickup: number;
  arrivalsAtDestination: number;
  eta: {
    samples: number;
    /** Share of rides whose first arrival estimate was within 20% of the actual ride time. */
    withinTwentyPercent: number | null;
    averageErrorPercent: number | null;
  };
}
