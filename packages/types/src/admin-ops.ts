import type { AccountStatus, AppUser, UserRole } from './index';
import type { AdminPermission } from './admin';
import type { DriverAvailabilityState } from './availability';
import type { DriverStatus } from './driver-verification';
import type { IncidentCategory, IncidentStatus, AuditEntry } from './safety';
import type { PaymentStatus } from './trip-commerce';
import type { TripStatus } from './trip';

/**
 * Admin operations: the shapes of the operational dashboard, analytics, user/vehicle/finance/
 * notification/audit views and admin management. Every figure is computed by the API from the
 * authoritative tables (trips, trip_payments, users, driver_*, safety); nothing here is stored a
 * second time, and the admin app only displays what it is sent.
 */

/** Words for who a person is and where their account stands: shared by every screen that shows them. */
export const ROLE_LABELS: Record<UserRole, string> = {
  PASSENGER: 'Passenger',
  DRIVER: 'Driver',
  ADMIN: 'Administrator',
};
export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
};

// ---------------------------------------------------------------- date ranges

export const RANGE_PRESETS = ['today', '7d', '30d', '90d'] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_PRESET_LABELS: Record<RangePreset, string> = {
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};
/** The longest custom range a report will cover, so one request cannot scan the whole history. */
export const MAX_RANGE_DAYS = 366;

/** A resolved range: [from, to) in the platform's time zone; what every figure below covers. */
export interface ResolvedRange {
  from: string;
  to: string;
  label: string;
  timeZone: string;
}

// ---------------------------------------------------------------- who is signed in

export interface AdminMe extends AppUser {
  permissions: AdminPermission[];
}

// ---------------------------------------------------------------- live dashboard

export interface DashboardData {
  generatedAt: string;
  range: ResolvedRange;
  rides: {
    /** Rides in a live state right now (not limited to the range). */
    active: number;
    activeByStatus: Partial<Record<TripStatus, number>>;
    /** Rides requested in the range that ended in these ways. */
    completed: number;
    cancelled: number;
    noDrivers: number;
  };
  drivers: {
    /** Drivers whose availability is ONLINE right now. */
    online: number;
    /** Online drivers who can be offered a ride now (verified, fresh location, not on a ride). */
    available: number;
    onTrip: number;
    /** Online drivers whose last location is stale. */
    staleLocation: number;
    pendingVerification: number;
  };
  payments: Record<PaymentStatus, number>;
  safety: {
    openIncidents: number;
    activeSos: number;
    openDisputes: number;
  };
}

// ---------------------------------------------------------------- analytics

export interface DailyPoint {
  /** YYYY-MM-DD in the platform time zone. */
  day: string;
  requested: number;
  completed: number;
  cancelled: number;
  grossFaresNpr: number;
}

export interface AnalyticsData {
  generatedAt: string;
  range: ResolvedRange;
  rides: {
    requested: number;
    completed: number;
    cancelled: number;
    noDrivers: number;
    /** Requested rides in the range that were still live when this was read. */
    stillActive: number;
    /** completed / rides that reached an end; null when none did. Whole percent, one decimal. */
    completionRatePercent: number | null;
    cancellationRatePercent: number | null;
    daily: DailyPoint[];
  };
  money: {
    /** Sum of the final fares of completed rides. Yatri does not model a commission, so this is also what drivers earned. */
    grossFaresNpr: number;
    averageFareNpr: number | null;
    /** Cash confirmed as received. */
    collectedNpr: number;
    /** Completed rides whose cash has not been confirmed yet. */
    outstandingNpr: number;
    cancellationFeesNpr: number;
    driverEarningsNpr: number;
    /** Wallets and payouts are not part of the platform (cash only): said plainly, not shown as zero. */
    payouts: { supported: false; reason: string };
  };
  drivers: { active: number; newlyRegistered: number; ridesPerActiveDriver: number | null };
  passengers: { active: number; newlyRegistered: number; ridesPerActivePassenger: number | null };
  safety: {
    incidents: number;
    incidentsByCategory: Partial<Record<IncidentCategory, number>>;
    incidentsByStatus: Partial<Record<IncidentStatus, number>>;
    sosAlerts: number;
    disputes: number;
    lowRatings: number;
  };
  ratings: { average: number | null; count: number };
}

// ---------------------------------------------------------------- users

export type AdminSort = 'newest' | 'oldest' | 'name';
export const ADMIN_SORTS: readonly AdminSort[] = ['newest', 'oldest', 'name'];

export interface AdminUserRow {
  id: string;
  role: UserRole;
  status: AccountStatus;
  fullName: string | null;
  phoneNumber: string | null;
  email: string | null;
  createdAt: string;
  ridesCompleted: number;
}

export interface AdminUserDetail extends AdminUserRow {
  driverStatus: DriverStatus | null;
  ridesRequested: number;
  ridesCancelled: number;
  rating: { average: number | null; count: number };
  activeRide: { tripId: string; status: TripStatus } | null;
  /** What this admin may do to the account right now. */
  canSuspend: boolean;
  canReactivate: boolean;
  audit: AuditEntry[];
}

export interface AdminListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserStatusChangeBody {
  /** Why (kept in the audit log, and shown to the person only as "your account was suspended"). */
  reason: string;
}

// ---------------------------------------------------------------- vehicles

export interface AdminVehicleRow {
  id: string;
  driverId: string;
  driverName: string | null;
  categoryCode: string | null;
  categoryLabel: string | null;
  make: string;
  model: string;
  year: number | null;
  registrationNumber: string;
  verificationStatus: string;
  registrationExpiryDate: string | null;
  insuranceExpiryDate: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------- finance

export interface AdminPaymentRow {
  id: string;
  tripId: string;
  amountNpr: number;
  method: string;
  status: PaymentStatus;
  passengerName: string | null;
  driverName: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface FinanceSummary {
  range: ResolvedRange;
  byStatus: Record<PaymentStatus, { count: number; amountNpr: number }>;
  grossFaresNpr: number;
  collectedNpr: number;
  outstandingNpr: number;
  cancellationFeesNpr: number;
  wallets: { supported: false; reason: string };
  payouts: { supported: false; reason: string };
}

export interface DriverEarningsRow {
  driverId: string;
  driverName: string | null;
  rides: number;
  earnedNpr: number;
  collectedNpr: number;
  outstandingNpr: number;
}

export const FINANCE_NOT_SUPPORTED =
  'Yatri takes payment in cash, paid by the passenger straight to the driver. It holds no money, so there are no wallets or payouts to show.';

// ---------------------------------------------------------------- notifications

export interface NotificationSummary {
  range: ResolvedRange;
  total: number;
  read: number;
  unread: number;
  byType: Array<{ type: string; count: number }>;
}

/** A notification as operations see it: what and when, never the words sent to the person. */
export interface AdminNotificationRow {
  id: string;
  type: string;
  title: string;
  userName: string | null;
  userRole: UserRole | null;
  createdAt: string;
  read: boolean;
}

// ---------------------------------------------------------------- audit and admins

export interface AdminAuditRow extends AuditEntry {
  subjectType: string;
  subjectIds: string[];
}

export interface AdminAccountRow {
  id: string;
  fullName: string | null;
  email: string | null;
  status: AccountStatus;
  permissions: AdminPermission[];
  createdAt: string;
  isYou: boolean;
}

export interface SetPermissionsBody {
  permissions: AdminPermission[];
  reason: string;
}

// ---------------------------------------------------------------- vehicle categories

export interface AdminVehicleCategory {
  id: string;
  code: string;
  label: string;
  isActive: boolean;
  sortOrder: number;
  /** Null = use the platform default for that fare part. */
  baseFareNpr: number | null;
  perKmNpr: number | null;
  perMinuteNpr: number | null;
  minimumFareNpr: number | null;
  driversUsing: number;
}

export interface VehicleCategoryBody {
  label?: string;
  isActive?: boolean;
  sortOrder?: number;
  baseFareNpr?: number | null;
  perKmNpr?: number | null;
  perMinuteNpr?: number | null;
  minimumFareNpr?: number | null;
  reason: string;
}

export type { DriverAvailabilityState };

/**
 * The account-status moves an ADMIN may make (a person deactivating their own account is a
 * separate, final move that only they can make). Suspension is reversible; nothing else is.
 */
export const ACCOUNT_ADMIN_MOVES: Partial<Record<AccountStatus, AccountStatus>> = {
  ACTIVE: 'SUSPENDED',
  SUSPENDED: 'ACTIVE',
};
