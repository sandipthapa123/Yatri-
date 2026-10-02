import type { Coordinate } from '../coordinates';
import { maneuverSentence, type Maneuver, type RoutePoint, type RouteStep } from '@yatri/types';

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
  /**
   * Turn-by-turn steps, only when requested and supported. Locations are [lat, lng]; the same shape for every vendor,
   * so nothing downstream knows which engine produced them.
   */
  steps?: RouteStep[];
  /** True only when the duration reflects live traffic (no bundled adapter can say so; a traffic provider would). */
  trafficAware?: boolean;
}

export interface RouteRequestOptions {
  geometry?: boolean;
  steps?: boolean;
}

/** What an adapter can do, so the rest of the system can say plainly what is and is not available. */
export interface RouteCapabilities {
  steps: boolean;
  /** Live-traffic durations. */
  traffic: boolean;
}

/**
 * Route abstraction. Fare calculation, driver matching and live-trip ETA
 * depend on this interface, not on a vendor.
 */
export interface RouteProvider {
  readonly name: string;
  readonly capabilities: RouteCapabilities;
  calculateRoute(
    from: Coordinate,
    to: Coordinate,
    opts?: RouteRequestOptions,
  ): Promise<RouteResult>;
  calculateETA(from: Coordinate, to: Coordinate): Promise<number | null>;
}

export class HaversineRouteProvider implements RouteProvider {
  readonly name = 'haversine';
  readonly capabilities: RouteCapabilities = { steps: false, traffic: false };
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

/** Vendor words for a turn become the one list of maneuvers. */
function modifierManeuver(modifier: string | undefined): Maneuver {
  switch (modifier) {
    case 'left':
      return 'left';
    case 'right':
      return 'right';
    case 'slight left':
      return 'slight-left';
    case 'slight right':
      return 'slight-right';
    case 'sharp left':
      return 'sharp-left';
    case 'sharp right':
      return 'sharp-right';
    case 'uturn':
      return 'uturn';
    case 'straight':
      return 'straight';
    default:
      return 'other';
  }
}

function osrmManeuver(type: string | undefined, modifier: string | undefined): Maneuver {
  switch (type) {
    case 'depart':
      return 'depart';
    case 'arrive':
      return 'arrive';
    case 'roundabout':
    case 'rotary':
    case 'roundabout turn':
      return 'roundabout';
    case 'merge':
      return 'merge';
    default:
      return modifierManeuver(modifier);
  }
}

function graphHopperManeuver(sign: number | undefined): Maneuver {
  switch (sign) {
    case -98:
    case -8:
      return 'uturn';
    case -3:
      return 'sharp-left';
    case -2:
      return 'left';
    case -1:
    case -7:
      return 'slight-left';
    case 0:
      return 'straight';
    case 1:
    case 7:
      return 'slight-right';
    case 2:
      return 'right';
    case 3:
      return 'sharp-right';
    case 4:
      return 'arrive';
    case 6:
      return 'roundabout';
    default:
      return 'other';
  }
}

function valhallaManeuver(type: number | undefined): Maneuver {
  switch (type) {
    case 1:
    case 2:
    case 3:
      return 'depart';
    case 4:
    case 5:
    case 6:
      return 'arrive';
    case 7:
    case 8:
      return 'straight';
    case 9:
      return 'slight-right';
    case 10:
      return 'right';
    case 11:
      return 'sharp-right';
    case 12:
    case 13:
      return 'uturn';
    case 14:
      return 'sharp-left';
    case 15:
      return 'left';
    case 16:
      return 'slight-left';
    case 25:
      return 'merge';
    case 26:
    case 27:
      return 'roundabout';
    default:
      return 'other';
  }
}

/** A Valhalla shape is a polyline at 6 decimals. */
export function decodePolyline6(encoded: string): RoutePoint[] {
  const out: RoutePoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1] as const) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20 && index <= encoded.length);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    out.push([lat / 1e6, lng / 1e6]);
  }
  return out;
}

const cleanRoad = (name: unknown): string | null =>
  typeof name === 'string' && name.trim() !== '' ? name.trim() : null;

abstract class HttpRouteProvider implements RouteProvider {
  abstract readonly name: string;
  abstract readonly capabilities: RouteCapabilities;
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
    opts?: RouteRequestOptions,
  ): Promise<RouteResult>;
  async calculateETA(from: Coordinate, to: Coordinate): Promise<number | null> {
    return (await this.calculateRoute(from, to)).durationSeconds;
  }
}

/** OSRM: GET /route/v1/driving/{lng,lat;lng,lat}. */
export class OsrmRouteProvider extends HttpRouteProvider {
  readonly name: string = 'osrm';
  readonly capabilities: RouteCapabilities = { steps: true, traffic: false };

  /** The one place the request address is built, so an OSRM-compatible vendor only changes this. */
  protected routeUrl(coords: string, qs: string): string {
    return `${this.base()}/route/v1/driving/${coords}?${qs}`;
  }

  async calculateRoute(
    from: Coordinate,
    to: Coordinate,
    opts: RouteRequestOptions = {},
  ): Promise<RouteResult> {
    const coords = `${from.longitude},${from.latitude};${to.longitude},${to.latitude}`;
    const qs = `overview=${opts.geometry ? 'full' : 'false'}&geometries=geojson&steps=${opts.steps ? 'true' : 'false'}`;
    const body = await fetchJson<{
      code?: string;
      routes?: Array<{
        distance?: number;
        duration?: number;
        geometry?: { coordinates?: Array<[number, number]> };
        legs?: Array<{
          steps?: Array<{
            distance?: number;
            duration?: number;
            name?: string;
            maneuver?: { type?: string; modifier?: string; location?: [number, number] };
          }>;
        }>;
      }>;
    }>(
      this.fetchImpl,
      this.routeUrl(coords, qs),
      {},
      this.config.timeoutMs,
      this.name,
    );
    const route = body?.routes?.[0];
    if (body?.code !== 'Ok' || !route) {
      throw new LocationProviderError('BAD_RESPONSE', 'osrm: no usable route');
    }
    usable(route.distance, route.duration, this.name);
    const steps: RouteStep[] = opts.steps
      ? (route.legs ?? []).flatMap((leg) =>
          (leg.steps ?? []).flatMap((st) => {
            const loc = st.maneuver?.location;
            if (!loc || typeof st.distance !== 'number' || typeof st.duration !== 'number')
              return [];
            const maneuver = osrmManeuver(st.maneuver?.type, st.maneuver?.modifier);
            const road = cleanRoad(st.name);
            return [
              {
                instruction: maneuverSentence(maneuver, road),
                maneuver,
                distanceMeters: st.distance,
                durationSeconds: st.duration,
                road,
                location: [loc[1], loc[0]] as RoutePoint,
              },
            ];
          }),
        )
      : [];
    return {
      distanceMeters: route.distance as number,
      durationSeconds: route.duration as number,
      method: 'route',
      trafficAware: this.capabilities.traffic,
      ...(opts.geometry && route.geometry?.coordinates
        ? { geometry: route.geometry.coordinates }
        : {}),
      ...(opts.steps && steps.length > 0 ? { steps } : {}),
    };
  }
}

/**
 * Mapbox Directions speaks the same JSON as OSRM, so it reuses every line of OsrmRouteProvider (steps, maneuvers, geometry)
 * and differs only in the address, the access token and that its `driving-traffic` profile reflects live traffic.
 */
export class MapboxRouteProvider extends OsrmRouteProvider {
  override readonly name = 'mapbox';
  override readonly capabilities: RouteCapabilities = { steps: true, traffic: true };

  protected override routeUrl(coords: string, qs: string): string {
    const base = this.config.baseUrl.replace(/\/$/, '');
    return `${base}/directions/v5/mapbox/driving-traffic/${coords}?${qs}&access_token=${encodeURIComponent(this.config.apiKey ?? '')}`;
  }
}

/** GraphHopper: GET /route?point=lat,lng&point=lat,lng (distance m, time ms). */
export class GraphHopperRouteProvider extends HttpRouteProvider {
  readonly name = 'graphhopper';
  readonly capabilities: RouteCapabilities = { steps: true, traffic: false };

  async calculateRoute(
    from: Coordinate,
    to: Coordinate,
    opts: RouteRequestOptions = {},
  ): Promise<RouteResult> {
    const qs = new URLSearchParams({ profile: 'car', points_encoded: 'false' });
    qs.append('point', `${from.latitude},${from.longitude}`);
    qs.append('point', `${to.latitude},${to.longitude}`);
    // Steps are located by their index into the line, so they need the line too.
    qs.set('calc_points', opts.geometry || opts.steps ? 'true' : 'false');
    if (opts.steps) qs.set('instructions', 'true');
    if (this.config.apiKey) qs.set('key', this.config.apiKey);
    const body = await fetchJson<{
      paths?: Array<{
        distance?: number;
        time?: number;
        points?: { coordinates?: Array<[number, number]> };
        instructions?: Array<{
          text?: string;
          street_name?: string;
          distance?: number;
          time?: number;
          sign?: number;
          interval?: [number, number];
        }>;
      }>;
    }>(this.fetchImpl, `${this.base()}/route?${qs}`, {}, this.config.timeoutMs, 'graphhopper');
    const path = body?.paths?.[0];
    if (!path) throw new LocationProviderError('BAD_RESPONSE', 'graphhopper: no path');
    usable(path.distance, path.time, 'graphhopper');
    const line = path.points?.coordinates ?? [];
    const steps: RouteStep[] = opts.steps
      ? (path.instructions ?? []).flatMap((ins) => {
          const at = line[ins.interval?.[0] ?? 0];
          if (!at || typeof ins.distance !== 'number' || typeof ins.time !== 'number') return [];
          const maneuver = graphHopperManeuver(ins.sign);
          const road = cleanRoad(ins.street_name);
          return [
            {
              instruction: maneuverSentence(maneuver, road),
              maneuver,
              distanceMeters: ins.distance,
              durationSeconds: ins.time / 1000,
              road,
              location: [at[1], at[0]] as RoutePoint,
            },
          ];
        })
      : [];
    return {
      distanceMeters: path.distance as number,
      durationSeconds: (path.time as number) / 1000,
      method: 'route',
      trafficAware: false,
      ...(opts.geometry && path.points?.coordinates ? { geometry: path.points.coordinates } : {}),
      ...(opts.steps && steps.length > 0 ? { steps } : {}),
    };
  }
}

/** Valhalla: POST /route (summary.length km, summary.time s). */
export class ValhallaRouteProvider extends HttpRouteProvider {
  readonly name = 'valhalla';
  readonly capabilities: RouteCapabilities = { steps: true, traffic: false };

  async calculateRoute(
    from: Coordinate,
    to: Coordinate,
    opts: RouteRequestOptions = {},
  ): Promise<RouteResult> {
    const body = await fetchJson<{
      trip?: {
        summary?: { length?: number; time?: number };
        legs?: Array<{
          shape?: string;
          maneuvers?: Array<{
            instruction?: string;
            type?: number;
            length?: number;
            time?: number;
            begin_shape_index?: number;
            street_names?: string[];
          }>;
        }>;
      };
    }>(
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
    const leg = body?.trip?.legs?.[0];
    const shape = leg?.shape ? decodePolyline6(leg.shape) : [];
    const steps: RouteStep[] = opts.steps
      ? (leg?.maneuvers ?? []).flatMap((m) => {
          const at = shape[m.begin_shape_index ?? 0];
          if (!at || typeof m.length !== 'number' || typeof m.time !== 'number') return [];
          const maneuver = valhallaManeuver(m.type);
          const road = cleanRoad(m.street_names?.[0]);
          return [
            {
              instruction: maneuverSentence(maneuver, road),
              maneuver,
              distanceMeters: m.length * 1000,
              durationSeconds: m.time,
              road,
              location: at,
            },
          ];
        })
      : [];
    return {
      distanceMeters: (s.length as number) * 1000,
      durationSeconds: s.time as number,
      method: 'route',
      trafficAware: false,
      // Valhalla gives [lat, lng]; the abstraction's geometry is GeoJSON-style [lng, lat].
      ...(opts.geometry && shape.length > 0
        ? { geometry: shape.map((p) => [p[1], p[0]] as [number, number]) }
        : {}),
      ...(opts.steps && steps.length > 0 ? { steps } : {}),
    };
  }
}

export type { HttpRouteConfig };
