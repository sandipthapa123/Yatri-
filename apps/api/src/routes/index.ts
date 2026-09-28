import { Router, type Router as RouterType } from 'express';

import { healthRouter } from '../modules/health/health.routes';

/**
 * Modular-monolith route mount point: each domain module (health today,
 * users/trips/payments later) owns its own router and is mounted here.
 * New capabilities get a new module + mount line, not a new service.
 */
export const apiRouter: RouterType = Router();

apiRouter.use('/health', healthRouter);
