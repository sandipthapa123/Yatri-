import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

import { HttpError } from './errorHandler';

/**
 * Parses and replaces req.body with the schema's output, or fails with 400
 * and per-field messages. Every mutating auth/profile endpoint validates
 * its body this way — nothing is trusted unvalidated from the client.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return next(
        new HttpError(400, 'VALIDATION_ERROR', 'Request body failed validation.').withDetails(
          result.error.flatten().fieldErrors,
        ),
      );
    }
    req.body = result.data;
    next();
  };
}
