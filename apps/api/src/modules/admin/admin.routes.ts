import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { validateQuery } from '../../middleware/validateQuery';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import { listAvailabilityHandler } from '../availability/admin-availability';
import { adminAvailabilityQuerySchema } from '../availability/availability.validators';
import {
  adminCancelHandler,
  adminCancelSchema,
  adminDisputesQuerySchema,
  adminResolveSchema,
  adminTripsQuerySchema,
  listDisputesHandler,
  listTripsHandler,
  resolveDisputeHandler,
  tripChatHandler,
  tripDetailHandler,
} from './admin-trips';
import {
  adminIncidentsQuerySchema,
  adminSosQuerySchema,
  incidentNoteSchema,
  incidentStatusSchema,
  lowRatingsQuerySchema,
  sosAcknowledgeSchema,
  sosResolveSchema,
} from '../safety/safety.validators';
import { getMeHandler } from '../users/users.controller';
import {
  acknowledgeSosHandler,
  incidentDetailHandler,
  incidentNoteHandler,
  incidentStatusHandler,
  listIncidentsHandler,
  listSosHandler,
  lowRatingsHandler,
  resolveSosHandler,
  sosDetailHandler,
} from './admin-safety';
import {
  approveDocumentHandler,
  approveVehicleHandler,
  getDocumentDownloadUrlHandler,
  rejectDocumentHandler,
  rejectVehicleHandler,
} from './admin-documents.controller';
import {
  getDriverDetailHandler,
  getDriverDocumentsHandler,
  getDriverVerificationHistoryHandler,
  listDriversHandler,
  rejectDriverHandler,
  suspendDriverHandler,
  verifyDriverHandler,
} from './admin-drivers.controller';
import {
  listDriversQuerySchema,
  rejectDriverSchema,
  reviewDocumentRejectSchema,
  suspendDriverSchema,
} from './admin-drivers.validators';

export const adminRouter: RouterType = Router();

adminRouter.use(authenticate, requireRole('ADMIN'));

adminRouter.get('/me', getMeHandler);

adminRouter.get(
  '/availability/drivers',
  validateQuery(adminAvailabilityQuerySchema),
  listAvailabilityHandler,
);

adminRouter.get('/trips', validateQuery(adminTripsQuerySchema), listTripsHandler);
adminRouter.get('/trips/:id', validateUuidParam('id'), tripDetailHandler);
adminRouter.get('/trips/:id/chat', validateUuidParam('id'), tripChatHandler);
adminRouter.post(
  '/trips/:id/cancel',
  validateUuidParam('id'),
  validateBody(adminCancelSchema),
  adminCancelHandler,
);
adminRouter.get('/disputes', validateQuery(adminDisputesQuerySchema), listDisputesHandler);
adminRouter.post(
  '/disputes/:id/resolve',
  validateUuidParam('id'),
  validateBody(adminResolveSchema),
  resolveDisputeHandler,
);

// Safety: alerts, incident reports and the signals around them (all need SAFETY_REVIEW).
adminRouter.get('/sos', validateQuery(adminSosQuerySchema), listSosHandler);
adminRouter.get('/sos/:id', validateUuidParam('id'), sosDetailHandler);
adminRouter.post(
  '/sos/:id/acknowledge',
  validateUuidParam('id'),
  validateBody(sosAcknowledgeSchema),
  acknowledgeSosHandler,
);
adminRouter.post(
  '/sos/:id/resolve',
  validateUuidParam('id'),
  validateBody(sosResolveSchema),
  resolveSosHandler,
);
adminRouter.get('/incidents', validateQuery(adminIncidentsQuerySchema), listIncidentsHandler);
adminRouter.get('/incidents/:id', validateUuidParam('id'), incidentDetailHandler);
adminRouter.post(
  '/incidents/:id/status',
  validateUuidParam('id'),
  validateBody(incidentStatusSchema),
  incidentStatusHandler,
);
adminRouter.post(
  '/incidents/:id/notes',
  validateUuidParam('id'),
  validateBody(incidentNoteSchema),
  incidentNoteHandler,
);
adminRouter.get('/ratings/low', validateQuery(lowRatingsQuerySchema), lowRatingsHandler);

adminRouter.get('/drivers', validateQuery(listDriversQuerySchema), listDriversHandler);
adminRouter.get('/drivers/:id', validateUuidParam('id'), getDriverDetailHandler);
adminRouter.get('/drivers/:id/documents', validateUuidParam('id'), getDriverDocumentsHandler);
adminRouter.get(
  '/drivers/:id/verification-history',
  validateUuidParam('id'),
  getDriverVerificationHistoryHandler,
);
adminRouter.post('/drivers/:id/verify', validateUuidParam('id'), verifyDriverHandler);
adminRouter.post(
  '/drivers/:id/reject',
  validateUuidParam('id'),
  validateBody(rejectDriverSchema),
  rejectDriverHandler,
);
adminRouter.post(
  '/drivers/:id/suspend',
  validateUuidParam('id'),
  validateBody(suspendDriverSchema),
  suspendDriverHandler,
);

adminRouter.get(
  '/documents/:id/download-url',
  validateUuidParam('id'),
  getDocumentDownloadUrlHandler,
);
adminRouter.post('/documents/:id/approve', validateUuidParam('id'), approveDocumentHandler);
adminRouter.post(
  '/documents/:id/reject',
  validateUuidParam('id'),
  validateBody(reviewDocumentRejectSchema),
  rejectDocumentHandler,
);

adminRouter.post('/vehicles/:id/approve', validateUuidParam('id'), approveVehicleHandler);
adminRouter.post(
  '/vehicles/:id/reject',
  validateUuidParam('id'),
  validateBody(reviewDocumentRejectSchema),
  rejectVehicleHandler,
);
