import { createHash } from 'node:crypto';
import type { DistanceResult, PlaceSummary, ReverseGeocodeResult } from '@yatri/types';

import { env } from '../../config/env';
import { getRedisClient } from '../../config/redis';
import { HttpError } from '../../middleware/errorHandler';
import { roundCoordinate, type Coordinate } from './coordinates';
import { haversineMeters } from './geo';
import { getLocationProvider, getRouteProvider } from './providers';
import { LocationProviderError } from './providers/location-provider';
import { log } from '../../lib/logger';

/**
 * Maps any provider failure to a safe, user-understandable HttpError. The
 * provider's own message (which can contain URLs, keys or upstream detail)
 * is logged server-side and never returned.
 */
function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof LocationProviderError) {
    log.error(`Location provider failure (${err.kind}): ${err.message}`);
    if (err.kind === 'RATE_LIMITED' || err.kind === 'QUOTA') {
      return new HttpError(
        503,
        'LOCATION_PROVIDER_BUSY',
        'Location search is busy right now. Please try again in a moment.',
      );
    }
    return new HttpError(
      503,
      'LOCATION_PROVIDER_UNAVAILABLE',
      'We could not reach the location service. Please try again, or pick a saved place.',
    );
  }
  throw err;
}

function requireProvider() {
  const provider = getLocationProvider();
  if (!provider) {
    throw new HttpError(
      503,
      'LOCATION_PROVIDER_UNAVAILABLE',
      'Location search is not available right now.',
    );
  }
  return provider;
}

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const raw = await getRedisClient().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null; // a cache outage must never break location lookups
  }
}

async function cacheSet(key: string, value: unknown, ttlSeconds: number) {
  if (ttlSeconds <= 0) return;
  try {
    await getRedisClient().set(key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch {
    /* best effort */
  }
}

function hash(parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);
}

/** NFC-normalise (Devanagari composes differently across keyboards), collapse whitespace, lowercase. */
export function normalizeQuery(q: string): string {
  return q.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function searchPlaces(
  rawQuery: string,
  opts: { limit: number; near?: Coordinate },
): Promise<PlaceSummary[]> {
  const provider = requireProvider();
  const query = normalizeQuery(rawQuery);
  // Coarsen the bias point (~1 km) before it leaves the server or keys the cache:
  // search only needs "roughly where", not the user's exact position.
  const near = opts.near
    ? {
        latitude: roundCoordinate(opts.near.latitude, 2),
        longitude: roundCoordinate(opts.near.longitude, 2),
      }
    : undefined;

  const key = `loc:search:${hash([
    provider.name,
    query,
    String(opts.limit),
    near ? `${near.latitude},${near.longitude}` : '',
    env.LOCATION_COUNTRY_CODES.join(','),
  ])}`;
  const cached = await cacheGet<PlaceSummary[]>(key);
  if (cached) return cached;

  try {
    const results = await provider.search(query, { limit: opts.limit, near });
    await cacheSet(key, results, env.LOCATION_SEARCH_CACHE_TTL_SECONDS);
    return results;
  } catch (err) {
    throw toHttpError(err);
  }
}

export async function reverseGeocode(point: Coordinate): Promise<ReverseGeocodeResult> {
  const provider = requireProvider();
  // ~11 m cells: nearby taps reuse one provider call. Cache is keyed by place, never by user.
  const key = `loc:rev:${provider.name}:${roundCoordinate(point.latitude, 4)},${roundCoordinate(point.longitude, 4)}`;

  let result = await cacheGet<ReverseGeocodeResult>(key);
  if (!result) {
    try {
      result = await provider.reverseGeocode(point);
    } catch (err) {
      throw toHttpError(err);
    }
    if (!result) {
      throw new HttpError(
        404,
        'LOCATION_NOT_FOUND',
        'We could not find an address for that spot. You can still use it, or search for a nearby place.',
      );
    }
    await cacheSet(key, result, env.LOCATION_REVERSE_CACHE_TTL_SECONDS);
  }
  // Always echo the requested point, not the cached neighbour's.
  return {
    ...result,
    latitude: roundCoordinate(point.latitude),
    longitude: roundCoordinate(point.longitude),
  };
}

/**
 * Server-side authoritative distance. `route` asks the RouteProvider;
 * when the configured provider is straight-line only (or fails) the result
 * honestly reports `straight_line` rather than pretending to be a road distance.
 */
export async function calculateDistance(
  origin: Coordinate,
  destination: Coordinate,
  method: 'straight_line' | 'route',
): Promise<DistanceResult> {
  if (method === 'route') {
    try {
      const route = await getRouteProvider().calculateRoute(origin, destination);
      return {
        distanceMeters: Math.round(route.distanceMeters),
        distanceKm: Math.round(route.distanceMeters / 10) / 100,
        method: route.method,
        durationSeconds: route.durationSeconds === null ? null : Math.round(route.durationSeconds),
      };
    } catch (err) {
      if (!(err instanceof LocationProviderError)) throw err;
      log.error(`Route provider failure (${err.kind}); falling back to straight line`);
    }
  }
  const meters = haversineMeters(origin, destination);
  return {
    distanceMeters: Math.round(meters),
    distanceKm: Math.round(meters / 10) / 100,
    method: 'straight_line',
    durationSeconds: null,
  };
}
