import type { Coordinate } from '../location/coordinates';
import { haversineMeters } from '../location/geo';
import { LocationProviderError } from '../location/providers/location-provider';
import type { RouteProvider } from '../location/providers/route-provider';

export interface EtaResult {
  distanceMeters: number;
  etaSeconds: number | null;
  basis: 'route' | 'estimate';
}

// Urban ride-hailing reality check when no routing engine is configured:
// road distance ≈ 1.3 × straight line, moving at ≈ 20 km/h on average.
const DETOUR_FACTOR = 1.3;
const FALLBACK_SPEED_MPS = 5.5;
const MIN_SPEED_MPS = 3;
const MAX_SPEED_MPS = 16;

/**
 * Speed-based estimate used whenever the RouteProvider cannot give a
 * duration (haversine provider, outage, quota). `observedSpeedMps` is the
 * driver's recent measured speed; it is clamped so a red light or a
 * highway burst does not produce a silly ETA.
 */
export function estimateEta(
  straightLineMeters: number,
  observedSpeedMps?: number | null,
): { etaSeconds: number } {
  const speed =
    observedSpeedMps && Number.isFinite(observedSpeedMps)
      ? Math.min(MAX_SPEED_MPS, Math.max(MIN_SPEED_MPS, observedSpeedMps))
      : FALLBACK_SPEED_MPS;
  return { etaSeconds: Math.round((straightLineMeters * DETOUR_FACTOR) / speed) };
}

/**
 * Distance + ETA between two points through the provider abstraction. The
 * caller never knows (or cares) whether OSRM, GraphHopper, Valhalla or the
 * fallback produced the number — only `basis` says how trustworthy it is.
 * Distance is always the server's own calculation (route length when the
 * provider returns one, else great-circle).
 */
export async function computeEta(
  from: Coordinate,
  to: Coordinate,
  provider: RouteProvider,
  observedSpeedMps?: number | null,
): Promise<EtaResult> {
  const straight = haversineMeters(from, to);
  try {
    const route = await provider.calculateRoute(from, to);
    if (route.method === 'route' && route.durationSeconds !== null) {
      return {
        distanceMeters: Math.round(route.distanceMeters),
        etaSeconds: Math.round(route.durationSeconds),
        basis: 'route',
      };
    }
  } catch (err) {
    if (!(err instanceof LocationProviderError)) throw err;
    console.error(`ETA route provider failure (${err.kind}); using estimate`);
  }
  return {
    distanceMeters: Math.round(straight),
    etaSeconds: estimateEta(straight, observedSpeedMps).etaSeconds,
    basis: 'estimate',
  };
}
