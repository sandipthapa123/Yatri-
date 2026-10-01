/**
 * The trip ("ride") domain: the ONE definition of trip statuses, places, summaries and the
 * live snapshot shared by the API, the realtime protocol and every app. Every value a screen
 * reader needs (distance, ETA, place, status, waiting, freshness) is data here — the map is
 * never the source. "Ride" in product language is `Trip` in code.
 *
 * Status is ONLY the physical progress of the journey. Payment, rating, chat and calls are
 * separate axes (see trip-commerce.ts / trip-comms.ts) and never share this enum.
 */

import type { LocationFreshness } from './availability';

export const TRIP_STATUSES = [
  /** Requested; the dispatcher is offering it to nearby drivers. */
  'SEARCHING',
  /** A driver accepted and is approaching the pickup (assigned + approaching). */
  'DRIVER_EN_ROUTE',
  /** The driver is at the pickup and waiting for the passenger. */
  'DRIVER_ARRIVED',
  /** The passenger is in the vehicle and the ride is under way. */
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
  /** Nobody accepted before the search deadline. */
  'NO_DRIVERS',
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

/** Neutral, third-person labels for any list or timeline (admin, history). Words, never colour alone. */
export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  SEARCHING: 'Searching for a driver',
  DRIVER_EN_ROUTE: 'Driver on the way',
  DRIVER_ARRIVED: 'Driver arrived, waiting',
  IN_PROGRESS: 'Ride in progress',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_DRIVERS: 'No drivers found',
};

/** Statuses in which the trip is still live (participants may act, location may be shared). */
export const ACTIVE_TRIP_STATUSES: readonly TripStatus[] = [
  'SEARCHING',
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
];

/** Statuses in which a driver is assigned to the trip. */
export const ASSIGNED_TRIP_STATUSES: readonly TripStatus[] = [
  'DRIVER_EN_ROUTE',
  'DRIVER_ARRIVED',
  'IN_PROGRESS',
];

/** Statuses in which a driver has been assigned but the ride has not started (waiting, arriving). */
export const WAITING_TRIP_STATUSES: readonly TripStatus[] = ['DRIVER_EN_ROUTE', 'DRIVER_ARRIVED'];

export const TERMINAL_TRIP_STATUSES: readonly TripStatus[] = [
  'COMPLETED',
  'CANCELLED',
  'NO_DRIVERS',
];

export type TripRole = 'PASSENGER' | 'DRIVER';

export interface TripPlace {
  name: string;
  address: string;
  latitude: number;
  longitude: number;
}

/** Fare figures are whole Nepalese rupees, always calculated by the server. */
export interface TripFare {
  estimateNpr: number;
  waitingChargeNpr: number;
  /** Set when the trip completes: estimate + waiting charge. */
  finalNpr: number | null;
  /** The distance the estimate was based on (server-calculated). */
  distanceMeters: number;
  /** What the ride actually measured — the inputs of the final fare. Null until the ride completes. */
  actualDistanceMeters: number | null;
  actualDurationSeconds: number | null;
}

export interface TripCounterpart {
  /** Display name only. Phone numbers are never exposed to the other party. */
  name: string | null;
  vehicle: { description: string; registrationNumber: string } | null;
  /** Average of received ratings (1–5), null until they have at least one. */
  rating: number | null;
  /** How many ratings that average is from. */
  ratingCount: number;
  /** The counterpart's profile photo, for the passenger only (a driver sees the passenger's name, not a photo). */
  photoUrl: string | null;
}

export type TripPaymentStatus = 'NONE' | 'PENDING' | 'PAID' | 'FAILED' | 'VOID';

/**
 * Set when the ride was booked for an organization. The rider and the driver are told, in the apps, that it
 * is a business ride and whether the organization pays (so no cash is collected). The booker is not a
 * participant of the ride: this is all either of them learns about the organization.
 */
export interface TripBusinessInfo {
  organizationName: string;
  purpose: string | null;
  /** True when the organization is billed: the driver collects nothing. */
  billedToOrganization: boolean;
  /** True when someone else booked it for the rider. */
  bookedByOther: boolean;
}

import type { TripAccessibility } from './accessibility';

export interface TripSummary {
  id: string;
  status: TripStatus;
  pickup: TripPlace;
  destination: TripPlace;
  requestedAt: string;
  matchedAt: string | null;
  arrivedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cancelReason: string | null;
  cancelledBy: 'PASSENGER' | 'DRIVER' | 'SYSTEM' | null;
  fare: TripFare | null;
  /** The other party, once matched. */
  counterpart: TripCounterpart | null;
  /** Which side the requesting user is on. */
  viewerRole: TripRole;
  paymentStatus: TripPaymentStatus;
  vehicleCategory: { code: string; label: string } | null;
  /**
   * What cancelling would cost right now under the server's cancellation rules (0 = free). Shown in
   * the confirmation; the apps never compute or restate the rule. Only set for the passenger of a live ride.
   */
  cancelFeeNpr: number;
  /** For a cancelled ride: the state it was cancelled from and the fee the rules recorded. */
  cancellation: { fromStatus: TripStatus; feeNpr: number } | null;
  /** True when this viewer has already rated the trip. */
  rated: boolean;
  /** Null for an ordinary ride. */
  business: TripBusinessInfo | null;
  /**
   * The passenger's stated needs and pickup instructions for this ride: set only for the passenger themselves and the
   * assigned driver, null for everyone else and for a ride with none.
   */
  accessibility: TripAccessibility | null;
}

/** live: fresh fix. stale: fix is old but recent enough to show with a warning. lost: treat as GPS lost. */
export type Freshness = 'live' | 'stale' | 'lost' | 'none';

export interface LiveParty {
  latitude: number;
  longitude: number;
  /** Device-reported horizontal accuracy in meters, when known. */
  accuracyMeters: number | null;
  /** Direction of travel in degrees (0 = north) when the device reports it. */
  headingDegrees: number | null;
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
  /** Share of the journey completed (0–100), from remaining vs starting distance. */
  progressPercent: number | null;
  basis: 'route' | 'estimate';
}

/** One waiting timer. The server owns `startedAt`; `seconds` is computed by the server at send time. */
export interface WaitingParty {
  startedAt: string;
  seconds: number;
  /** When the other party was last told about this wait. */
  notifiedAt: string | null;
}

export interface WaitingRule {
  /** Free grace period before waiting is charged. */
  freeSeconds: number;
  perMinuteNpr: number;
  /** After this long the driver may cancel as a passenger no-show. */
  noShowAfterSeconds: number;
}

/**
 * Authoritative waiting state. `driver` = the driver waiting at the pickup (DRIVER_ARRIVED);
 * `passenger` = the passenger waiting for the driver to arrive (DRIVER_EN_ROUTE). Both apps
 * render exactly this; nothing about waiting is computed on a device.
 */
export interface WaitingInfo {
  driver: WaitingParty | null;
  passenger: WaitingParty | null;
  rule: WaitingRule;
  /** Whether waiting currently affects the fare (only the driver's wait beyond the free period). */
  affectsFare: boolean;
  chargeableSeconds: number;
  chargeNpr: number;
}

export interface LiveTripSnapshot {
  tripId: string;
  status: TripStatus;
  /** Monotonic per trip; clients drop any snapshot with a lower version than the last applied. */
  version: number;
  /** Highest domain event sequence number that exists for this trip (see trip-events.ts). */
  lastEventSeq: number;
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
  /** Present while a wait is running (EN_ROUTE: passenger waiting; ARRIVED: driver waiting). */
  waiting: WaitingInfo | null;
}

export type { LocationFreshness };
