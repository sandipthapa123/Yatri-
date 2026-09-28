import { Router, type Router as RouterType } from 'express';

import { adminRouter } from '../modules/admin/admin.routes';
import { authRouter } from '../modules/auth/auth.routes';
import { driversRouter } from '../modules/drivers/drivers.routes';
import { healthRouter } from '../modules/health/health.routes';
import { usersRouter } from '../modules/users/users.routes';

/**
 * Modular-monolith route mount point: each domain module owns its own
 * router and is mounted here. New capabilities get a new module + mount
 * line, not a new service.
 */
export const apiRouter: RouterType = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/users', usersRouter);
apiRouter.use('/drivers', driversRouter);
apiRouter.use('/admin', adminRouter);
