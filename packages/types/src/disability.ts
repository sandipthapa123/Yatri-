import { daysUntil, expiryState, reminderStage, type ExpiryState } from './fleet';

/**
 * Disability benefit verification: the ONE definition of the states, the legal moves between them, who may make each
 * move, the card rules, the words, and what each person is allowed to see. The API decides and records everything;
 * the passenger app and the admin workspace only show these shapes and send intentions. A client never sets a status:
 * it asks, the server moves (or refuses), and only the server can ever mark a person VERIFIED.
 *
 * The whole thing is voluntary. A rider opts in, gives a consent (the existing consent system), submits a card and its
 * document, is told Approved / Not approved / Needs correction, and only then does a benefit apply. The benefit itself
 * is NOT defined here: it is an ordinary campaign (growth.ts) whose eligibility says "verified disability benefit", so
 * its value is configuration an administrator edits, and the discount and any points go through the one promotion
 * engine and the one points ledger.
 *
 * Privacy. The card number is never stored: only a keyed hash (to notice the same card on two accounts) and its last
 * four characters (so the rider and staff can recognise it). The document lives behind the storage provider and is shown
 * to staff through a short-lived signed link, each use audited. A driver never sees the number, the document or the
 * status history: only, after accepting a ride and only if the rider allowed it, that the rider has a verified
 * benefit. Withdrawing the consent ends the benefit and erases the card details.
 */

// ---------------------------------------------------------------- states and the legal moves

export const DISABILITY_VERIFICATION_STATUSES = [
  'NOT_SUBMITTED',
  'SUBMITTED',
  'UNDER_REVIEW',
  'NEEDS_CORRECTION',
  'VERIFIED',
  'REJECTED',
  'EXPIRED',
  'REVOKED',
] as const;
export type DisabilityVerificationStatus = (typeof DISABILITY_VERIFICATION_STATUSES)[number];

/** Staff words (precise). */
export const DISABILITY_STATUS_LABELS: Record<DisabilityVerificationStatus, string> = {
  NOT_SUBMITTED: 'Not submitted',
  SUBMITTED: 'Submitted, waiting for review',
  UNDER_REVIEW: 'Under review',
  NEEDS_CORRECTION: 'Needs correction',
  VERIFIED: 'Verified',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  REVOKED: 'Revoked',
};

/**
 * Every legal move, once. VERIFIED can only end (expire or be revoked); a rejected, expired or revoked rider may apply
 * again with new details; NOT_SUBMITTED is also where withdrawing an application that was not yet decided goes.
 */
export const DISABILITY_TRANSITIONS: Record<
  DisabilityVerificationStatus,
  readonly DisabilityVerificationStatus[]
> = {
  NOT_SUBMITTED: ['SUBMITTED'],
  SUBMITTED: ['UNDER_REVIEW', 'VERIFIED', 'NEEDS_CORRECTION', 'REJECTED', 'NOT_SUBMITTED'],
  UNDER_REVIEW: ['VERIFIED', 'NEEDS_CORRECTION', 'REJECTED', 'NOT_SUBMITTED'],
  NEEDS_CORRECTION: ['SUBMITTED', 'NOT_SUBMITTED'],
  VERIFIED: ['EXPIRED', 'REVOKED'],
  REJECTED: ['SUBMITTED', 'NOT_SUBMITTED'],
  EXPIRED: ['SUBMITTED', 'NOT_SUBMITTED'],
  REVOKED: ['SUBMITTED', 'NOT_SUBMITTED'],
};

export const DISABILITY_ACTORS = ['PASSENGER', 'ADMIN', 'SYSTEM'] as const;
export type DisabilityActor = (typeof DISABILITY_ACTORS)[number];

/**
 * Who may move a verification INTO each state. The passenger can only apply, or step away (withdraw an application, or
 * withdraw consent, which ends a verified benefit); VERIFIED belongs to staff and to the system (an official check that
 * confirmed the card); expiry is the system's.
 */
export const DISABILITY_ACTOR_TARGETS: Record<
  DisabilityActor,
  readonly DisabilityVerificationStatus[]
> = {
  PASSENGER: ['SUBMITTED', 'NOT_SUBMITTED', 'REVOKED'],
  ADMIN: ['UNDER_REVIEW', 'NEEDS_CORRECTION', 'VERIFIED', 'REJECTED', 'REVOKED'],
  SYSTEM: ['UNDER_REVIEW', 'VERIFIED', 'EXPIRED'],
};

export const canDisabilityTransition = (
  from: DisabilityVerificationStatus,
  to: DisabilityVerificationStatus,
) => DISABILITY_TRANSITIONS[from].includes(to);

export const disabilityStatusesLeadingTo = (
  to: DisabilityVerificationStatus,
): DisabilityVerificationStatus[] =>
  DISABILITY_VERIFICATION_STATUSES.filter((from) => canDisabilityTransition(from, to));

export type DisabilityMoveCheck = { ok: true } | { ok: false; reason: string };

/** Whether this actor may make this move now. The one check the API applies under the row lock. */
export function checkDisabilityMove(
  from: DisabilityVerificationStatus,
  to: DisabilityVerificationStatus,
  actor: DisabilityActor,
): DisabilityMoveCheck {
  if (!DISABILITY_ACTOR_TARGETS[actor].includes(to)) {
    return { ok: false, reason: 'That change is not one you can make.' };
  }
  if (!canDisabilityTransition(from, to)) {
    return {
      ok: false,
      reason: `A verification that is "${DISABILITY_STATUS_LABELS[from]}" cannot become "${DISABILITY_STATUS_LABELS[to]}".`,
    };
  }
  return { ok: true };
}

/** States the rider may change the card details and document in (the ones from which they can apply). */
export const DISABILITY_EDITABLE_STATUSES: readonly DisabilityVerificationStatus[] =
  disabilityStatusesLeadingTo('SUBMITTED');
/** States in which the application is with staff. */
export const DISABILITY_OPEN_STATUSES: readonly DisabilityVerificationStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
];

// ---------------------------------------------------------------- how a card is verified

/**
 * MANUAL        an administrator looks at the card and its document
 * OFFICIAL_API  an official verification service confirms the card; only selectable when an administrator has switched
 *               it on AND a connection exists. It can only CONFIRM: anything else goes to a person, never to a refusal.
 */
export const DISABILITY_METHODS = ['MANUAL', 'OFFICIAL_API'] as const;
export type DisabilityMethod = (typeof DISABILITY_METHODS)[number];
export const DISABILITY_METHOD_LABELS: Record<DisabilityMethod, { label: string; help: string }> = {
  MANUAL: {
    label: 'Checked by a Yatri reviewer',
    help: 'You upload a photo or PDF of your card. A person at Yatri looks at it.',
  },
  OFFICIAL_API: {
    label: 'Checked with the official service',
    help: 'Your card details are checked with the official verification service. If it cannot confirm them, a person at Yatri looks at your application.',
  },
};

// ---------------------------------------------------------------- consent, limits and wording constants

/** The consent (in the existing compliance_policies) a rider gives before anything is collected. */
export const DISABILITY_CONSENT_POLICY_KEY = 'DISABILITY_BENEFIT_CONSENT';
/** The personal setting (PREFERENCE_DEFS) that lets the driver of an accepted ride see that the benefit is verified. */
export const DISABILITY_DRIVER_SHARING_PREFERENCE = 'shareDisabilityStatusWithDriver';
/** The document type (in document_types) the card's photo or PDF is stored as. */
export const DISABILITY_DOCUMENT_TYPE_CODE = 'DISABILITY_CARD';
/** The kind of campaign eligibility that a benefit is paid through: see CampaignEligibility.requiresDisabilityVerified. */

/** Days before a verified card runs out that the rider is reminded (once each; the nearest one that applies). */
export const DISABILITY_EXPIRY_WARNING_DAYS = [30, 7] as const;

export const DISABILITY_CARD_NUMBER_MIN = 4;
export const DISABILITY_CARD_NUMBER_MAX = 30;
export const DISABILITY_AUTHORITY_MIN = 2;
export const DISABILITY_AUTHORITY_MAX = 120;
export const DISABILITY_REASON_MIN = 3;
export const DISABILITY_REASON_MAX = 300;
export const DISABILITY_MESSAGE_MAX = 500;
/** The longest a card's expiry date may be from today: a typo such as year 3025 is refused, not stored. */
export const DISABILITY_MAX_VALIDITY_YEARS = 50;

/** What the driver of an accepted ride is told, when the rider allowed it. Never an identity, a number or a document. */
export const DISABILITY_DRIVER_TEXT =
  'This rider has a verified disability benefit. Any accessibility needs they shared are listed with the ride.';

export interface TripDisabilityNote {
  verified: true;
  text: string;
}

// ---------------------------------------------------------------- the card rules (one place, pure)

/** Upper-case letters and digits only: the form in which a number is hashed and its last four kept. */
export const normalizeCardNumber = (raw: string): string =>
  raw.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function cardNumberProblem(raw: string): string | null {
  const n = normalizeCardNumber(raw);
  if (n.length < DISABILITY_CARD_NUMBER_MIN || n.length > DISABILITY_CARD_NUMBER_MAX) {
    return `The card number needs ${DISABILITY_CARD_NUMBER_MIN} to ${DISABILITY_CARD_NUMBER_MAX} letters or digits.`;
  }
  return null;
}

export const cardLast4 = (raw: string): string => normalizeCardNumber(raw).slice(-4);

/** "•••• 4821": what a rider and staff see in place of the number. */
export const maskedCard = (last4: string | null): string =>
  last4 ? `ending in ${last4.split('').join(' ')}` : 'no number saved';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
export function isIsoDate(v: string): boolean {
  if (!ISO_DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** What is wrong with the dates of a card, in words, or null. `today` is YYYY-MM-DD in the platform's time zone. */
export function cardDatesProblem(
  d: { issueDate: string | null; expiryDate: string | null },
  today: string,
): string | null {
  if (d.issueDate !== null && !isIsoDate(d.issueDate)) return 'The issue date is not a valid date.';
  if (d.expiryDate !== null && !isIsoDate(d.expiryDate))
    return 'The expiry date is not a valid date.';
  if (d.issueDate !== null && d.issueDate > today) return 'The issue date cannot be in the future.';
  if (d.expiryDate !== null && d.expiryDate < today)
    return 'This card has expired. Only a card that is still valid can be verified.';
  if (d.expiryDate !== null && daysUntil(d.expiryDate, today) > DISABILITY_MAX_VALIDITY_YEARS * 366)
    return 'The expiry date is too far away. Please check it.';
  return null;
}

export interface SubmissionFacts {
  consentGiven: boolean;
  method: DisabilityMethod;
  hasCardNumber: boolean;
  issuingAuthority: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  hasDocument: boolean;
}

/**
 * Everything still missing before an application can be sent, in words (empty: it can be sent). A manual check needs
 * the document; an official check needs only the details it checks. The server applies exactly this, and the apps list
 * it, so a rider is told what to do instead of being refused.
 */
export function submissionGaps(f: SubmissionFacts, today: string): string[] {
  const gaps: string[] = [];
  if (!f.consentGiven) gaps.push('Give your consent to use your card details.');
  if (!f.hasCardNumber) gaps.push('Enter your card number.');
  if (!f.issuingAuthority) gaps.push('Enter who issued the card.');
  if (!f.issueDate) gaps.push('Enter the issue date.');
  if (!f.expiryDate) gaps.push('Enter the expiry date.');
  const dates = cardDatesProblem({ issueDate: f.issueDate, expiryDate: f.expiryDate }, today);
  if (dates && f.issueDate && f.expiryDate) gaps.push(dates);
  if (f.method === 'MANUAL' && !f.hasDocument) gaps.push('Add a photo or PDF of your card.');
  return gaps;
}

/** The expiry reminder (in days) that applies to a verified card with this many days left, or null. */
export const disabilityExpiryReminder = (daysLeft: number): number | null =>
  reminderStage(daysLeft, DISABILITY_EXPIRY_WARNING_DAYS);

/** Valid, expiring soon or expired, from the same rule documents and licences use. */
export const disabilityExpiryState = (expiryDate: string | null, today: string): ExpiryState =>
  expiryState(expiryDate, today, Math.max(...DISABILITY_EXPIRY_WARNING_DAYS));

// ---------------------------------------------------------------- the words

interface StatusWords {
  /** The rider's label for the state (a submitted application and one under review read the same to them). */
  label: string;
  /** What just happened or is true, as a sentence. */
  headline: string;
  /** What happens next. */
  next: string;
}

export const DISABILITY_PASSENGER_WORDS: Record<DisabilityVerificationStatus, StatusWords> = {
  NOT_SUBMITTED: {
    label: 'Not submitted',
    headline: 'Disability benefit verification has not been submitted.',
    next: 'You can apply whenever you wish. It is optional.',
  },
  SUBMITTED: {
    label: 'Under review',
    headline: 'Disability benefit verification submitted.',
    next: 'We will tell you when it changes.',
  },
  UNDER_REVIEW: {
    label: 'Under review',
    headline: 'Your disability benefit verification is being reviewed.',
    next: 'We will tell you when it changes.',
  },
  NEEDS_CORRECTION: {
    label: 'Needs correction',
    headline: 'Your disability benefit verification needs a correction.',
    next: 'Read the message, fix the details, and send it again.',
  },
  VERIFIED: {
    label: 'Verified',
    headline: 'Your disability benefit is verified.',
    next: 'Your benefit applies to eligible rides.',
  },
  REJECTED: {
    label: 'Not approved',
    headline: 'Your disability benefit verification was not approved.',
    next: 'Read the reason. You can apply again with new details.',
  },
  EXPIRED: {
    label: 'Expired',
    headline: 'Your disability benefit verification has expired.',
    next: 'Your benefit no longer applies. You can apply again with a card that is still valid.',
  },
  REVOKED: {
    label: 'Ended',
    headline: 'Your disability benefit has ended.',
    next: 'You can apply again if you wish.',
  },
};

/** The one sentence announced for a state: "Disability benefit verification submitted. Status: Under review. We will tell you when it changes." */
export function disabilityAnnouncement(status: DisabilityVerificationStatus): string {
  const w = DISABILITY_PASSENGER_WORDS[status];
  return `${w.headline} Status: ${w.label}. ${w.next}`;
}

export const DISABILITY_NOTIFICATION_TYPES = {
  DISABILITY_VERIFICATION_UPDATE: 'DISABILITY_VERIFICATION_UPDATE',
  DISABILITY_VERIFICATION_EXPIRING: 'DISABILITY_VERIFICATION_EXPIRING',
} as const;

/** The notification a rider gets when their verification moves into a state (none for the ones they made themselves). */
export function disabilityNotification(
  to: DisabilityVerificationStatus,
  note: string | null,
): { title: string; body: string } | null {
  switch (to) {
    case 'UNDER_REVIEW':
      return {
        title: 'Verification under review',
        body: 'A reviewer has started looking at your disability benefit verification.',
      };
    case 'NEEDS_CORRECTION':
      return {
        title: 'Verification needs a correction',
        body: note
          ? `Please correct your application: ${note}`
          : 'Please correct your application and send it again.',
      };
    case 'VERIFIED':
      return {
        title: 'Disability benefit verified',
        body: 'Your disability benefit is verified and applies to eligible rides.',
      };
    case 'REJECTED':
      return {
        title: 'Verification not approved',
        body: note
          ? `Your application was not approved: ${note}`
          : 'Your application was not approved.',
      };
    case 'EXPIRED':
      return {
        title: 'Disability benefit expired',
        body: 'Your card has expired, so the benefit no longer applies. You can apply again with a valid card.',
      };
    case 'REVOKED':
      return {
        title: 'Disability benefit ended',
        body: note ? `Your benefit has ended: ${note}` : 'Your disability benefit has ended.',
      };
    default:
      return null;
  }
}

export function disabilityExpiryWarningText(daysLeft: number): { title: string; body: string } {
  return {
    title: 'Disability benefit card expires soon',
    body:
      daysLeft <= 0
        ? 'Your disability identity card expires today. Apply again with a card that is still valid to keep your benefit.'
        : `Your disability identity card expires in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}. Apply again with a valid card to keep your benefit.`,
  };
}

// ---------------------------------------------------------------- what the rider sees

export interface DisabilityMethodOption {
  method: DisabilityMethod;
  label: string;
  help: string;
  /** False when the method cannot be chosen now (the official service is off or not connected); `unavailableReason` says why. */
  available: boolean;
  unavailableReason: string | null;
}

export interface DisabilityHistoryEntry {
  at: string;
  toStatus: DisabilityVerificationStatus;
  /** One sentence ("Your disability benefit verification was not approved.") plus any reason staff gave. */
  text: string;
}

export interface DisabilityVerificationView {
  /** False when an administrator has switched the whole feature off. */
  enabled: boolean;
  status: DisabilityVerificationStatus;
  statusLabel: string;
  /** The full announcement sentence for the state. */
  statusText: string;
  method: DisabilityMethod;
  /** How it was actually verified, once it is. */
  verifiedMethod: DisabilityMethod | null;
  methods: DisabilityMethodOption[];
  consent: {
    policyKey: string;
    title: string;
    version: string;
    contentUrl: string | null;
    given: boolean;
    givenAt: string | null;
  };
  card: {
    last4: string | null;
    issuingAuthority: string | null;
    issueDate: string | null;
    expiryDate: string | null;
    hasDocument: boolean;
    documentName: string | null;
  };
  /** The reason or correction message staff gave for the latest decision. */
  message: string | null;
  submittedAt: string | null;
  verifiedAt: string | null;
  validUntil: string | null;
  expiry: { daysLeft: number | null; state: ExpiryState | null };
  canOptIn: boolean;
  canEdit: boolean;
  canSubmit: boolean;
  /** What is still missing before it can be sent, in words. */
  gaps: string[];
  canWithdraw: boolean;
  /** Whether the driver of an accepted ride may see that the benefit is verified (the personal setting; changed in settings). */
  driverSharing: boolean;
  benefit: { active: boolean; text: string };
  history: DisabilityHistoryEntry[];
}

export interface DisabilityDetailsBody {
  cardNumber?: string;
  issuingAuthority?: string;
  issueDate?: string;
  expiryDate?: string;
  method?: DisabilityMethod;
}
export interface DisabilityOptInBody {
  /** The version of the consent the rider read: refused if it is no longer the current one. */
  consentVersion: string;
  method?: DisabilityMethod;
}
export interface DisabilityPatchBody {
  details?: DisabilityDetailsBody;
  withdrawConsent?: true;
}

// ---------------------------------------------------------------- what staff see

export const DISABILITY_ADMIN_ACTIONS = [
  'start-review',
  'approve',
  'reject',
  'request-correction',
  'revoke',
] as const;
export type DisabilityAdminAction = (typeof DISABILITY_ADMIN_ACTIONS)[number];
export const DISABILITY_ADMIN_ACTION_TARGET: Record<
  DisabilityAdminAction,
  DisabilityVerificationStatus
> = {
  'start-review': 'UNDER_REVIEW',
  approve: 'VERIFIED',
  reject: 'REJECTED',
  'request-correction': 'NEEDS_CORRECTION',
  revoke: 'REVOKED',
};
export const DISABILITY_ADMIN_ACTION_LABELS: Record<
  DisabilityAdminAction,
  { label: string; consequence: string; needs: 'none' | 'reason' | 'message' }
> = {
  'start-review': {
    label: 'Start the review',
    consequence: 'The application is marked as being reviewed, and the rider is told.',
    needs: 'none',
  },
  approve: {
    label: 'Approve',
    consequence:
      'The rider is verified until the card expires, and the benefit applies to their eligible rides.',
    needs: 'none',
  },
  reject: {
    label: 'Reject',
    consequence: 'The application is not approved. The rider is told and sees your reason.',
    needs: 'reason',
  },
  'request-correction': {
    label: 'Ask for a correction',
    consequence: 'The rider is asked to fix the details and send the application again.',
    needs: 'message',
  },
  revoke: {
    label: 'Revoke',
    consequence: 'The benefit stops now. The rider is told and sees your reason.',
    needs: 'reason',
  },
};

/** The actions an administrator may take on a verification in this state: derived from the one transition table. */
export const disabilityAdminActionsFrom = (
  status: DisabilityVerificationStatus,
): DisabilityAdminAction[] =>
  DISABILITY_ADMIN_ACTIONS.filter(
    (a) => checkDisabilityMove(status, DISABILITY_ADMIN_ACTION_TARGET[a], 'ADMIN').ok,
  );

export interface AdminDisabilityRow {
  id: string;
  userId: string;
  userName: string | null;
  status: DisabilityVerificationStatus;
  statusLabel: string;
  /** What the rider chose, and how it was actually verified: never mixed up. */
  method: DisabilityMethod;
  verifiedMethod: DisabilityMethod | null;
  cardLast4: string | null;
  issuingAuthority: string | null;
  expiryDate: string | null;
  submittedAt: string | null;
  updatedAt: string;
  /** How many OTHER accounts hold a card with the same number (a reason to look, never proof). */
  duplicateCount: number;
  hasDocument: boolean;
}

export interface AdminDisabilityList {
  items: AdminDisabilityRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminDisabilityEvent {
  id: string;
  at: string;
  fromStatus: DisabilityVerificationStatus;
  toStatus: DisabilityVerificationStatus;
  toLabel: string;
  actorKind: DisabilityActor;
  actorName: string | null;
  method: DisabilityMethod | null;
  note: string | null;
}

export interface AdminDisabilityDetail extends AdminDisabilityRow {
  issueDate: string | null;
  message: string | null;
  consentActive: boolean;
  consentGivenAt: string | null;
  decidedAt: string | null;
  verifiedAt: string | null;
  validUntil: string | null;
  /** The other accounts with the same card number, by verification, so a reviewer can open them. */
  duplicates: Array<{ verificationId: string; status: DisabilityVerificationStatus }>;
  document: { name: string; mimeType: string; sizeBytes: number; uploadedAt: string } | null;
  history: AdminDisabilityEvent[];
  allowedActions: DisabilityAdminAction[];
}

export interface AdminDisabilityApproveBody {
  note?: string;
  /** Required when the card number is also on another account: the reviewer says they looked at it. */
  acknowledgeDuplicate?: boolean;
}
export interface AdminDisabilityReasonBody {
  reason: string;
}
export interface AdminDisabilityMessageBody {
  message: string;
}

/** The benefit side of the staff workspace: policies and their use, service options, and what a person should look at. */
export interface DisabilityBenefitsOverview {
  waitingForReview: number;
  policies: Array<{
    campaignId: string;
    name: string;
    status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ENDED';
    uses: number;
    discountNpr: number;
    distinctRiders: number;
  }>;
  serviceOptions: {
    extraBoardingSeconds: number;
    accessibleSearchRadiusBonusPercent: number;
    verificationEnabled: boolean;
    officialCheckOffered: boolean;
  };
  toReview: Array<{
    riskEventId: string;
    userId: string;
    userName: string | null;
    rule: string;
    points: number;
    at: string;
  }>;
}

export interface AdminDisabilityListFilters {
  status?: DisabilityVerificationStatus;
  method?: DisabilityMethod;
  duplicate?: boolean;
  limit?: number;
  offset?: number;
}
