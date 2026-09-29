import { API_BASE_URL } from '@yatri/mobile-auth';
import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { LiveTripController, type LiveTripState } from './liveTripController';
import { tripsApi } from './locationApi';
import { realtimeUrlFrom, type TripRealtimeClient } from './realtimeClient';
import type { Viewer } from './tripText';

export type { LiveTripState, SpokenMessage } from './liveTripController';

const WS_OVERRIDE = process.env.EXPO_PUBLIC_WS_URL;

const IDLE: LiveTripState = {
  snapshot: null,
  receivedAtMs: null,
  connection: 'closed',
  connectionNotice: '',
  polite: null,
  assertive: null,
  rejection: null,
};

/**
 * Live trip state for one trip: a socket that pushes snapshots (no polling,
 * no page refresh), the accessibility announcement decisions derived from
 * them, and the client handle used to send this device's location.
 */
export function useLiveTrip(
  tripId: string | null,
  getAccessToken: () => Promise<string>,
  viewer: Viewer,
): LiveTripState & { client: TripRealtimeClient | null } {
  const controller = useMemo(
    () =>
      tripId
        ? new LiveTripController({
            tripId,
            viewer,
            getToken: getAccessToken,
            url: realtimeUrlFrom(API_BASE_URL, WS_OVERRIDE),
            fetchInitial: async () => tripsApi.live(await getAccessToken(), tripId),
          })
        : null,
    [tripId, viewer, getAccessToken],
  );

  useEffect(() => {
    controller?.start();
    return () => controller?.stop();
  }, [controller]);

  const state = useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getState : getIdle,
  );
  return { ...state, client: controller?.client ?? null };
}

const noopSubscribe = () => () => undefined;
const getIdle = () => IDLE;
