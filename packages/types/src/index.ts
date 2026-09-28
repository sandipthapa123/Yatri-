/**
 * Foundational shared types for Yatri.
 *
 * Phase 1 scope only: identity, geography, and API envelope primitives that
 * every app (passenger, driver, admin, api) already needs. Ride/booking
 * domain types land in a later phase alongside that feature.
 */

export type UserRole = 'passenger' | 'driver' | 'admin';

export interface AppUser {
  id: string;
  role: UserRole;
  fullName: string;
  phoneNumber: string;
  email?: string;
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
