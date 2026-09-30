import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { userRateLimit } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/requireRole';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import { savedPlacesRouter } from '../saved-places/saved-places.routes';
import { uploadSingleFile } from '../../middleware/upload';
import { validateBody } from '../../middleware/validate';
import {
  deactivateMeHandler,
  getMeHandler,
  updateMeHandler,
  uploadProfilePictureHandler,
} from './users.controller';
import {
  addContactHandler,
  listContactsHandler,
  myRatingHandler,
  removeContactHandler,
} from '../safety/safety.controller';
import { emergencyContactSchema } from '../safety/safety.validators';
import { updateProfileSchema } from './users.validators';

export const usersRouter: RouterType = Router();

// Any authenticated role (passenger, driver, admin) can read/update their
// own base profile — role-specific extensions live under their own router
// (e.g. /drivers/me).
usersRouter.get('/me', authenticate, getMeHandler);
usersRouter.patch('/me', authenticate, validateBody(updateProfileSchema), updateMeHandler);
usersRouter.post(
  '/me/profile-picture',
  authenticate,
  uploadSingleFile,
  uploadProfilePictureHandler,
);
// Ratings summary and emergency contacts: a passenger's or driver's own, and nobody else's.
usersRouter.get('/me/rating', authenticate, requireRole('PASSENGER', 'DRIVER'), myRatingHandler);
usersRouter.get(
  '/me/emergency-contacts',
  authenticate,
  requireRole('PASSENGER', 'DRIVER'),
  listContactsHandler,
);
usersRouter.post(
  '/me/emergency-contacts',
  authenticate,
  requireRole('PASSENGER', 'DRIVER'),
  userRateLimit('emergency-contacts', 20, 3600),
  validateBody(emergencyContactSchema),
  addContactHandler,
);
usersRouter.delete(
  '/me/emergency-contacts/:contactId',
  authenticate,
  requireRole('PASSENGER', 'DRIVER'),
  validateUuidParam('contactId'),
  removeContactHandler,
);
usersRouter.post('/me/deactivate', authenticate, deactivateMeHandler);
usersRouter.use('/me/saved-places', savedPlacesRouter);
