/**
 * Live trip tracking types shared by the API, the realtime protocol and the
 * mobile apps. Every value a screen reader needs (distance, ETA, place,
 * status, freshness) is here as data — the map is never the source.
 */

import type { DriverAvailabilityStatus, LocationFreshness } from './availability';

export const TRIP_STATUSES = [
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

export const ACTIVE_TRIP_STATUSES: readonly TripStatus[] = [
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
];

export interface TripPlace {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

export interface TripSummary {
  id: string;
  status: TripStatus;
  pickup: TripPlace;
  destination: TripPlace;
  createdAt: string;
  arrivedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Which side the requesting user is on. */
  viewerRole: 'PASSENGER' | 'DRIVER';
}

/** live: fresh fix. stale: fix is old but recent enough to show with a warning. lost: treat as GPS lost. */
export type Freshness = 'live' | 'stale' | 'lost' | 'none';

export interface LiveParty {
  latitude: number;
  longitude: number;
  /** Device-reported horizontal accuracy in meters, when known. */
  accuracyMeters: number | null;
  /** Server receive time of the latest accepted fix. */
  updatedAt: string;
  ageSeconds: number;
  freshness: Freshness;
  /** Road or place near this position ("New Road"), from reverse geocoding. */
  placeName: string | null;
  placeKind: 'road' | 'place' | null;
  /** True when the place name is older than the position (geocoding failed or is pending). */
  placeStale: boolean;
}

/** Driver arrival ETA: only meaningful before pickup. */
export interface DriverArrivalInfo {
  distanceMeters: number;
  etaSeconds: number | null;
  basis: 'route' | 'estimate';
}

/** Trip ETA: only meaningful once the ride is in progress. */
export interface TripProgressInfo {
  distanceRemainingMeters: number;
  etaSeconds: number | null;
  basis: 'route' | 'estimate';
}

export interface LiveTripSnapshot {
  tripId: string;
  status: TripStatus;
  /** Monotonic per trip; clients drop anything <= the last one they applied. */
  eventId: number;
  serverTime: string;
  pickup: TripPlace;
  destination: TripPlace;
  /** Driver's position. Visible to the trip's passenger (and the driver) only while the trip is active. */
  driver: LiveParty | null;
  /** Passenger's position. Visible to the driver only while en route, and only if the passenger chose to share. */
  passenger: LiveParty | null;
  /** Present only while DRIVER_EN_ROUTE. */
  driverArrival: DriverArrivalInfo | null;
  /** Present only while IN_PROGRESS. */
  trip: TripProgressInfo | null;
  /** Present only while DRIVER_ARRIVED: how long the driver has been waiting. */
  waitingSeconds: number | null;
}

export type TripEventName =
  | 'DRIVER_ARRIVED'
  | 'TRIP_STARTED'
  | 'TRIP_COMPLETED'
  | 'TRIP_CANCELLED'
  | 'DRIVER_LOCATION_LOST'
  | 'DRIVER_LOCATION_RESTORED';

/** Client -> server realtime messages. */
export type ClientRealtimeMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; tripId: string }
  | { type: 'unsubscribe'; tripId: string }
  | {
      type: 'driver_location' | 'passenger_location';
      tripId: string;
      latitude: number;
      longitude: number;
      accuracyMeters?: number | null;
      /** Device clock, ms since epoch. Used for ordering and staleness, never trusted for "now". */
      deviceTimeMs: number;
    }
  | { type: 'stop_sharing'; tripId: string }
  /** Driver presence: the authenticated connection IS the driver; there is no driverId field. */
  | ({ type: 'location' } & DriverLocationSample)
  | { type: 'availability'; action: 'online'; location: DriverLocationSample }
  | { type: 'availability'; action: 'offline' }
  | { type: 'ping' };

/** One GPS reading from the driver's device. Only what matching and fraud checks need. */
export interface DriverLocationSample {
  latitude: number;
  longitude: number;
  accuracyMeters?: number | null;
  headingDegrees?: number | null;
  speedMps?: number | null;
  /** Device clock, ms. Used for ordering/staleness only; the server records its own receive time. */
  deviceTimeMs: number;
  /** Set when the platform reports a mocked/simulated location. Flagged, never trusted. */
  mockLocation?: boolean;
}

/** Server -> client realtime messages. */
export type ServerRealtimeMessage =
  | { type: 'authed'; userId: string; role: string }
  | { type: 'subscribed'; tripId: string }
  | { type: 'snapshot'; snapshot: LiveTripSnapshot }
  | {
      type: 'event';
      tripId: string;
      eventId: number;
      event: TripEventName;
      /** Assertive announcements only for genuinely important events. */
      important: boolean;
    }
  | { type: 'rejected'; tripId: string; reason: string }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' }
  | { type: 'availability'; status: DriverAvailabilityStatus }
  | { type: 'availability_error'; code: string; message: string }
  | {
      type: 'connection';
      status: 'connected' | 'superseded';
      updateIntervalMs: number;
    }
  | { type: 'location_ack'; receivedAt: string; freshness: LocationFreshness };
