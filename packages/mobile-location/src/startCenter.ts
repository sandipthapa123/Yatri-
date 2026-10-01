import type { PublicPlatformConfig } from '@yatri/types';

/**
 * Where a map should start: the centre of the first open city (else the first city), or null when none is configured (the
 * picker then starts on the whole country). Pure, so it is tested without the app.
 */
export function startCenterOf(config: Pick<PublicPlatformConfig, 'cities'> | null) {
  const city = config?.cities.find((c) => c.openNow) ?? config?.cities[0];
  return city ? { latitude: city.centerLatitude, longitude: city.centerLongitude } : null;
}
