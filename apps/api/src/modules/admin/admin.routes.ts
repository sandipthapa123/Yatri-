import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { getMeHandler } from '../users/users.controller';

export const adminRouter: RouterType = Router();

// Mirrors GET /users/me but explicitly gated to ADMIN — the admin web app
// uses this to confirm a session is both valid and actually an admin.
adminRouter.get('/me', authenticate, requireRole('ADMIN'), getMeHandler);
