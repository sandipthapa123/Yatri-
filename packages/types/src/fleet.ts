import type { AuditEntry } from './safety';

/**
 * Fleet and driver operations: the state models, their legal moves, and the words, defined once. There is
 * one authoritative model for each concept, and they are kept apart on purpose:
 *
 *  - ACCOUNT status (active, suspended, deactivated): `users.status`, owned by the account system.
 *  - VERIFICATION status (application, documents reviewed, verified): `driver_profiles.status`.
 *  - OPERATIONAL status (active, restricted, suspended by operations): `driver_profiles.operational_status`,
 *    below. It can be lifted without re-verifying, and a restriction has a real effect (a daily ride cap).
 *  - AVAILABILITY state (online, offline, ...): the availability machine.
 *  - RIDE status: the trip machine.
 *  - VEHICLE LIFECYCLE (active ... retired): `vehicles.lifecycle_status`, below; separate from the
 *    vehicle's verification (`verification_status`, an admin review of its papers).
 *
 * Who drives which vehicle has ONE source: `vehicles.driver_user_id`. Documents stay in the document
 * system; this adds no second store for them.
 */

// ---------------------------------------------------------------- vehicle lifecycle

export const VEHICLE_LIFECYCLE_STATES = [
  'ACTIVE',
  'INACTIVE',
  'MAINTENANCE',
  'SUSPENDED',
  'RETIRED',
] as const;
export type VehicleLifecycle = (typeof VEHICLE_LIFECYCLE_STATES)[number];

/** RETIRED is final. Only ACTIVE vehicles are offered for rides. */
export const VEHICLE_LIFECYCLE_TRANSITIONS: Record<VehicleLifecycle, readonly VehicleLifecycle[]> =
  {
    ACTIVE: ['INACTIVE', 'MAINTENANCE', 'SUSPENDED', 'RETIRED'],
    INACTIVE: ['ACTIVE', 'MAINTENANCE', 'SUSPENDED', 'RETIRED'],
    MAINTENANCE: ['ACTIVE', 'INACTIVE', 'SUSPENDED', 'RETIRED'],
    SUSPENDED: ['ACTIVE', 'INACTIVE', 'MAINTENANCE', 'RETIRED'],
    RETIRED: [],
  };
export const canVehicleTransition = (from: VehicleLifecycle, to: VehicleLifecycle) =>
  VEHICLE_LIFECYCLE_TRANSITIONS[from].includes(to);
export const vehicleLifecycleLeadingTo = (to: VehicleLifecycle): VehicleLifecycle[] =>
  VEHICLE_LIFECYCLE_STATES.filter((from) => canVehicleTransition(from, to));

export const VEHICLE_LIFECYCLE_LABELS: Record<VehicleLifecycle, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  MAINTENANCE: 'In maintenance',
  SUSPENDED: 'Suspended',
  RETIRED: 'Retired',
};

/** The vehicle state in words for the driver it is assigned to (also the notification). */
export function describeVehicleLifecycle(registration: string, to: VehicleLifecycle): string {
  switch (to) {
    case 'ACTIVE':
      return `Vehicle ${registration} is active and can be used for rides.`;
    case 'INACTIVE':
      return `Vehicle ${registration} is inactive and cannot be used for rides until it is made active.`;
    case 'MAINTENANCE':
      return `Vehicle ${registration} is in maintenance and cannot be used for rides until it is back.`;
    case 'SUSPENDED':
      return `Vehicle ${registration} is suspended and cannot be used for rides. Contact your operator.`;
    case 'RETIRED':
      return `Vehicle ${registration} has been retired and can no longer be used.`;
  }
}

// ---------------------------------------------------------------- driver operational status

export const OPERATIONAL_STATES = ['ACTIVE', 'RESTRICTED', 'SUSPENDED'] as const;
export type OperationalStatus = (typeof OPERATIONAL_STATES)[number];

/**
 * ACTIVE: no operational limit. RESTRICTED: may drive, but only up to the restricted daily ride cap.
 * SUSPENDED: no rides at all until reinstated. Moving back to ACTIVE is the reinstatement; none of it touches
 * the account, the verification or the availability models.
 */
export const OPERATIONAL_TRANSITIONS: Record<OperationalStatus, readonly OperationalStatus[]> = {
  ACTIVE: ['RESTRICTED', 'SUSPENDED'],
  RESTRICTED: ['ACTIVE', 'SUSPENDED'],
  SUSPENDED: ['ACTIVE', 'RESTRICTED'],
};
export const canOperationalTransition = (from: OperationalStatus, to: OperationalStatus) =>
  OPERATIONAL_TRANSITIONS[from].includes(to);

export const OPERATIONAL_LABELS: Record<OperationalStatus, string> = {
  ACTIVE: 'Active',
  RESTRICTED: 'Restricted',
  SUSPENDED: 'Suspended by operations',
};

export function describeOperationalStatus(
  from: OperationalStatus,
  to: OperationalStatus,
  reason: string | null,
  until: string | null,
): string {
  const why = reason ? ` Reason: ${reason}.` : '';
  const when = until ? ` This lasts until ${new Date(until).toLocaleDateString()}.` : '';
  if (to === 'ACTIVE') {
    return from === 'ACTIVE'
      ? 'Your driver status is active.'
      : 'You have been reinstated. You can go online and take rides again.';
  }
  if (to === 'RESTRICTED') {
    return `Your driving has been restricted: you can take a limited number of rides a day.${why}${when}`;
  }
  return `Your driving has been suspended by operations. You cannot take rides until you are reinstated.${why}${when}`;
}

// ---------------------------------------------------------------- fleets

export const FLEET_STATUSES = ['ACTIVE', 'INACTIVE', 'SUSPENDED'] as const;
export type FleetStatus = (typeof FLEET_STATUSES)[number];
export const FLEET_STATUS_LABELS: Record<FleetStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  SUSPENDED: 'Suspended',
};
/** While a fleet is not ACTIVE, its vehicles and drivers are not offered rides. */
export const FLEET_NAME_MAX = 100;

// ---------------------------------------------------------------- expiry monitoring

export const EXPIRY_KINDS = [
  'DRIVER_LICENCE',
  'DRIVER_DOCUMENT',
  'VEHICLE_DOCUMENT',
  'VEHICLE_REGISTRATION',
  'VEHICLE_INSURANCE',
  'VEHICLE_SERVICE',
] as const;
export type ExpiryKind = (typeof EXPIRY_KINDS)[number];
export const EXPIRY_KIND_LABELS: Record<ExpiryKind, string> = {
  DRIVER_LICENCE: 'Driving licence',
  DRIVER_DOCUMENT: 'Driver document',
  VEHICLE_DOCUMENT: 'Vehicle document',
  VEHICLE_REGISTRATION: 'Vehicle registration',
  VEHICLE_INSURANCE: 'Vehicle insurance',
  VEHICLE_SERVICE: 'Vehicle service',
};

export const EXPIRY_STATES = ['VALID', 'EXPIRING_SOON', 'EXPIRED', 'MISSING'] as const;
export type ExpiryState = (typeof EXPIRY_STATES)[number];
export const EXPIRY_STATE_LABELS: Record<ExpiryState, string> = {
  VALID: 'Valid',
  EXPIRING_SOON: 'Expiring soon',
  EXPIRED: 'Expired',
  MISSING: 'Missing',
};

/** Whole days from `today` to a date (both YYYY-MM-DD): negative once it has passed. */
export function daysUntil(date: string, today: string): number {
  const a = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/**
 * The state of a date that can run out. A date is valid through the day it names, expired from the next
 * day, and "expiring soon" within `soonDays`. A missing date is MISSING. The one rule for documents,
 * licences, registrations, insurance and service dates alike.
 */
export function expiryState(
  expiresOn: string | null,
  today: string,
  soonDays: number,
): ExpiryState {
  if (!expiresOn) return 'MISSING';
  const d = daysUntil(expiresOn, today);
  if (d < 0) return 'EXPIRED';
  return d <= soonDays ? 'EXPIRING_SOON' : 'VALID';
}

/** The smallest reminder threshold (in days) this many days left falls within, or null when none applies. */
export function reminderStage(daysLeft: number, thresholds: readonly number[]): number | null {
  const hit = [...thresholds].filter((t) => daysLeft <= t).sort((a, b) => a - b)[0];
  return hit ?? null;
}

export interface ExpiryItem {
  kind: ExpiryKind;
  /** Stable key for this thing (a document id, "licence", "registration", ...). */
  itemKey: string;
  label: string;
  state: ExpiryState;
  expiresOn: string | null;
  /** Negative when already past. Null when there is no date. */
  daysLeft: number | null;
  driverId: string | null;
  driverName: string | null;
  vehicleId: string | null;
  vehicleRegistration: string | null;
  fleetId: string | null;
  fleetName: string | null;
  /** The sentence for this item, for the person it concerns and for the admin list. */
  text: string;
}

export function describeExpiry(i: {
  label: string;
  state: ExpiryState;
  expiresOn: string | null;
  daysLeft: number | null;
  subject: string;
}): string {
  const on = i.expiresOn ? ` on ${i.expiresOn.slice(0, 10)}` : '';
  switch (i.state) {
    case 'VALID':
      return `${i.subject}: ${i.label} is valid${on}.`;
    case 'EXPIRING_SOON':
      return `${i.subject}: ${i.label} expires${on}, in ${i.daysLeft} day${i.daysLeft === 1 ? '' : 's'}. Renew it before then.`;
    case 'EXPIRED':
      return `${i.subject}: ${i.label} expired${on}. Renew it to keep driving.`;
    case 'MISSING':
      return `${i.subject}: ${i.label} is missing. Upload it to keep driving.`;
  }
}

// ---------------------------------------------------------------- inspections and maintenance

export const SERVICE_KINDS = ['INSPECTION', 'MAINTENANCE'] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];
export const SERVICE_KIND_LABELS: Record<ServiceKind, string> = {
  INSPECTION: 'Inspection',
  MAINTENANCE: 'Maintenance',
};
export const SERVICE_STATUSES = ['IN_PROGRESS', 'COMPLETED'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];
export const SERVICE_STATUS_LABELS: Record<ServiceStatus, string> = {
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
};
export const INSPECTION_RESULTS = ['PASSED', 'FAILED'] as const;
export type InspectionResult = (typeof INSPECTION_RESULTS)[number];
export const SERVICE_NOTE_MAX = 2000;

export interface ServiceRecordInfo {
  id: string;
  vehicleId: string;
  vehicleRegistration: string | null;
  kind: ServiceKind;
  status: ServiceStatus;
  /** The date the work was done (set when completed or for an inspection). */
  performedOn: string | null;
  /** When the next one is due; watched by the expiry monitor. */
  nextDueOn: string | null;
  result: InspectionResult | null;
  notes: string | null;
  recordedByName: string | null;
  createdAt: string;
  completedAt: string | null;
}

// ---------------------------------------------------------------- notifications

/** The notification types fleet operations sends, once: the server sends them and the apps route on them. */
export const FLEET_NOTIFICATION_TYPES = {
  DOCUMENT_EXPIRING: 'FLEET_DOCUMENT_EXPIRING',
  DOCUMENT_EXPIRED: 'FLEET_DOCUMENT_EXPIRED',
  DOCUMENT_MISSING: 'FLEET_DOCUMENT_MISSING',
  VEHICLE_STATUS: 'FLEET_VEHICLE_STATUS',
  VEHICLE_MAINTENANCE: 'FLEET_VEHICLE_MAINTENANCE',
  VEHICLE_ASSIGNED: 'FLEET_VEHICLE_ASSIGNED',
  VEHICLE_UNASSIGNED: 'FLEET_VEHICLE_UNASSIGNED',
  DRIVER_SUSPENDED: 'FLEET_DRIVER_SUSPENDED',
  DRIVER_REINSTATED: 'FLEET_DRIVER_REINSTATED',
  DRIVER_RESTRICTED: 'FLEET_DRIVER_RESTRICTED',
  ELIGIBILITY_LOST: 'FLEET_ELIGIBILITY_LOST',
} as const;
export type FleetNotificationType =
  (typeof FLEET_NOTIFICATION_TYPES)[keyof typeof FLEET_NOTIFICATION_TYPES];

// ---------------------------------------------------------------- admin views and bodies

export interface FleetInfo {
  id: string;
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  status: FleetStatus;
  vehicleCount: number;
  driverCount: number;
  createdAt: string;
}

export interface AdminFleetBody {
  name: string;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  status: FleetStatus;
  reason: string;
}

/** What stops a driver or vehicle being used for rides right now, in words (empty means it can be). */
export interface RideEligibility {
  eligible: boolean;
  reasons: string[];
}

export interface FleetVehicleRow {
  id: string;
  registrationNumber: string;
  description: string;
  categoryLabel: string | null;
  lifecycle: VehicleLifecycle;
  verificationStatus: string;
  fleetId: string | null;
  fleetName: string | null;
  driverId: string | null;
  driverName: string | null;
  eligible: boolean;
}

export interface FleetDriverRow {
  id: string;
  name: string | null;
  phone: string | null;
  accountStatus: string;
  verificationStatus: string;
  operationalStatus: OperationalStatus;
  availability: string;
  fleetId: string | null;
  fleetName: string | null;
  vehicleCount: number;
  eligible: boolean;
}

export interface FleetVehicleDetail extends FleetVehicleRow {
  allowedNext: VehicleLifecycle[];
  eligibility: RideEligibility;
  expiry: ExpiryItem[];
  service: ServiceRecordInfo[];
  audit: AuditEntry[];
  /** True when the vehicle could be assigned to a driver right now (it has none). */
  assignable: boolean;
}

export interface FleetDriverDetail extends FleetDriverRow {
  operationalReason: string | null;
  operationalUntil: string | null;
  allowedNext: OperationalStatus[];
  /** The separate models, side by side, each from its one owner. */
  axes: {
    account: string;
    verification: string;
    operational: string;
    availability: string;
    ride: string;
  };
  eligibility: RideEligibility;
  vehicles: FleetVehicleRow[];
  expiry: ExpiryItem[];
  audit: AuditEntry[];
}

export interface FleetDetail extends FleetInfo {
  vehicles: FleetVehicleRow[];
  drivers: FleetDriverRow[];
  audit: AuditEntry[];
}

export interface AdminLifecycleBody {
  to: VehicleLifecycle;
  reason: string;
}
export interface AdminVehicleAssignBody {
  driverId: string;
}
export interface AdminUnassignBody {
  reason: string;
}
export interface AdminOperationalBody {
  to: OperationalStatus;
  reason: string;
  /** When a restriction or suspension ends by itself (optional). */
  until?: string | null;
}
export interface AdminFleetVehicleBody {
  fleetId: string | null;
  categoryId: string;
  make: string;
  model: string;
  year: number;
  color: string;
  registrationNumber: string;
  registrationExpiryDate?: string | null;
  insuranceExpiryDate?: string | null;
}
export interface AdminMaintenanceStartBody {
  notes?: string;
}
export interface AdminMaintenanceCompleteBody {
  performedOn: string;
  nextDueOn?: string | null;
  notes?: string;
  /** Where the vehicle goes afterwards. */
  returnTo: 'ACTIVE' | 'INACTIVE';
}
export interface AdminInspectionBody {
  performedOn: string;
  result: InspectionResult;
  nextDueOn?: string | null;
  notes?: string;
}
export interface AdminServiceLogBody {
  performedOn: string;
  nextDueOn?: string | null;
  notes?: string;
}
