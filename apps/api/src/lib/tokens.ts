import { ACCESS_TOKEN_ALGORITHM, ACCESS_TOKEN_ISSUER } from '@yatri/types';
import jwt from 'jsonwebtoken';

import { env } from '../config/env';

export interface AccessTokenClaims {
  sub: string; // user id
  sid: string; // auth_sessions.id
  role: 'PASSENGER' | 'DRIVER' | 'ADMIN';
  /** Expiry (seconds since epoch); present on verified tokens. */
  exp?: number;
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: ACCESS_TOKEN_ALGORITHM,
    issuer: ACCESS_TOKEN_ISSUER,
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
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: [ACCESS_TOKEN_ALGORITHM],
      issuer: ACCESS_TOKEN_ISSUER,
    });
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      typeof decoded.sub !== 'string' ||
      typeof (decoded as Record<string, unknown>).sid !== 'string' ||
      typeof (decoded as Record<string, unknown>).role !== 'string'
    ) {
      throw new InvalidAccessTokenError();
    }
    const { sub, sid, role, exp } = decoded as {
      sub: string;
      sid: string;
      role: string;
      exp?: number;
    };
    return { sub, sid, role: role as AccessTokenClaims['role'], exp };
  } catch {
    throw new InvalidAccessTokenError();
  }
}
