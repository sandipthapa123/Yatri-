import jwt from 'jsonwebtoken';

import { env } from '../config/env';

export interface AccessTokenClaims {
  sub: string; // user id
  sid: string; // auth_sessions.id
  role: 'PASSENGER' | 'DRIVER' | 'ADMIN';
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    expiresIn: `${env.ACCESS_TOKEN_TTL_MINUTES}m`,
  });
}

export class InvalidAccessTokenError extends Error {
  constructor() {
    super('Invalid or expired access token');
    this.name = 'InvalidAccessTokenError';
  }
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof decoded.sub !== 'string' ||
      typeof (decoded as Record<string, unknown>).sid !== 'string' ||
      typeof (decoded as Record<string, unknown>).role !== 'string'
    ) {
      throw new InvalidAccessTokenError();
    }
    const { sub, sid, role } = decoded as { sub: string; sid: string; role: string };
    return { sub, sid, role: role as AccessTokenClaims['role'] };
  } catch {
    throw new InvalidAccessTokenError();
  }
}
