import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import {
  activeTripHandler,
  getTripHandler,
  liveSnapshotHandler,
  statusHandler,
} from './trips.controller';

/** Passenger/driver-facing trip endpoints. Every lookup is participant-scoped. */
export const tripsRouter: RouterType = Router();

tripsRouter.use(authenticate, requireRole('PASSENGER', 'DRIVER'));
tripsRouter.get('/active', activeTripHandler);
tripsRouter.get('/:id', validateUuidParam('id'), getTripHandler);
tripsRouter.get('/:id/live', validateUuidParam('id'), liveSnapshotHandler);
tripsRouter.post('/:id/arrived', validateUuidParam('id'), statusHandler('arrived'));
tripsRouter.post('/:id/start', validateUuidParam('id'), statusHandler('start'));
tripsRouter.post('/:id/complete', validateUuidParam('id'), statusHandler('complete'));
tripsRouter.post('/:id/cancel', validateUuidParam('id'), statusHandler('cancel'));
