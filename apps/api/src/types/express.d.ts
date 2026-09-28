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
    }
  }
}

export {};
