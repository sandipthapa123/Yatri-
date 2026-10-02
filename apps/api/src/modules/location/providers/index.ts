import { env } from '../../../config/env';
import type { LocationProvider } from './location-provider';
import { MapboxGeocodingProvider } from './mapbox-provider';
import { NominatimProvider } from './nominatim-provider';
import {
  GraphHopperRouteProvider,
  HaversineRouteProvider,
  MapboxRouteProvider,
  OsrmRouteProvider,
  ValhallaRouteProvider,
  type RouteProvider,
} from './route-provider';
import { StaticLocationProvider } from './static-provider';

export interface LocationProviderConfig {
  LOCATION_PROVIDER: 'nominatim' | 'static' | 'none' | 'mapbox';
  MAPBOX_ACCESS_TOKEN?: string;
  MAPBOX_BASE_URL: string;
  LOCATION_PROVIDER_BASE_URL: string;
  LOCATION_PROVIDER_API_KEY?: string;
  LOCATION_PROVIDER_USER_AGENT: string;
  LOCATION_COUNTRY_CODES: string[];
  LOCATION_REQUEST_TIMEOUT_MS: number;
  LOCATION_ROUTING_PROVIDER: 'haversine' | 'osrm' | 'graphhopper' | 'valhalla' | 'mapbox';
  LOCATION_ROUTING_BASE_URL: string;
  LOCATION_ROUTING_API_KEY?: string;
}

/**
 * The provider registry. Choosing a vendor is configuration only: each case
 * builds an adapter that satisfies the same interface, and nothing outside
 * this folder ever imports an adapter class.
 */
export function createLocationProvider(
  c: LocationProviderConfig,
  fetchImpl?: typeof fetch,
): LocationProvider | null {
  switch (c.LOCATION_PROVIDER) {
    case 'nominatim':
      return new NominatimProvider({
        baseUrl: c.LOCATION_PROVIDER_BASE_URL,
        apiKey: c.LOCATION_PROVIDER_API_KEY,
        userAgent: c.LOCATION_PROVIDER_USER_AGENT,
        countryCodes: c.LOCATION_COUNTRY_CODES,
        timeoutMs: c.LOCATION_REQUEST_TIMEOUT_MS,
        fetchImpl,
      });
    case 'mapbox':
      return new MapboxGeocodingProvider({
        baseUrl: c.MAPBOX_BASE_URL,
        accessToken: c.MAPBOX_ACCESS_TOKEN ?? '',
        countryCodes: c.LOCATION_COUNTRY_CODES,
        timeoutMs: c.LOCATION_REQUEST_TIMEOUT_MS,
        fetchImpl,
      });
    case 'static':
      return new StaticLocationProvider();
    case 'none':
      return null;
  }
}

export function createRouteProvider(
  c: LocationProviderConfig,
  fetchImpl?: typeof fetch,
): RouteProvider {
  const http = {
    baseUrl: c.LOCATION_ROUTING_BASE_URL,
    apiKey: c.LOCATION_ROUTING_API_KEY,
    timeoutMs: c.LOCATION_REQUEST_TIMEOUT_MS,
    fetchImpl,
  };
  switch (c.LOCATION_ROUTING_PROVIDER) {
    case 'osrm':
      return new OsrmRouteProvider(http);
    case 'graphhopper':
      return new GraphHopperRouteProvider(http);
    case 'valhalla':
      return new ValhallaRouteProvider(http);
    case 'mapbox':
      return new MapboxRouteProvider({ ...http, baseUrl: c.MAPBOX_BASE_URL, apiKey: c.MAPBOX_ACCESS_TOKEN });
    case 'haversine':
      return new HaversineRouteProvider();
  }
}

let locationProvider: LocationProvider | null | undefined;
let routeProvider: RouteProvider | undefined;

/** Returns the configured geocoder, or null when LOCATION_PROVIDER=none. */
export function getLocationProvider(): LocationProvider | null {
  if (locationProvider === undefined) locationProvider = createLocationProvider(env);
  return locationProvider;
}

export function getRouteProvider(): RouteProvider {
  routeProvider ??= createRouteProvider(env);
  return routeProvider;
}

/** Test seam: install fakes (pass undefined to reset to the configured providers). */
export function setLocationProviderForTests(p: LocationProvider | null | undefined) {
  locationProvider = p;
}
export function setRouteProviderForTests(p: RouteProvider | undefined) {
  routeProvider = p;
}
