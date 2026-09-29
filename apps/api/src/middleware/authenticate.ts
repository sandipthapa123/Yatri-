import type { NextFunction, Request, Response } from 'express';

import { findActiveSessionWithUser } from '../modules/auth/session.repository';
import { InvalidAccessTokenError, verifyAccessToken } from '../lib/tokens';
import type { AuthContext } from '../types/express';
import { HttpError } from './errorHandler';
import { recordAuthEvent } from '../modules/auth/auth-event.repository';

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}

export type AccessTokenResolution =
  | { ok: true; auth: AuthContext; expiresAtMs: number }
  | { ok: false; reason: 'invalid' | 'suspended' | 'deactivated'; userId?: string };

/**
 * Verifies an access token AND re-checks the backing session and user
 * status against the database. Shared by the HTTP `authenticate`
 * middleware and the realtime gateway so both enforce identical rules.
 */
export async function resolveAccessToken(token: string): Promise<AccessTokenResolution> {
  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof InvalidAccessTokenError) return { ok: false, reason: 'invalid' };
    throw err;
  }

  const session = await findActiveSessionWithUser(claims.sid);
  if (
    !session ||
    session.user_id !== claims.sub ||
    session.session_revoked_at ||
    session.session_expires_at.getTime() <= Date.now()
  ) {
    return { ok: false, reason: 'invalid' };
  }
  if (session.status === 'SUSPENDED' || session.status === 'DEACTIVATED') {
    return {
      ok: false,
      reason: session.status === 'SUSPENDED' ? 'suspended' : 'deactivated',
      userId: session.user_id,
    };
  }
  return {
    ok: true,
    expiresAtMs: claims.exp ? claims.exp * 1000 : Date.now(),
    auth: {
      userId: session.user_id,
      sessionId: session.session_id,
      role: session.role,
      status: session.status,
    },
  };
}

/**
 * Verifies the access token AND re-checks the backing session and user
 * status against the database on every request. A pure JWT-signature check
 * would let a revoked session or a just-suspended account keep working
 * until the token's natural expiry; this middleware makes both take effect
 * immediately, at the cost of one indexed join per request.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const token = extractBearerToken(req);
  if (!token) {
    return next(
      new HttpError(401, 'UNAUTHENTICATED', 'Missing or malformed Authorization header.'),
    );
  }

  const resolved = await resolveAccessToken(token);
  if (!resolved.ok) {
    if (resolved.reason === 'invalid') {
      return next(new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired access token.'));
    }
    await recordAuthEvent({
      eventType:
        resolved.reason === 'suspended' ? 'ACCESS_BLOCKED_SUSPENDED' : 'ACCESS_BLOCKED_DEACTIVATED',
      userId: resolved.userId ?? null,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      metadata: { path: req.path },
    });
    return next(
      new HttpError(
        403,
        resolved.reason === 'suspended' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DEACTIVATED',
        `Your account is ${resolved.reason}.`,
      ),
    );
  }

  req.auth = resolved.auth;
  next();
}
