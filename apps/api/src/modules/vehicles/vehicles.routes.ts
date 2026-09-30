import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { userMutationRateLimit } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import {
  createVehicleHandler,
  listMyVehiclesHandler,
  listVehicleCategoriesHandler,
  updateVehicleHandler,
} from './vehicles.controller';
import { createVehicleSchema, updateVehicleSchema } from './vehicles.validators';

export const vehiclesRouter: RouterType = Router();

vehiclesRouter.use(authenticate);
vehiclesRouter.use(userMutationRateLimit());

// Must come before "/:id"-shaped routes so "categories" isn't parsed as an id.
vehiclesRouter.get('/categories', listVehicleCategoriesHandler);

vehiclesRouter.post(
  '/',
  requireRole('DRIVER'),
  validateBody(createVehicleSchema),
  createVehicleHandler,
);
vehiclesRouter.get('/', requireRole('DRIVER'), listMyVehiclesHandler);
vehiclesRouter.patch(
  '/:id',
  requireRole('DRIVER'),
  validateUuidParam('id'),
  validateBody(updateVehicleSchema),
  updateVehicleHandler,
);
