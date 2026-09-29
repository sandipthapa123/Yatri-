import { API_BASE_URL } from '@yatri/mobile-auth';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';

import { DriverPresenceController, type PresenceState } from './driverPresenceController';
import { expoLocationAdapter } from './expoLocationAdapter';
import { driverAvailabilityApi, reverseGeocode } from './locationApi';
import { realtimeUrlFrom, RealtimeClient } from './realtimeClient';

const WS_OVERRIDE = process.env.EXPO_PUBLIC_WS_URL;

/**
 * Wires the framework-free DriverPresenceController to the real device GPS,
 * the API and the realtime socket. The screen only renders `state` and calls
 * `goOnline` / `goOffline`.
 */
export function useDriverPresence(getAccessToken: () => Promise<string>) {
  const controller = useMemo(
    () =>
      new DriverPresenceController({
        location: expoLocationAdapter,
        api: {
          online: async (s) => driverAvailabilityApi.online(await getAccessToken(), s),
          offline: async () => driverAvailabilityApi.offline(await getAccessToken()),
          status: async () => driverAvailabilityApi.status(await getAccessToken()),
        },
        reverseGeocode: async (fix) => {
          const r = await reverseGeocode(await getAccessToken(), fix);
          return r.formattedAddress || r.name;
        },
        createClient: (h) =>
          new RealtimeClient({
            url: realtimeUrlFrom(API_BASE_URL, WS_OVERRIDE),
            getToken: getAccessToken,
            onConnection: h.onConnection,
            onMessage: h.onMessage,
          }),
      }),
    [getAccessToken],
  );

  useEffect(() => {
    void controller.restore();
    return () => controller.dispose();
  }, [controller]);

  const state: PresenceState = useSyncExternalStore(controller.subscribe, controller.getState);
  const goOnline = useCallback(() => void controller.goOnline(), [controller]);
  const goOffline = useCallback(() => void controller.goOffline(), [controller]);
  return { state, goOnline, goOffline, socket: controller };
}
