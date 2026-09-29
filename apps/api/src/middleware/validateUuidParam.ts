import type { NextFunction, Request, Response } from 'express';

import { HttpError } from './errorHandler';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed :id would otherwise reach the database as a raw string and
 * fail with an "invalid input syntax for type uuid" error — a real
 * Postgres error message reaching an unhandled-error 500 instead of a
 * clean validation response. Reject it here instead.
 */
export function validateUuidParam(name: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const value = req.params[name];
    const candidate = Array.isArray(value) ? value[0] : value;
    if (!candidate || !UUID_RE.test(candidate)) {
      return next(new HttpError(400, 'VALIDATION_ERROR', `Invalid ${name}.`));
    }
    next();
  };
}
