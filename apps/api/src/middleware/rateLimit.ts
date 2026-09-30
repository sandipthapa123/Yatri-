import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env';
import { checkWindowLimit } from '../lib/rate-limit';
import { log } from '../lib/logger';
import { HttpError } from './errorHandler';

export interface LimitOptions {
  /**
   * What to do when the limiter itself cannot be reached (Redis down). Security-sensitive routes keep
   * the default and refuse (closed); the generic API-wide ceiling lets requests through (open) so a
   * Redis outage does not turn every read into an error.
   */
  failOpen?: boolean;
}

async function hit(
  key: string,
  limit: number,
  windowSeconds: number,
  res: Response,
  next: NextFunction,
  options: LimitOptions,
) {
  let result;
  try {
    result = await checkWindowLimit(key, limit, windowSeconds);
  } catch (err) {
    if (options.failOpen) {
      log.warn('Rate limiter unavailable; letting the request through', err);
      return next();
    }
    return next(err);
  }
  // Tell well-behaved clients where they stand.
  res.setHeader('RateLimit-Limit', String(limit));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - result.count)));
  res.setHeader('RateLimit-Reset', String(result.retryAfterSeconds));
  if (result.limited) {
    res.setHeader('Retry-After', String(result.retryAfterSeconds));
    return next(new HttpError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.'));
  }
  next();
}

/**
 * Coarse, IP-keyed request-flooding guard for a router. Defense in depth on top of the OTP-specific
 * limits in otp.service.ts (keyed by phone number): it stops generic hammering (malformed bodies,
 * admin-login guessing) before it reaches business logic.
 */
export function ipRateLimit(
  keyPrefix: string,
  limit: number,
  windowSeconds: number,
  options: LimitOptions = {},
) {
  return (req: Request, res: Response, next: NextFunction) =>
    hit(`${keyPrefix}:${req.ip ?? 'unknown'}`, limit, windowSeconds, res, next, options);
}

/** Same as ipRateLimit but keyed by the authenticated user; must run after `authenticate`. */
export function userRateLimit(
  keyPrefix: string,
  limit: number,
  windowSeconds: number,
  options: LimitOptions = {},
) {
  return (req: Request, res: Response, next: NextFunction) =>
    hit(
      `${keyPrefix}:u:${req.auth?.userId ?? req.ip ?? 'unknown'}`,
      limit,
      windowSeconds,
      res,
      next,
      options,
    );
}

/**
 * A per-user ceiling on state-changing requests (POST, PUT, PATCH, DELETE), for whole routers, after
 * `authenticate`. Reads are not counted. Routes with a real reason for a lower number (OTP, SOS,
 * uploads, sharing) keep their own stricter limit in front of this one.
 */
export function userMutationRateLimit(limit: number = env.MUTATION_RATE_LIMIT_PER_MINUTE) {
  const limiter = userRateLimit('mutate', limit, 60);
  return (req: Request, res: Response, next: NextFunction) =>
    req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS'
      ? next()
      : limiter(req, res, next);
}
