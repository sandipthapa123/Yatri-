/**
 * Driver availability — deliberately separate from trip/ride status. A driver
 * can be ONLINE and idle, or ONLINE and (in a later phase) assigned or on a
 * trip; those are different axes and never share an enum. Future states such
 * as ONLINE_AVAILABLE / ONLINE_ASSIGNED / ON_TRIP slot in as sub-states of
 * ONLINE without changing the persisted column (see availability.machine.ts).
 */
export type DriverAvailabilityState =
  'OFFLINE' | 'GOING_ONLINE' | 'ONLINE' | 'GOING_OFFLINE' | 'SUSPENDED' | 'UNAVAILABLE';

/** Age of the last accepted location: fresh (usable for matching), stale (not), none. */
export type LocationFreshness = 'fresh' | 'stale' | 'none';

/** Server-computed reasons a driver cannot go online right now (shown to the driver verbatim). */
export interface EligibilitySummary {
  eligible: boolean;
  reasons: string[];
}

export interface DriverAvailabilityStatus {
  state: DriverAvailabilityState;
  /** Why the server last moved the driver offline/unavailable, when it did (e.g. STALE_LOCATION). */
  reason: string | null;
  onlineSince: string | null;
  locationFreshness: LocationFreshness;
  /** Server receive time of the last accepted location. */
  lastLocationAt: string | null;
  lastLocationAgeSeconds: number | null;
  accuracyMeters: number | null;
  eligibility: EligibilitySummary;
  /** Configured update cadence, so the client never hard-codes it. */
  updateIntervalsMs: { idle: number; enRoute: number; onTrip: number };
  freshWithinSeconds: number;
}

export interface AdminDriverAvailabilityRow {
  driverId: string;
  name: string | null;
  verificationStatus: string;
  availabilityState: DriverAvailabilityState;
  online: boolean;
  lastLocationAt: string | null;
  locationFreshness: LocationFreshness;
  /** Present only for admins holding DRIVER_LOCATION_VIEW; null for everyone else. */
  location: { latitude: number; longitude: number; accuracyMeters: number | null } | null;
}

export interface AdminDriverAvailabilityResponse {
  items: AdminDriverAvailabilityRow[];
  total: number;
  canViewLocation: boolean;
}
