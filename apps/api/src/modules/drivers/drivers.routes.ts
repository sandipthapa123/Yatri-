import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { updateProfileSchema } from '../users/users.validators';
import { getDriverMeHandler, updateDriverMeHandler } from './drivers.controller';

export const driversRouter: RouterType = Router();

driversRouter.use(authenticate, requireRole('DRIVER'));
driversRouter.get('/me', getDriverMeHandler);
driversRouter.patch('/me', validateBody(updateProfileSchema), updateDriverMeHandler);
