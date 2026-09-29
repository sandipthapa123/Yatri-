import type { SelectedPlace } from '@yatri/mobile-location';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * The passenger's chosen pickup and destination for the ride they are
 * about to plan. Held in memory only (never persisted, never a location
 * history). Ride requests arrive in a later phase and will read from here.
 */
interface TripLocationsValue {
  pickup: SelectedPlace | null;
  destination: SelectedPlace | null;
  setPickup: (p: SelectedPlace | null) => void;
  setDestination: (p: SelectedPlace | null) => void;
}

const Ctx = createContext<TripLocationsValue | null>(null);

export function TripLocationsProvider({ children }: { children: ReactNode }) {
  const [pickup, setPickupState] = useState<SelectedPlace | null>(null);
  const [destination, setDestinationState] = useState<SelectedPlace | null>(null);
  const setPickup = useCallback((p: SelectedPlace | null) => setPickupState(p), []);
  const setDestination = useCallback((p: SelectedPlace | null) => setDestinationState(p), []);
  const value = useMemo(
    () => ({ pickup, destination, setPickup, setDestination }),
    [pickup, destination, setPickup, setDestination],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTripLocations(): TripLocationsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTripLocations must be used inside TripLocationsProvider');
  return v;
}
