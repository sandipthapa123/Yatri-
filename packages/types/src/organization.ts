import type { PaymentMethod } from './trip-commerce';
import type { TripRequestBody } from './trip-commerce';
import type { AuditEntry } from './safety';
import type { ResolvedRange } from './admin-ops';

/**
 * Business and institutional transport: the ONE definition of organization roles, what each may do, the
 * booking policy and how it is applied, approvals and statements. The API, the admin screens and the apps read
 * these; nobody keeps a second copy of a rule.
 *
 * Organization authorization is SEPARATE from platform roles. A person is a platform PASSENGER (or a platform
 * administrator, with permissions of their own: see admin.ts); inside an organization they hold ONE of the
 * roles below, which says only what they may do for that organization. Holding an organization role grants no
 * platform permission, and a platform administrator is not thereby a member of any organization.
 *
 * A ride booked for an organization is an ordinary ride (the trips table, the trip state machine, the one
 * pricing, dispatch and payment systems). It carries who booked it (`bookedBy`), who rides (`passenger`: they
 * are different people when a booker books for an employee), the organization, a cost centre and a purpose.
 */

// ---------------------------------------------------------------- roles and what they may do

export const ORG_ROLES = ['OWNER', 'ADMIN', 'BOOKER', 'MEMBER', 'VIEWER'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Administrator',
  BOOKER: 'Booker',
  MEMBER: 'Member',
  VIEWER: 'Viewer',
};

export const ORG_ROLE_HELP: Record<OrgRole, string> = {
  OWNER:
    'Everything, including making other owners. An organization always has at least one owner.',
  ADMIN:
    'Manages members (except owners and other administrators), policies and cost centres, approves rides, and sees billing and reports.',
  BOOKER: 'Books rides for themselves and for other members.',
  MEMBER: 'Books rides for themselves, within the organization policy.',
  VIEWER: 'Sees all rides and reports. Cannot book or change anything.',
};

export const ORG_PERMISSIONS = [
  'ORG_MANAGE',
  'MEMBERS_MANAGE',
  'RIDES_BOOK_SELF',
  'RIDES_BOOK_FOR_OTHERS',
  'RIDES_APPROVE',
  'RIDES_VIEW_ALL',
  'REPORTS_VIEW',
  'BILLING_VIEW',
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const ORG_PERMISSION_LABELS: Record<OrgPermission, string> = {
  ORG_MANAGE: 'Change the organization profile, policy and cost centres',
  MEMBERS_MANAGE: 'Invite, change and remove members',
  RIDES_BOOK_SELF: 'Book rides for themselves',
  RIDES_BOOK_FOR_OTHERS: 'Book rides for other members',
  RIDES_APPROVE: 'Approve or decline rides that need approval',
  RIDES_VIEW_ALL: "See every member's rides",
  REPORTS_VIEW: 'See usage reports',
  BILLING_VIEW: 'See statements and what is owed',
};

/** The single table of what a role may do. Everything else (policy, spending) narrows it further. */
export const ORG_ROLE_PERMISSIONS: Record<OrgRole, readonly OrgPermission[]> = {
  OWNER: ORG_PERMISSIONS,
  ADMIN: ORG_PERMISSIONS,
  BOOKER: ['RIDES_BOOK_SELF', 'RIDES_BOOK_FOR_OTHERS'],
  MEMBER: ['RIDES_BOOK_SELF'],
  VIEWER: ['RIDES_VIEW_ALL', 'REPORTS_VIEW'],
};

export const orgRoleHolds = (role: OrgRole, permission: OrgPermission): boolean =>
  ORG_ROLE_PERMISSIONS[role].includes(permission);

/** Which roles one member may give to another. Only an owner makes an owner or an administrator. */
export function assignableOrgRoles(actor: OrgRole): readonly OrgRole[] {
  if (actor === 'OWNER') return ORG_ROLES;
  if (actor === 'ADMIN') return ['BOOKER', 'MEMBER', 'VIEWER'];
  return [];
}
/** Whether `actor` may change or remove a member who currently holds `target`. */
export function canManageOrgMember(actor: OrgRole, target: OrgRole): boolean {
  if (actor === 'OWNER') return true;
  return actor === 'ADMIN' && (target === 'BOOKER' || target === 'MEMBER' || target === 'VIEWER');
}

export const ORG_MEMBER_STATUSES = ['INVITED', 'ACTIVE', 'REMOVED'] as const;
export type OrgMemberStatus = (typeof ORG_MEMBER_STATUSES)[number];
export const ORG_MEMBER_STATUS_LABELS: Record<OrgMemberStatus, string> = {
  INVITED: 'Invited, not yet accepted',
  ACTIVE: 'Active',
  REMOVED: 'Removed',
};

/** Organization status: only the platform changes it (a suspension stops new bookings; nothing is deleted). */
export const ORG_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];
export const ORG_STATUS_LABELS: Record<OrgStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
};
export const ORG_STATUS_MOVES: Record<OrgStatus, OrgStatus> = {
  ACTIVE: 'SUSPENDED',
  SUSPENDED: 'ACTIVE',
};

// ---------------------------------------------------------------- the policy

/**
 * How rides are paid for. ON_ACCOUNT: the organization is billed on its monthly statement (the ride's payment
 * method is ORGANIZATION). EMPLOYEE_CASH: the rider pays the driver in cash as for any ride; the ride is still
 * tagged to the organization and cost centre for reports.
 */
export const ORG_PAYMENT_MODES = ['ON_ACCOUNT', 'EMPLOYEE_CASH'] as const;
export type OrgPaymentMode = (typeof ORG_PAYMENT_MODES)[number];
export const ORG_PAYMENT_MODE_LABELS: Record<OrgPaymentMode, string> = {
  ON_ACCOUNT: 'Billed to the organization on a monthly statement',
  EMPLOYEE_CASH: 'The rider pays cash; rides are tagged for reports',
};
/** The payment method each mode produces on the ride's payment record (the one payment system). */
export const ORG_PAYMENT_MODE_METHOD: Record<OrgPaymentMode, PaymentMethod> = {
  ON_ACCOUNT: 'ORGANIZATION',
  EMPLOYEE_CASH: 'CASH',
};

/** The organization's booking policy: ONE row per organization, applied by `evaluateBooking` and nowhere else. */
export interface OrgPolicy {
  /** Vehicle category codes members may book. Empty: every category. */
  allowedCategoryCodes: string[];
  /** Service zone ids both ends of a ride must touch. Empty: anywhere the service runs. */
  allowedZoneIds: string[];
  perRideLimitNpr: number | null;
  perMemberMonthlyLimitNpr: number | null;
  monthlyLimitNpr: number | null;
  /** A ride whose fare is above this needs approval. Null: no threshold. */
  approvalOverNpr: number | null;
  approvalForAll: boolean;
  /** Whether people with the MEMBER role may book for themselves. */
  memberSelfBooking: boolean;
  costCenterRequired: boolean;
  paymentMode: OrgPaymentMode;
}

export const DEFAULT_ORG_POLICY: OrgPolicy = {
  allowedCategoryCodes: [],
  allowedZoneIds: [],
  perRideLimitNpr: null,
  perMemberMonthlyLimitNpr: null,
  monthlyLimitNpr: null,
  approvalOverNpr: null,
  approvalForAll: false,
  memberSelfBooking: true,
  costCenterRequired: false,
  paymentMode: 'ON_ACCOUNT',
};

export const ORG_LIMIT_MAX_NPR = 10_000_000;

/**
 * The policy in sentences: the ONE wording, used by the apps and the admin console. `names` turns the stored
 * category codes and zone ids into words when the caller has them.
 */
export function describeOrgPolicy(
  p: OrgPolicy,
  names: { categories?: Record<string, string>; zones?: Record<string, string> } = {},
): string[] {
  const money = (v: number) => `NPR ${v}`;
  const list = (items: string[], all: string) => (items.length === 0 ? all : items.join(', '));
  return [
    `Payment: ${ORG_PAYMENT_MODE_LABELS[p.paymentMode]}.`,
    `Vehicle types: ${list(
      p.allowedCategoryCodes.map((c) => names.categories?.[c] ?? c),
      'all',
    )}.`,
    `Areas: ${list(
      p.allowedZoneIds.map((z) => names.zones?.[z] ?? 'a chosen area'),
      'anywhere the service runs',
    )}.`,
    `Limit for one ride: ${p.perRideLimitNpr === null ? 'none' : money(p.perRideLimitNpr)}.`,
    `Limit for each rider each month: ${p.perMemberMonthlyLimitNpr === null ? 'none' : money(p.perMemberMonthlyLimitNpr)}.`,
    `Limit for the organization each month: ${p.monthlyLimitNpr === null ? 'none' : money(p.monthlyLimitNpr)}.`,
    `Approval: ${
      p.approvalForAll
        ? 'every ride needs it'
        : p.approvalOverNpr === null
          ? 'not required'
          : `rides over ${money(p.approvalOverNpr)} need it`
    }.`,
    `Members may book rides for themselves: ${p.memberSelfBooking ? 'yes' : 'no'}.`,
    `A cost centre is required: ${p.costCenterRequired ? 'yes' : 'no'}.`,
  ];
}

export type BookingOutcome = 'ALLOWED' | 'NEEDS_APPROVAL' | 'DENIED';
export interface BookingDecision {
  outcome: BookingOutcome;
  /** In words. For DENIED, why; for NEEDS_APPROVAL, why approval is needed. */
  reasons: string[];
}

export interface BookingFacts {
  policy: OrgPolicy;
  /** The role of the person making the booking. */
  bookerRole: OrgRole;
  forSelf: boolean;
  categoryCode: string;
  fareNpr: number;
  pickupZoneIds: readonly string[];
  dropoffZoneIds: readonly string[];
  costCenterId: string | null;
  /** What is already committed this month (rides not cancelled), before this one. */
  spentThisMonthNpr: { organization: number; passenger: number };
}

/**
 * The ONE booking rule. DENIED beats NEEDS_APPROVAL beats ALLOWED. People who may approve rides are not asked
 * to approve their own, but are held to every limit like everyone else.
 */
export function evaluateBooking(f: BookingFacts): BookingDecision {
  const p = f.policy;
  const denied: string[] = [];
  if (f.bookerRole === 'MEMBER' && f.forSelf && !p.memberSelfBooking) {
    denied.push('Members of this organization cannot book rides themselves. Ask a booker.');
  }
  if (p.allowedCategoryCodes.length > 0 && !p.allowedCategoryCodes.includes(f.categoryCode)) {
    denied.push('This vehicle type is not allowed by the organization policy.');
  }
  if (p.allowedZoneIds.length > 0) {
    const inside = (ids: readonly string[]) => ids.some((z) => p.allowedZoneIds.includes(z));
    if (!inside(f.pickupZoneIds) || !inside(f.dropoffZoneIds)) {
      denied.push(
        'Both the pickup and the drop-off must be inside the areas the organization allows.',
      );
    }
  }
  if (p.costCenterRequired && !f.costCenterId) {
    denied.push('A cost centre is required for rides of this organization.');
  }
  if (p.perRideLimitNpr !== null && f.fareNpr > p.perRideLimitNpr) {
    denied.push(
      `The fare (NPR ${f.fareNpr}) is above the limit of NPR ${p.perRideLimitNpr} for one ride.`,
    );
  }
  if (
    p.perMemberMonthlyLimitNpr !== null &&
    f.spentThisMonthNpr.passenger + f.fareNpr > p.perMemberMonthlyLimitNpr
  ) {
    denied.push("This ride would go over the rider's monthly limit.");
  }
  if (
    p.monthlyLimitNpr !== null &&
    f.spentThisMonthNpr.organization + f.fareNpr > p.monthlyLimitNpr
  ) {
    denied.push("This ride would go over the organization's monthly limit.");
  }
  if (denied.length > 0) return { outcome: 'DENIED', reasons: denied };

  const needs: string[] = [];
  if (p.approvalForAll) needs.push('Every ride of this organization needs approval.');
  else if (p.approvalOverNpr !== null && f.fareNpr > p.approvalOverNpr) {
    needs.push(`Rides over NPR ${p.approvalOverNpr} need approval.`);
  }
  if (needs.length > 0 && !orgRoleHolds(f.bookerRole, 'RIDES_APPROVE')) {
    return { outcome: 'NEEDS_APPROVAL', reasons: needs };
  }
  return { outcome: 'ALLOWED', reasons: [] };
}

// ---------------------------------------------------------------- approvals

export const ORG_APPROVAL_STATUSES = [
  'PENDING',
  'APPROVED',
  'DECLINED',
  'EXPIRED',
  'CANCELLED',
] as const;
export type OrgApprovalStatus = (typeof ORG_APPROVAL_STATUSES)[number];
export const ORG_APPROVAL_STATUS_LABELS: Record<OrgApprovalStatus, string> = {
  PENDING: 'Waiting for approval',
  APPROVED: 'Approved: the ride was requested',
  DECLINED: 'Declined',
  EXPIRED: 'Expired before anyone decided',
  CANCELLED: 'Cancelled by the person who asked',
};
/** A pending request can end four ways; nothing leaves the other states. */
export const ORG_APPROVAL_TRANSITIONS: Record<OrgApprovalStatus, readonly OrgApprovalStatus[]> = {
  PENDING: ['APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'],
  APPROVED: [],
  DECLINED: [],
  EXPIRED: [],
  CANCELLED: [],
};

// ---------------------------------------------------------------- statements

export const ORG_STATEMENT_STATUSES = ['ISSUED', 'PAID', 'VOID'] as const;
export type OrgStatementStatus = (typeof ORG_STATEMENT_STATUSES)[number];
export const ORG_STATEMENT_STATUS_LABELS: Record<OrgStatementStatus, string> = {
  ISSUED: 'Issued, awaiting payment',
  PAID: 'Paid',
  VOID: 'Cancelled',
};
export const ORG_STATEMENT_TRANSITIONS: Record<OrgStatementStatus, readonly OrgStatementStatus[]> =
  {
    ISSUED: ['PAID', 'VOID'],
    PAID: [],
    VOID: [],
  };

/** A statement period is a calendar month in the platform time zone, written 2026-09. */
export const STATEMENT_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isStatementPeriod = (v: string) => STATEMENT_PERIOD_PATTERN.test(v);

// ---------------------------------------------------------------- limits

export const ORG_NAME_MAX = 100;
export const ORG_PURPOSE_MAX = 200;
export const ORG_COST_CENTER_CODE_MAX = 20;
export const ORG_REASON_MAX = 300;

// ---------------------------------------------------------------- notifications

export const ORG_NOTIFICATION_TYPES = {
  INVITED: 'ORG_INVITED',
  ROLE_CHANGED: 'ORG_ROLE_CHANGED',
  REMOVED: 'ORG_REMOVED',
  RIDE_BOOKED_FOR_YOU: 'ORG_RIDE_BOOKED_FOR_YOU',
  APPROVAL_NEEDED: 'ORG_APPROVAL_NEEDED',
  APPROVAL_DECIDED: 'ORG_APPROVAL_DECIDED',
  STATEMENT_ISSUED: 'ORG_STATEMENT_ISSUED',
  STATEMENT_PAID: 'ORG_STATEMENT_PAID',
  SUSPENDED: 'ORG_SUSPENDED',
  REACTIVATED: 'ORG_REACTIVATED',
} as const;
export type OrgNotificationType =
  (typeof ORG_NOTIFICATION_TYPES)[keyof typeof ORG_NOTIFICATION_TYPES];

// ---------------------------------------------------------------- what the API returns

export interface OrganizationInfo {
  id: string;
  name: string;
  legalName: string | null;
  billingEmail: string | null;
  billingContactName: string | null;
  status: OrgStatus;
  /** The caller's role and permissions in this organization (from the server; the apps only show what is listed). */
  myRole: OrgRole;
  myPermissions: OrgPermission[];
  createdAt: string;
}

export interface OrgInvitationInfo {
  organizationId: string;
  organizationName: string;
  role: OrgRole;
  invitedAt: string;
}

export interface OrgMemberInfo {
  id: string;
  userId: string;
  name: string | null;
  role: OrgRole;
  status: OrgMemberStatus;
  defaultCostCenterId: string | null;
  /** The roles the caller may give this person, and whether they may remove them (server's answer). */
  canChange: boolean;
  invitedAt: string;
  joinedAt: string | null;
}

export interface OrgCostCenterInfo {
  id: string;
  code: string;
  name: string;
  department: string | null;
  isActive: boolean;
}

export interface OrgPolicyView extends OrgPolicy {
  /** Category labels and zone names for the codes and ids above, so screens show words. */
  categoryOptions: Array<{ code: string; label: string }>;
  zoneOptions: Array<{ id: string; name: string }>;
}

export interface OrgBookingBody extends TripRequestBody {
  /** The member who will ride. Omitted: the booker. */
  passengerId?: string;
  costCenterId?: string | null;
  purpose?: string | null;
}

export interface OrgApprovalInfo {
  id: string;
  status: OrgApprovalStatus;
  requestedByName: string | null;
  passengerName: string | null;
  pickupAddress: string;
  destinationAddress: string;
  vehicleCategory: string;
  fareNpr: number;
  costCenterName: string | null;
  purpose: string | null;
  reasons: string[];
  expiresAt: string;
  createdAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  tripId: string | null;
  /** Whether the caller may decide it, or withdraw it (server's answer). */
  canDecide: boolean;
  canCancel: boolean;
}

/** What the policy says about a booking, before anything is created (so a rider is not surprised). */
export interface OrgBookingPreview {
  outcome: BookingOutcome;
  reasons: string[];
  fareNpr: number;
}

/** What booking returns: a ride was requested, or it is waiting for approval (never both). */
export interface OrgBookingResult {
  outcome: 'REQUESTED' | 'NEEDS_APPROVAL';
  tripId: string | null;
  approval: OrgApprovalInfo | null;
  reasons: string[];
}

/** One ride of the organization, for history: who booked, who rode, what it cost. No live location, no phone numbers. */
export interface OrgRideRow {
  tripId: string;
  status: string;
  requestedAt: string;
  endedAt: string | null;
  bookedByName: string | null;
  passengerName: string | null;
  pickupAddress: string;
  destinationAddress: string;
  vehicleCategory: string | null;
  costCenterCode: string | null;
  purpose: string | null;
  costNpr: number;
  paymentStatus: string;
  statementNumber: number | null;
}

export interface OrgStatementInfo {
  id: string;
  number: number;
  periodKey: string;
  status: OrgStatementStatus;
  rides: number;
  totalNpr: number;
  issuedAt: string;
  dueOn: string;
  paidAt: string | null;
  paidReference: string | null;
}

export interface OrgStatementLine {
  tripId: string;
  endedAt: string | null;
  passengerName: string | null;
  bookedByName: string | null;
  costCenterCode: string | null;
  purpose: string | null;
  pickupAddress: string;
  destinationAddress: string;
  amountNpr: number;
}

export interface OrgStatementDetail extends OrgStatementInfo {
  organizationId: string;
  organizationName: string;
  lines: OrgStatementLine[];
  /** Totals by cost centre, so a statement can be split across departments. */
  byCostCenter: Array<{
    code: string | null;
    name: string | null;
    rides: number;
    totalNpr: number;
  }>;
}

export interface OrgUsageReport {
  /** The range the figures cover (the platform's one date-range rule). */
  range: ResolvedRange;
  rides: number;
  completed: number;
  cancelled: number;
  spendNpr: number;
  byMonth: Array<{ month: string; rides: number; spendNpr: number }>;
  byCostCenter: Array<{
    code: string | null;
    name: string | null;
    rides: number;
    spendNpr: number;
  }>;
  byMember: Array<{ userId: string; name: string | null; rides: number; spendNpr: number }>;
  byCategory: Array<{ code: string | null; label: string | null; rides: number; spendNpr: number }>;
}

export interface OrgActivityEntry extends AuditEntry {
  subjectType: string;
}

// ---------------------------------------------------------------- request bodies

export interface CreateOrganizationBody {
  name: string;
  legalName?: string | null;
  billingEmail?: string | null;
  billingContactName?: string | null;
}
export type UpdateOrganizationBody = CreateOrganizationBody;
export interface InviteMemberBody {
  phoneNumber: string;
  role: OrgRole;
}
export interface ChangeMemberBody {
  role?: OrgRole;
  defaultCostCenterId?: string | null;
}
export interface CostCenterBody {
  code: string;
  name: string;
  department?: string | null;
  isActive?: boolean;
}
export interface DecideApprovalBody {
  decision: 'APPROVE' | 'DECLINE';
  note?: string | null;
}

// ---------------------------------------------------------------- the platform's view (admin console)

export interface AdminOrganizationRow {
  id: string;
  name: string;
  status: OrgStatus;
  members: number;
  ridesThisMonth: number;
  spendThisMonthNpr: number;
  outstandingNpr: number;
  createdAt: string;
}
export interface AdminOrganizationDetail extends AdminOrganizationRow {
  legalName: string | null;
  billingEmail: string | null;
  billingContactName: string | null;
  policy: OrgPolicy;
  owners: Array<{ userId: string; name: string | null }>;
  statements: OrgStatementInfo[];
  audit: AuditEntry[];
  allowedNext: OrgStatus;
}
export interface AdminStatementRow extends OrgStatementInfo {
  organizationId: string;
  organizationName: string;
}
export interface AdminStatementRunResult {
  periodKey: string;
  issued: number;
  skipped: number;
}
export interface AdminMarkStatementPaidBody {
  receivedNpr: number;
  reference: string;
}
