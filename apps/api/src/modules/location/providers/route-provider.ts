import type { Coordinate } from '../coordinates';
import { haversineMeters } from '../geo';
import { LocationProviderError } from './location-provider';

export interface RouteResult {
  distanceMeters: number;
  /** null when the provider cannot estimate travel time (straight-line). */
  durationSeconds: number | null;
  /** `route` follows roads; `straight_line` is the great-circle fallback. */
  method: 'route' | 'straight_line';
  /** GeoJSON-style [lng, lat] pairs; only populated when requested and supported. */
  geometry?: Array<[number, number]>;
}

/**
 * Route abstraction. Fare calculation and driver matching (later phases)
 * depend on this interface, not on a vendor.
 */
export interface RouteProvider {
  readonly name: string;
  calculateRoute(
    from: Coordinate,
    to: Coordinate,
    opts?: { geometry?: boolean },
  ): Promise<RouteResult>;
  calculateETA(from: Coordinate, to: Coordinate): Promise<number | null>;
}

export class HaversineRouteProvider implements RouteProvider {
  readonly name = 'haversine';
  async calculateRoute(from: Coordinate, to: Coordinate): Promise<RouteResult> {
    return {
      distanceMeters: haversineMeters(from, to),
      durationSeconds: null,
      method: 'straight_line',
    };
  }
  async calculateETA(): Promise<number | null> {
    return null;
  }
}

export interface OsrmConfig {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface OsrmBody {
  code?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: { coordinates?: Array<[number, number]> };
  }>;
}

export class OsrmRouteProvider implements RouteProvider {
  readonly name = 'osrm';
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OsrmConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async calculateRoute(
    from: Coordinate,
    to: Coordinate,
    opts: { geometry?: boolean } = {},
  ): Promise<RouteResult> {
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const qs = `overview=${opts.geometry ? 'full' : 'false'}&geometries=geojson`;
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.config.baseUrl.replace(/\/$/, '')}/route/v1/driving/${coords}?${qs}`,
        { signal: AbortSignal.timeout(this.config.timeoutMs) },
      );
    } catch (err) {
      const isTimeout =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new LocationProviderError(isTimeout ? 'TIMEOUT' : 'UNAVAILABLE', 'osrm request failed');
    }
    if (res.status === 429) throw new LocationProviderError('RATE_LIMITED', 'osrm 429');
    if (!res.ok) throw new LocationProviderError('UNAVAILABLE', `osrm ${res.status}`);

    const body = (await res.json().catch(() => null)) as OsrmBody | null;
    const route = body?.routes?.[0];
    if (
      body?.code !== 'Ok' ||
      !route ||
      !Number.isFinite(route.distance) ||
      !Number.isFinite(route.duration)
    ) {
      throw new LocationProviderError('BAD_RESPONSE', 'osrm: no usable route');
    }
    return {
      distanceMeters: route.distance as number,
      durationSeconds: route.duration as number,
      method: 'route',
      ...(opts.geometry && route.geometry?.coordinates
        ? { geometry: route.geometry.coordinates }
        : {}),
    };
  }

  async calculateETA(from: Coordinate, to: Coordinate): Promise<number | null> {
    return (await this.calculateRoute(from, to)).durationSeconds;
  }
}
