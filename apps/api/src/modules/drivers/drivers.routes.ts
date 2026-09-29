import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { updateProfileSchema } from '../users/users.validators';
import {
  getDriverMeHandler,
  getOnboardingHandler,
  getVerificationStatusHandler,
  submitVerificationHandler,
  updateDriverMeHandler,
  updateOnboardingHandler,
} from './drivers.controller';
import { updateOnboardingSchema } from './drivers.validators';

export const driversRouter: RouterType = Router();

driversRouter.use(authenticate, requireRole('DRIVER'));
driversRouter.get('/me', getDriverMeHandler);
driversRouter.patch('/me', validateBody(updateProfileSchema), updateDriverMeHandler);

driversRouter.get('/me/onboarding', getOnboardingHandler);
driversRouter.patch(
  '/me/onboarding',
  validateBody(updateOnboardingSchema),
  updateOnboardingHandler,
);
driversRouter.get('/me/verification-status', getVerificationStatusHandler);
driversRouter.post('/me/submit-verification', submitVerificationHandler);
