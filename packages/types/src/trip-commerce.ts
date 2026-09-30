import type { TripPlace, TripSummary } from './trip';

/** Payment and rating definitions (ride problems and disputes are support tickets: see support.ts) — separate axes from trip status. */

export const PAYMENT_METHODS = ['CASH'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_STATUSES = ['PENDING', 'PAID', 'FAILED', 'VOID'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** Payment wording for lists and admin (a ride with no payment yet is NONE). One set of words. */
export const PAYMENT_STATUS_LABELS: Record<PaymentStatus | 'NONE', string> = {
  NONE: 'No payment yet',
  PENDING: 'Awaiting cash',
  PAID: 'Paid in cash',
  FAILED: 'Failed',
  VOID: 'Not due',
};

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
  /** 1 when normal pricing applies; above 1 when a pricing rule raised this ride's fare. */
  surgeMultiplier: number;
  /** The extra rupees the multiplier adds (0 at normal pricing); totalNpr includes it. */
  surgeNpr: number;
  /** The rule's name for the rider ("Airport rush"), null at normal pricing. */
  surgeLabel: string | null;
}

export const RATING_MIN = 1;
export const RATING_MAX = 5;
export const RATING_COMMENT_MAX = 500;

export interface RatingInput {
  stars: number;
  comment?: string | null;
}

export interface TripRequestBody {
  /** Code of the vehicle category (see `RideCategoryOption`). The server validates it. */
  vehicleCategory: string;
  pickup: { latitude: number; longitude: number; address: string; name?: string };
  destination: { latitude: number; longitude: number; address: string; name?: string };
  /**
   * The total the rider was shown and agreed to. It is never a price (the server prices the ride): it is
   * compared with the server's fare, and a difference (demand pricing changed) refuses the request with
   * the new fare so the rider confirms again.
   */
  confirmedTotalNpr?: number;
}

/** A vehicle category a passenger can ride in. Categories are reference data owned by the server. */
export interface VehicleCategoryInfo {
  code: string;
  label: string;
}

/**
 * One row of the category picker: what it would cost and whether a driver is available NOW near
 * the pickup. `available` is a yes/no — the passenger never learns who or how many drivers there are.
 */
export interface RideCategoryOption extends VehicleCategoryInfo {
  available: boolean;
  fare: FareBreakdown;
}

/** An estimate may omit the category: the server then prices the default one and returns them all. */
export type TripEstimateBody = Omit<TripRequestBody, 'vehicleCategory'> & {
  vehicleCategory?: string;
};

export interface FareEstimateResponse {
  /** The fare for the requested category (also present in `categories`). */
  fare: FareBreakdown;
  vehicleCategory: VehicleCategoryInfo;
  /** Every active category priced for this trip, so the picker needs no second request. */
  categories: RideCategoryOption[];
  pickup: TripPlace;
  destination: TripPlace;
  waitingRule: { freeSeconds: number; perMinuteNpr: number };
  /** Sentences about the places: for example the airport pickup point. Shown and read before confirming. */
  notices: string[];
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
  vehicleCategory: VehicleCategoryInfo | null;
  fareEstimateNpr: number;
  expiresAt: string;
  serverTime: string;
}

/** Admin views (same authoritative data, wider audience). */
export interface AdminTripRow {
  /** The final fare once completed, otherwise the estimate; null before either exists. */
  fareNpr: number | null;
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
