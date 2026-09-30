import type { LocationFreshness } from './availability';
import type { PaymentInfo, DisputeInfo } from './trip-commerce';
import type { CallInfo } from './trip-comms';
import type { TripEventRecord } from './trip-events';
import type { TripFare, TripPlace, TripStatus, WaitingInfo } from './trip';

/**
 * Admin permissions — the one list, and the only way admin access is decided. An admin holds a set of
 * them; each admin route asks for exactly one (`requirePermission`). The three that reveal sensitive
 * data (`DRIVER_LOCATION_VIEW` exact coordinates, `TRIP_CHAT_VIEW` what was said, `SAFETY_REVIEW` SOS
 * alerts and incident reports) are also audited on every use. A MANAGE permission implies the matching
 * VIEW (`PERMISSION_IMPLIES`), stated once here.
 */
export const ADMIN_PERMISSIONS = [
  'OPERATIONS_VIEW',
  'DRIVERS_REVIEW',
  'RIDES_MANAGE',
  'DISPUTES_MANAGE',
  'USERS_VIEW',
  'USERS_MANAGE',
  'FINANCE_VIEW',
  'ANALYTICS_VIEW',
  'NOTIFICATIONS_VIEW',
  'SETTINGS_VIEW',
  'SETTINGS_MANAGE',
  'AUDIT_VIEW',
  'ADMINS_MANAGE',
  'DRIVER_LOCATION_VIEW',
  'TRIP_CHAT_VIEW',
  'SAFETY_REVIEW',
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

export const ADMIN_PERMISSION_LABELS: Record<AdminPermission, { label: string; help: string }> = {
  OPERATIONS_VIEW: {
    label: 'Live operations',
    help: 'The live dashboard, rides (active and past) and driver availability.',
  },
  DRIVERS_REVIEW: {
    label: 'Driver verification',
    help: 'Review applications, documents and vehicles; verify, reject or suspend a driver.',
  },
  RIDES_MANAGE: { label: 'Cancel rides', help: 'Cancel a stuck or disputed ride as an operator.' },
  DISPUTES_MANAGE: { label: 'Resolve disputes', help: 'Decide reported problems with a ride.' },
  USERS_VIEW: { label: 'View users', help: 'Search and read user accounts.' },
  USERS_MANAGE: { label: 'Manage users', help: 'Suspend and reactivate accounts.' },
  FINANCE_VIEW: {
    label: 'Financial data',
    help: 'Payments, collected cash and driver earnings. Every read is audited.',
  },
  ANALYTICS_VIEW: { label: 'Analytics', help: 'Ride, revenue, activity and safety metrics.' },
  NOTIFICATIONS_VIEW: {
    label: 'Notification monitoring',
    help: 'What was sent, by type and when (never the message text).',
  },
  SETTINGS_VIEW: { label: 'View settings', help: 'Read platform settings and vehicle categories.' },
  SETTINGS_MANAGE: {
    label: 'Change settings',
    help: 'Change fares, cancellation and waiting rules, availability, notifications and vehicle categories.',
  },
  AUDIT_VIEW: { label: 'Audit log', help: 'Read who did what across the platform.' },
  ADMINS_MANAGE: {
    label: 'Manage administrators',
    help: 'Grant and remove the permissions of other administrators.',
  },
  DRIVER_LOCATION_VIEW: {
    label: 'Exact driver locations',
    help: 'See driver coordinates. Every disclosure is audited.',
  },
  TRIP_CHAT_VIEW: {
    label: 'Ride conversations',
    help: 'Read what the two people on a ride said. Every read is audited.',
  },
  SAFETY_REVIEW: {
    label: 'Safety team',
    help: 'SOS alerts, incident reports and low ratings; notified when one arrives.',
  },
};

/** Holding the key means also holding what it implies. */
export const PERMISSION_IMPLIES: Partial<Record<AdminPermission, readonly AdminPermission[]>> = {
  USERS_MANAGE: ['USERS_VIEW'],
  SETTINGS_MANAGE: ['SETTINGS_VIEW'],
  RIDES_MANAGE: ['OPERATIONS_VIEW'],
  DRIVERS_REVIEW: ['OPERATIONS_VIEW'],
};

/** Whether a set of held permissions grants the one needed. The one rule; the API and the app use it. */
export function holdsPermission(
  held: readonly AdminPermission[],
  needed: AdminPermission,
): boolean {
  return held.some((h) => h === needed || PERMISSION_IMPLIES[h]?.includes(needed));
}

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
