import type { TripRole } from './trip';
import type { AuditEntry } from './safety';

/**
 * Support, ride disputes and refunds: the definitions, once. A ride dispute IS a support ticket whose
 * category is of kind DISPUTE and which points at the ride (it holds a reference, never a copy of the
 * ride). Tickets, refunds and their legal moves are decided here by tables; the services apply them with
 * a guarded update and the apps only show the states.
 */

// ---------------------------------------------------------------- ticket lifecycle

export const TICKET_STATUSES = [
  'OPEN',
  'IN_REVIEW',
  'WAITING_FOR_USER',
  'WAITING_FOR_ADMIN',
  'RESOLVED',
  'CLOSED',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * OPEN: raised, no one has picked it up. IN_REVIEW: someone is working on it. WAITING_FOR_USER: we asked
 * the person something. WAITING_FOR_ADMIN: they answered, it is our turn. RESOLVED: we say it is
 * done (the person can still reopen it by replying). CLOSED: final.
 */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  OPEN: ['IN_REVIEW', 'WAITING_FOR_USER', 'RESOLVED', 'CLOSED'],
  IN_REVIEW: ['WAITING_FOR_USER', 'WAITING_FOR_ADMIN', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_USER: ['IN_REVIEW', 'WAITING_FOR_ADMIN', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_ADMIN: ['IN_REVIEW', 'WAITING_FOR_USER', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_REVIEW', 'WAITING_FOR_ADMIN', 'CLOSED'],
  CLOSED: [],
};
export const canTicketTransition = (from: TicketStatus, to: TicketStatus) =>
  TICKET_TRANSITIONS[from].includes(to);
export const ticketStatesLeadingTo = (to: TicketStatus): TicketStatus[] =>
  TICKET_STATUSES.filter((from) => canTicketTransition(from, to));

/** Still being handled: not resolved and not closed. */
export const UNRESOLVED_TICKET_STATES: readonly TicketStatus[] = TICKET_STATUSES.filter(
  (s) => s !== 'RESOLVED' && s !== 'CLOSED',
);

/** Waiting for us to answer: the states an unanswered-too-long escalation watches. */
export const AWAITING_SUPPORT_STATES: readonly TicketStatus[] = ['OPEN', 'WAITING_FOR_ADMIN'];

export type TicketActor = 'REQUESTER' | 'ADMIN';

/**
 * What a reply does to the status. A person's reply hands the ticket to us (and reopens a resolved one);
 * ours hands it to them. `null` means no reply is possible (closed). These are the only moves a reply
 * makes, and every one is a legal transition above (a test checks that).
 */
export function statusAfterReply(from: TicketStatus, actor: TicketActor): TicketStatus | null {
  if (from === 'CLOSED') return null;
  if (actor === 'REQUESTER') {
    if (from === 'OPEN') return 'OPEN';
    return 'WAITING_FOR_ADMIN';
  }
  if (from === 'RESOLVED') return 'RESOLVED';
  return 'WAITING_FOR_USER';
}

/** The only status changes a person may ask for directly: closing a ticket that is resolved. */
export const REQUESTER_CAN_CLOSE_FROM: readonly TicketStatus[] = ['RESOLVED'];

export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  OPEN: 'Open',
  IN_REVIEW: 'Being reviewed',
  WAITING_FOR_USER: 'Waiting for your reply',
  WAITING_FOR_ADMIN: 'Waiting for support',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
};

/** The words for a status, for the person who raised the ticket: read out when it changes. One function. */
export function describeTicketStatus(number: number, status: TicketStatus): string {
  const what = `Support request ${number}`;
  switch (status) {
    case 'OPEN':
      return `${what} was received. We will look at it soon.`;
    case 'IN_REVIEW':
      return `${what} is being reviewed.`;
    case 'WAITING_FOR_USER':
      return `${what}: we need something from you. Open it to reply.`;
    case 'WAITING_FOR_ADMIN':
      return `${what}: we have your reply and will get back to you.`;
    case 'RESOLVED':
      return `${what} is resolved. If it is not, reply and we will reopen it.`;
    case 'CLOSED':
      return `${what} is closed.`;
  }
}

// ---------------------------------------------------------------- categories and priorities (data, not code)

export const SUPPORT_CATEGORY_KINDS = ['GENERAL', 'DISPUTE'] as const;
export type SupportCategoryKind = (typeof SUPPORT_CATEGORY_KINDS)[number];

export interface SupportCategory {
  code: string;
  label: string;
  /** A sentence that tells the person what belongs here. */
  help: string;
  kind: SupportCategoryKind;
  /** Who may pick it. */
  forRoles: TripRole[];
  /** A ride must be named (disputes always; some general ones). */
  requiresRide: boolean;
  defaultPriority: string;
  isActive: boolean;
  sortOrder: number;
}

/** A priority level and how long an unanswered ticket may wait before it is escalated. All editable data. */
export interface SupportPriority {
  code: string;
  label: string;
  /** Higher is more urgent. */
  rank: number;
  firstResponseHours: number;
  /** The priority an unanswered ticket is raised to after that time; null means only the team is told. */
  escalatesTo: string | null;
}

export const TICKET_SUBJECT_MAX = 120;
export const TICKET_BODY_MIN = 10;
export const TICKET_BODY_MAX = 4000;
export const TICKET_NOTE_MAX = 4000;
export const SUPPORT_RESOLUTION_MAX = 1000;

// ---------------------------------------------------------------- what people and admins see

export interface AttachmentInfo {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface TicketMessageInfo {
  id: string;
  /** Who wrote it, from the reader's point of view; a status change is SYSTEM. */
  from: 'YOU' | 'SUPPORT' | 'SYSTEM';
  body: string;
  createdAt: string;
  attachments: AttachmentInfo[];
}

/** The person's view of one ticket. Priority, assignment and internal notes are never in it. */
export interface TicketInfo {
  id: string;
  number: number;
  categoryCode: string;
  categoryLabel: string;
  isDispute: boolean;
  subject: string;
  status: TicketStatus;
  statusText: string;
  tripId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  /** For a dispute that was decided: whether it was upheld or rejected. */
  outcome: TicketOutcome | null;
  resolution: string | null;
}

export const TICKET_OUTCOMES = ['UPHELD', 'REJECTED'] as const;
export type TicketOutcome = (typeof TICKET_OUTCOMES)[number];

export interface TicketDetail extends TicketInfo {
  messages: TicketMessageInfo[];
  canReply: boolean;
  canClose: boolean;
  attachmentsLeft: number;
  /** The refund, if one was asked for on this ticket (the person's own view of it). */
  refund: RefundInfo | null;
  /** A passenger may ask for a refund when the ride was paid and nothing is being refunded. */
  canRequestRefund: boolean;
}

export interface CreateTicketBody {
  categoryCode: string;
  subject: string;
  body: string;
  /** Required for categories that need a ride. */
  tripId?: string;
}

export interface TicketReplyBody {
  body: string;
}

// ---------------------------------------------------------------- refunds

export const REFUND_STATES = [
  'REQUESTED',
  'REVIEWING',
  'APPROVED',
  'PROCESSING',
  'COMPLETED',
  'REJECTED',
  'FAILED',
] as const;
export type RefundStatus = (typeof REFUND_STATES)[number];

/**
 * REQUESTED: asked for. REVIEWING: someone is checking the ride and the payment. APPROVED / REJECTED: the
 * decision. PROCESSING: the money is being returned to the person. COMPLETED: they have it. FAILED: the
 * return did not work (it can be retried, or rejected). COMPLETED and REJECTED are final.
 */
export const REFUND_TRANSITIONS: Record<RefundStatus, readonly RefundStatus[]> = {
  REQUESTED: ['REVIEWING', 'REJECTED'],
  REVIEWING: ['APPROVED', 'REJECTED'],
  APPROVED: ['PROCESSING', 'REJECTED'],
  PROCESSING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  REJECTED: [],
  FAILED: ['PROCESSING', 'REJECTED'],
};
export const canRefundTransition = (from: RefundStatus, to: RefundStatus) =>
  REFUND_TRANSITIONS[from].includes(to);
export const refundStatesLeadingTo = (to: RefundStatus): RefundStatus[] =>
  REFUND_STATES.filter((from) => canRefundTransition(from, to));
/** Refunds that still count as "one is already under way" for a payment. */
export const ACTIVE_REFUND_STATES: readonly RefundStatus[] = REFUND_STATES.filter(
  (s) => s !== 'COMPLETED' && s !== 'REJECTED',
);

export const REFUND_STATUS_LABELS: Record<RefundStatus, string> = {
  REQUESTED: 'Requested',
  REVIEWING: 'Being reviewed',
  APPROVED: 'Approved',
  PROCESSING: 'Being paid back',
  COMPLETED: 'Paid back',
  REJECTED: 'Not approved',
  FAILED: 'Payment back failed',
};

/** What the refund is for. The amount each implies is worked out by ONE function on the server. */
export const REFUND_REASONS = ['FULL_FARE', 'WAITING_CHARGE', 'PARTIAL'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  FULL_FARE: 'The whole fare',
  WAITING_CHARGE: 'The waiting charge',
  PARTIAL: 'Part of the fare (an amount)',
};

/** How the money goes back. Yatri holds none, so this records who paid it back; nothing here moves money. */
export const REFUND_METHODS = ['PLATFORM', 'DRIVER_CASH'] as const;
export type RefundMethod = (typeof REFUND_METHODS)[number];
export const REFUND_METHOD_LABELS: Record<RefundMethod, string> = {
  PLATFORM: 'Yatri pays the rider directly',
  DRIVER_CASH: 'The driver returns the cash',
};

export interface RefundInfo {
  id: string;
  ticketId: string | null;
  tripId: string;
  amountNpr: number;
  reason: RefundReason;
  status: RefundStatus;
  statusText: string;
  method: RefundMethod | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export function describeRefundStatus(amountNpr: number, status: RefundStatus): string {
  const amount = `NPR ${amountNpr}`;
  switch (status) {
    case 'REQUESTED':
      return `Your refund request for ${amount} was received.`;
    case 'REVIEWING':
      return `Your refund request for ${amount} is being reviewed.`;
    case 'APPROVED':
      return `Your refund of ${amount} was approved.`;
    case 'PROCESSING':
      return `Your refund of ${amount} is being paid back to you.`;
    case 'COMPLETED':
      return `Your refund of ${amount} has been paid back.`;
    case 'REJECTED':
      return `Your refund request for ${amount} was not approved.`;
    case 'FAILED':
      return `Paying back your refund of ${amount} did not work. We will try again.`;
  }
}

export interface RefundRequestBody {
  reason: RefundReason;
  /** Only for PARTIAL. Whole rupees. */
  amountNpr?: number;
}

/** What a refund may be, right now, for one ride (the same figure the server checks a request against). */
export interface RefundQuote {
  paidNpr: number;
  refundedNpr: number;
  remainingNpr: number;
  waitingChargeNpr: number;
  /** The amount each reason implies (null when it does not apply). */
  amounts: Record<RefundReason, number | null>;
}

// ---------------------------------------------------------------- admin views

/** A ride problem on a ride, as the ride's detail lists it (the ticket holds the conversation). */
export interface TripProblemSummary {
  id: string;
  number: number;
  status: TicketStatus;
  categoryLabel: string;
  raisedByRole: TripRole;
  createdAt: string;
}

export interface AdminTicketRow {
  id: string;
  number: number;
  subject: string;
  categoryCode: string;
  categoryLabel: string;
  isDispute: boolean;
  status: TicketStatus;
  priorityCode: string;
  priorityLabel: string;
  priorityRank: number;
  requesterId: string;
  requesterName: string | null;
  requesterRole: TripRole;
  assignedToId: string | null;
  assignedToName: string | null;
  tripId: string | null;
  createdAt: string;
  updatedAt: string;
  /** Escalated at least once (the level is data, the words say it). */
  escalationLevel: number;
  /** When the next answer is due for this priority; null once answered or finished. */
  responseDueAt: string | null;
  overdue: boolean;
}

export interface AdminTicketMessage {
  id: string;
  kind: 'MESSAGE' | 'NOTE' | 'STATUS' | 'RESOLUTION';
  from: 'REQUESTER' | 'ADMIN' | 'SYSTEM';
  authorName: string | null;
  body: string;
  createdAt: string;
  attachments: AttachmentInfo[];
}

export interface TicketRideContext {
  tripId: string;
  status: string;
  pickup: string;
  destination: string;
  requestedAt: string;
  passengerName: string | null;
  driverName: string | null;
  fareEstimateNpr: number | null;
  fareFinalNpr: number | null;
  waitingChargeNpr: number;
  cancellationFeeNpr: number;
  cancelledBy: string | null;
}

export interface TicketPaymentContext {
  amountNpr: number;
  status: string;
  method: string;
  paidAt: string | null;
  refundedNpr: number;
  quote: RefundQuote | null;
}

export interface AdminRefundInfo extends RefundInfo {
  requestedByName: string | null;
  requestedByRole: 'PASSENGER' | 'DRIVER' | 'ADMIN';
  decidedByName: string | null;
  decisionNote: string | null;
  reference: string | null;
  failedReason: string | null;
  /** What this admin may do next (the server applies the same rules again when they try). */
  allowedNext: RefundStatus[];
}

export interface AdminTicketDetail extends AdminTicketRow {
  messages: AdminTicketMessage[];
  ride: TicketRideContext | null;
  payment: TicketPaymentContext | null;
  refunds: AdminRefundInfo[];
  /** The person's earlier tickets: a summary, not the conversations. */
  history: Array<{
    id: string;
    number: number;
    subject: string;
    status: TicketStatus;
    createdAt: string;
  }>;
  outcome: TicketOutcome | null;
  resolution: string | null;
  allowedNext: TicketStatus[];
  canDecideRefunds: boolean;
  audit: AuditEntry[];
}

export interface AdminReplyBody {
  body: string;
  /** Optionally also move the ticket (otherwise the reply hands it to the person). */
  status?: TicketStatus;
}
export interface AdminNoteBody {
  body: string;
}
export interface AdminStatusBody {
  status: TicketStatus;
  /** Required to resolve: what was decided. */
  resolution?: string;
  outcome?: TicketOutcome;
}
export interface AdminAssignBody {
  /** Null to unassign. */
  adminId: string | null;
}
export interface AdminPriorityBody {
  priorityCode: string;
  reason: string;
}
export interface AdminRefundCreateBody extends RefundRequestBody {
  note?: string;
}
export interface AdminRefundActionBody {
  to: RefundStatus;
  note?: string;
  method?: RefundMethod;
  reference?: string;
  failedReason?: string;
}

/** The notification types support sends, once: the server sends them and the apps route on them. */
export const SUPPORT_NOTIFICATION_TYPES = {
  TICKET_CREATED: 'SUPPORT_TICKET_CREATED',
  REPLY: 'SUPPORT_REPLY',
  STATUS: 'SUPPORT_STATUS',
  DISPUTE_UPDATED: 'SUPPORT_DISPUTE_UPDATED',
  REFUND_DECISION: 'SUPPORT_REFUND_DECISION',
  REFUND_COMPLETED: 'SUPPORT_REFUND_COMPLETED',
  ESCALATED: 'SUPPORT_ESCALATED',
} as const;
export type SupportNotificationType =
  (typeof SUPPORT_NOTIFICATION_TYPES)[keyof typeof SUPPORT_NOTIFICATION_TYPES];
