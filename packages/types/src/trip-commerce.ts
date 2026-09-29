import type { TripPlace, TripSummary } from './trip';

/** Payment, rating and dispute definitions — separate axes from trip status. */

export const PAYMENT_METHODS = ['CASH'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAILED', 'VOID'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentInfo {
  tripId: string;
  amountNpr: number;
  method: PaymentMethod;
  status: PaymentStatus;
  paidAt: string | null;
}

/** Server-calculated fare estimate. Clients display these numbers; they never compute a fare. */
export interface FareBreakdown {
  currency: 'NPR';
  baseNpr: number;
  distanceNpr: number;
  timeNpr: number;
  minimumFareApplied: boolean;
  totalNpr: number;
  distanceMeters: number;
  durationSeconds: number | null;
  /** True when the distance/time came from a road route rather than the straight-line estimate. */
  routeBased: boolean;
}

export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const RATING_COMMENT_MAX = 500;

export interface RatingInput {
  stars: number;
  comment?: string | null;
}

export const DISPUTE_STATUSES = ['OPEN', 'RESOLVED', 'REJECTED'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const DISPUTE_REASON_MAX = 1000;

export interface DisputeInfo {
  id: string;
  tripId: string;
  status: DisputeStatus;
  reason: string;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TripRequestBody {
  pickup: { latitude: number; longitude: number; address: string; name?: string };
  destination: { latitude: number; longitude: number; address: string; name?: string };
}

export interface FareEstimateResponse {
  fare: FareBreakdown;
  pickup: TripPlace;
  destination: TripPlace;
  waitingRule: { freeSeconds: number; perMinuteNpr: number };
}

export interface TripHistoryPage {
  items: TripSummary[];
  total: number;
}

/** What a driver sees when the dispatcher offers them a ride. Pickup + destination only. */
export interface TripOfferInfo {
  offerId: string;
  tripId: string;
  pickup: TripPlace;
  destination: TripPlace;
  pickupDistanceMeters: number;
  tripDistanceMeters: number;
  fareEstimateNpr: number;
  expiresAt: string;
  serverTime: string;
}

/** Admin views (same authoritative data, wider audience). */
export interface AdminTripRow {
  id: string;
  status: TripSummary['status'];
  passengerName: string | null;
  driverName: string | null;
  pickupName: string;
  destinationName: string;
  requestedAt: string;
  endedAt: string | null;
  paymentStatus: TripSummary['paymentStatus'];
  openDisputes: number;
}
