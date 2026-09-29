import type { Coordinate } from '../coordinates';
import { haversineMeters } from '../geo';
import { fetchJson } from './http';
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
 * Route abstraction. Fare calculation, driver matching and live-trip ETA
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

interface HttpRouteConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

function usable(distance: unknown, duration: unknown, label: string) {
  if (typeof distance !== 'number' || typeof duration !== 'number') {
    throw new LocationProviderError('BAD_RESPONSE', `${label}: no usable route`);
  }
  if (!Number.isFinite(distance) || !Number.isFinite(duration) || distance < 0 || duration < 0) {
    throw new LocationProviderError('BAD_RESPONSE', `${label}: invalid numbers`);
  }
}

abstract class HttpRouteProvider implements RouteProvider {
  abstract readonly name: string;
  protected readonly fetchImpl: typeof fetch;
  constructor(protected readonly config: HttpRouteConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
  }
  protected base(): string {
    return this.config.baseUrl.replace(/\/$/, '');
  }
  abstract calculateRoute(
    from: Coordinate,
    to: Coordinate,
    opts?: { geometry?: boolean },
  ): Promise<RouteResult>;
  async calculateETA(from: Coordinate, to: Coordinate): Promise<number | null> {
    return (await this.calculateRoute(from, to)).durationSeconds;
  }
}

/** OSRM: GET /route/v1/driving/{lng,lat;lng,lat}. */
export class OsrmRouteProvider extends HttpRouteProvider {
  readonly name = 'osrm';

  async calculateRoute(
    from: Coordinate,
    to: Coordinate,
    opts: { geometry?: boolean } = {},
  ): Promise<RouteResult> {
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const qs = `overview=${opts.geometry ? 'full' : 'false'}&geometries=geojson`;
    const body = await fetchJson<{
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
      }>;
    }>(
      this.fetchImpl,
      `${this.base()}/route/v1/driving/${coords}?${qs}`,
      {},
      this.config.timeoutMs,
      'osrm',
    );
    const route = body?.routes?.[0];
    if (body?.code !== 'Ok' || !route) {
      throw new LocationProviderError('BAD_RESPONSE', 'osrm: no usable route');
    }
    usable(route.distance, route.duration, 'osrm');
    return {
      distanceMeters: route.distance as number,
      durationSeconds: route.duration as number,
      method: 'route',
      ...(opts.geometry && route.geometry?.coordinates
        ? { geometry: route.geometry.coordinates }
        : {}),
    };
  }
}

/** GraphHopper: GET /route?point=lat,lng&point=lat,lng (distance m, time ms). */
export class GraphHopperRouteProvider extends HttpRouteProvider {
  readonly name = 'graphhopper';

  async calculateRoute(
    from: Coordinate,
    to: Coordinate,
    opts: { geometry?: boolean } = {},
  ): Promise<RouteResult> {
    const qs = new URLSearchParams({ profile: 'car', points_encoded: 'false' });
    qs.append('point', `${from.latitude},${from.longitude}`);
    qs.append('point', `${to.latitude},${to.longitude}`);
    qs.set('calc_points', opts.geometry ? 'true' : 'false');
    if (this.config.apiKey) qs.set('key', this.config.apiKey);
    const body = await fetchJson<{
      paths?: Array<{
        distance?: number;
        time?: number;
        points?: { coordinates?: Array<[number, number]> };
      }>;
    }>(this.fetchImpl, `${this.base()}/route?${qs}`, {}, this.config.timeoutMs, 'graphhopper');
    const path = body?.paths?.[0];
    if (!path) throw new LocationProviderError('BAD_RESPONSE', 'graphhopper: no path');
    usable(path.distance, path.time, 'graphhopper');
    return {
      distanceMeters: path.distance as number,
      durationSeconds: (path.time as number) / 1000,
      method: 'route',
      ...(opts.geometry && path.points?.coordinates ? { geometry: path.points.coordinates } : {}),
    };
  }
}

/** Valhalla: POST /route (summary.length km, summary.time s). */
export class ValhallaRouteProvider extends HttpRouteProvider {
  readonly name = 'valhalla';

  async calculateRoute(from: Coordinate, to: Coordinate): Promise<RouteResult> {
    const body = await fetchJson<{ trip?: { summary?: { length?: number; time?: number } } }>(
      this.fetchImpl,
      `${this.base()}/route${this.config.apiKey ? `?api_key=${encodeURIComponent(this.config.apiKey)}` : ''}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locations: [
            { lat: from.latitude, lon: from.longitude },
            { lat: to.latitude, lon: to.longitude },
          ],
          costing: 'auto',
          units: 'kilometers',
        }),
      },
      this.config.timeoutMs,
      'valhalla',
    );
    const s = body?.trip?.summary;
    if (!s) throw new LocationProviderError('BAD_RESPONSE', 'valhalla: no summary');
    usable(s.length, s.time, 'valhalla');
    return {
      distanceMeters: (s.length as number) * 1000,
      durationSeconds: s.time as number,
      method: 'route',
    };
  }
}

export type { HttpRouteConfig };
