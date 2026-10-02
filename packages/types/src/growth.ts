/**
 * Growth and loyalty: the ONE definition of campaigns, offers, eligibility, usage limits, validity, the points
 * ledger, referrals and the words for them. The API's engine decides and records everything; the admin dashboard
 * edits these shapes; the passenger app only shows the result of the engine's answer. No app holds a campaign rule,
 * an amount or a limit of its own.
 *
 *   Campaign -> Eligibility -> Offer -> Usage limit -> Validity -> Redemption -> Result
 *
 * Every pure rule below (is a campaign live, is a person eligible, what does an offer take off a fare, how several
 * offers combine, how many points a fare earns) is unit tested here once and called by the engine; nothing re-derives
 * them. Money is whole Nepalese rupees. Driver incentives are NOT a second system: they stay in the existing incentive
 * rules (operations/incentives.service.ts) and the campaign service presents them alongside.
 */

// ---------------------------------------------------------------- campaigns

/**
 * PROMO       an offer on rides for the people it is meant for, applied automatically unless it has a code
 * COUPON      the same, but only with its code (the code is required)
 * FIRST_RIDE  an offer for a person's first completed ride (always only that)
 * REFERRAL    what a new person and the person who invited them each get
 * RETENTION   an offer (and a message) for people who stopped riding
 * PUSH        a message to a group of people, once, at a scheduled time
 */
export const CAMPAIGN_KINDS = [
  'PROMO',
  'COUPON',
  'FIRST_RIDE',
  'REFERRAL',
  'RETENTION',
  'PUSH',
] as const;
export type CampaignKind = (typeof CAMPAIGN_KINDS)[number];

export const CAMPAIGN_KIND_LABELS: Record<CampaignKind, { label: string; help: string }> = {
  PROMO: {
    label: 'Promotion',
    help: 'An offer on rides for the people it is meant for. Applied automatically, or only with a code if you give it one.',
  },
  COUPON: { label: 'Coupon', help: 'An offer that is used by entering its code.' },
  FIRST_RIDE: {
    label: 'First-ride offer',
    help: "An offer for a person's first completed ride, and only that.",
  },
  REFERRAL: {
    label: 'Referral',
    help: "What a new rider gets for using an invite, and the points the person who invited them earns when that rider's first ride is done.",
  },
  RETENTION: {
    label: 'Win-back offer',
    help: 'An offer, with a message, for riders who have not ridden for a while.',
  },
  PUSH: {
    label: 'Message campaign',
    help: 'A notification sent once, at the scheduled time, to the riders it is meant for.',
  },
};

/** Whether the kind carries an offer the engine applies to a ride or a person. */
export const CAMPAIGN_KIND_HAS_OFFER: Record<CampaignKind, boolean> = {
  PROMO: true,
  COUPON: true,
  FIRST_RIDE: true,
  REFERRAL: true,
  RETENTION: true,
  PUSH: false,
};
/** Kinds that need a message (the title and text people read). */
export const CAMPAIGN_KIND_HAS_MESSAGE: Record<CampaignKind, boolean> = {
  PROMO: false,
  COUPON: false,
  FIRST_RIDE: false,
  REFERRAL: false,
  RETENTION: true,
  PUSH: true,
};

export const CAMPAIGN_STATUSES = ['DRAFT', 'ACTIVE', 'PAUSED', 'ENDED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];
export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  ENDED: 'Ended',
};

/** The moves an administrator can make; ENDED is final. The one transition table. */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ['ACTIVE', 'ENDED'],
  ACTIVE: ['PAUSED', 'ENDED'],
  PAUSED: ['ACTIVE', 'ENDED'],
  ENDED: [],
};

/** What a campaign is doing right now, from its status and its schedule. */
export type CampaignPhase = 'DRAFT' | 'SCHEDULED' | 'LIVE' | 'PAUSED' | 'EXPIRED' | 'ENDED';
export const CAMPAIGN_PHASE_LABELS: Record<CampaignPhase, string> = {
  DRAFT: 'Draft, not started',
  SCHEDULED: 'Scheduled, starts later',
  LIVE: 'Live now',
  PAUSED: 'Paused',
  EXPIRED: 'Finished (its dates have passed)',
  ENDED: 'Ended',
};

export function campaignPhase(
  c: { status: CampaignStatus; startsAt: string | null; endsAt: string | null },
  now: Date = new Date(),
): CampaignPhase {
  if (c.status === 'DRAFT') return 'DRAFT';
  if (c.status === 'ENDED') return 'ENDED';
  if (c.status === 'PAUSED') return 'PAUSED';
  const t = now.getTime();
  if (c.startsAt && new Date(c.startsAt).getTime() > t) return 'SCHEDULED';
  if (c.endsAt && new Date(c.endsAt).getTime() <= t) return 'EXPIRED';
  return 'LIVE';
}

// ---------------------------------------------------------------- eligibility

/**
 * Who a campaign is for. Every part is optional and they all have to hold. `userIds` targets named people only.
 * Rides-based parts use COMPLETED rides.
 */
export interface CampaignEligibility {
  /** 0 means "only before their first completed ride". */
  maxCompletedRides?: number;
  minCompletedRides?: number;
  /** Accounts at most this many days old. */
  newUserWithinDays?: number;
  /** Riders whose last completed ride was at least this many days ago (and who have had one). */
  inactiveForDays?: number;
  /** Vehicle category codes the ride must be in. */
  vehicleCategoryCodes?: string[];
  /** Cities (by id) the ride must be in. */
  cityIds?: string[];
  /** The fare must be at least this much for the offer to apply. */
  minFareNpr?: number;
  userIds?: string[];
}

/** What is known about a person (and, when quoting, the ride) when eligibility is judged. */
export interface EligibilityFacts {
  userId: string;
  completedRides: number;
  accountAgeDays: number;
  /** Days since the last completed ride; null when there has been none. */
  daysSinceLastRide: number | null;
  /** The ride being priced; null when judging a person with no ride (a push audience, a grant). */
  ride: { categoryCode: string | null; cityId: string | null; fareNpr: number } | null;
}

export interface EligibilityVerdict {
  eligible: boolean;
  /** The first reason in words when not eligible (never shown as a blame, only as why an offer does not apply). */
  reason: string | null;
}

/** The ONE eligibility rule. Pure. */
export function evaluateEligibility(
  rule: CampaignEligibility,
  f: EligibilityFacts,
): EligibilityVerdict {
  const no = (reason: string): EligibilityVerdict => ({ eligible: false, reason });
  if (rule.userIds && rule.userIds.length > 0 && !rule.userIds.includes(f.userId)) {
    return no('This offer is for specific riders.');
  }
  if (rule.maxCompletedRides !== undefined && f.completedRides > rule.maxCompletedRides) {
    return no(
      rule.maxCompletedRides === 0
        ? 'This offer is for your first ride only.'
        : 'You have taken too many rides for this offer.',
    );
  }
  if (rule.minCompletedRides !== undefined && f.completedRides < rule.minCompletedRides) {
    return no(`This offer needs at least ${rule.minCompletedRides} completed rides.`);
  }
  if (rule.newUserWithinDays !== undefined && f.accountAgeDays > rule.newUserWithinDays) {
    return no('This offer is for new riders.');
  }
  if (rule.inactiveForDays !== undefined) {
    if (f.daysSinceLastRide === null || f.daysSinceLastRide < rule.inactiveForDays) {
      return no('This offer is for riders who have not ridden for a while.');
    }
  }
  if (f.ride) {
    if (rule.vehicleCategoryCodes && rule.vehicleCategoryCodes.length > 0) {
      if (!f.ride.categoryCode || !rule.vehicleCategoryCodes.includes(f.ride.categoryCode)) {
        return no('This offer does not apply to this vehicle type.');
      }
    }
    if (rule.cityIds && rule.cityIds.length > 0) {
      if (!f.ride.cityId || !rule.cityIds.includes(f.ride.cityId))
        return no('This offer does not apply in this city.');
    }
    if (rule.minFareNpr !== undefined && f.ride.fareNpr < rule.minFareNpr) {
      return no(`This offer needs a fare of at least NPR ${rule.minFareNpr}.`);
    }
  } else if (
    (rule.vehicleCategoryCodes && rule.vehicleCategoryCodes.length > 0) ||
    (rule.cityIds && rule.cityIds.length > 0) ||
    rule.minFareNpr !== undefined
  ) {
    // A ride-shaped condition cannot be judged without a ride: such an offer is shown as available and checked at booking.
    return { eligible: true, reason: null };
  }
  return { eligible: true, reason: null };
}

// ---------------------------------------------------------------- offers

/**
 * PERCENT_OFF / FIXED_OFF   take money off a fare (the platform pays the difference)
 * BONUS_POINTS              extra loyalty points on the ride
 * POINTS_MULTIPLIER         the ride's loyalty points multiplied (a "double points" campaign)
 */
export const OFFER_TYPES = [
  'PERCENT_OFF',
  'FIXED_OFF',
  'BONUS_POINTS',
  'POINTS_MULTIPLIER',
] as const;
export type OfferType = (typeof OFFER_TYPES)[number];
export const OFFER_TYPE_LABELS: Record<OfferType, string> = {
  PERCENT_OFF: 'Percent off the fare',
  FIXED_OFF: 'Fixed amount off the fare',
  BONUS_POINTS: 'Bonus loyalty points',
  POINTS_MULTIPLIER: 'Loyalty points multiplier',
};
export const OFFER_IS_DISCOUNT: Record<OfferType, boolean> = {
  PERCENT_OFF: true,
  FIXED_OFF: true,
  BONUS_POINTS: false,
  POINTS_MULTIPLIER: false,
};

export interface CampaignOffer {
  type: OfferType;
  percent?: number;
  fixedNpr?: number;
  /** Cap on a percent discount. */
  maxDiscountNpr?: number;
  points?: number;
  /** For POINTS_MULTIPLIER: 2 means double the ride's points. */
  multiplier?: number;
}

export const OFFER_LIMITS = {
  percentMax: 100,
  fixedMax: 100_000,
  pointsMax: 100_000,
  multiplierMin: 1.1,
  multiplierMax: 10,
} as const;

/** What is wrong with an offer, in words, or null. */
export function offerProblem(o: CampaignOffer): string | null {
  switch (o.type) {
    case 'PERCENT_OFF':
      return o.percent === undefined ||
        !Number.isFinite(o.percent) ||
        o.percent <= 0 ||
        o.percent > OFFER_LIMITS.percentMax
        ? `A percent offer needs a percentage from 1 to ${OFFER_LIMITS.percentMax}.`
        : o.maxDiscountNpr !== undefined &&
            (!Number.isInteger(o.maxDiscountNpr) || o.maxDiscountNpr <= 0)
          ? 'The most it can take off must be a whole number of rupees above zero.'
          : null;
    case 'FIXED_OFF':
      return o.fixedNpr === undefined ||
        !Number.isInteger(o.fixedNpr) ||
        o.fixedNpr <= 0 ||
        o.fixedNpr > OFFER_LIMITS.fixedMax
        ? 'A fixed offer needs a whole number of rupees above zero.'
        : null;
    case 'BONUS_POINTS':
      return o.points === undefined ||
        !Number.isInteger(o.points) ||
        o.points <= 0 ||
        o.points > OFFER_LIMITS.pointsMax
        ? 'Bonus points must be a whole number above zero.'
        : null;
    case 'POINTS_MULTIPLIER':
      return o.multiplier === undefined ||
        o.multiplier < OFFER_LIMITS.multiplierMin ||
        o.multiplier > OFFER_LIMITS.multiplierMax
        ? `The multiplier must be between ${OFFER_LIMITS.multiplierMin} and ${OFFER_LIMITS.multiplierMax}.`
        : null;
  }
}

/** The ONE discount calculation: whole rupees, never more than the fare, never negative. */
export function computeDiscount(o: CampaignOffer, fareNpr: number): number {
  if (fareNpr <= 0) return 0;
  let d = 0;
  if (o.type === 'PERCENT_OFF' && o.percent) {
    d = Math.floor((fareNpr * o.percent) / 100);
    if (o.maxDiscountNpr !== undefined) d = Math.min(d, o.maxDiscountNpr);
  } else if (o.type === 'FIXED_OFF' && o.fixedNpr) {
    d = o.fixedNpr;
  }
  return Math.max(0, Math.min(d, fareNpr));
}

/** A short plain description of an offer ("10% off, up to NPR 100"). */
export function describeOffer(o: CampaignOffer): string {
  switch (o.type) {
    case 'PERCENT_OFF':
      return `${o.percent}% off your fare${o.maxDiscountNpr ? `, up to NPR ${o.maxDiscountNpr}` : ''}`;
    case 'FIXED_OFF':
      return `NPR ${o.fixedNpr} off your fare`;
    case 'BONUS_POINTS':
      return `${o.points} bonus reward points`;
    case 'POINTS_MULTIPLIER':
      return `${o.multiplier}× reward points on the ride`;
  }
}

// ---------------------------------------------------------------- usage and validity

export interface CampaignLimits {
  /** How many times one person may use it; null = no limit. */
  perUser: number | null;
  /** How many times in all; null = no limit. */
  total: number | null;
  /** For an offer given to a person (a grant): it must be used within this many days of being given. */
  validDaysAfterGrant: number | null;
}

/** Whether another use is allowed under the limits, given the counts so far. */
export function usageAllowed(
  limits: Pick<CampaignLimits, 'perUser' | 'total'>,
  used: { byUser: number; total: number },
): { allowed: boolean; reason: string | null } {
  if (limits.perUser !== null && used.byUser >= limits.perUser) {
    return {
      allowed: false,
      reason:
        limits.perUser === 1
          ? 'You have already used this offer.'
          : `You have used this offer the most times it allows (${limits.perUser}).`,
    };
  }
  if (limits.total !== null && used.total >= limits.total) {
    return { allowed: false, reason: 'This offer has been fully used.' };
  }
  return { allowed: true, reason: null };
}

/** The conditions of an offer in plain sentences, for the rider's offer list. One wording. */
export function describeConditions(
  e: CampaignEligibility,
  limits: Pick<CampaignLimits, 'perUser' | 'total'>,
): string[] {
  const out: string[] = [];
  if (e.maxCompletedRides === 0) out.push('For your first completed ride.');
  else if (e.maxCompletedRides !== undefined)
    out.push(`For riders with up to ${e.maxCompletedRides} completed rides.`);
  if (e.minCompletedRides !== undefined && e.minCompletedRides > 0)
    out.push(`For riders with at least ${e.minCompletedRides} completed rides.`);
  if (e.newUserWithinDays !== undefined)
    out.push(`For accounts opened in the last ${e.newUserWithinDays} days.`);
  if (e.inactiveForDays !== undefined)
    out.push(`For riders who have not ridden for ${e.inactiveForDays} days.`);
  if (e.vehicleCategoryCodes && e.vehicleCategoryCodes.length > 0)
    out.push(`Vehicle types: ${e.vehicleCategoryCodes.join(', ')}.`);
  if (e.minFareNpr !== undefined) out.push(`For fares of at least NPR ${e.minFareNpr}.`);
  if (limits.perUser !== null)
    out.push(limits.perUser === 1 ? 'Can be used once.' : `Can be used ${limits.perUser} times.`);
  return out;
}

// ---------------------------------------------------------------- the campaign record

export interface CampaignMessage {
  title: string;
  body: string;
}

export interface CampaignInfo {
  id: string;
  kind: CampaignKind;
  name: string;
  description: string;
  /** The code a person enters; null when the offer needs none. */
  code: string | null;
  status: CampaignStatus;
  phase: CampaignPhase;
  startsAt: string | null;
  endsAt: string | null;
  eligibility: CampaignEligibility;
  offer: CampaignOffer | null;
  /** REFERRAL only: points the person who invited earns when the new rider's first ride is done. */
  referrerPoints: number | null;
  /** Another offer may be used on the same ride with this one. */
  stackable: boolean;
  limits: CampaignLimits;
  message: CampaignMessage | null;
  /** PUSH / RETENTION: when the message went out, if it has. */
  sentAt: string | null;
  /** Redemptions so far (a ride that used it, applied or waiting for the ride to end). */
  redemptions: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const CAMPAIGN_CODE_PATTERN = /^[A-Z0-9]{4,20}$/;
export const CAMPAIGN_NAME_MAX = 80;
export const CAMPAIGN_MESSAGE_TITLE_MAX = 60;
export const CAMPAIGN_MESSAGE_BODY_MAX = 240;

/** The body an administrator saves. A save names the version it was based on and says why. */
export interface AdminCampaignBody {
  kind: CampaignKind;
  name: string;
  description: string;
  code: string | null;
  startsAt: string | null;
  endsAt: string | null;
  eligibility: CampaignEligibility;
  offer: CampaignOffer | null;
  referrerPoints: number | null;
  stackable: boolean;
  limits: CampaignLimits;
  message: CampaignMessage | null;
  version?: number;
  reason: string;
}

/** What is wrong with a campaign as configured, in words, or null. The one validity rule (server and dashboard). */
export function campaignProblem(b: Omit<AdminCampaignBody, 'reason' | 'version'>): string | null {
  if (b.name.trim().length < 3) return 'Give the campaign a name of at least three characters.';
  if (b.code !== null && !CAMPAIGN_CODE_PATTERN.test(b.code)) {
    return 'A code is 4 to 20 capital letters and digits.';
  }
  if (b.kind === 'COUPON' && b.code === null) return 'A coupon needs a code.';
  if (b.kind !== 'COUPON' && b.kind !== 'PROMO' && b.code !== null) {
    return 'Only promotions and coupons can have a code.';
  }
  if (b.startsAt && b.endsAt && new Date(b.endsAt) <= new Date(b.startsAt)) {
    return 'The end must be after the start.';
  }
  if (CAMPAIGN_KIND_HAS_OFFER[b.kind]) {
    if (!b.offer) return 'This kind of campaign needs an offer.';
    const p = offerProblem(b.offer);
    if (p) return p;
    if (
      b.kind === 'FIRST_RIDE' &&
      b.eligibility.maxCompletedRides !== undefined &&
      b.eligibility.maxCompletedRides !== 0
    ) {
      return 'A first-ride offer is only for the first ride.';
    }
    if (b.kind === 'RETENTION' && b.eligibility.inactiveForDays === undefined) {
      return 'A win-back offer needs "has not ridden for" days.';
    }
    if (b.kind === 'RETENTION' && b.offer && !OFFER_IS_DISCOUNT[b.offer.type]) {
      return 'A win-back offer takes money off the fare.';
    }
  } else if (b.offer) {
    return 'A message campaign has no offer.';
  }
  if (b.kind === 'REFERRAL') {
    if (
      b.referrerPoints === null ||
      !Number.isInteger(b.referrerPoints) ||
      b.referrerPoints < 0 ||
      b.referrerPoints > OFFER_LIMITS.pointsMax
    ) {
      return 'Say how many points the person who invited earns (0 for none).';
    }
  } else if (b.referrerPoints !== null) {
    return 'Only a referral campaign has points for the person who invited.';
  }
  if (CAMPAIGN_KIND_HAS_MESSAGE[b.kind]) {
    if (!b.message || b.message.title.trim().length === 0 || b.message.body.trim().length === 0) {
      return 'Write the message (a title and the text).';
    }
    if (
      b.message.title.length > CAMPAIGN_MESSAGE_TITLE_MAX ||
      b.message.body.length > CAMPAIGN_MESSAGE_BODY_MAX
    ) {
      return `The title can be ${CAMPAIGN_MESSAGE_TITLE_MAX} characters and the text ${CAMPAIGN_MESSAGE_BODY_MAX}.`;
    }
    if (b.kind === 'PUSH' && b.startsAt === null) return 'Say when the message should be sent.';
  }
  for (const [name, v] of [
    ['per person', b.limits.perUser],
    ['in all', b.limits.total],
    ['days to use', b.limits.validDaysAfterGrant],
  ] as const) {
    if (v !== null && (!Number.isInteger(v) || v < 1))
      return `The limit ${name} must be a whole number above zero, or empty.`;
  }
  return null;
}

// ---------------------------------------------------------------- combining offers on a ride

export interface OfferCandidate {
  campaignId: string;
  name: string;
  offer: CampaignOffer;
  stackable: boolean;
}

export interface AppliedOffer {
  campaignId: string;
  name: string;
  type: OfferType;
  discountNpr: number;
  bonusPoints: number;
  pointsMultiplier: number;
  /** One sentence for the fare breakdown. */
  description: string;
}

/**
 * Which offers apply together to one ride. The best discount goes first; others only join it if BOTH are stackable
 * (so one promotion never silently stacks on another unless an administrator said they may). Points offers
 * (bonus, multiplier) are not discounts and combine with whatever applies. The total discount never exceeds the fare.
 */
export function combineOffers(
  candidates: readonly OfferCandidate[],
  fareNpr: number,
): AppliedOffer[] {
  const scored = candidates.map((c) => ({ c, discount: computeDiscount(c.offer, fareNpr) }));
  const discounts = scored
    .filter((s) => OFFER_IS_DISCOUNT[s.c.offer.type])
    .sort((a, b) => b.discount - a.discount || a.c.campaignId.localeCompare(b.c.campaignId));
  const out: AppliedOffer[] = [];
  let remaining = fareNpr;
  let leader: OfferCandidate | null = null;
  for (const s of discounts) {
    if (remaining <= 0) break;
    if (leader && !(leader.stackable && s.c.stackable)) continue;
    const d = Math.min(s.discount, remaining);
    if (d <= 0) continue;
    leader ??= s.c;
    remaining -= d;
    out.push({
      campaignId: s.c.campaignId,
      name: s.c.name,
      type: s.c.offer.type,
      discountNpr: d,
      bonusPoints: 0,
      pointsMultiplier: 1,
      description: describeOffer(s.c.offer),
    });
  }
  for (const s of scored) {
    if (OFFER_IS_DISCOUNT[s.c.offer.type]) continue;
    out.push({
      campaignId: s.c.campaignId,
      name: s.c.name,
      type: s.c.offer.type,
      discountNpr: 0,
      bonusPoints: s.c.offer.type === 'BONUS_POINTS' ? (s.c.offer.points ?? 0) : 0,
      pointsMultiplier: s.c.offer.type === 'POINTS_MULTIPLIER' ? (s.c.offer.multiplier ?? 1) : 1,
      description: describeOffer(s.c.offer),
    });
  }
  return out;
}

// ---------------------------------------------------------------- reward points

export const LEDGER_KINDS = ['EARN', 'REDEEM', 'EXPIRE', 'ADJUST', 'REVERSAL'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
export const LEDGER_KIND_LABELS: Record<LedgerKind, string> = {
  EARN: 'Earned',
  REDEEM: 'Used on a ride',
  EXPIRE: 'Expired',
  ADJUST: 'Adjusted by Yatri',
  REVERSAL: 'Taken back',
};

/** What an earning or spending was for. */
export const LEDGER_SOURCES = ['RIDE', 'CAMPAIGN', 'REFERRAL', 'ADMIN', 'EXPIRY'] as const;
export type LedgerSource = (typeof LEDGER_SOURCES)[number];

export interface LoyaltyRules {
  pointsPer100Npr: number;
  /** What one point is worth, in rupees, when used on a ride. */
  pointValueNpr: number;
  expireDays: number;
  minRedeemPoints: number;
  maxRedeemPercent: number;
}

/** Points earned by a fare: whole points, multiplied if a campaign says so, plus any bonus. */
export function pointsForFare(
  fareNpr: number,
  rules: Pick<LoyaltyRules, 'pointsPer100Npr'>,
  applied: ReadonlyArray<Pick<AppliedOffer, 'bonusPoints' | 'pointsMultiplier'>> = [],
): number {
  if (fareNpr <= 0) return 0;
  const base = Math.floor((fareNpr * rules.pointsPer100Npr) / 100);
  const multiplier = applied.reduce(
    (m, a) => m * (a.pointsMultiplier > 1 ? a.pointsMultiplier : 1),
    1,
  );
  const bonus = applied.reduce((s, a) => s + a.bonusPoints, 0);
  return Math.floor(base * multiplier) + bonus;
}

/**
 * How many points can be used on a ride: not more than the balance, not below the minimum, and never more than the
 * allowed share of what is left to pay. Returns the points and what they take off.
 */
export function redeemablePoints(
  balance: number,
  payableNpr: number,
  rules: Pick<LoyaltyRules, 'pointValueNpr' | 'minRedeemPoints' | 'maxRedeemPercent'>,
): { points: number; valueNpr: number } {
  if (balance < rules.minRedeemPoints || payableNpr <= 0 || rules.pointValueNpr <= 0)
    return { points: 0, valueNpr: 0 };
  const maxValue = Math.floor((payableNpr * rules.maxRedeemPercent) / 100);
  const byValue = Math.floor(maxValue / rules.pointValueNpr);
  const points = Math.min(balance, byValue);
  if (points < rules.minRedeemPoints) return { points: 0, valueNpr: 0 };
  return { points, valueNpr: Math.floor(points * rules.pointValueNpr) };
}

export interface LedgerEntryInfo {
  id: string;
  kind: LedgerKind;
  /** Signed: earned is positive, used, expired and taken back are negative. */
  points: number;
  source: LedgerSource;
  /** A sentence for the history ("Earned for a ride", "Used on a ride"). */
  description: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface RewardsSummary {
  balance: number;
  /** Points that will expire within the warning period, and when the first of them does. */
  expiringSoon: { points: number; at: string } | null;
  valueNpr: number;
  rules: LoyaltyRules;
}

export interface RewardsHistoryResponse {
  items: LedgerEntryInfo[];
  nextBefore: string | null;
}

// ---------------------------------------------------------------- what a rider sees

export interface OfferView {
  campaignId: string;
  kind: CampaignKind;
  name: string;
  description: string;
  /** One sentence ("10% off your fare, up to NPR 100"). */
  summary: string;
  code: string | null;
  /** When it ends, if it does. */
  endsAt: string | null;
  /** For an offer given to this person: the last day to use it. */
  usableUntil: string | null;
  /** Whether it applies automatically (no code). */
  automatic: boolean;
  conditions: string[];
}

/** The answer to "what would I pay": the engine's, never the app's. */
export interface PromotionQuote {
  fareNpr: number;
  offers: AppliedOffer[];
  discountNpr: number;
  pointsUsed: number;
  pointsValueNpr: number;
  payableNpr: number;
  /** A sentence about points this ride is expected to earn, when it is known. */
  pointsToEarn: number;
  /** Why a typed code was not applied, in words. */
  codeProblem: string | null;
}

export interface PromotionRequest {
  promoCode?: string;
  /** Use reward points on this ride (as many as the rules allow). */
  usePoints?: boolean;
}

// ---------------------------------------------------------------- referral

export const REFERRAL_STATUSES = ['PENDING', 'REWARDED', 'HELD'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];
export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  PENDING: 'Waiting for the first ride',
  REWARDED: 'First ride done, reward given',
  HELD: 'Held for review',
};
export const REFERRAL_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{8}$/;

export interface ReferralView {
  /** Your invite code. */
  code: string;
  /** False when no referral campaign is open (the code still exists and works when one opens). */
  open: boolean;
  /** What you earn per friend, and what a friend gets. */
  youEarnPoints: number | null;
  friendGets: string | null;
  invited: number;
  rewarded: number;
  pending: number;
  /** A sentence to share. */
  shareText: string;
  /** Whether you have already used someone's invite. */
  usedInvite: boolean;
  referrals: Array<{ status: ReferralStatus; statusText: string; invitedAt: string }>;
}

export interface ApplyReferralBody {
  code: string;
}

// ---------------------------------------------------------------- admin views

export interface CampaignRedemptionRow {
  id: string;
  campaignId: string;
  campaignName: string;
  userId: string;
  userName: string | null;
  tripId: string | null;
  status: 'RESERVED' | 'APPLIED' | 'VOID';
  discountNpr: number;
  bonusPoints: number;
  createdAt: string;
}

export interface CampaignAnalytics {
  rangeLabel: string;
  redemptions: number;
  discountNpr: number;
  pointsIssued: number;
  pointsRedeemed: number;
  pointsExpired: number;
  referralsInvited: number;
  referralsRewarded: number;
  pushSent: number;
  /** Per campaign in the range. */
  byCampaign: Array<{
    campaignId: string;
    name: string;
    kind: CampaignKind;
    redemptions: number;
    discountNpr: number;
    distinctRiders: number;
  }>;
  /** Driver bonuses paid by the existing incentive rules, shown beside, never mixed in. */
  driverIncentives: { awards: number; bonusNpr: number };
}

export interface GrowthAdjustBody {
  points: number;
  reason: string;
}

export interface GrowthDriverView {
  /** The existing incentive rules and the driver's own progress: one definition, shown from the campaign service. */
  incentives: import('./operations').DriverIncentivesView;
}

// ---------------------------------------------------------------- notifications

export const GROWTH_NOTIFICATION_TYPES = {
  REFERRAL_QUALIFIED: 'REFERRAL_QUALIFIED',
  REWARD_POINTS_EARNED: 'REWARD_POINTS_EARNED',
  REWARD_POINTS_EXPIRING: 'REWARD_POINTS_EXPIRING',
  OFFER_GRANTED: 'OFFER_GRANTED',
  CAMPAIGN_MESSAGE: 'CAMPAIGN_MESSAGE',
} as const;

/** How many days ahead people are warned that points will expire. */
export const REWARD_EXPIRY_WARNING_DAYS = 14;
