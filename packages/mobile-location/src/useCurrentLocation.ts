import * as ExpoLocation from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking } from 'react-native';

import { classifyFixError, classifyPermission, type LocationIssue } from './permissions';

export interface LocationFix {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  timestamp: number;
}

export type CurrentLocationState =
  | { status: 'idle' }
  | { status: 'locating' }
  | { status: 'success'; fix: LocationFix }
  | { status: 'error'; issue: LocationIssue };

const FIX_TIMEOUT_MS = 15_000;

function isUsableFix(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

/**
 * One-shot GPS. Nothing here watches or tracks: `request()` asks for
 * permission if needed, takes ONE reading, and stops. Call it only in
 * response to a user action, after the UI has explained why.
 */
export function useCurrentLocation() {
  const [state, setState] = useState<CurrentLocationState>({ status: 'idle' });
  const mounted = useRef(true);
  const inFlight = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const set = useCallback((next: CurrentLocationState) => {
    if (mounted.current) setState(next);
  }, []);

  const request = useCallback(async (): Promise<LocationFix | null> => {
    if (inFlight.current) return null; // no duplicate GPS requests
    inFlight.current = true;
    set({ status: 'locating' });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      let permission = await ExpoLocation.getForegroundPermissionsAsync();
      if (!permission.granted) {
        permission = await ExpoLocation.requestForegroundPermissionsAsync();
      }
      const verdict = classifyPermission(permission);
      if (verdict !== 'granted') {
        set({ status: 'error', issue: verdict });
        return null;
      }
      if (!(await ExpoLocation.hasServicesEnabledAsync())) {
        set({ status: 'error', issue: 'services-off' });
        return null;
      }

      const position = await Promise.race([
        ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), FIX_TIMEOUT_MS);
        }),
      ]);
      const { latitude, longitude, accuracy } = position.coords;
      if (!isUsableFix(latitude, longitude)) {
        set({ status: 'error', issue: 'unavailable' });
        return null;
      }
      const fix: LocationFix = {
        latitude,
        longitude,
        accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
        timestamp: position.timestamp,
      };
      set({ status: 'success', fix });
      return fix;
    } catch (err) {
      set({ status: 'error', issue: classifyFixError(err) });
      return null;
    } finally {
      if (timer) clearTimeout(timer);
      inFlight.current = false;
    }
  }, [set]);

  const openSettings = useCallback(() => {
    void Linking.openSettings();
  }, []);

  const reset = useCallback(() => set({ status: 'idle' }), [set]);

  return { state, request, openSettings, reset };
}

/**
 * A position for an emergency: never asks for permission, never waits long. The last known fix if
 * there is a recent one, otherwise one fresh reading raced against a short timer. Null is fine —
 * an SOS is sent without a position rather than held up (the server has its own fallbacks).
 */
export async function quickFix(maxWaitMs = 3000): Promise<LocationFix | null> {
  try {
    const permission = await ExpoLocation.getForegroundPermissionsAsync();
    if (!permission.granted) return null;
    const last = await ExpoLocation.getLastKnownPositionAsync({ maxAge: 120_000 });
    const position =
      last ??
      (await Promise.race([
        ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), maxWaitMs)),
      ]));
    if (!position) return null;
    const { latitude, longitude, accuracy } = position.coords;
    if (!isUsableFix(latitude, longitude)) return null;
    return {
      latitude,
      longitude,
      accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
      timestamp: position.timestamp,
    };
  } catch {
    return null;
  }
}
