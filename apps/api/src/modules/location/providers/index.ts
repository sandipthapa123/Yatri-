import { env } from '../../../config/env';
import type { LocationProvider } from './location-provider';
import { NominatimProvider } from './nominatim-provider';
import { HaversineRouteProvider, OsrmRouteProvider, type RouteProvider } from './route-provider';

let locationProvider: LocationProvider | null | undefined;
let routeProvider: RouteProvider | undefined;

/** Returns the configured geocoder, or null when LOCATION_PROVIDER=none. */
export function getLocationProvider(): LocationProvider | null {
  if (locationProvider === undefined) {
    locationProvider =
      env.LOCATION_PROVIDER === 'nominatim'
        ? new NominatimProvider({
            baseUrl: env.LOCATION_PROVIDER_BASE_URL,
            apiKey: env.LOCATION_PROVIDER_API_KEY,
            userAgent: env.LOCATION_PROVIDER_USER_AGENT,
            countryCodes: env.LOCATION_COUNTRY_CODES,
            timeoutMs: env.LOCATION_REQUEST_TIMEOUT_MS,
          })
        : null;
  }
  return locationProvider;
}

export function getRouteProvider(): RouteProvider {
  routeProvider ??=
    env.LOCATION_ROUTING_PROVIDER === 'osrm'
      ? new OsrmRouteProvider({
          baseUrl: env.LOCATION_ROUTING_BASE_URL,
          timeoutMs: env.LOCATION_REQUEST_TIMEOUT_MS,
        })
      : new HaversineRouteProvider();
  return routeProvider;
}

/** Test seam: install fakes (pass undefined to reset to the configured providers). */
export function setLocationProviderForTests(p: LocationProvider | null | undefined) {
  locationProvider = p;
}
export function setRouteProviderForTests(p: RouteProvider | undefined) {
  routeProvider = p;
}
