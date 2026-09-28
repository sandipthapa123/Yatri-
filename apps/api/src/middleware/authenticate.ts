import type { NextFunction, Request, Response } from 'express';

import { findActiveSessionWithUser } from '../modules/auth/session.repository';
import { InvalidAccessTokenError, verifyAccessToken } from '../lib/tokens';
import { HttpError } from './errorHandler';
import { recordAuthEvent } from '../modules/auth/auth-event.repository';

function extractBearerToken(req: Request): string | null {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
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

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err) {
    if (err instanceof InvalidAccessTokenError) {
      return next(new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired access token.'));
    }
    return next(err);
  }

  const session = await findActiveSessionWithUser(claims.sid);
  if (
    !session ||
    session.user_id !== claims.sub ||
    session.session_revoked_at ||
    session.session_expires_at.getTime() <= Date.now()
  ) {
    return next(new HttpError(401, 'UNAUTHENTICATED', 'Session is no longer valid.'));
  }

  if (session.status === 'SUSPENDED' || session.status === 'DEACTIVATED') {
    await recordAuthEvent({
      eventType:
        session.status === 'SUSPENDED' ? 'ACCESS_BLOCKED_SUSPENDED' : 'ACCESS_BLOCKED_DEACTIVATED',
      userId: session.user_id,
      ipAddress: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      metadata: { path: req.path },
    });
    return next(
      new HttpError(
        403,
        session.status === 'SUSPENDED' ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DEACTIVATED',
        `Your account is ${session.status.toLowerCase()}.`,
      ),
    );
  }

  req.auth = {
    userId: session.user_id,
    sessionId: session.session_id,
    role: session.role,
    status: session.status,
  };
  next();
}
