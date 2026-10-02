import type { AuditEntry } from './safety';

/**
 * Fraud and risk: the ONE definition of every risk rule, level and wording. The API's detectors, the admin
 * screens and the tests read these tables; no app keeps its own rule.
 *
 * What the system does and does not do. It raises SIGNALS (a rule fired for a person, with a few points and
 * the minimal evidence needed to look into it) and derives a LEVEL from them. A signal is a reason for a human
 * to look, never proof, so:
 *  - the score is the sum of open and confirmed events in the window; an event an administrator dismissed as a
 *    false positive stops counting;
 *  - no single signal restricts anyone, and the engine never suspends: a restriction is temporary and a
 *    suspension is the existing, reversible, administrator-only account move;
 *  - events hold counts and record ids, never a phone number, an address or a coordinate.
 *
 * Level order, mildest first: LOW_RISK, REVIEW_REQUIRED (the score reached the review threshold),
 * RESTRICTED (a temporary restriction is in force), SUSPENDED (the account is suspended).
 */
export const RISK_LEVELS = ['LOW_RISK', 'REVIEW_REQUIRED', 'RESTRICTED', 'SUSPENDED'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_LEVEL_LABELS: Record<RiskLevel, string> = {
  LOW_RISK: 'Low risk',
  REVIEW_REQUIRED: 'Review required',
  RESTRICTED: 'Restricted',
  SUSPENDED: 'Suspended',
};

/** What each level means for the person, in words an administrator can repeat. */
export const RISK_LEVEL_HELP: Record<RiskLevel, string> = {
  LOW_RISK: 'Nothing needs attention.',
  REVIEW_REQUIRED:
    'The signals add up to enough that a person should look. Nothing has been changed for the account.',
  RESTRICTED:
    'A temporary restriction is in force: a passenger cannot request rides and a driver is not offered rides. It ends by itself.',
  SUSPENDED: 'The account is suspended. Only an administrator can restore it.',
};

export const RISK_CATEGORIES = [
  'ACCOUNT',
  'OTP',
  'MULTIPLE_ACCOUNTS',
  'GPS',
  'CANCELLATION',
  'PAYMENT',
  'RATING',
  'COLLUSION',
  'DISPUTE',
  'PAYOUT',
  'PROMOTION',
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_CATEGORY_LABELS: Record<RiskCategory, string> = {
  ACCOUNT: 'Suspicious account activity',
  OTP: 'One-time code abuse',
  MULTIPLE_ACCOUNTS: 'Several accounts',
  GPS: 'Location anomalies',
  CANCELLATION: 'Cancellation pattern',
  PAYMENT: 'Payment and refund abuse',
  RATING: 'Rating abuse',
  COLLUSION: 'Driver and passenger collusion',
  DISPUTE: 'Repeated disputes',
  PAYOUT: 'Unusual payouts',
  PROMOTION: 'Promotion and referral abuse',
};

export type RiskSubjectRole = 'PASSENGER' | 'DRIVER' | 'ANY';

export interface RiskRuleDef {
  code: string;
  category: RiskCategory;
  label: string;
  /** What it looks for, and why it can be innocent. */
  help: string;
  /** Whom it looks at. */
  subject: RiskSubjectRole;
  /** The defaults; an administrator can change them (stored as an override, with a reason). */
  points: number;
  threshold: number;
  windowHours: number;
  /** What `threshold` counts. */
  unit: string;
}

export const RISK_RULES = [
  {
    code: 'OTP_REQUEST_BURST',
    category: 'OTP',
    label: 'Many one-time codes requested for one number',
    help: 'Codes were requested again and again for the same account. A person who cannot receive the text does this too.',
    subject: 'ANY',
    points: 10,
    threshold: 6,
    windowHours: 1,
    unit: 'requests',
  },
  {
    code: 'OTP_WRONG_CODES',
    category: 'OTP',
    label: 'Many wrong one-time codes',
    help: 'Wrong codes were entered repeatedly, which can be guessing. It can also be someone mistyping.',
    subject: 'ANY',
    points: 15,
    threshold: 6,
    windowHours: 24,
    unit: 'failures',
  },
  {
    code: 'LOGIN_FAILURE_BURST',
    category: 'ACCOUNT',
    label: 'Many failed sign-ins',
    help: 'Many sign-ins failed for one account in a short time.',
    subject: 'ANY',
    points: 10,
    threshold: 10,
    windowHours: 1,
    unit: 'failures',
  },
  {
    code: 'SUSPENDED_RETRIES',
    category: 'ACCOUNT',
    label: 'Repeated attempts to use a suspended account',
    help: 'A suspended account kept trying to get in.',
    subject: 'ANY',
    points: 10,
    threshold: 3,
    windowHours: 24,
    unit: 'attempts',
  },
  {
    code: 'SHARED_ADDRESS_ACCOUNTS',
    category: 'MULTIPLE_ACCOUNTS',
    label: 'Several accounts signing in from one network address',
    help: 'Many different accounts verified from one address. Shared networks (a mobile carrier, an office, a household) do this innocently, so this adds few points.',
    subject: 'ANY',
    points: 5,
    threshold: 4,
    windowHours: 24,
    unit: 'accounts',
  },
  {
    code: 'GPS_SPOOFING_FLAGS',
    category: 'GPS',
    label: 'Repeated implausible driver locations',
    help: 'A driver app reported mock locations, impossible speeds or jumps many times. A faulty phone does this too.',
    subject: 'DRIVER',
    points: 20,
    threshold: 5,
    windowHours: 24,
    unit: 'flags',
  },
  {
    code: 'PROMO_REDEMPTION_BURST',
    category: 'PROMOTION',
    label: 'Many offers used in a short time',
    help: 'A rider used many offers in a day. Several rides in a day with offers is possible, so only a high count adds points.',
    subject: 'PASSENGER',
    points: 10,
    threshold: 6,
    windowHours: 24,
    unit: 'redemptions',
  },
  {
    code: 'REFERRAL_BURST',
    category: 'PROMOTION',
    label: 'Many invites accepted in a short time',
    help: 'Many new accounts used one person\u2019s invite code within a week. A popular person (or a family) can do this innocently.',
    subject: 'PASSENGER',
    points: 15,
    threshold: 8,
    windowHours: 168,
    unit: 'invites',
  },
  {
    code: 'REFERRAL_SHARED_NETWORK',
    category: 'PROMOTION',
    label: 'Invited accounts signing in from the inviter\u2019s network address',
    help: 'Accounts that used someone\u2019s invite verified from the same network address as that person. A household or an office shares an address innocently, so this adds few points.',
    subject: 'PASSENGER',
    points: 5,
    threshold: 2,
    windowHours: 720,
    unit: 'accounts',
  },
  {
    code: 'SELF_REFERRAL_ATTEMPTS',
    category: 'PROMOTION',
    label: 'Repeated attempts to use one\u2019s own invite',
    help: 'A rider tried several times to use their own invite code. Someone who misunderstood how invites work does this too.',
    subject: 'PASSENGER',
    points: 10,
    threshold: 3,
    windowHours: 24,
    unit: 'attempts',
  },
  {
    code: 'DISABILITY_DUPLICATE_CARD',
    category: 'PROMOTION',
    label: 'Disability card number also on another account',
    help: 'The card number of a disability benefit application is also on another rider\u2019s application. Family members, a mistyped number or a lost-and-found card all do this, so it adds few points and only asks a reviewer to look. It never rejects anyone.',
    subject: 'PASSENGER',
    points: 15,
    threshold: 1,
    windowHours: 720,
    unit: 'other accounts',
  },
  {
    code: 'DISABILITY_REPEATED_SUBMISSIONS',
    category: 'PROMOTION',
    label: 'Disability application sent again and again',
    help: 'A rider sent a disability benefit application many times in a month. Corrections after a reviewer\u2019s message are normal, so only a high count adds points.',
    subject: 'PASSENGER',
    points: 10,
    threshold: 5,
    windowHours: 720,
    unit: 'applications',
  },
  {
    code: 'ROUTE_DEVIATION_PATTERN',
    category: 'GPS',
    label: 'Repeatedly far off the planned route',
    help: 'A driver was confirmed far off the planned route, several times on each of several rides. Roadworks, closed streets, passenger requests and poor maps do this innocently, so it adds few points and only a pattern across rides counts, never one ride.',
    subject: 'DRIVER',
    points: 5,
    threshold: 3,
    windowHours: 168,
    unit: 'rides',
  },
  {
    code: 'PASSENGER_CANCELLATIONS',
    category: 'CANCELLATION',
    label: 'Passenger cancels most rides',
    help: 'A passenger cancelled many rides, and most of those they requested. Plans change, so only a high count and share counts.',
    subject: 'PASSENGER',
    points: 15,
    threshold: 5,
    windowHours: 168,
    unit: 'cancellations',
  },
  {
    code: 'DRIVER_CANCELLATIONS',
    category: 'CANCELLATION',
    label: 'Driver cancels most accepted rides',
    help: 'A driver cancelled many rides they had accepted, and most of those they accepted. It can mean cherry-picking trips, or a vehicle problem.',
    subject: 'DRIVER',
    points: 20,
    threshold: 5,
    windowHours: 168,
    unit: 'cancellations',
  },
  {
    code: 'UNPAID_RIDES',
    category: 'PAYMENT',
    label: 'Finished rides left unpaid',
    help: 'A passenger finished several rides that were never paid for.',
    subject: 'PASSENGER',
    points: 25,
    threshold: 3,
    windowHours: 720,
    unit: 'unpaid rides',
  },
  {
    code: 'REFUND_REQUEST_BURST',
    category: 'PAYMENT',
    label: 'Many refund requests',
    help: 'A person asked for refunds on many rides. Some of these are genuine problems; the decision on each stays with support.',
    subject: 'ANY',
    points: 15,
    threshold: 3,
    windowHours: 720,
    unit: 'requests',
  },
  {
    code: 'RATING_BOOSTING',
    category: 'RATING',
    label: 'Repeated top ratings between the same two people',
    help: 'The same rider and driver rated each other five stars again and again.',
    subject: 'ANY',
    points: 10,
    threshold: 4,
    windowHours: 720,
    unit: 'ratings',
  },
  {
    code: 'RATING_BOMBING',
    category: 'RATING',
    label: 'Many lowest ratings in a short time',
    help: 'A person gave one star to many people in a day. A bad day for the service does this too.',
    subject: 'ANY',
    points: 10,
    threshold: 5,
    windowHours: 24,
    unit: 'ratings',
  },
  {
    code: 'REPEAT_PAIR_RIDES',
    category: 'COLLUSION',
    label: 'The same rider and driver, ride after ride',
    help: 'A rider and a driver completed many rides together. Regular commuters do this innocently; it matters when rides earn incentives.',
    subject: 'ANY',
    points: 15,
    threshold: 6,
    windowHours: 168,
    unit: 'rides',
  },
  {
    code: 'REPEATED_DISPUTES',
    category: 'DISPUTE',
    label: 'Many disputes',
    help: 'A person raised many disputes. Each may be genuine; the pattern is only a reason to look.',
    subject: 'ANY',
    points: 10,
    threshold: 3,
    windowHours: 720,
    unit: 'disputes',
  },
  {
    code: 'INCENTIVE_SPIKE',
    category: 'PAYOUT',
    label: 'Unusually large incentive earnings',
    help: 'A driver earned a lot in incentives in a short time. Platform-paid bonuses are the only payout the platform makes.',
    subject: 'DRIVER',
    points: 20,
    threshold: 5000,
    windowHours: 24,
    unit: 'NPR',
  },
] as const satisfies readonly RiskRuleDef[];

export type RiskRuleCode = (typeof RISK_RULES)[number]['code'];
export const RISK_RULE_CODES: readonly RiskRuleCode[] = RISK_RULES.map((r) => r.code);

export function riskRuleDef(code: string): RiskRuleDef | undefined {
  return (RISK_RULES as readonly RiskRuleDef[]).find((r) => r.code === code);
}

/**
 * The share of a person's rides that must be cancelled, besides the count, before the cancellation rules fire.
 * A heavy user with many rides and a few cancellations is not a pattern.
 */
export const RISK_CANCELLATION_MIN_SHARE_PERCENT = 50;

/** A finished ride is only called unpaid after this long, so a payment that is simply late does not count. */
export const RISK_UNPAID_GRACE_HOURS = 24;

/** The team is told again that a person still needs a review only after this long. */
export const RISK_REVIEW_REMINDER_DAYS = 7;

/** At most this many record ids are kept as evidence on one event. */
export const RISK_EVIDENCE_MAX_IDS = 10;

/** Limits on what administrators write. */
export const RISK_NOTE_MAX = 1000;

/**
 * The ONE rule for the level, used by the API for every screen and check: suspended beats restricted beats
 * review-required. Nothing here is stored; it is worked out from the account, the restriction and the score.
 */
export function deriveRiskLevel(input: {
  accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  restrictedUntil: string | Date | null;
  score: number;
  reviewScore: number;
  now?: number;
}): RiskLevel {
  if (input.accountStatus === 'SUSPENDED') return 'SUSPENDED';
  const until = input.restrictedUntil ? new Date(input.restrictedUntil).getTime() : 0;
  if (until > (input.now ?? Date.now())) return 'RESTRICTED';
  return input.score >= input.reviewScore ? 'REVIEW_REQUIRED' : 'LOW_RISK';
}

export const RISK_EVENT_STATUSES = ['OPEN', 'CONFIRMED', 'DISMISSED'] as const;
export type RiskEventStatus = (typeof RISK_EVENT_STATUSES)[number];
export const RISK_EVENT_STATUS_LABELS: Record<RiskEventStatus, string> = {
  OPEN: 'Open',
  CONFIRMED: 'Confirmed',
  DISMISSED: 'Dismissed as a false alarm',
};
/** The review decisions an administrator can make on an event. */
export const RISK_EVENT_TRANSITIONS: Record<RiskEventStatus, readonly RiskEventStatus[]> = {
  OPEN: ['CONFIRMED', 'DISMISSED'],
  CONFIRMED: ['DISMISSED'],
  DISMISSED: ['CONFIRMED'],
};
/** Dismissed events are the only ones that stop counting towards the score. */
export const RISK_COUNTING_STATUSES: readonly RiskEventStatus[] = ['OPEN', 'CONFIRMED'];

/** Who set a restriction, for the record: a person, or the engine. */
export const RISK_RESTRICTION_SOURCES = ['ADMIN', 'AUTOMATIC'] as const;
export type RiskRestrictionSource = (typeof RISK_RESTRICTION_SOURCES)[number];

/** Shown to a restricted person: neutral, nothing about why or what was detected. */
export const ACCOUNT_RESTRICTED_MESSAGE =
  'This feature is temporarily unavailable for your account. Please contact support if you need help.';

/** Facts kept with an event: counts and record ids only (no phone, address or coordinates). */
export interface RiskEvidence {
  count?: number;
  total?: number;
  windowHours?: number;
  /** Records worth looking at, never personal details. */
  tripIds?: string[];
  relatedUserIds?: string[];
  kinds?: string[];
}

export type RiskUserRole = 'PASSENGER' | 'DRIVER' | 'ADMIN';

export interface RiskEventInfo {
  id: string;
  userId: string | null;
  userName: string | null;
  userRole: RiskUserRole | null;
  ruleCode: string;
  ruleLabel: string;
  category: RiskCategory;
  points: number;
  status: RiskEventStatus;
  evidence: RiskEvidence;
  tripId: string | null;
  createdAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

export interface RiskNoteInfo {
  id: string;
  authorName: string | null;
  note: string;
  userId: string | null;
  tripId: string | null;
  eventId: string | null;
  createdAt: string;
}

export interface RiskRestrictionInfo {
  until: string;
  reason: string;
  source: RiskRestrictionSource;
  setAt: string;
}

export interface RiskUserRow {
  userId: string;
  name: string | null;
  role: RiskUserRole;
  level: RiskLevel;
  score: number;
  openEvents: number;
  lastEventAt: string | null;
}

export interface RiskUserDetail {
  userId: string;
  name: string | null;
  role: RiskUserRole;
  accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  level: RiskLevel;
  levelHelp: string;
  score: number;
  reviewScore: number;
  /** The longest restriction the server will accept, so the form can say it. */
  maxRestrictionDays: number;
  restriction: RiskRestrictionInfo | null;
  events: RiskEventInfo[];
  notes: RiskNoteInfo[];
  /** Context for judging the signals, all counts. */
  context: {
    completedRides: number;
    cancelledRides: number;
    disputes: number;
    refundRequests: number;
  };
  audit: AuditEntry[];
  /** What the administrator may do now, from the server: the screens show only these controls. */
  actions: { canRestrict: boolean; canLift: boolean; canSuspend: boolean; canRestore: boolean };
}

export interface RiskTripDetail {
  tripId: string;
  status: string;
  passengerId: string;
  passengerName: string | null;
  driverId: string | null;
  driverName: string | null;
  events: RiskEventInfo[];
  notes: RiskNoteInfo[];
  /** Which records exist, not what is in them; the rides screen shows those and audits the read. */
  hasPayment: boolean;
  hasRefund: boolean;
  hasDispute: boolean;
  audit: AuditEntry[];
}

export interface RiskRuleInfo extends RiskRuleDef {
  enabled: boolean;
  /** Whether an administrator has changed it from the defaults. */
  customised: boolean;
  defaults: { points: number; threshold: number; windowHours: number };
}

export interface RiskOverview {
  reviewRequired: number;
  restricted: number;
  suspended: number;
  openEvents: number;
  eventsLast24h: number;
  byCategory: Array<{ category: RiskCategory; open: number }>;
  reviewScore: number;
  autoRestrictScore: number;
}

export interface RiskSweepResult {
  evaluated: number;
  eventsCreated: number;
  restricted: number;
  lifted: number;
}

// --- Admin request bodies ---
export interface AdminRiskReviewBody {
  status: RiskEventStatus;
  reason: string;
}
export interface AdminRiskNoteBody {
  note: string;
  userId?: string | null;
  tripId?: string | null;
  eventId?: string | null;
}
export interface AdminRiskRestrictBody {
  days: number;
  reason: string;
}
export interface AdminRiskLiftBody {
  reason: string;
}
export interface AdminRiskRuleBody {
  enabled: boolean;
  points: number;
  threshold: number;
  windowHours: number;
  reason: string;
}

/** The notifications risk sends, once. The team's carries no details; a person's is neutral. */
export const RISK_NOTIFICATION_TYPES = {
  REVIEW_NEEDED: 'RISK_REVIEW_NEEDED',
  ACCOUNT_RESTRICTED: 'RISK_ACCOUNT_RESTRICTED',
  RESTRICTION_LIFTED: 'RISK_RESTRICTION_LIFTED',
} as const;
export type RiskNotificationType =
  (typeof RISK_NOTIFICATION_TYPES)[keyof typeof RISK_NOTIFICATION_TYPES];
