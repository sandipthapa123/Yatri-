import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';

import { HttpError } from './errorHandler';

/**
 * Same idea as validateBody, for query-string params — except Express 5
 * makes `req.query` a read-only getter, so the validated/coerced/defaulted
 * result is attached as `req.validatedQuery` instead of written back onto
 * `req.query`. Controllers read `req.validatedQuery`.
 */
export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      return next(
        new HttpError(400, 'VALIDATION_ERROR', 'Query parameters failed validation.').withDetails(
          result.error.flatten().fieldErrors,
        ),
      );
    }
    req.validatedQuery = result.data;
    next();
  };
}
