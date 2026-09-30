import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { userMutationRateLimit } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import {
  createHandler,
  deleteHandler,
  getHandler,
  listHandler,
  updateHandler,
} from './saved-places.controller';
import { createSavedPlaceSchema, updateSavedPlaceSchema } from './saved-places.validators';

/** Mounted at /users/me/saved-places. Every query is scoped to req.auth.userId. */
export const savedPlacesRouter: RouterType = Router();

savedPlacesRouter.use(authenticate, requireRole('PASSENGER'));
savedPlacesRouter.use(userMutationRateLimit());
savedPlacesRouter.get('/', listHandler);
savedPlacesRouter.post('/', validateBody(createSavedPlaceSchema), createHandler);
savedPlacesRouter.get('/:id', validateUuidParam('id'), getHandler);
savedPlacesRouter.patch(
  '/:id',
  validateUuidParam('id'),
  validateBody(updateSavedPlaceSchema),
  updateHandler,
);
savedPlacesRouter.delete('/:id', validateUuidParam('id'), deleteHandler);
