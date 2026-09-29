import type { LocationFreshness } from './availability';
import type { PaymentInfo, DisputeInfo } from './trip-commerce';
import type { CallInfo } from './trip-comms';
import type { TripEventRecord } from './trip-events';
import type { TripFare, TripPlace, TripStatus, WaitingInfo } from './trip';

/**
 * Admin permissions — the one list. `DRIVER_LOCATION_VIEW` reveals exact driver coordinates;
 * `TRIP_CHAT_VIEW` reveals what was said in a trip's chat. Every use is written to the
 * admin access log. Without a permission the admin sees status and metadata only.
 */
export const ADMIN_PERMISSIONS = ['DRIVER_LOCATION_VIEW', 'TRIP_CHAT_VIEW'] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

/** Everything an admin needs to understand one trip, from the same authoritative records the apps use. */
export interface AdminTripDetail {
  id: string;
  status: TripStatus;
  requestedAt: string;
  matchedAt: string | null;
  arrivedAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  cancelledBy: string | null;
  /** The state the ride was cancelled from, and the fee the cancellation rules recorded. */
  cancelledFromStatus: TripStatus | null;
  cancellationFeeNpr: number;
  vehicleCategory: { code: string; label: string } | null;
  cancelReason: string | null;
  pickup: TripPlace;
  destination: TripPlace;
  fare: TripFare | null;
  passenger: { id: string; name: string | null };
  driver: { id: string; name: string | null } | null;
  /** Waiting as the apps see it right now (null when no wait is running). */
  waiting: WaitingInfo | null;
  location: {
    driverFreshness: LocationFreshness;
    lastUpdateAt: string | null;
    /** Only for admins holding DRIVER_LOCATION_VIEW. */
    driverPosition: { latitude: number; longitude: number; accuracyMeters: number | null } | null;
  };
  /** Every domain event, in order — the same records the apps announce from. */
  events: TripEventRecord[];
  /** Dispatch history: who was offered the ride and what they did. */
  offers: Array<{
    driverName: string | null;
    status: string;
    pickupDistanceMeters: number;
    offeredAt: string;
    respondedAt: string | null;
  }>;
  /** Communication status: call metadata (never media) and chat counts (never content here). */
  calls: CallInfo[];
  chat: { messageCount: number; canViewContent: boolean };
  payment: PaymentInfo | null;
  ratings: Array<{ raterRole: string; stars: number; comment: string | null }>;
  disputes: Array<DisputeInfo & { raisedByRole: 'PASSENGER' | 'DRIVER' }>;
}

export interface AdminDisputeRow extends DisputeInfo {
  raisedByRole: 'PASSENGER' | 'DRIVER';
  passengerName: string | null;
  driverName: string | null;
}
