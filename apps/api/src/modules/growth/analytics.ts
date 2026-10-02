import type {
  CampaignAnalytics,
  CampaignKind,
  CampaignRedemptionRow,
  ResolvedRange,
} from '@yatri/types';

import { query } from '../../lib/db';

/**
 * Campaign figures for administrators: counts and rupees across campaigns, never a rider's trips or places. A rider
 * appears only by name in the redemptions of one campaign (so support can answer "did this person get the offer").
 * Driver bonuses from the existing incentive rules are shown beside, from their own award records, never mixed in.
 */
export async function campaignAnalytics(range: ResolvedRange): Promise<CampaignAnalytics> {
  const p = [range.from, range.to];
  const [red, ledger, referrals, push, byCampaign, incentives] = await Promise.all([
    query<{ n: string; d: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(discount_npr), 0)::text AS d FROM campaign_redemptions
       WHERE status = 'APPLIED' AND applied_at >= $1 AND applied_at < $2`,
      p,
    ),
    query<{ kind: string; pts: string }>(
      `SELECT kind, COALESCE(sum(abs(points)), 0)::text AS pts FROM reward_ledger
       WHERE created_at >= $1 AND created_at < $2 GROUP BY kind`,
      p,
    ),
    query<{ invited: string; rewarded: string }>(
      `SELECT count(*)::text AS invited, count(*) FILTER (WHERE status = 'REWARDED')::text AS rewarded
       FROM referrals WHERE created_at >= $1 AND created_at < $2`,
      p,
    ),
    query<{ n: string }>(
      `SELECT count(*)::text AS n FROM notifications WHERE type = 'CAMPAIGN_MESSAGE' AND delivery_status = 'SENT'
         AND created_at >= $1 AND created_at < $2`,
      p,
    ),
    query<{ id: string; name: string; kind: CampaignKind; n: string; d: string; riders: string }>(
      `SELECT c.id, c.name, c.kind, count(r.id)::text AS n, COALESCE(sum(r.discount_npr), 0)::text AS d,
              count(DISTINCT r.user_id)::text AS riders
       FROM campaigns c JOIN campaign_redemptions r ON r.campaign_id = c.id AND r.status = 'APPLIED'
         AND r.applied_at >= $1 AND r.applied_at < $2
       GROUP BY c.id, c.name, c.kind ORDER BY count(r.id) DESC, c.name LIMIT 100`,
      p,
    ),
    query<{ n: string; s: string }>(
      `SELECT count(*)::text AS n, COALESCE(sum(amount_npr), 0)::text AS s FROM incentive_awards
       WHERE created_at >= $1 AND created_at < $2`,
      p,
    ),
  ]);
  const pts = (k: string) => Number(ledger.rows.find((x) => x.kind === k)?.pts ?? 0);
  return {
    rangeLabel: range.label,
    redemptions: Number(red.rows[0]?.n ?? 0),
    discountNpr: Number(red.rows[0]?.d ?? 0),
    // Earned plus positive adjustments is "issued"; the ledger stores the sign, so this counts the EARN kind.
    pointsIssued: pts('EARN'),
    pointsRedeemed: pts('REDEEM'),
    pointsExpired: pts('EXPIRE'),
    referralsInvited: Number(referrals.rows[0]?.invited ?? 0),
    referralsRewarded: Number(referrals.rows[0]?.rewarded ?? 0),
    pushSent: Number(push.rows[0]?.n ?? 0),
    byCampaign: byCampaign.rows.map((x) => ({
      campaignId: x.id,
      name: x.name,
      kind: x.kind,
      redemptions: Number(x.n),
      discountNpr: Number(x.d),
      distinctRiders: Number(x.riders),
    })),
    driverIncentives: {
      awards: Number(incentives.rows[0]?.n ?? 0),
      bonusNpr: Number(incentives.rows[0]?.s ?? 0),
    },
  };
}

export async function campaignRedemptions(
  campaignId: string,
  limit = 100,
): Promise<CampaignRedemptionRow[]> {
  const r = await query<{
    id: string;
    campaign_id: string;
    name: string;
    user_id: string;
    user_name: string | null;
    trip_id: string | null;
    status: 'RESERVED' | 'APPLIED' | 'VOID';
    discount_npr: number;
    bonus_points: number;
    created_at: Date;
  }>(
    `SELECT r.id, r.campaign_id, c.name, r.user_id, u.full_name AS user_name, r.trip_id, r.status, r.discount_npr,
            r.bonus_points, r.created_at
     FROM campaign_redemptions r JOIN campaigns c ON c.id = r.campaign_id JOIN users u ON u.id = r.user_id
     WHERE r.campaign_id = $1 ORDER BY r.created_at DESC LIMIT $2`,
    [campaignId, limit],
  );
  return r.rows.map((x) => ({
    id: x.id,
    campaignId: x.campaign_id,
    campaignName: x.name,
    userId: x.user_id,
    userName: x.user_name,
    tripId: x.trip_id,
    status: x.status,
    discountNpr: x.discount_npr,
    bonusPoints: x.bonus_points,
    createdAt: x.created_at.toISOString(),
  }));
}
