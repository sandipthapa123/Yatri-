import { randomInt } from 'node:crypto';

import {
  GROWTH_NOTIFICATION_TYPES,
  REFERRAL_CODE_PATTERN,
  REFERRAL_STATUS_LABELS,
  describeCampaignOffer,
  type ReferralStatus,
  type ReferralView,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { activeRestriction } from '../risk/restriction.service';
import { settingNumber } from '../settings/settings.service';
import { CAMPAIGN_COLUMNS, toCampaign, type CampaignRow } from './campaigns.service';
import { earnPoints } from './loyalty';

/**
 * Referrals. A rider has one invite code. A NEW rider (nobody yet on a completed ride, never invited before) can use
 * ONE code, once: they get the offer the referral campaign gives (a grant), the person who invited earns points when
 * that rider's first ride is done. The rules that keep it honest, all here and all on the server:
 *  - your own code, and a circle (A invited B, then B uses A's code), are refused, and recorded for the risk system;
 *  - a person who already has a completed ride cannot become "new";
 *  - one code can bring in only so many riders in 30 days (a platform setting);
 *  - a referee row is unique, so two simultaneous uses of codes, or of one code, count once;
 *  - the reward is a ledger entry unique per referral, paid only when the first ride completes (not when the code is
 *    typed), and held (not paid) if the inviting account is restricted or not active at that moment.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () =>
  Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');

export async function referralCodeFor(userId: string): Promise<string> {
  const have = await query<{ code: string }>('SELECT code FROM referral_codes WHERE user_id = $1', [
    userId,
  ]);
  if (have.rows[0]) return have.rows[0].code;
  for (let i = 0; i < 6; i += 1) {
    const r = await query<{ code: string }>(
      `INSERT INTO referral_codes (user_id, code) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING code`,
      [userId, newCode()],
    );
    if (r.rows[0]) return r.rows[0].code;
    const again = await query<{ code: string }>(
      'SELECT code FROM referral_codes WHERE user_id = $1',
      [userId],
    );
    if (again.rows[0]) return again.rows[0].code; // a simultaneous request made it
  }
  throw new HttpError(503, 'TRY_AGAIN', 'Could not make an invite code. Please try again.');
}

/** The referral campaign people are invited under right now (the newest live one), if any. */
async function openCampaign(): Promise<CampaignRow | null> {
  const r = await query<CampaignRow>(
    `SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c
     WHERE c.kind = 'REFERRAL' AND c.status = 'ACTIVE' AND (c.starts_at IS NULL OR c.starts_at <= now())
       AND (c.ends_at IS NULL OR c.ends_at > now()) ORDER BY c.created_at DESC LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

export async function referralView(userId: string): Promise<ReferralView> {
  const code = await referralCodeFor(userId);
  const campaign = await openCampaign();
  const rows = await query<{ status: ReferralStatus; created_at: Date }>(
    'SELECT status, created_at FROM referrals WHERE referrer_id = $1 ORDER BY created_at DESC LIMIT 20',
    [userId],
  );
  const counts = await query<{ status: ReferralStatus; n: string }>(
    'SELECT status, count(*)::text AS n FROM referrals WHERE referrer_id = $1 GROUP BY status',
    [userId],
  );
  const n = (s: ReferralStatus) => Number(counts.rows.find((c) => c.status === s)?.n ?? 0);
  const used = await query('SELECT 1 FROM referrals WHERE referee_id = $1', [userId]);
  const info = campaign ? toCampaign(campaign) : null;
  const friendGets = info?.offer ? describeCampaignOffer(info.offer) : null;
  return {
    code,
    open: !!campaign,
    youEarnPoints: info?.referrerPoints ?? null,
    friendGets,
    invited: n('PENDING') + n('REWARDED') + n('HELD'),
    rewarded: n('REWARDED'),
    pending: n('PENDING'),
    shareText: `Join me on Yatri. Use my invite code ${code} when you sign up${friendGets ? ` and get ${friendGets} on your first ride` : ''}.`,
    usedInvite: !!used.rowCount,
    referrals: rows.rows.map((r) => ({
      status: r.status,
      statusText: REFERRAL_STATUS_LABELS[r.status],
      invitedAt: r.created_at.toISOString(),
    })),
  };
}

const blocked = (userId: string, reason: string) =>
  recordAudit({
    actorId: userId,
    actorRole: 'PASSENGER',
    action: 'REFERRAL_BLOCKED',
    subjectType: 'referral',
    subjectIds: null,
    detail: { reason },
  }).catch(() => undefined);

/** A new rider uses someone's invite code. Returns a sentence about what they got. */
export async function applyReferral(userId: string, rawCode: string): Promise<{ message: string }> {
  const code = rawCode.trim().toUpperCase();
  if (!REFERRAL_CODE_PATTERN.test(code))
    throw new HttpError(
      404,
      'INVITE_NOT_FOUND',
      'That invite code is not valid. Check it and try again.',
    );
  const campaign = await openCampaign();
  if (!campaign) throw new HttpError(409, 'REFERRALS_CLOSED', 'Invites are not open right now.');

  const owner = await query<{ user_id: string; status: string }>(
    'SELECT c.user_id, u.status FROM referral_codes c JOIN users u ON u.id = c.user_id WHERE c.code = $1',
    [code],
  );
  const ownerRow = owner.rows[0];
  if (!ownerRow || ownerRow.status !== 'ACTIVE') {
    throw new HttpError(
      404,
      'INVITE_NOT_FOUND',
      'That invite code is not valid. Check it and try again.',
    );
  }
  if (ownerRow.user_id === userId) {
    await blocked(userId, 'SELF');
    throw new HttpError(
      422,
      'SELF_REFERRAL',
      'You cannot use your own invite code. Share it with a friend instead.',
    );
  }
  const circle = await query('SELECT 1 FROM referrals WHERE referrer_id = $1 AND referee_id = $2', [
    userId,
    ownerRow.user_id,
  ]);
  if (circle.rowCount) {
    await blocked(userId, 'CIRCLE');
    throw new HttpError(
      422,
      'CIRCULAR_REFERRAL',
      'You already invited that person, so you cannot use their code.',
    );
  }
  const done = await query('SELECT 1 FROM trips WHERE passenger_id = $1 AND status = $2 LIMIT 1', [
    userId,
    'COMPLETED',
  ]);
  if (done.rowCount) {
    throw new HttpError(
      422,
      'NOT_A_NEW_RIDER',
      'Invite codes are for riders who have not completed a ride yet.',
    );
  }
  const recent = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM referrals WHERE referrer_id = $1 AND created_at > now() - interval '30 days'`,
    [ownerRow.user_id],
  );
  if (Number(recent.rows[0]?.n ?? 0) >= settingNumber('REFERRAL_MAX_INVITES_30D')) {
    throw new HttpError(409, 'INVITE_LIMIT', 'That invite code has reached its limit for now.');
  }

  try {
    await withTransaction(async (c) => {
      await c.query(
        `INSERT INTO referrals (referrer_id, referee_id, campaign_id) VALUES ($1, $2, $3)`,
        [ownerRow.user_id, userId, campaign.id],
      );
      if (campaign.offer) {
        await c.query(
          `INSERT INTO campaign_grants (campaign_id, user_id, expires_at)
           VALUES ($1, $2, CASE WHEN $3::int IS NULL THEN NULL ELSE now() + ($3::int * interval '1 day') END)
           ON CONFLICT DO NOTHING`,
          [campaign.id, userId, campaign.valid_days_after_grant],
        );
      }
    });
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'ALREADY_REFERRED', 'You have already used an invite code.');
    }
    throw err;
  }
  const info = toCampaign(campaign);
  const gets = info.offer ? describeCampaignOffer(info.offer) : null;
  await notify({
    userId,
    type: GROWTH_NOTIFICATION_TYPES.OFFER_GRANTED,
    title: 'Invite accepted',
    body: gets ? `You will get ${gets} on your first ride.` : 'Your invite was accepted.',
    metadata: { campaignId: campaign.id },
    dedupeKey: `grant:${campaign.id}:${userId}`,
  }).catch(() => undefined);
  return {
    message: gets
      ? `Invite accepted. You will get ${gets} on your first ride.`
      : 'Invite accepted.',
  };
}

/**
 * The invited rider's first completed ride is done: the person who invited earns the campaign's points, once. Called by
 * the engine after a ride is settled; safe to call again.
 */
export async function qualifyReferral(refereeId: string, tripId: string): Promise<void> {
  const awarded = await withTransaction(async (c) => {
    const ref = await c.query<{ id: string; referrer_id: string; campaign_id: string | null }>(
      `SELECT id, referrer_id, campaign_id FROM referrals WHERE referee_id = $1 AND status = 'PENDING' FOR UPDATE`,
      [refereeId],
    );
    const referral = ref.rows[0];
    if (!referral) return null;
    const trip = await c.query<{ fare: number | null; org: string | null }>(
      'SELECT fare_final_npr AS fare, organization_id AS org FROM trips WHERE id = $1',
      [tripId],
    );
    if (!trip.rows[0] || trip.rows[0].org) return null; // an organization ride does not qualify
    const first = await c.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM trips WHERE passenger_id = $1 AND status = 'COMPLETED'`,
      [refereeId],
    );
    if (Number(first.rows[0]?.n ?? 0) !== 1) return null;

    const camp = referral.campaign_id
      ? await c.query<CampaignRow>(`SELECT ${CAMPAIGN_COLUMNS} FROM campaigns c WHERE c.id = $1`, [
          referral.campaign_id,
        ])
      : { rows: [] as CampaignRow[] };
    const points = camp.rows[0]?.referrer_points ?? 0;
    const minFare = camp.rows[0]?.eligibility?.minFareNpr ?? 0;
    if ((trip.rows[0].fare ?? 0) < minFare) return null;

    const referrer = await c.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [
      referral.referrer_id,
    ]);
    const restricted = await activeRestriction(referral.referrer_id).catch(() => null);
    const eligible = referrer.rows[0]?.status === 'ACTIVE' && !restricted;
    await c.query(
      "UPDATE referrals SET status = $2, rewarded_at = CASE WHEN $2 = 'REWARDED' THEN now() END WHERE id = $1",
      [referral.id, eligible ? 'REWARDED' : 'HELD'],
    );
    if (!eligible) return null;
    if (points > 0) {
      await earnPoints(c, {
        userId: referral.referrer_id,
        points,
        source: 'REFERRAL',
        sourceId: referral.id,
        description: 'A friend you invited finished their first ride',
      });
    }
    return { referrerId: referral.referrer_id, points, id: referral.id };
  });
  if (awarded) {
    await notify({
      userId: awarded.referrerId,
      type: GROWTH_NOTIFICATION_TYPES.REFERRAL_QUALIFIED,
      title: 'Your invite worked',
      body:
        awarded.points > 0
          ? `A friend you invited finished their first ride. You earned ${awarded.points} reward points.`
          : 'A friend you invited finished their first ride.',
      metadata: { referralId: awarded.id, points: awarded.points },
      dedupeKey: `referral:${awarded.id}`,
    }).catch(() => undefined);
  }
}
