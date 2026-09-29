import type { Freshness } from '@yatri/types';

import { haversineMeters } from '../location/geo';

/**
 * Pure rules for accepting or rejecting a GPS fix. No I/O, no clocks other
 * than the ones passed in — every branch is unit-tested with mocked
 * coordinates, including the impossible-jump and out-of-order cases.
 */
export interface Fix {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  /** Device clock (ms). Used for ordering and staleness of the reading itself. */
  deviceTimeMs: number;
}

export interface StoredFix extends Fix {
  /** Server clock when this fix was accepted. */
  receivedAtMs: number;
  /** A candidate baseline after a suspicious jump; promoted if the device keeps reporting from there. */
  pendingJump?: { latitude: number; longitude: number; deviceTimeMs: number; count: number };
}

export interface TrackingConfig {
  /** Fastest plausible movement. 55 m/s ≈ 200 km/h. */
  maxSpeedMps: number;
  /** Extra slack on top of the accuracy radii when judging a jump. */
  jumpSlackMeters: number;
  /** Fixes older than this on arrival are dropped (a queued reading delivered late). */
  maxFixAgeMs: number;
  /** Device clock further ahead than this is treated as a broken clock. */
  maxClockSkewMs: number;
  /** Ignore updates arriving faster than this. */
  minIntervalMs: number;
  /** Fixes worse than this are never used. */
  maxAccuracyMeters: number;
  /** How many mutually consistent "jumps" it takes to accept the new location as real. */
  jumpConfirmations: number;
  /** Freshness thresholds (age of the last accepted fix at the server). */
  liveWithinMs: number;
  staleWithinMs: number;
}

export const DEFAULT_TRACKING_CONFIG: TrackingConfig = {
  maxSpeedMps: 55,
  jumpSlackMeters: 30,
  maxFixAgeMs: 30_000,
  maxClockSkewMs: 60_000,
  minIntervalMs: 800,
  maxAccuracyMeters: 200,
  jumpConfirmations: 3,
  liveWithinMs: 15_000,
  staleWithinMs: 60_000,
};

export type RejectReason =
  | 'duplicate'
  | 'out_of_order'
  | 'stale'
  | 'clock_skew'
  | 'too_frequent'
  | 'low_accuracy'
  | 'impossible_jump'
  | 'invalid';

export type Decision =
  { accept: true; next: StoredFix } | { accept: false; reason: RejectReason; next?: StoredFix };

function validCoordinate(f: Fix): boolean {
  return (
    Number.isFinite(f.latitude) &&
    Number.isFinite(f.longitude) &&
    Math.abs(f.latitude) <= 90 &&
    Math.abs(f.longitude) <= 180 &&
    !(f.latitude === 0 && f.longitude === 0) &&
    Number.isFinite(f.deviceTimeMs) &&
    (f.accuracyMeters === null || (Number.isFinite(f.accuracyMeters) && f.accuracyMeters >= 0))
  );
}

export function evaluateFix(
  prev: StoredFix | null,
  incoming: Fix,
  nowMs: number,
  cfg: TrackingConfig = DEFAULT_TRACKING_CONFIG,
): Decision {
  if (!validCoordinate(incoming)) return { accept: false, reason: 'invalid' };
  if (incoming.deviceTimeMs - nowMs > cfg.maxClockSkewMs) {
    return { accept: false, reason: 'clock_skew' };
  }
  if (nowMs - incoming.deviceTimeMs > cfg.maxFixAgeMs) return { accept: false, reason: 'stale' };
  if (incoming.accuracyMeters !== null && incoming.accuracyMeters > cfg.maxAccuracyMeters) {
    return { accept: false, reason: 'low_accuracy' };
  }

  const accepted = (): Decision => ({
    accept: true,
    next: { ...incoming, receivedAtMs: nowMs },
  });
  if (!prev) return accepted();

  if (incoming.deviceTimeMs === prev.deviceTimeMs) return { accept: false, reason: 'duplicate' };
  if (incoming.deviceTimeMs < prev.deviceTimeMs) return { accept: false, reason: 'out_of_order' };
  if (nowMs - prev.receivedAtMs < cfg.minIntervalMs)
    return { accept: false, reason: 'too_frequent' };

  // Don't replace a recent, good fix with a much worse one.
  const prevIsFresh = nowMs - prev.receivedAtMs <= cfg.liveWithinMs;
  if (
    prevIsFresh &&
    prev.accuracyMeters !== null &&
    incoming.accuracyMeters !== null &&
    incoming.accuracyMeters > Math.max(50, prev.accuracyMeters * 3)
  ) {
    return { accept: false, reason: 'low_accuracy' };
  }

  const dtSec = Math.max(0.5, (incoming.deviceTimeMs - prev.deviceTimeMs) / 1000);
  const distance = haversineMeters(prev, incoming);
  const allowed =
    cfg.maxSpeedMps * dtSec +
    (prev.accuracyMeters ?? 0) +
    (incoming.accuracyMeters ?? 0) +
    cfg.jumpSlackMeters;

  if (distance <= allowed) return accepted(); // pendingJump is cleared by not carrying it over

  // Impossible jump. Keep the last good position, but remember the candidate: if the
  // device keeps reporting from the new place, the earlier fix was the bad one.
  const pending = prev.pendingJump;
  const continuesPending =
    pending &&
    haversineMeters(pending, incoming) <=
      cfg.maxSpeedMps * Math.max(0.5, (incoming.deviceTimeMs - pending.deviceTimeMs) / 1000) +
        cfg.jumpSlackMeters +
        (incoming.accuracyMeters ?? 0);
  const count = continuesPending && pending ? pending.count + 1 : 1;
  if (count >= cfg.jumpConfirmations) return accepted();

  return {
    accept: false,
    reason: 'impossible_jump',
    next: {
      ...prev,
      pendingJump: {
        latitude: incoming.latitude,
        longitude: incoming.longitude,
        deviceTimeMs: incoming.deviceTimeMs,
        count,
      },
    },
  };
}

export function freshnessOf(
  lastReceivedAtMs: number | null,
  nowMs: number,
  cfg: TrackingConfig = DEFAULT_TRACKING_CONFIG,
): Freshness {
  if (lastReceivedAtMs === null) return 'none';
  const age = nowMs - lastReceivedAtMs;
  if (age <= cfg.liveWithinMs) return 'live';
  if (age <= cfg.staleWithinMs) return 'stale';
  return 'lost';
}

/** Should we look up a new place name? Only after meaningful movement AND a pause since the last lookup. */
export function shouldRefreshPlaceName(
  last: { latitude: number; longitude: number; atMs: number } | null,
  current: { latitude: number; longitude: number },
  nowMs: number,
  opts = { minMoveMeters: 75, minIntervalMs: 15_000 },
): boolean {
  if (!last) return true;
  return (
    nowMs - last.atMs >= opts.minIntervalMs && haversineMeters(last, current) >= opts.minMoveMeters
  );
}
