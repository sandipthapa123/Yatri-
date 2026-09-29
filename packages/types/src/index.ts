/**
 * Foundational shared types for Yatri.
 *
 * Phase 1 scope only: identity, geography, and API envelope primitives that
 * every app (passenger, driver, admin, api) already needs. Ride/booking
 * domain types land in a later phase alongside that feature.
 */

export type UserRole = 'PASSENGER' | 'DRIVER' | 'ADMIN';
export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';

export * from './driver-verification';
export * from './location';
export * from './trip';
export * from './trip-events';
export * from './trip-commerce';
export * from './trip-comms';
export * from './realtime';
export * from './format';
export * from './admin';
export * from './availability';
export * from './geo';

/** Matches the API's PublicProfile response shape (GET/PATCH /users/me). */
export interface AppUser {
  id: string;
  role: UserRole;
  status: AccountStatus;
  fullName: string | null;
  phoneNumber: string | null;
  profilePictureUrl: string | null;
  createdAt: string;
}

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface ApiErrorShape {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ApiResponse<T> = { success: true; data: T } | { success: false; error: ApiErrorShape };

export type AppEnvironment = 'development' | 'staging' | 'production';
