import { Router, type Router as RouterType } from 'express';

import { callsRouter } from '../calls/calls.routes';
import { chatRouter } from '../chat/chat.routes';
import { authenticate } from '../../middleware/authenticate';
import { userRateLimit } from '../../middleware/rateLimit';
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
  listDisputesHandler,
  liveSnapshotHandler,
  offerResponseHandler,
  openDisputeHandler,
  rateHandler,
  requestHandler,
} from './trips.controller';
import {
  cancelSchema,
  disputeSchema,
  eventsQuerySchema,
  historyQuerySchema,
  ratingSchema,
  tripRequestSchema,
} from './trips.validators';

/** Passenger/driver-facing trip endpoints. Every lookup is participant-scoped. */
export const tripsRouter: RouterType = Router();

tripsRouter.use(authenticate, requireRole('PASSENGER', 'DRIVER'));

// Passenger: price a ride, request it.
tripsRouter.post(
  '/estimate',
  requireRole('PASSENGER'),
  userRateLimit('trip-estimate', 30, 60),
  validateBody(tripRequestSchema),
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
tripsRouter.post('/:id/cancel', validateUuidParam('id'), validateBody(cancelSchema), cancelHandler);

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

// Payment (settled by the driver for cash), rating, disputes.
tripsRouter.get('/:id/payment', validateUuidParam('id'), getPaymentHandler);
tripsRouter.post(
  '/:id/payment/confirm',
  requireRole('DRIVER'),
  validateUuidParam('id'),
  confirmPaymentHandler,
);
tripsRouter.post('/:id/rating', validateUuidParam('id'), validateBody(ratingSchema), rateHandler);
tripsRouter.get('/:id/disputes', validateUuidParam('id'), listDisputesHandler);
tripsRouter.post(
  '/:id/disputes',
  validateUuidParam('id'),
  validateBody(disputeSchema),
  openDisputeHandler,
);
