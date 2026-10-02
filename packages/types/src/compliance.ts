import type { UserRole } from './index';

/**
 * Compliance records, data requests and retention: the definitions, once. What a person agreed to is stored
 * as the policy's key, its VERSION and when: the policy text lives in one place (the address the policy
 * points to) and is never copied into an app or a record.
 */

export const POLICY_KINDS = ['POLICY', 'CONSENT'] as const;
export type PolicyKind = (typeof POLICY_KINDS)[number];

/** A policy as it is published now. The current version is the only one a person can accept. */
export interface PolicyInfo {
  key: string;
  kind: PolicyKind;
  title: string;
  version: string;
  effectiveAt: string;
  /** Where the words are (one address, served by whoever hosts the policy); null until published. */
  contentUrl: string | null;
  required: boolean;
  appliesTo: UserRole[];
}

/** A policy with this person's standing on it. */
export interface MyPolicyStatus extends PolicyInfo {
  accepted: boolean;
  acceptedVersion: string | null;
  acceptedAt: string | null;
}

export interface AcceptPolicyBody {
  key: string;
  /** The version they saw: refused if it is no longer the current one. */
  version: string;
}

export interface ComplianceRecordInfo {
  id: string;
  policyKey: string;
  policyVersion: string;
  acceptedAt: string;
  source: 'APP' | 'ADMIN';
  /** When the person withdrew a consent (a policy is never withdrawn); null while it stands. */
  withdrawnAt: string | null;
}

// ---------------------------------------------------------------- data requests

export const DATA_REQUEST_KINDS = ['DATA_ACCESS', 'ACCOUNT_DELETION'] as const;
export type DataRequestKind = (typeof DATA_REQUEST_KINDS)[number];
export const DATA_REQUEST_KIND_LABELS: Record<DataRequestKind, string> = {
  DATA_ACCESS: 'A copy of my personal data',
  ACCOUNT_DELETION: 'Delete my account',
};

export const DATA_REQUEST_STATES = [
  'REQUESTED',
  'REVIEWING',
  'COMPLETED',
  'REJECTED',
  'CANCELLED',
] as const;
export type DataRequestStatus = (typeof DATA_REQUEST_STATES)[number];

/** The person can withdraw a request until someone has started on it; COMPLETED, REJECTED, CANCELLED are final. */
export const DATA_REQUEST_TRANSITIONS: Record<DataRequestStatus, readonly DataRequestStatus[]> = {
  REQUESTED: ['REVIEWING', 'REJECTED', 'CANCELLED'],
  REVIEWING: ['COMPLETED', 'REJECTED'],
  COMPLETED: [],
  REJECTED: [],
  CANCELLED: [],
};
export const canDataRequestTransition = (from: DataRequestStatus, to: DataRequestStatus) =>
  DATA_REQUEST_TRANSITIONS[from].includes(to);
export const dataRequestStatesLeadingTo = (to: DataRequestStatus): DataRequestStatus[] =>
  DATA_REQUEST_STATES.filter((from) => canDataRequestTransition(from, to));
export const OPEN_DATA_REQUEST_STATES: readonly DataRequestStatus[] = ['REQUESTED', 'REVIEWING'];

export const DATA_REQUEST_STATUS_LABELS: Record<DataRequestStatus, string> = {
  REQUESTED: 'Received',
  REVIEWING: 'Being handled',
  COMPLETED: 'Done',
  REJECTED: 'Not possible',
  CANCELLED: 'Withdrawn',
};

export function describeDataRequest(kind: DataRequestKind, status: DataRequestStatus): string {
  const what =
    kind === 'DATA_ACCESS'
      ? 'Your request for a copy of your data'
      : 'Your request to delete your account';
  switch (status) {
    case 'REQUESTED':
      return `${what} was received.`;
    case 'REVIEWING':
      return `${what} is being handled.`;
    case 'COMPLETED':
      return kind === 'DATA_ACCESS' ? `${what} is ready to download.` : `${what} is done.`;
    case 'REJECTED':
      return `${what} could not be completed. The reason is on the request.`;
    case 'CANCELLED':
      return `${what} was withdrawn.`;
  }
}

export interface DataRequestInfo {
  id: string;
  kind: DataRequestKind;
  status: DataRequestStatus;
  statusText: string;
  /** The date by which a decision is due. */
  dueAt: string;
  decisionNote: string | null;
  createdAt: string;
  completedAt: string | null;
  /** True once a data-access request is done and its copy can be fetched. */
  canDownload: boolean;
  canCancel: boolean;
}
export interface CreateDataRequestBody {
  kind: DataRequestKind;
  note?: string;
}

export interface AdminDataRequestRow extends DataRequestInfo {
  userId: string;
  userName: string | null;
  userRole: UserRole;
  note: string | null;
  decidedByName: string | null;
  overdue: boolean;
  allowedNext: DataRequestStatus[];
}
export interface DataRequestActionBody {
  to: DataRequestStatus;
  note?: string;
}

// ---------------------------------------------------------------- retention

/** Every kind of record the platform keeps that has a retention rule. */
export const RETENTION_RECORD_TYPES = [
  'OTP_REQUESTS',
  'NOTIFICATIONS',
  'AUTH_EVENTS',
  'CHAT_MESSAGES',
  'SUPPORT_EVIDENCE',
  'TRIPS',
  'PAYMENTS',
  'REFUNDS',
  'SUPPORT_TICKETS',
  'SAFETY_RECORDS',
  'AUDIT_LOG',
  'COMPLIANCE_RECORDS',
  'DATA_REQUESTS',
  'RISK_EVENTS',
  'ORGANIZATION_RECORDS',
  'JOB_RUNS',
  'IDEMPOTENCY_KEYS',
  'ACCESSIBILITY_RIDE_DETAILS',
  'REWARD_LEDGER',
  'DISABILITY_VERIFICATION',
  'DRIVER_PAYOUTS',
] as const;
export type RetentionRecordType = (typeof RETENTION_RECORD_TYPES)[number];

export const RETENTION_ACTIONS = ['DELETE', 'KEEP'] as const;
export type RetentionAction = (typeof RETENTION_ACTIONS)[number];

export interface RetentionPolicyInfo {
  recordType: RetentionRecordType;
  label: string;
  /** How long it is kept before the action runs; null when it is kept (no time limit). */
  retainDays: number | null;
  /** The shortest a rule may be set to (a floor a person editing it cannot go under). */
  minRetainDays: number | null;
  action: RetentionAction;
  legalBasis: string;
  /** Whether a job applies this rule (KEEP records and unbuilt jobs are only recorded). */
  enforced: boolean;
  lastRunAt: string | null;
  lastRunCount: number | null;
}
export interface UpdateRetentionBody {
  retainDays: number;
  reason: string;
}

export interface PublishPolicyBody {
  version: string;
  title?: string;
  contentUrl?: string | null;
  effectiveAt?: string;
  reason: string;
}
