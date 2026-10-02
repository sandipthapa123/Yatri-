import {
  REWARD_EXPIRY_WARNING_DAYS,
  GROWTH_NOTIFICATION_TYPES,
  type LedgerEntryInfo,
  type LedgerKind,
  type LedgerSource,
  type LoyaltyRules,
  type RewardsHistoryResponse,
  type RewardsSummary,
} from '@yatri/types';
import { query, withTransaction, type Queryable } from '../../lib/db';
import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { settingNumber } from '../settings/settings.service';

/**
 * THE reward-points ledger. Append-only: nothing edits or deletes an entry, and nothing but this module writes one.
 * Earned points are LOTS (`remaining`), so using and expiring points is first-expiring-first and a balance is just
 * what the unexpired lots still hold. Every change to one person's points happens under one advisory lock per
 * person, so two rides, two servers or an administrator and a ride cannot spend the same points twice. A source can
 * write a kind of entry for a person once (a unique index), so a repeated ride completion cannot pay twice.
 */
export function loyaltyRules(): LoyaltyRules {
  return {
    pointsPer100Npr: settingNumber('LOYALTY_POINTS_PER_100_NPR'),
    pointValueNpr: settingNumber('LOYALTY_POINT_VALUE_NPR'),
    expireDays: settingNumber('LOYALTY_POINTS_EXPIRE_DAYS'),
    minRedeemPoints: settingNumber('LOYALTY_MIN_REDEEM_POINTS'),
    maxRedeemPercent: settingNumber('LOYALTY_MAX_REDEEM_PERCENT'),
  };
}

type Q = Queryable;
const lock = (c: Q, userId: string) =>
  c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`rewards:${userId}`]);

/** What a person can spend now: the unexpired lots. */
export async function balanceOf(userId: string, c: Q = { query }): Promise<number> {
  const r = await c.query<{ n: string }>(
    `SELECT COALESCE(sum(remaining), 0)::text AS n FROM reward_ledger
     WHERE user_id = $1 AND remaining > 0 AND (expires_at IS NULL OR expires_at > now())`,
    [userId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

const expiryFrom = (days: number): string | null =>
  days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;

interface Write {
  userId: string;
  kind: LedgerKind;
  points: number;
  source: LedgerSource;
  sourceId: string | null;
  description: string;
}

/**
 * Add points as a new lot (EARN, or a positive ADJUST). Returns false when this source already wrote this entry
 * (the repeat changes nothing). Call inside the person's lock.
 */
async function addLot(c: Q, w: Write): Promise<boolean> {
  const r = await c.query(
    `INSERT INTO reward_ledger (user_id, kind, points, remaining, source, source_id, description, expires_at)
     VALUES ($1, $2, $3, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING id`,
    [
      w.userId,
      w.kind,
      w.points,
      w.source,
      w.sourceId,
      w.description,
      expiryFrom(loyaltyRules().expireDays),
    ],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Take points from the lots that expire first. Returns how many were taken (never more than the balance). */
async function takeFromLots(c: Q, userId: string, wanted: number): Promise<number> {
  const lots = await c.query<{ id: string; remaining: number }>(
    `SELECT id, remaining FROM reward_ledger
     WHERE user_id = $1 AND remaining > 0 AND (expires_at IS NULL OR expires_at > now())
     ORDER BY expires_at NULLS LAST, created_at, id FOR UPDATE`,
    [userId],
  );
  let left = wanted;
  for (const lot of lots.rows) {
    if (left <= 0) break;
    const use = Math.min(lot.remaining, left);
    await c.query('UPDATE reward_ledger SET remaining = remaining - $2 WHERE id = $1', [
      lot.id,
      use,
    ]);
    left -= use;
  }
  return wanted - left;
}

/** Points earned for something (a ride, a campaign, a referral). Idempotent per source. Returns true if it was new. */
export async function earnPoints(
  c: Q,
  p: {
    userId: string;
    points: number;
    source: LedgerSource;
    sourceId: string;
    description: string;
  },
): Promise<boolean> {
  if (p.points <= 0) return false;
  await lock(c, p.userId);
  return addLot(c, { ...p, kind: 'EARN' });
}

/**
 * Spend points on a ride. Spends at most the balance; returns how many were really taken. Idempotent per source
 * (a repeat returns 0 and takes nothing).
 */
export async function spendPoints(
  c: Q,
  p: { userId: string; points: number; sourceId: string; description: string },
): Promise<number> {
  if (p.points <= 0) return 0;
  await lock(c, p.userId);
  const exists = await c.query(
    `SELECT 1 FROM reward_ledger WHERE user_id = $1 AND kind = 'REDEEM' AND source = 'RIDE' AND source_id = $2`,
    [p.userId, p.sourceId],
  );
  if (exists.rowCount) return 0;
  const taken = await takeFromLots(c, p.userId, p.points);
  if (taken <= 0) return 0;
  await c.query(
    `INSERT INTO reward_ledger (user_id, kind, points, remaining, source, source_id, description)
     VALUES ($1, 'REDEEM', $2, 0, 'RIDE', $3, $4)`,
    [p.userId, -taken, p.sourceId, p.description],
  );
  return taken;
}

/** An administrator corrects a person's points (up or down), with the reason kept in the entry and the audit log. */
export async function adjustPoints(
  c: Q,
  p: { userId: string; points: number; reason: string; adminId: string },
): Promise<void> {
  if (p.points === 0) throw new HttpError(400, 'VALIDATION_ERROR', 'The change must not be zero.');
  await lock(c, p.userId);
  if (p.points > 0) {
    await c.query(
      `INSERT INTO reward_ledger (user_id, kind, points, remaining, source, source_id, description, expires_at)
       VALUES ($1, 'ADJUST', $2, $2, 'ADMIN', NULL, $3, $4)`,
      [p.userId, p.points, `Added by Yatri: ${p.reason}`, expiryFrom(loyaltyRules().expireDays)],
    );
    return;
  }
  const have = await balanceOf(p.userId, c);
  if (-p.points > have) {
    throw new HttpError(
      409,
      'INSUFFICIENT_POINTS',
      `The person only has ${have} points, so that many cannot be taken.`,
    );
  }
  const taken = await takeFromLots(c, p.userId, -p.points);
  await c.query(
    `INSERT INTO reward_ledger (user_id, kind, points, remaining, source, source_id, description)
     VALUES ($1, 'ADJUST', $2, 0, 'ADMIN', NULL, $3)`,
    [p.userId, -taken, `Taken back by Yatri: ${p.reason}`],
  );
}

/**
 * The expiry job: lots whose time has passed are written off (one EXPIRE entry each), and people with points about to
 * expire are told once a week. Safe to run twice and from two servers.
 */
export async function expirePoints(): Promise<{ expired: number; warned: number }> {
  const due = await query<{ id: string; user_id: string; remaining: number }>(
    `SELECT id, user_id, remaining FROM reward_ledger
     WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at <= now() ORDER BY expires_at LIMIT 500`,
  );
  let expired = 0;
  for (const lot of due.rows) {
    await withTransaction(async (c) => {
      await lock(c, lot.user_id);
      const cur = await c.query<{ remaining: number }>(
        'SELECT remaining FROM reward_ledger WHERE id = $1 FOR UPDATE',
        [lot.id],
      );
      const left = cur.rows[0]?.remaining ?? 0;
      if (left > 0) {
        await c.query(
          `INSERT INTO reward_ledger (user_id, kind, points, remaining, source, source_id, description)
           VALUES ($1, 'EXPIRE', $2, 0, 'EXPIRY', $3, 'Points expired') ON CONFLICT DO NOTHING`,
          [lot.user_id, -left, lot.id],
        );
        await c.query('UPDATE reward_ledger SET remaining = 0 WHERE id = $1', [lot.id]);
        expired += 1;
      }
    });
  }

  const soon = await query<{ user_id: string; points: string; at: Date }>(
    `SELECT user_id, sum(remaining)::text AS points, min(expires_at) AS at FROM reward_ledger
     WHERE remaining > 0 AND expires_at > now() AND expires_at <= now() + ($1::int * interval '1 day')
     GROUP BY user_id LIMIT 500`,
    [REWARD_EXPIRY_WARNING_DAYS],
  );
  let warned = 0;
  const week = Math.floor(Date.now() / (7 * 86_400_000));
  for (const s of soon.rows) {
    await notify({
      userId: s.user_id,
      type: GROWTH_NOTIFICATION_TYPES.REWARD_POINTS_EXPIRING,
      title: 'Reward points expiring',
      body: `${s.points} of your reward points expire on ${s.at.toISOString().slice(0, 10)}. Use them on a ride to keep their value.`,
      metadata: { points: Number(s.points) },
      dedupeKey: `expiring:${s.user_id}:${week}`,
    }).catch(() => undefined);
    warned += 1;
  }
  return { expired, warned };
}

// ---------------------------------------------------------------- what a person sees

export async function rewardsSummary(userId: string): Promise<RewardsSummary> {
  const rules = loyaltyRules();
  const balance = await balanceOf(userId);
  const soon = await query<{ points: string; at: Date | null }>(
    `SELECT COALESCE(sum(remaining), 0)::text AS points, min(expires_at) AS at FROM reward_ledger
     WHERE user_id = $1 AND remaining > 0 AND expires_at > now() AND expires_at <= now() + ($2::int * interval '1 day')`,
    [userId, REWARD_EXPIRY_WARNING_DAYS],
  );
  const s = soon.rows[0];
  return {
    balance,
    valueNpr: Math.floor(balance * rules.pointValueNpr),
    expiringSoon:
      s && Number(s.points) > 0 && s.at
        ? { points: Number(s.points), at: s.at.toISOString() }
        : null,
    rules,
  };
}

export async function rewardsHistory(
  userId: string,
  before: string | null,
  limit = 30,
): Promise<RewardsHistoryResponse> {
  const r = await query<{
    id: string;
    kind: LedgerKind;
    points: number;
    source: LedgerSource;
    description: string;
    expires_at: Date | null;
    created_at: Date;
  }>(
    `SELECT id, kind, points, source, description, expires_at, created_at FROM reward_ledger
     WHERE user_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
     ORDER BY created_at DESC, id DESC LIMIT $3`,
    [userId, before, limit + 1],
  );
  const rows = r.rows.slice(0, limit);
  return {
    items: rows.map((x): LedgerEntryInfo => ({
      id: x.id,
      kind: x.kind,
      points: x.points,
      source: x.source,
      description: x.description,
      expiresAt: x.expires_at?.toISOString() ?? null,
      createdAt: x.created_at.toISOString(),
    })),
    nextBefore:
      r.rows.length > limit ? (rows[rows.length - 1]?.created_at.toISOString() ?? null) : null,
  };
}
