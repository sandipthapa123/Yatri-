import { env } from '../../config/env';
import type { TrackingConfig } from './tracking.rules';

const c = {
  // Accepting / rejecting GPS fixes (physical plausibility limits, not deployment tuning).
  maxSpeedMps: 55, // ≈ 200 km/h
  jumpSlackMeters: 30,
  maxFixAgeMs: 30_000,
  maxClockSkewMs: 60_000,
  maxAccuracyMeters: 200,
  jumpConfirmations: 3,
};

/**
 * THE tracking configuration. Freshness thresholds and the update rate limit come from
 * the environment (DRIVER_LOCATION_FRESH_SECONDS, DRIVER_LOCATION_LOST_SECONDS,
 * TRACKING_MIN_INTERVAL_MS) so availability, trip tracking and the admin list all agree on
 * what "fresh" means. The pure rules module holds no numbers of its own.
 */
export function trackingConfig(): TrackingConfig {
  return {
    ...c,
    minIntervalMs: env.TRACKING_MIN_INTERVAL_MS,
    liveWithinMs: env.DRIVER_LOCATION_FRESH_SECONDS * 1000,
    staleWithinMs: env.DRIVER_LOCATION_LOST_SECONDS * 1000,
  };
}
