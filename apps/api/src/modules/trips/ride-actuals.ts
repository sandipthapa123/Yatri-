import { haversineMeters } from '@yatri/types';

/**
 * What a ride actually measured, as pure functions (the service feeds them recorded facts).
 * The FARE for these inputs is computed by the one fare service (`pricing/pricing.ts`); nothing here
 * prices anything.
 */

/**
 * Distance travelled. The odometer sums the driver's accepted location updates while the ride runs;
 * sparse GPS cuts corners, so it can under-count but never legitimately falls below the straight
 * line from where the ride started to where it ended. The larger of the two is the measured distance.
 */
export function measuredRideDistance(
  odometerMeters: number,
  start: { latitude: number; longitude: number } | null,
  end: { latitude: number; longitude: number },
): number {
  const straight = start ? haversineMeters(start, end) : 0;
  return Math.round(Math.max(odometerMeters, straight));
}

export function rideDurationSeconds(startedAt: Date | null, endedAtMs: number): number {
  return startedAt ? Math.max(0, Math.round((endedAtMs - startedAt.getTime()) / 1000)) : 0;
}

/** Location updates smaller than this are GPS jitter, not movement; they are not added to the odometer. */
export const ODOMETER_MIN_STEP_METERS = 5;
