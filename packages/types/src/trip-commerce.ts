import type { TripAccessibilityRequest } from './accessibility';
import type { PromotionQuote, PromotionRequest } from './growth';
import type { TripPlace, TripSummary } from './trip';

/** Payment and rating definitions (ride problems and disputes are support tickets: see support.ts) — separate axes from trip status. */

/** CASH: the driver collects it. ORGANIZATION: billed to the rider's organization on a monthly statement. */
export const PAYMENT_METHODS = ['CASH', 'ORGANIZATION'] as const;
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

/**
 * Words for a payment, from its method and status (a ride billed to an organization is never "awaiting cash").
 * Prefer this to PAYMENT_STATUS_LABELS wherever the method is known.
 */
export function describePayment(
  method: PaymentMethod | null,
  status: PaymentStatus | 'NONE',
): string {
  if (method === 'ORGANIZATION') {
    if (status === 'PENDING') return 'Billed to the organization';
    if (status === 'PAID') return 'Paid by the organization';
  }
  return PAYMENT_STATUS_LABELS[status];
}

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
  /**
   * This ride's accessibility needs and pickup instructions. Left out, the passenger's saved profile is used (nothing
   * is ever inferred); given, it replaces the profile for this ride only.
   */
  accessibility?: TripAccessibilityRequest;
}

/** A vehicle category a passenger can ride in. Categories are reference data owned by the server. */
export interface VehicleCategoryInfo {
  /** A promo or coupon code and whether to use reward points: the server decides what, if anything, they take off. */
  promotion?: PromotionRequest;
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
  /** What the rider would pay after offers and points, worked out by the server. Null when nothing applies. */
  promotion: PromotionQuote | null;
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
  /** What the vehicle must have for this ride ("Wheelchair accessible vehicle"); never anything about the person. */
  vehicleNeeds: string[];
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
  /** How it is paid, so the words fit (an organization-billed ride is not awaiting cash). Null before a payment exists. */
  paymentMethod: PaymentMethod | null;
  /** The organization a business ride was booked for. */
  organizationName: string | null;
  openDisputes: number;
}
