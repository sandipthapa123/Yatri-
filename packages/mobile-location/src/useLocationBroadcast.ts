import * as ExpoLocation from 'expo-location';
import { useEffect, useState } from 'react';

import { classifyPermission } from './permissions';
import type { TripRealtimeClient } from './realtimeClient';

export type BroadcastStatus =
  'idle' | 'starting' | 'active' | 'gps-lost' | 'denied' | 'blocked' | 'services-off' | 'error';

const GPS_LOST_AFTER_MS = 15_000;
const WATCHDOG_MS = 5_000;

export const BROADCAST_MESSAGES: Record<BroadcastStatus, string> = {
  idle: '',
  starting: 'Starting location sharing.',
  active: '',
  'gps-lost':
    'No GPS signal. Sharing has paused and will resume automatically. Move to an open area and keep Yatri open on screen.',
  denied: 'Location permission is needed to share your position on this trip.',
  blocked:
    'Location is turned off for Yatri. Open your phone settings and allow location, then return here.',
  'services-off': 'Your phone’s location service is off. Turn it on to share your position.',
  error: 'Location sharing could not start. Please try again.',
};

/**
 * Streams this device's GPS to the trip while `enabled`, and only then.
 * Foreground only: when the app is backgrounded the OS stops delivering
 * fixes (background tracking needs a separate, explicit permission and
 * task that this phase does not add), the watchdog reports `gps-lost`, and
 * the server independently marks the feed stale. Everything is released on
 * disable/unmount.
 */
export function useLocationBroadcast(opts: {
  client: TripRealtimeClient | null;
  kind: 'passenger_location';
  enabled: boolean;
}) {
  const { client, kind, enabled } = opts;
  const [state, setState] = useState<{ status: BroadcastStatus; accuracy: number | null }>({
    status: 'starting',
    accuracy: null,
  });

  useEffect(() => {
    if (!enabled || !client) return;
    let cancelled = false;
    let subscription: ExpoLocation.LocationSubscription | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let lastFixAt = Date.now();

    void (async () => {
      try {
        let perm = await ExpoLocation.getForegroundPermissionsAsync();
        if (!perm.granted) perm = await ExpoLocation.requestForegroundPermissionsAsync();
        const verdict = classifyPermission(perm);
        if (cancelled) return;
        if (verdict !== 'granted') {
          setState({ status: verdict, accuracy: null });
          return;
        }
        if (!(await ExpoLocation.hasServicesEnabledAsync())) {
          if (!cancelled) setState({ status: 'services-off', accuracy: null });
          return;
        }
        subscription = await ExpoLocation.watchPositionAsync(
          {
            accuracy: ExpoLocation.Accuracy.High,
            timeInterval: 2000, // ≥ 2 s apart: plenty for tracking, kind to battery and the server
            distanceInterval: 3,
          },
          (position) => {
            const { latitude, longitude, accuracy } = position.coords;
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
            lastFixAt = Date.now();
            client.sendLocation(kind, {
              latitude,
              longitude,
              accuracyMeters: accuracy !== null && Number.isFinite(accuracy) ? accuracy : null,
              deviceTimeMs: position.timestamp,
            });
            setState((prev) =>
              prev.status === 'active' && prev.accuracy === (accuracy ?? null)
                ? prev
                : { status: 'active', accuracy: accuracy ?? null },
            );
          },
        );
        if (cancelled) {
          subscription.remove();
          subscription = null;
          return;
        }
        watchdog = setInterval(() => {
          if (Date.now() - lastFixAt > GPS_LOST_AFTER_MS) {
            setState((prev) =>
              prev.status === 'gps-lost' ? prev : { ...prev, status: 'gps-lost' },
            );
          }
        }, WATCHDOG_MS);
      } catch {
        if (!cancelled) setState({ status: 'error', accuracy: null });
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
      if (watchdog) clearInterval(watchdog);
    };
  }, [enabled, client, kind]);

  return enabled ? state : { status: 'idle' as const, accuracy: null };
}
