import { Router, type Router as RouterType } from 'express';

import { callsRouter } from '../calls/calls.routes';
import {
  cancelSosHandler,
  createIncidentHandler,
  myIncidentsHandler,
  mySosHandler,
  triggerSosHandler,
} from '../safety/safety.controller';
import { incidentSchema, sosBodySchema } from '../safety/safety.validators';
import {
  createShareHandler,
  listSharesHandler,
  stopShareHandler,
} from '../sharing/sharing.controller';
import { chatRouter } from '../chat/chat.routes';
import { authenticate } from '../../middleware/authenticate';
import { idempotent } from '../../middleware/idempotency';
import { userRateLimit, userMutationRateLimit } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { validateQuery } from '../../middleware/validateQuery';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import {
  activeTripHandler,
  cancelHandler,
  confirmPaymentHandler,
  currentOfferHandler,
  driverAction,
  estimateHandler,
  eventsHandler,
  getPaymentHandler,
  getTripHandler,
  historyHandler,
  liveSnapshotHandler,
  offerResponseHandler,
  rateHandler,
  requestHandler,
} from './trips.controller';
import {
  cancelSchema,
  eventsQuerySchema,
  historyQuerySchema,
  ratingSchema,
  tripEstimateSchema,
  tripRequestSchema,
} from './trips.validators';

/** Passenger/driver-facing trip endpoints. Every lookup is participant-scoped. */
export const tripsRouter: RouterType = Router();

tripsRouter.use(authenticate, requireRole('PASSENGER', 'DRIVER'));
tripsRouter.use(userMutationRateLimit());
// Every mutating trip action honours an optional Idempotency-Key (see middleware/idempotency.ts).
tripsRouter.use(idempotent());

// Passenger: price a ride, request it.
tripsRouter.post(
  '/estimate',
  requireRole('PASSENGER'),
  userRateLimit('trip-estimate', 30, 60),
  validateBody(tripEstimateSchema),
  estimateHandler,
);
tripsRouter.post(
  '/request',
  requireRole('PASSENGER'),
  userRateLimit('trip-request', 10, 60),
  validateBody(tripRequestSchema),
  requestHandler,
);

// Driver: the dispatcher's offers.
tripsRouter.get('/offers/current', requireRole('DRIVER'), currentOfferHandler);
tripsRouter.post(
  '/offers/:offerId/accept',
  requireRole('DRIVER'),
  validateUuidParam('offerId'),
  offerResponseHandler(true),
);
tripsRouter.post(
  '/offers/:offerId/decline',
  requireRole('DRIVER'),
  validateUuidParam('offerId'),
  offerResponseHandler(false),
);

// Passenger: share this ride with a trusted contact (link creation is rate limited and audited by events).
tripsRouter.post(
  '/:id/shares',
  requireRole('PASSENGER'),
  userRateLimit('trip-share', 10, 3600),
  validateUuidParam('id'),
  createShareHandler,
);
tripsRouter.get(
  '/:id/shares',
  requireRole('PASSENGER'),
  validateUuidParam('id'),
  listSharesHandler,
);
tripsRouter.delete(
  '/:id/shares/:shareId',
  requireRole('PASSENGER'),
  validateUuidParam('id'),
  validateUuidParam('shareId'),
  stopShareHandler,
);

// Safety, for the two people on the ride: an emergency alert (never announced to the other person)
// and a report about the ride.
tripsRouter.post(
  '/:id/sos',
  userRateLimit('sos', 10, 600),
  validateUuidParam('id'),
  validateBody(sosBodySchema),
  triggerSosHandler,
);
tripsRouter.get('/:id/sos', validateUuidParam('id'), mySosHandler);
tripsRouter.post('/:id/sos/cancel', validateUuidParam('id'), cancelSosHandler);
tripsRouter.post(
  '/:id/incidents',
  userRateLimit('incident', 10, 3600),
  validateUuidParam('id'),
  validateBody(incidentSchema),
  createIncidentHandler,
);
tripsRouter.get('/:id/incidents', validateUuidParam('id'), myIncidentsHandler);

// Everyone in a trip.
tripsRouter.get('/active', activeTripHandler);
tripsRouter.get('/history', validateQuery(historyQuerySchema), historyHandler);
tripsRouter.get('/:id', validateUuidParam('id'), getTripHandler);
tripsRouter.get('/:id/live', validateUuidParam('id'), liveSnapshotHandler);
tripsRouter.get(
  '/:id/events',
  validateUuidParam('id'),
  validateQuery(eventsQuerySchema),
  eventsHandler,
);
tripsRouter.post(
  '/:id/cancel',
  userRateLimit('trip-cancel', 20, 3600),
  validateUuidParam('id'),
  validateBody(cancelSchema),
  cancelHandler,
);

// Driver-only lifecycle steps.
for (const [path, action] of [
  ['arrived', 'arrived'],
  ['start', 'start'],
  ['complete', 'complete'],
  ['no-show', 'no-show'],
] as const) {
  tripsRouter.post(
    `/:id/${path}`,
    requireRole('DRIVER'),
    validateUuidParam('id'),
    driverAction(action),
  );
}

// Chat and call control share the trip they belong to.
tripsRouter.use('/:id/chat', validateUuidParam('id'), chatRouter);
tripsRouter.use('/:id/calls', validateUuidParam('id'), callsRouter);

// Payment (settled by the driver for cash) and rating. Ride problems are support tickets (/support).
tripsRouter.get('/:id/payment', validateUuidParam('id'), getPaymentHandler);
tripsRouter.post(
  '/:id/payment/confirm',
  requireRole('DRIVER'),
  userRateLimit('payment-confirm', 60, 3600),
  validateUuidParam('id'),
  confirmPaymentHandler,
);
tripsRouter.post(
  '/:id/rating',
  userRateLimit('trip-rating', 30, 3600),
  validateUuidParam('id'),
  validateBody(ratingSchema),
  rateHandler,
);
