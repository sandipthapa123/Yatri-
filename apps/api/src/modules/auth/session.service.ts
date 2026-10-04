import { env } from '../../config/env';
import { generateOpaqueToken, sha256Hex } from '../../lib/crypto';
import { signAccessToken } from '../../lib/tokens';
import { findUserById } from '../users/users.repository';
import type { AccountStatus, UserRole } from '../users/users.types';
import { recordAuthEvent } from './auth-event.repository';
import {
  createSession,
  findSessionByTokenHash,
  revokeAllUserSessions,
  revokeSession,
  rotateSession,
} from './session.repository';

export class InvalidRefreshTokenError extends Error {
  constructor() {
    super('Refresh token is invalid, expired, or revoked.');
    this.name = 'InvalidRefreshTokenError';
  }
}

export class AccountNotActiveError extends Error {
  constructor(public readonly status: AccountStatus) {
    super(`Account is ${status.toLowerCase()}.`);
    this.name = 'AccountNotActiveError';
  }
}

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

interface RequestContext {
  userAgent: string | null;
  ipAddress: string | null;
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
}

export async function issueSession(
  userId: string,
  role: UserRole,
  ctx: RequestContext,
): Promise<IssuedSession> {
  const refreshToken = generateOpaqueToken();
  const refreshTokenExpiresAt = refreshExpiry();

  const session = await createSession({
    userId,
    refreshTokenHash: sha256Hex(refreshToken),
    expiresAt: refreshTokenExpiresAt,
    deviceLabel: ctx.userAgent ? ctx.userAgent.slice(0, 120) : null,
    userAgent: ctx.userAgent,
    ipAddress: ctx.ipAddress,
  });

  const accessToken = signAccessToken({ sub: userId, sid: session.id, role });

  return {
    accessToken,
    accessTokenExpiresInSeconds: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshToken,
    refreshTokenExpiresAt,
  };
}

export async function refreshSession(
  refreshToken: string,
  ctx: RequestContext,
): Promise<IssuedSession> {
  const session = await findSessionByTokenHash(sha256Hex(refreshToken));

  if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now()) {
    await recordAuthEvent({
      eventType: 'TOKEN_REFRESH_FAILED',
      userId: session?.user_id ?? null,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { reason: !session ? 'not_found' : session.revoked_at ? 'revoked' : 'expired' },
    });
    throw new InvalidRefreshTokenError();
  }

  const user = await findUserById(session.user_id);
  if (!user || user.status !== 'ACTIVE') {
    await recordAuthEvent({
      eventType: 'TOKEN_REFRESH_FAILED',
      userId: session.user_id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { reason: 'account_not_active' },
    });
    // Revoke so this refresh token can't be tried again.
    await revokeSession(session.id);
    throw new AccountNotActiveError(user?.status ?? 'DEACTIVATED');
  }

  const newRefreshToken = generateOpaqueToken();
  const newExpiresAt = refreshExpiry();
  const swapped = await rotateSession(
    session.id,
    sha256Hex(refreshToken),
    sha256Hex(newRefreshToken),
    newExpiresAt,
  );
  if (!swapped) {
    // Someone else used this refresh token a moment ago (or it was revoked): only one use of a token can win.
    await recordAuthEvent({
      eventType: 'TOKEN_REFRESH_FAILED',
      userId: session.user_id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
      metadata: { reason: 'already_used' },
    });
    throw new InvalidRefreshTokenError();
  }

  const accessToken = signAccessToken({ sub: user.id, sid: session.id, role: user.role });

  await recordAuthEvent({
    eventType: 'TOKEN_REFRESHED',
    userId: user.id,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });

  return {
    accessToken,
    accessTokenExpiresInSeconds: env.ACCESS_TOKEN_TTL_MINUTES * 60,
    refreshToken: newRefreshToken,
    refreshTokenExpiresAt: newExpiresAt,
  };
}

export async function logout(
  params: { sessionId: string; userId: string; allDevices: boolean },
  ctx: RequestContext,
): Promise<void> {
  if (params.allDevices) {
    await revokeAllUserSessions(params.userId);
  } else {
    await revokeSession(params.sessionId);
  }
  await recordAuthEvent({
    eventType: 'LOGOUT',
    userId: params.userId,
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
    metadata: { allDevices: params.allDevices },
  });
}
