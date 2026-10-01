import {
  ACCOUNT_RESTRICTED_MESSAGE,
  RISK_NOTIFICATION_TYPES,
  type RiskRestrictionInfo,
  type RiskRestrictionSource,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { enforceEligibility } from '../fleet/enforcement';

/**
 * Temporary restriction: the only thing risk ever does to an account by itself, and only ever for a limited
 * time. A restricted passenger cannot request rides; a restricted driver is not offered rides (the eligibility
 * rules in fleet/eligibility.ts read RISK_RESTRICTED_SQL). Support, sign-in and rides already under way are
 * untouched. Suspension is NOT here: it is the existing account move in admin-users, a separate, reversible
 * decision only an administrator makes.
 *
 * Applying is guarded under a row lock on the user, so two administrators (or an administrator and the sweep)
 * cannot both apply: one wins, the other is told it is already restricted.
 */
interface ApplyInput {
  userId: string;
  hours: number;
  reason: string;
  source: RiskRestrictionSource;
  actorId: string | null;
}

async function tell(userId: string, type: string, body: string): Promise<void> {
  await notify({ userId, type, title: 'Yatri', body, metadata: {} }).catch(() => undefined);
}

export async function applyRestriction(i: ApplyInput): Promise<RiskRestrictionInfo> {
  let role = '';
  const row = await withTransaction(async (c) => {
    const u = (
      await c.query<{ role: string; status: string }>(
        'SELECT role, status FROM users WHERE id = $1 FOR UPDATE',
        [i.userId],
      )
    ).rows[0];
    if (!u) throw new HttpError(404, 'NOT_FOUND', 'Person not found.');
    role = u.role;
    if (u.role === 'ADMIN') {
      throw new HttpError(409, 'NOT_ALLOWED', 'Administrator accounts cannot be restricted here.');
    }
    if (u.status !== 'ACTIVE') {
      throw new HttpError(409, 'NOT_ACTIVE', 'Only an active account can be restricted.');
    }
    const r = await c.query<{ restricted_until: Date; restriction_set_at: Date }>(
      `INSERT INTO risk_profiles (user_id, restricted_until, restriction_reason, restriction_source,
                                  restriction_set_by, restriction_set_at, updated_at)
       VALUES ($1, now() + ($2::int * interval '1 hour'), $3, $4, $5, now(), now())
       ON CONFLICT (user_id) DO UPDATE
         SET restricted_until = now() + ($2::int * interval '1 hour'), restriction_reason = $3,
             restriction_source = $4, restriction_set_by = $5, restriction_set_at = now(), updated_at = now()
         WHERE risk_profiles.restricted_until IS NULL OR risk_profiles.restricted_until <= now()
       RETURNING restricted_until, restriction_set_at`,
      [i.userId, i.hours, i.reason, i.source, i.actorId],
    );
    if (!r.rows[0]) {
      throw new HttpError(
        409,
        'ALREADY_RESTRICTED',
        'This account is already restricted. Lift it first to change it.',
      );
    }
    return r.rows[0];
  });
  await recordAudit({
    actorId: i.actorId,
    actorRole: i.actorId ? 'ADMIN' : 'SYSTEM',
    action: i.source === 'AUTOMATIC' ? 'RISK_USER_AUTO_RESTRICTED' : 'RISK_USER_RESTRICTED',
    subjectType: 'risk_user',
    subjectIds: [i.userId],
    detail: { hours: i.hours, reason: i.reason, until: row.restricted_until.toISOString() },
  });
  // A driver online right now is taken offline by the same enforcement fleet operations uses.
  if (role === 'DRIVER') await enforceEligibility(i.userId).catch(() => false);
  await tell(i.userId, RISK_NOTIFICATION_TYPES.ACCOUNT_RESTRICTED, ACCOUNT_RESTRICTED_MESSAGE);
  return {
    until: row.restricted_until.toISOString(),
    reason: i.reason,
    source: i.source,
    setAt: row.restriction_set_at.toISOString(),
  };
}

export async function liftRestriction(
  userId: string,
  reason: string,
  adminId: string,
): Promise<void> {
  const r = await query(
    `UPDATE risk_profiles SET restricted_until = NULL, restriction_reason = NULL, restriction_source = NULL,
            restriction_set_by = NULL, updated_at = now()
     WHERE user_id = $1 AND restricted_until > now()`,
    [userId],
  );
  if (!r.rowCount) throw new HttpError(409, 'NOT_RESTRICTED', 'This account is not restricted.');
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'RISK_USER_RESTRICTION_LIFTED',
    subjectType: 'risk_user',
    subjectIds: [userId],
    detail: { reason },
  });
  await tell(
    userId,
    RISK_NOTIFICATION_TYPES.RESTRICTION_LIFTED,
    'The temporary limit on your account has ended.',
  );
}

/** Clear restrictions whose time has passed, so the history says so. They had already stopped applying. */
export async function expireRestrictions(): Promise<number> {
  const r = await query<{ user_id: string }>(
    `UPDATE risk_profiles SET restricted_until = NULL, restriction_reason = NULL, restriction_source = NULL,
            restriction_set_by = NULL, updated_at = now()
     WHERE restricted_until IS NOT NULL AND restricted_until <= now()
     RETURNING user_id`,
  );
  await recordAudit({
    actorId: null,
    actorRole: 'SYSTEM',
    action: 'RISK_RESTRICTION_EXPIRED',
    subjectType: 'risk_user',
    subjectIds: r.rows.map((x) => x.user_id),
  });
  return r.rows.length;
}

export async function activeRestriction(userId: string): Promise<RiskRestrictionInfo | null> {
  const r = await query<{
    restricted_until: Date;
    restriction_reason: string | null;
    restriction_source: RiskRestrictionSource;
    restriction_set_at: Date | null;
  }>(
    `SELECT restricted_until, restriction_reason, restriction_source, restriction_set_at
     FROM risk_profiles WHERE user_id = $1 AND restricted_until > now()`,
    [userId],
  );
  const x = r.rows[0];
  return x
    ? {
        until: x.restricted_until.toISOString(),
        reason: x.restriction_reason ?? '',
        source: x.restriction_source,
        setAt: (x.restriction_set_at ?? x.restricted_until).toISOString(),
      }
    : null;
}

/** For the places that refuse a restricted person (ride requests). The message says nothing about why. */
export async function assertNotRestricted(userId: string): Promise<void> {
  if (await activeRestriction(userId)) {
    throw new HttpError(403, 'ACCOUNT_RESTRICTED', ACCOUNT_RESTRICTED_MESSAGE);
  }
}
