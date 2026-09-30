import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { userMutationRateLimit, userRateLimit } from '../../middleware/rateLimit';
import { updateProfileSchema } from '../users/users.validators';
import {
  getDriverMeHandler,
  getOnboardingHandler,
  getVerificationStatusHandler,
  submitVerificationHandler,
  updateDriverMeHandler,
  updateOnboardingHandler,
} from './drivers.controller';
import {
  deleteLocationHandler,
  driverLocationSchema,
  getLocationHandler,
  putLocationHandler,
} from './driver-location';
import {
  getAvailabilityHandler,
  goOfflineHandler,
  goOnlineHandler,
} from '../availability/availability.controller';
import { driverLocationSampleSchema } from '../availability/availability.validators';
import { updateOnboardingSchema } from './drivers.validators';

export const driversRouter: RouterType = Router();

driversRouter.use(authenticate, requireRole('DRIVER'));
driversRouter.use(userMutationRateLimit());
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

// Explicit one-shot location share (last known position only; no history, no streaming).
driversRouter.put(
  '/me/location',
  userRateLimit('driver-loc', 30, 60),
  validateBody(driverLocationSchema),
  putLocationHandler,
);
driversRouter.get('/me/location', getLocationHandler);
driversRouter.delete('/me/location', deleteLocationHandler);

// Availability. Eligibility is decided by the server; the client only asks.
driversRouter.get('/me/availability', getAvailabilityHandler);
driversRouter.post(
  '/me/availability/online',
  userRateLimit('drv-online', 20, 60),
  validateBody(driverLocationSampleSchema),
  goOnlineHandler,
);
driversRouter.post(
  '/me/availability/offline',
  userRateLimit('drv-offline', 20, 60),
  goOfflineHandler,
);
