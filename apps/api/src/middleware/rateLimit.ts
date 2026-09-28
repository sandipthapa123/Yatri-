import type { NextFunction, Request, Response } from 'express';

import { checkWindowLimit } from '../lib/rate-limit';
import { HttpError } from './errorHandler';

/**
 * Coarse, IP-keyed request-flooding guard for a router. This is defense in
 * depth on top of the OTP-specific limits in otp.service.ts (which are
 * keyed by phone number, not just IP) — it exists to stop generic
 * hammering of auth endpoints (malformed bodies, admin-login guessing)
 * before it reaches business logic.
 */
export function ipRateLimit(keyPrefix: string, limit: number, windowSeconds: number) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const result = await checkWindowLimit(`${keyPrefix}:${ip}`, limit, windowSeconds);
    if (result.limited) {
      _res.setHeader('Retry-After', String(result.retryAfterSeconds));
      return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'));
    }
    next();
  };
}
