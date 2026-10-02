import { query } from '../../lib/db';
import type { AccountStatus, UserRole } from '../users/users.types';

export interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  device_label: string | null;
  user_agent: string | null;
  ip_address: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
}

export interface SessionWithUser {
  session_id: string;
  session_expires_at: Date;
  session_revoked_at: Date | null;
  user_id: string;
  role: UserRole;
  status: AccountStatus;
}

export async function createSession(input: {
  userId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  deviceLabel: string | null;
  userAgent: string | null;
  ipAddress: string | null;
}): Promise<SessionRow> {
  const result = await query<SessionRow>(
    `INSERT INTO auth_sessions
       (user_id, refresh_token_hash, expires_at, device_label, user_agent, ip_address, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING id, user_id, refresh_token_hash, device_label, user_agent, ip_address,
               expires_at, revoked_at, last_used_at, created_at`,
    [
      input.userId,
      input.refreshTokenHash,
      input.expiresAt,
      input.deviceLabel,
      input.userAgent,
      input.ipAddress,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create session');
  return row;
}

/** Used by the `authenticate` middleware: one round trip for session + user liveness. */
export async function findActiveSessionWithUser(
  sessionId: string,
): Promise<SessionWithUser | null> {
  const result = await query<SessionWithUser>(
    `SELECT s.id AS session_id, s.expires_at AS session_expires_at, s.revoked_at AS session_revoked_at,
            u.id AS user_id, u.role, u.status
     FROM auth_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [sessionId],
  );
  return result.rows[0] ?? null;
}

export async function findSessionByTokenHash(refreshTokenHash: string): Promise<SessionRow | null> {
  const result = await query<SessionRow>(
    `SELECT id, user_id, refresh_token_hash, device_label, user_agent, ip_address,
            expires_at, revoked_at, last_used_at, created_at
     FROM auth_sessions WHERE refresh_token_hash = $1`,
    [refreshTokenHash],
  );
  return result.rows[0] ?? null;
}

/**
 * Swap a session's refresh token for the next one, only if it is still the one that was presented (compare and swap). Two
 * refreshes with the same token cannot both win: the loser gets false, so a token that was already used (a replay, a race)
 * is refused instead of silently overwriting the winner's new token and logging that device out later.
 */
export async function rotateSession(
  sessionId: string,
  presentedRefreshTokenHash: string,
  newRefreshTokenHash: string,
  newExpiresAt: Date,
): Promise<boolean> {
  const r = await query(
    `UPDATE auth_sessions
     SET refresh_token_hash = $3, expires_at = $4, last_used_at = now()
     WHERE id = $1 AND refresh_token_hash = $2 AND revoked_at IS NULL`,
    [sessionId, presentedRefreshTokenHash, newRefreshTokenHash, newExpiresAt],
  );
  return (r.rowCount ?? 0) === 1;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await query(`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
    sessionId,
  ]);
}

export async function revokeAllUserSessions(userId: string): Promise<void> {
  await query(
    `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  // A person with no signed-in device is pushed nothing: their phones' addresses go with their sessions.
  await query('DELETE FROM push_tokens WHERE user_id = $1', [userId]);
}
