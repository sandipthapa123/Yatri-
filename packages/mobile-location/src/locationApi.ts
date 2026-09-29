import { authApi } from '@yatri/mobile-auth';
import type {
  DistanceResult,
  DriverAvailabilityStatus,
  DriverLocationSample,
  DriverLocation,
  LiveTripSnapshot,
  PlaceSummary,
  ReverseGeocodeResult,
  SavedPlace,
  SavedPlaceKind,
  TripSummary,
} from '@yatri/types';

/**
 * The only place mobile code talks to Yatri's location endpoints. Screens
 * and components call these — never fetch directly, and never a map vendor.
 */
export function searchPlaces(
  accessToken: string,
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<PlaceSummary[]> {
  const qs = new URLSearchParams({ q: query, limit: String(opts.limit ?? 6) });
  return authApi.request<PlaceSummary[]>(`/location/search?${qs}`, {
    accessToken,
    signal: opts.signal,
  });
}

export function reverseGeocode(
  accessToken: string,
  point: { latitude: number; longitude: number },
  signal?: AbortSignal,
): Promise<ReverseGeocodeResult> {
  const qs = new URLSearchParams({
    latitude: String(point.latitude),
    longitude: String(point.longitude),
  });
  return authApi.request<ReverseGeocodeResult>(`/location/reverse-geocode?${qs}`, {
    accessToken,
    signal,
  });
}

export function calculateDistance(
  accessToken: string,
  origin: { latitude: number; longitude: number },
  destination: { latitude: number; longitude: number },
): Promise<DistanceResult> {
  return authApi.request<DistanceResult>('/location/distance', {
    method: 'POST',
    accessToken,
    body: { origin, destination },
  });
}

export interface SavedPlaceInput {
  kind: SavedPlaceKind;
  name: string;
  label?: string | null;
  address?: string;
  latitude: number;
  longitude: number;
  city?: string | null;
  province?: string | null;
  country?: string | null;
}

export const savedPlacesApi = {
  list: (accessToken: string) =>
    authApi.request<SavedPlace[]>('/users/me/saved-places', { accessToken }),
  create: (accessToken: string, input: SavedPlaceInput) =>
    authApi.request<SavedPlace>('/users/me/saved-places', {
      method: 'POST',
      accessToken,
      body: input,
    }),
  update: (accessToken: string, id: string, patch: Partial<SavedPlaceInput>) =>
    authApi.request<SavedPlace>(`/users/me/saved-places/${id}`, {
      method: 'PATCH',
      accessToken,
      body: patch,
    }),
  remove: (accessToken: string, id: string) =>
    authApi.request<{ deleted: true }>(`/users/me/saved-places/${id}`, {
      method: 'DELETE',
      accessToken,
    }),
};

export const driverLocationApi = {
  share: (
    accessToken: string,
    fix: { latitude: number; longitude: number; accuracyMeters: number | null },
  ) =>
    authApi.request<DriverLocation>('/drivers/me/location', {
      method: 'PUT',
      accessToken,
      body: fix,
    }),
  clear: (accessToken: string) =>
    authApi.request<{ cleared: true }>('/drivers/me/location', {
      method: 'DELETE',
      accessToken,
    }),
};

export const tripsApi = {
  active: (accessToken: string) =>
    authApi.request<TripSummary | null>('/trips/active', { accessToken }),
  /** REST snapshot: first paint and fallback while the socket connects. */
  live: (accessToken: string, tripId: string) =>
    authApi.request<LiveTripSnapshot>(`/trips/${tripId}/live`, { accessToken }),
  act: (accessToken: string, tripId: string, action: 'arrived' | 'start' | 'complete' | 'cancel') =>
    authApi.request<TripSummary>(`/trips/${tripId}/${action}`, { method: 'POST', accessToken }),
};

export const driverAvailabilityApi = {
  status: (accessToken: string) =>
    authApi.request<DriverAvailabilityStatus>('/drivers/me/availability', { accessToken }),
  online: (accessToken: string, sample: DriverLocationSample) =>
    authApi.request<DriverAvailabilityStatus>('/drivers/me/availability/online', {
      method: 'POST',
      accessToken,
      body: sample,
    }),
  offline: (accessToken: string) =>
    authApi.request<DriverAvailabilityStatus>('/drivers/me/availability/offline', {
      method: 'POST',
      accessToken,
    }),
};
