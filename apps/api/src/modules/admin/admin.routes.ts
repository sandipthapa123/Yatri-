import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { validateQuery } from '../../middleware/validateQuery';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import { listAvailabilityHandler } from '../availability/admin-availability';
import { adminAvailabilityQuerySchema } from '../availability/availability.validators';
import { adminCreateTripHandler, createTripSchema } from '../trips/trips.controller';
import { getMeHandler } from '../users/users.controller';
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
// Stand-in for ride matching (a later phase): lets an admin/test create a trip so live tracking can run.
adminRouter.post('/trips', validateBody(createTripSchema), adminCreateTripHandler);

adminRouter.get(
  '/availability/drivers',
  validateQuery(adminAvailabilityQuerySchema),
  listAvailabilityHandler,
);

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
