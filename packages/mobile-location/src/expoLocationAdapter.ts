import * as ExpoLocation from 'expo-location';

import type { GpsFix, LocationAdapter } from './driverPresenceController';
import { classifyPermission } from './permissions';

function toFix(p: ExpoLocation.LocationObject): GpsFix {
  const c = p.coords;
  return {
    latitude: c.latitude,
    longitude: c.longitude,
    accuracyMeters: c.accuracy !== null && Number.isFinite(c.accuracy) ? c.accuracy : null,
    headingDegrees:
      c.heading !== null && Number.isFinite(c.heading) && c.heading >= 0 ? c.heading : null,
    speedMps: c.speed !== null && Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null,
    timestampMs: p.timestamp,
    // Android exposes whether the reading came from a mock provider; iOS has no such signal.
    mocked: (p as { mocked?: boolean }).mocked === true,
  };
}

/**
 * The only place the presence logic touches the device GPS. Accuracy policy:
 * one HIGH-accuracy reading to open the shift (so the server can verify it),
 * then BALANCED updates at the server-configured interval and only after the
 * driver has actually moved — never continuous maximum accuracy.
 */
export const expoLocationAdapter: LocationAdapter = {
  async ensurePermission() {
    let perm = await ExpoLocation.getForegroundPermissionsAsync();
    if (!perm.granted) perm = await ExpoLocation.requestForegroundPermissionsAsync();
    return classifyPermission(perm);
  },
  servicesEnabled: () => ExpoLocation.hasServicesEnabledAsync(),
  async getCurrent() {
    return toFix(
      await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.High }),
    );
  },
  async watch(opts, onFix) {
    const sub = await ExpoLocation.watchPositionAsync(
      {
        accuracy: ExpoLocation.Accuracy.Balanced,
        timeInterval: opts.intervalMs,
        distanceInterval: opts.distanceMeters,
      },
      (p) => onFix(toFix(p)),
    );
    return { remove: () => sub.remove() };
  },
};
