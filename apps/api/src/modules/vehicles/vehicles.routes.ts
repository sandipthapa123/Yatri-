import type {
  ApiResponse,
  VehicleCapabilitiesBody,
  VehicleCapabilitiesResponse,
} from '@yatri/types';
import { Router, type Request, type Response, type Router as RouterType } from 'express';

import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import { capabilitiesOf, declareCapabilities } from '../accessibility/accessibility.service';
import { declareSchema } from '../accessibility/accessibility.validators';

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

/** The driver's own vehicle only: features declared here wait for approval where verification is required. */
async function capabilitiesHandler(
  req: Request,
  res: Response<ApiResponse<VehicleCapabilitiesResponse>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  res.json({ success: true, data: await capabilitiesOf(requireParam(req, 'id'), req.auth.userId) });
}
async function declareHandler(
  req: Request,
  res: Response<ApiResponse<VehicleCapabilitiesResponse>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const { declared } = req.body as VehicleCapabilitiesBody;
  res.json({
    success: true,
    data: await declareCapabilities(requireParam(req, 'id'), req.auth.userId, declared),
  });
}

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
vehiclesRouter.get(
  '/:id/accessibility',
  requireRole('DRIVER'),
  validateUuidParam('id'),
  capabilitiesHandler,
);
vehiclesRouter.put(
  '/:id/accessibility',
  requireRole('DRIVER'),
  validateUuidParam('id'),
  validateBody(declareSchema),
  declareHandler,
);
vehiclesRouter.patch(
  '/:id',
  requireRole('DRIVER'),
  validateUuidParam('id'),
  validateBody(updateVehicleSchema),
  updateVehicleHandler,
);
