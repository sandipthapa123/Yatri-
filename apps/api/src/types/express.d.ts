import type { AccountStatus, UserRole } from '../modules/users/users.types';

export interface AuthContext {
  userId: string;
  sessionId: string;
  role: UserRole;
  status: AccountStatus;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      /**
       * Set by validateQuery. Express 5 makes `req.query` a read-only
       * getter, so the parsed/coerced/defaulted query data (e.g. page
       * numbers, enum filters) lives here instead of being written back
       * onto `req.query`.
       */
      validatedQuery?: unknown;
    }
  }
}

export {};
