import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { LiveTripSnapshot } from '@yatri/types';

import { tripsApi } from './locationApi';
import { NavigationController, type NavigationState } from './navigationController';

const IDLE: NavigationState = { route: null, guidance: null, stale: false, polite: null };
const noopSubscribe = () => () => undefined;
const getIdle = () => IDLE;

/**
 * The driver's navigation for one ride. It follows the live snapshot the ride room already has (no second socket, no
 * polling): when the server's route version changes it fetches the route once. `enabled` is false for the passenger,
 * who never receives a route. Call `refresh` when the app returns to the foreground or the connection comes back.
 */
export function useNavigation(
  tripId: string | null,
  enabled: boolean,
  snapshot: LiveTripSnapshot | null,
  getAccessToken: () => Promise<string>,
): { state: NavigationState; refresh: () => void } {
  const controller = useMemo(
    () =>
      tripId && enabled
        ? new NavigationController({
            fetchRoute: async (version) =>
              tripsApi.navigation(await getAccessToken(), tripId, version),
          })
        : null,
    [tripId, enabled, getAccessToken],
  );
  useEffect(() => () => controller?.dispose(), [controller]);
  useEffect(() => {
    controller?.onSnapshot(snapshot);
  }, [controller, snapshot]);

  const state = useSyncExternalStore(
    controller ? controller.subscribe : noopSubscribe,
    controller ? controller.getState : getIdle,
    getIdle,
  );
  return { state, refresh: () => controller?.refresh() };
}
