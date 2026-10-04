import type { NextFunction, Request, Response } from 'express';

import { HttpError } from './errorHandler';

/**
 * PostgreSQL cannot store a NUL character in text at all: a value that contains one makes the write fail, which a handler
 * would otherwise turn into a server error. No Yatri field has any use for it, so a request carrying one anywhere (the body,
 * the query string or the address) is refused here, once, in plain words, before any route sees it. Other characters
 * (newlines in a message, accents, scripts) are left to each field's own validator.
 */
function hasNul(value: unknown, depth = 0): boolean {
  if (depth > 32) return false; // the JSON body is size-limited; this only stops a pathological nesting walk
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some((v) => hasNul(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => k.includes('\u0000') || hasNul(v, depth + 1));
  }
  return false;
}

export function rejectNulText(req: Request, _res: Response, next: NextFunction): void {
  if (req.path.includes('\u0000') || hasNul(req.query) || hasNul(req.body)) {
    return next(
      new HttpError(
        400,
        'VALIDATION_ERROR',
        'The request contains a character that cannot be stored (a null character).',
      ),
    );
  }
  next();
}
