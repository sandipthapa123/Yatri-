import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { uploadSingleFile } from '../../middleware/upload';
import { validateBody } from '../../middleware/validate';
import {
  deactivateMeHandler,
  getMeHandler,
  updateMeHandler,
  uploadProfilePictureHandler,
} from './users.controller';
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
usersRouter.post('/me/deactivate', authenticate, deactivateMeHandler);
