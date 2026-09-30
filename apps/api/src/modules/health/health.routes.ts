import { Router, type Router as RouterType } from 'express';

import { getHealth, getReady } from './health.controller';

export const healthRouter: RouterType = Router();

// /health is liveness (the process is up); /health/ready is readiness (its dependencies answer).
healthRouter.get('/', getHealth);
healthRouter.get('/live', getHealth);
healthRouter.get('/ready', getReady);
