import {
  DRIVER_AVAILABILITY_STATES,
  type DriverAvailabilityState,
  type LocationFreshness,
} from '@yatri/types';

import { freshnessOf } from '../tracking/tracking.rules';

/**
 * Driver availability state machine (pure).
 *
 *   OFFLINE ─► GOING_ONLINE ─► ONLINE ─► GOING_OFFLINE ─► OFFLINE
 *      ▲            │             │  └────────────────────────┘
 *      │            └─(failure)───┤
 *      │                          └─(location silent too long)─► UNAVAILABLE
 *      └──── UNAVAILABLE ◄── system pause; the driver must tap Go Online again
 *   SUSPENDED: set when an admin suspends the driver; leaves only via Go Online
 *   after the account is reinstated AND eligibility passes again.
 *
 * This is a DRIVER-AVAILABILITY machine only. Ride/trip status is a separate
 * concern (see trips). "Online" never means "on a trip". Future refinements
 * (ONLINE_AVAILABLE, ONLINE_ASSIGNED, ON_TRIP) are sub-states of ONLINE that a later
 * phase adds as an extra column (`online_substate`) — the persisted machine below
 * and every query that means "is this driver reachable?" keep working unchanged.
 */
export const ALL_STATES = DRIVER_AVAILABILITY_STATES;

/** Mid-change states; a change that never completes is rolled back by the sweeper. */
export const TRANSITIONAL_STATES: readonly DriverAvailabilityState[] = [
  'GOING_ONLINE',
  'GOING_OFFLINE',
];

const TRANSITIONS: Record<DriverAvailabilityState, readonly DriverAvailabilityState[]> = {
  OFFLINE: ['GOING_ONLINE', 'SUSPENDED'],
  GOING_ONLINE: ['ONLINE', 'OFFLINE', 'SUSPENDED'],
  ONLINE: ['GOING_OFFLINE', 'OFFLINE', 'UNAVAILABLE', 'SUSPENDED'],
  GOING_OFFLINE: ['OFFLINE', 'SUSPENDED'],
  UNAVAILABLE: ['GOING_ONLINE', 'OFFLINE', 'SUSPENDED'],
  SUSPENDED: ['GOING_ONLINE', 'OFFLINE'],
};

export function canTransition(from: DriverAvailabilityState, to: DriverAvailabilityState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States from which a Go Online request may start. */
export const CAN_START_ONLINE: readonly DriverAvailabilityState[] = [
  'OFFLINE',
  'UNAVAILABLE',
  'SUSPENDED',
];

/** States that mean "the driver is on shift" (ONLINE or in the middle of leaving). */
export function isOnShift(state: DriverAvailabilityState): boolean {
  return state === 'ONLINE' || state === 'GOING_OFFLINE';
}

/**
 * The one definition of "may future matching pick this driver?": ONLINE with a
 * FRESH location. Matching (a later phase) must go through this, not re-derive it.
 */
export function isMatchable(state: DriverAvailabilityState, freshness: LocationFreshness): boolean {
  return state === 'ONLINE' && freshness === 'fresh';
}

/**
 * Availability's "fresh / stale / none" is the tracking rules' single freshness function
 * with the same configured threshold; only the vocabulary differs (live → fresh, and both
 * "stale" and "lost" read as stale here — being reachable is binary).
 */
export function locationFreshness(
  lastReceivedAtMs: number | null,
  nowMs: number,
  freshWithinSeconds: number,
): LocationFreshness {
  const f = freshnessOf(lastReceivedAtMs, nowMs, {
    liveWithinMs: freshWithinSeconds * 1000,
    staleWithinMs: Number.POSITIVE_INFINITY,
  });
  return f === 'live' ? 'fresh' : f === 'none' ? 'none' : 'stale';
}
