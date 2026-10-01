import { authApi } from '@yatri/mobile-auth';
import type {
  DeviceSession,
  PreferencesResponse,
  RecentPlacesResponse,
  UpdatePreferencesBody,
} from '@yatri/types';

/** The only place the apps talk to the preferences, devices and recent-places endpoints (all the caller's own). */
type Token = string;

export const preferencesApi = {
  get: (t: Token) =>
    authApi.request<PreferencesResponse>('/users/me/preferences', { accessToken: t }),
  update: (t: Token, body: UpdatePreferencesBody) =>
    authApi.request<PreferencesResponse>('/users/me/preferences', {
      method: 'PATCH',
      accessToken: t,
      body,
    }),
  devices: (t: Token) => authApi.request<DeviceSession[]>('/users/me/devices', { accessToken: t }),
  signOutDevice: (t: Token, id: string) =>
    authApi.request<{ signedOut: true }>(`/users/me/devices/${id}`, {
      method: 'DELETE',
      accessToken: t,
    }),
  signOutOthers: (t: Token) =>
    authApi.request<{ signedOut: number }>('/users/me/devices/sign-out-others', {
      method: 'POST',
      accessToken: t,
    }),
  recentPlaces: (t: Token) =>
    authApi.request<RecentPlacesResponse>('/users/me/recent-places', { accessToken: t }),
  clearRecentPlaces: (t: Token) =>
    authApi.request<{ cleared: true }>('/users/me/recent-places/clear', {
      method: 'POST',
      accessToken: t,
    }),
};
export type PreferencesApi = typeof preferencesApi;
