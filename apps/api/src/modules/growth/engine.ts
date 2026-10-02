import {
  GROWTH_NOTIFICATION_TYPES,
  combineOffers,
  describeConditions,
  describeOffer,
  evaluateEligibility,
  pointsForFare,
  redeemablePoints,
  usageAllowed,
  type AppliedOffer,
  type CampaignEligibility,
  type EligibilityFacts,
  type OfferCandidate,
  type OfferView,
  type PromotionQuote,
  type PromotionRequest,
} from '@yatri/types';
import type { PoolClient } from 'pg';

import { query, withTransaction, type Queryable } from '../../lib/db';
import { log } from '../../lib/logger';
import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { benefitActiveFor } from '../disability/verification.service';
import { toCampaign, CAMPAIGN_COLUMNS, type CampaignRow } from './campaigns.service';
import { balanceOf, earnPoints, loyaltyRules, spendPoints } from './loyalty';
import { qualifyReferral } from './referrals';

/**
 * THE promotion and reward engine. Everything that decides whether a person gets an offer, what it takes off, how
 * many points a ride earns or uses, and whether a limit is reached, is here and in the pure rules of @yatri/types:
 * no app, no admin screen and no other module computes any of it. The shape of a ride's life:
 *
 *   quote    what the rider WOULD pay (estimate time; reads only, no locks, takes nothing)
 *   reserve  the ride is requested: the offers are held for it, under the campaign's row lock so two riders cannot
 *            both take the last use; the offer as it was is copied onto the reservation
 *   release  the ride never happened (cancelled, no driver): the reservation is void
 *   settle   the ride completed: the discount is worked out again on the FINAL fare from the copied offer, points are
 *            used and earned, a referral may qualify, and the platform-paid amount is recorded on the ride
 *
 * A promotion never changes a fare: it is a platform-paid amount recorded beside the ride, and the payment is for what
 * the rider owes after it (fare minus that amount). Business rides (an organization pays by its own policy) take no
 * promotions and earn no points.
 */
export interface RideContext {
  fareNpr: number;
  categoryCode: string | null;
  cityId: string | null;
}

type Q = Queryable;
const normalizeCode = (c: string | undefined) => (c ?? '').trim().toUpperCase();

async function loadFacts(
  c: Q,
  userId: string,
  ride: RideContext | null,
): Promise<EligibilityFacts> {
  const r = await c.query<{ rides: string; age: string; since: string | null }>(
    `SELECT (SELECT count(*) FROM trips t WHERE t.passenger_id = u.id AND t.status = 'COMPLETED')::text AS rides,
            floor(extract(epoch FROM (now() - u.created_at)) / 86400)::text AS age,
            (SELECT floor(extract(epoch FROM (now() - max(t.ended_at))) / 86400)::text
               FROM trips t WHERE t.passenger_id = u.id AND t.status = 'COMPLETED') AS since
     FROM users u WHERE u.id = $1`,
    [userId],
  );
  const row = r.rows[0];
  return {
    userId,
    completedRides: Number(row?.rides ?? 0),
    accountAgeDays: Number(row?.age ?? 0),
    daysSinceLastRide: row?.since === null || row?.since === undefined ? null : Number(row.since),
    disabilityVerified: await benefitActiveFor(userId),
    ride: ride
      ? { categoryCode: ride.categoryCode, cityId: ride.cityId, fareNpr: ride.fareNpr }
      : null,
  };
}

interface Considered {
  row: CampaignRow;
  candidate: OfferCandidate;
  grantExpiresAt: Date | null;
  usable: boolean;
  reason: string | null;
}

/**
 * The campaigns that could apply to this person (and ride): live promotions with no code, the one whose code was
 * typed, and any offer given to the person. Each judged by the one eligibility rule and the usage limits.
 * `lock` takes the campaign rows FOR UPDATE (in id order) so the limit counts below cannot race.
 */
async function consider(
  c: Q,
  facts: EligibilityFacts,
  enteredCode: string,
  lock: boolean,
): Promise<Considered[]> {
  const r = await c.query<CampaignRow & { grant_expires: Date | null; has_grant: boolean }>(
    `SELECT ${CAMPAIGN_COLUMNS},
            g.expires_at AS grant_expires, (g.id IS NOT NULL) AS has_grant
     FROM campaigns c
     LEFT JOIN campaign_grants g ON g.campaign_id = c.id AND g.user_id = $1
     WHERE c.status = 'ACTIVE' AND c.offer IS NOT NULL
       AND (c.starts_at IS NULL OR c.starts_at <= now()) AND (c.ends_at IS NULL OR c.ends_at > now())
       AND (
         (c.kind IN ('PROMO', 'COUPON', 'FIRST_RIDE') AND (c.code IS NULL OR ($2 <> '' AND c.code = $2)))
         OR (g.id IS NOT NULL AND (g.expires_at IS NULL OR g.expires_at > now()))
       )
     ORDER BY c.id ${lock ? 'FOR UPDATE OF c' : ''}`,
    [facts.userId, enteredCode],
  );
  const out: Considered[] = [];
  for (const row of r.rows) {
    // A code-only campaign needs the code (or a grant); a grant-only kind needs the grant.
    const granted = row.has_grant && (row.grant_expires === null || row.grant_expires > new Date());
    if ((row.kind === 'REFERRAL' || row.kind === 'RETENTION') && !granted) continue;
    const verdict = evaluateEligibility(row.eligibility ?? {}, facts);
    let reason = verdict.reason;
    let usable = verdict.eligible;
    if (usable) {
      const used = await c.query<{ by_user: string; total: string }>(
        `SELECT count(*) FILTER (WHERE user_id = $2)::text AS by_user, count(*)::text AS total
         FROM campaign_redemptions WHERE campaign_id = $1 AND status <> 'VOID'`,
        [row.id, facts.userId],
      );
      const u = usageAllowed(
        { perUser: row.per_user_limit, total: row.total_limit },
        { byUser: Number(used.rows[0]?.by_user ?? 0), total: Number(used.rows[0]?.total ?? 0) },
      );
      if (!u.allowed) {
        usable = false;
        reason = u.reason;
      }
    }
    out.push({
      row,
      candidate: {
        campaignId: row.id,
        name: row.name,
        offer: row.offer as NonNullable<CampaignRow['offer']>,
        stackable: row.stackable,
        disabilityBenefit: row.eligibility?.requiresDisabilityVerified === true,
      },
      grantExpiresAt: granted ? row.grant_expires : null,
      usable,
      reason,
    });
  }
  return out;
}

/** Why a typed code did not apply, in words (never "invalid" without saying what to do). */
async function explainCode(c: Q, code: string, considered: Considered[]): Promise<string | null> {
  if (!code) return null;
  const hit = considered.find((x) => x.row.code === code);
  if (hit) return hit.usable ? null : (hit.reason ?? 'This code cannot be used on this ride.');
  const any = await c.query<{ status: string }>('SELECT status FROM campaigns WHERE code = $1', [
    code,
  ]);
  if (!any.rows[0]) return 'That code is not valid. Check it and try again.';
  return 'That offer is not running right now.';
}

interface Plan {
  applied: AppliedOffer[];
  discountNpr: number;
  pointsUsed: number;
  pointsValueNpr: number;
  payableNpr: number;
  pointsToEarn: number;
  /** Why a typed code did not apply, in words (also when a better offer simply won). */
  codeProblem: string | null;
  /** Set only when the typed code itself cannot be used (unknown, not eligible, a limit): a request with it is refused. */
  codeBlocked: string | null;
  usedCampaigns: Considered[];
}

async function plan(
  c: Q,
  userId: string,
  ride: RideContext,
  req: PromotionRequest | undefined,
  lock: boolean,
): Promise<Plan> {
  const rules = loyaltyRules();
  const code = normalizeCode(req?.promoCode);
  const facts = await loadFacts(c, userId, ride);
  const considered = await consider(c, facts, code, lock);
  const usable = considered.filter((x) => x.usable);
  const applied = combineOffers(
    usable.map((x) => x.candidate),
    ride.fareNpr,
  );
  const discount = applied.reduce((s, a) => s + a.discountNpr, 0);
  let pointsUsed = 0;
  let pointsValue = 0;
  if (req?.usePoints) {
    const r = redeemablePoints(await balanceOf(userId, c), ride.fareNpr - discount, rules);
    pointsUsed = r.points;
    pointsValue = r.valueNpr;
  }
  const payable = Math.max(0, ride.fareNpr - discount - pointsValue);
  const codeProblem = await explainCode(c, code, considered);
  // A typed code that lost out to a better non-stackable offer is said, not dropped silently.
  const codeApplied =
    !code ||
    applied.some((a) => considered.find((x) => x.row.id === a.campaignId)?.row.code === code);
  return {
    applied,
    discountNpr: discount,
    pointsUsed,
    pointsValueNpr: pointsValue,
    payableNpr: payable,
    pointsToEarn: pointsForFare(payable, rules, applied),
    codeProblem:
      codeProblem ??
      (codeApplied
        ? null
        : 'A better offer is already applied to this ride, and offers do not combine.'),
    codeBlocked: codeProblem,
    usedCampaigns: usable.filter((x) => applied.some((a) => a.campaignId === x.row.id)),
  };
}

const toQuote = (p: Plan, fareNpr: number): PromotionQuote => ({
  fareNpr,
  offers: p.applied,
  discountNpr: p.discountNpr,
  pointsUsed: p.pointsUsed,
  pointsValueNpr: p.pointsValueNpr,
  payableNpr: p.payableNpr,
  pointsToEarn: p.pointsToEarn,
  codeProblem: p.codeProblem,
});

/** What the rider would pay. Null when nothing applies and nothing was asked for (so the screen shows only the fare). */
export async function quoteRide(
  userId: string,
  ride: RideContext,
  req: PromotionRequest | undefined,
): Promise<PromotionQuote | null> {
  const p = await plan({ query }, userId, ride, req, false);
  const asked = !!req?.promoCode || !!req?.usePoints;
  if (p.applied.length === 0 && p.pointsUsed === 0 && !asked && p.pointsToEarn === 0) return null;
  return toQuote(p, ride.fareNpr);
}

/**
 * The ride is being requested (call inside its transaction): hold the offers and the points choice for it. A typed
 * code that cannot be used now refuses the request, in words, so the rider is never charged differently from what they
 * were shown without being told.
 */
export async function reserveForRide(
  client: PoolClient,
  p: { tripId: string; userId: string; ride: RideContext; req: PromotionRequest | undefined },
): Promise<void> {
  const planned = await plan(client, p.userId, p.ride, p.req, true);
  // Only a code that cannot be used refuses the request; one that simply lost to a better offer is not an error.
  if (p.req?.promoCode && planned.codeBlocked) {
    throw new HttpError(409, 'PROMO_UNAVAILABLE', planned.codeBlocked);
  }
  for (const x of planned.usedCampaigns) {
    const a = planned.applied.find((o) => o.campaignId === x.row.id);
    await client.query(
      `INSERT INTO campaign_redemptions (campaign_id, user_id, trip_id, status, name, offer, stackable)
       VALUES ($1, $2, $3, 'RESERVED', $4, $5::jsonb, $6) ON CONFLICT DO NOTHING`,
      [
        x.row.id,
        p.userId,
        p.tripId,
        a?.name ?? x.row.name,
        JSON.stringify(x.row.offer),
        x.row.stackable,
      ],
    );
  }
  // Points are chosen now and taken when the ride completes (re-checked then).
  await client.query('UPDATE trips SET points_used = $2 WHERE id = $1', [
    p.tripId,
    planned.pointsUsed,
  ]);
}

/** The ride did not happen: what was held for it is released. */
export async function releaseReservations(tripId: string): Promise<void> {
  await query(
    `UPDATE campaign_redemptions SET status = 'VOID' WHERE trip_id = $1 AND status = 'RESERVED'`,
    [tripId],
  );
  await query('UPDATE trips SET points_used = 0 WHERE id = $1 AND status <> $2', [
    tripId,
    'COMPLETED',
  ]);
}

export interface Settlement {
  discountNpr: number;
  pointsUsed: number;
  pointsEarned: number;
}

/**
 * The ride completed. Works out the discount again on the final fare from the offers as they were reserved, uses and
 * earns points, records what the platform paid on the ride, and lets a referral qualify. Idempotent: a second call
 * (a retry, the reconcile job) returns what was recorded and changes nothing.
 */
export async function settleRide(tripId: string): Promise<Settlement> {
  let earnedNotice: { userId: string; points: number } | null = null;
  let passengerId = '';
  const result = await withTransaction(async (c): Promise<Settlement> => {
    const t = await c.query<{
      passenger_id: string;
      status: string;
      fare_final_npr: number | null;
      organization_id: string | null;
      points_used: number;
      discount_npr: number;
      rewards_settled_at: Date | null;
    }>(
      'SELECT passenger_id, status, fare_final_npr, organization_id, points_used, discount_npr, rewards_settled_at FROM trips WHERE id = $1 FOR UPDATE',
      [tripId],
    );
    const trip = t.rows[0];
    if (!trip || trip.status !== 'COMPLETED' || trip.fare_final_npr === null) {
      return { discountNpr: 0, pointsUsed: 0, pointsEarned: 0 };
    }
    if (trip.rewards_settled_at) {
      // Already settled: report what was recorded and change nothing.
      const e = await c.query<{ points: number }>(
        `SELECT COALESCE(sum(points), 0)::int AS points FROM reward_ledger WHERE user_id = $1 AND kind = 'EARN' AND source = 'RIDE' AND source_id = $2`,
        [trip.passenger_id, tripId],
      );
      return {
        discountNpr: trip.discount_npr,
        pointsUsed: trip.points_used,
        pointsEarned: e.rows[0]?.points ?? 0,
      };
    }
    passengerId = trip.passenger_id;
    if (trip.organization_id) return { discountNpr: 0, pointsUsed: 0, pointsEarned: 0 }; // an organization pays by its own policy
    const fare = trip.fare_final_npr;

    const held = await c.query<{
      id: string;
      campaign_id: string;
      name: string;
      offer: NonNullable<CampaignRow['offer']>;
      stackable: boolean;
    }>(
      `SELECT id, campaign_id, name, offer, stackable FROM campaign_redemptions
       WHERE trip_id = $1 AND status = 'RESERVED' ORDER BY campaign_id FOR UPDATE`,
      [tripId],
    );
    const applied = combineOffers(
      held.rows.map((h) => ({
        campaignId: h.campaign_id,
        name: h.name,
        offer: h.offer,
        stackable: h.stackable,
      })),
      fare,
    );
    for (const h of held.rows) {
      const a = applied.find((o) => o.campaignId === h.campaign_id);
      await c.query(
        `UPDATE campaign_redemptions SET status = 'APPLIED', discount_npr = $2, bonus_points = $3, points_multiplier = $4, applied_at = now()
         WHERE id = $1`,
        [h.id, a?.discountNpr ?? 0, a?.bonusPoints ?? 0, a?.pointsMultiplier ?? 1],
      );
    }
    const campaignDiscount = applied.reduce((s, a) => s + a.discountNpr, 0);

    let pointsUsed = 0;
    let pointsValue = 0;
    if (trip.points_used > 0) {
      const rules = loyaltyRules();
      const balance = await balanceOf(trip.passenger_id, c);
      const allowed = redeemablePoints(
        Math.min(balance, trip.points_used),
        fare - campaignDiscount,
        { ...rules, minRedeemPoints: 1 },
      );
      pointsUsed = await spendPoints(c, {
        userId: trip.passenger_id,
        points: allowed.points,
        sourceId: tripId,
        description: 'Used on a ride',
      });
      pointsValue = Math.floor(pointsUsed * rules.pointValueNpr);
    }
    const discountTotal = campaignDiscount + pointsValue;
    await c.query(
      'UPDATE trips SET discount_npr = $2, points_used = $3, rewards_settled_at = now() WHERE id = $1',
      [tripId, discountTotal, pointsUsed],
    );

    const earnedPoints = pointsForFare(fare - discountTotal, loyaltyRules(), applied);
    if (earnedPoints > 0) {
      const wrote = await earnPoints(c, {
        userId: trip.passenger_id,
        points: earnedPoints,
        source: 'RIDE',
        sourceId: tripId,
        description: 'Earned for a ride',
      });
      if (wrote) earnedNotice = { userId: trip.passenger_id, points: earnedPoints };
    }
    return { discountNpr: discountTotal, pointsUsed, pointsEarned: earnedPoints };
  });

  // Beside the ride, after it is safely recorded: a failure here never undoes a completed ride.
  if (earnedNotice) {
    const n = earnedNotice as { userId: string; points: number };
    await notify({
      userId: n.userId,
      type: GROWTH_NOTIFICATION_TYPES.REWARD_POINTS_EARNED,
      title: 'Reward points earned',
      body: `You earned ${n.points} reward points for your ride.`,
      metadata: { tripId, points: n.points },
      dedupeKey: `earn:${tripId}`,
    }).catch((err) => log.warn('Reward notice failed', err));
  }
  if (passengerId)
    await qualifyReferral(passengerId, tripId).catch((err) =>
      log.error('Referral qualification failed', err),
    );
  return result;
}

// ---------------------------------------------------------------- what a rider sees

const viewOf = (row: CampaignRow, usableUntil: Date | null): OfferView => {
  const info = toCampaign(row);
  return {
    campaignId: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    summary: row.offer ? describeOffer(row.offer) : row.name,
    code: row.code,
    endsAt: info.endsAt,
    usableUntil: usableUntil?.toISOString() ?? null,
    automatic: row.code === null && !usableUntil,
    conditions: describeConditions(row.eligibility ?? {}, {
      perUser: row.per_user_limit,
      total: row.total_limit,
    }),
  };
};

/**
 * The offers this person could use: live promotions that apply automatically (and that they are eligible for as a
 * person), and offers given to them. Coupons are not listed (they are used by entering the code).
 */
export async function availableOffers(userId: string): Promise<OfferView[]> {
  const facts = await loadFacts({ query }, userId, null);
  const considered = await consider({ query }, facts, '', false);
  return considered
    .filter(
      (x) =>
        x.usable &&
        (x.row.kind !== 'COUPON' || x.grantExpiresAt !== null) &&
        (x.row.code === null || x.grantExpiresAt !== null),
    )
    .map((x) => viewOf(x.row, x.grantExpiresAt));
}

/** Check a typed code for this person, without a ride: whether it exists, is running and is theirs to use. */
export async function checkCode(
  userId: string,
  raw: string,
): Promise<{ valid: boolean; offer: OfferView | null; problem: string | null }> {
  const code = normalizeCode(raw);
  if (!code) return { valid: false, offer: null, problem: 'Enter a code.' };
  const facts = await loadFacts({ query }, userId, null);
  const considered = await consider({ query }, facts, code, false);
  const hit = considered.find((x) => x.row.code === code);
  if (hit && hit.usable)
    return { valid: true, offer: viewOf(hit.row, hit.grantExpiresAt), problem: null };
  return { valid: false, offer: null, problem: await explainCode({ query }, code, considered) };
}

export type { CampaignEligibility };
