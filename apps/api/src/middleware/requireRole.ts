import type { NextFunction, Request, Response } from 'express';

import type { UserRole } from '../modules/users/users.types';
import { HttpError } from './errorHandler';

/**
 * Authorization guard: must run after `authenticate`. The role checked here
 * always comes from the database-backed session (`req.auth`, set by
 * `authenticate`), never from anything the client sent on this request —
 * a client cannot elevate itself by passing a different role in a header
 * or body.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) {
      return next(new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.'));
    }
    if (!roles.includes(req.auth.role)) {
      return next(new HttpError(403, 'FORBIDDEN', 'You do not have access to this resource.'));
    }
    next();
  };
}
