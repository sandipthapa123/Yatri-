import { Router, type Router as RouterType } from 'express';

import { getHealth } from './health.controller';

export const healthRouter: RouterType = Router();

healthRouter.get('/', getHealth);
