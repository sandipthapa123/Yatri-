import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { validateQuery } from '../../middleware/validateQuery';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import { listAvailabilityHandler } from '../availability/admin-availability';
import { adminAvailabilityQuerySchema } from '../availability/availability.validators';
import {
  adminIncidentsQuerySchema,
  adminSosQuerySchema,
  incidentNoteSchema,
  incidentStatusSchema,
  lowRatingsQuerySchema,
  sosAcknowledgeSchema,
  sosResolveSchema,
} from '../safety/safety.validators';
import { adminAdminsRoutes } from './admin-admins.routes';
import { analyticsHandler } from './admin-analytics';
import { adminAuditQuerySchema, listAuditHandler } from './admin-audit';
import { dashboardHandler } from './admin-dashboard';
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
import {
  adminEarningsQuerySchema,
  adminFinanceRangeSchema,
  adminPaymentsQuerySchema,
  earningsHandler,
  financeSummaryHandler,
  paymentsHandler,
} from './admin-finance';
import {
  adminNotificationSummarySchema,
  adminNotificationsQuerySchema,
  listNotificationsHandler,
  notificationSummaryHandler,
} from './admin-notifications';
import { rangeQuerySchema } from './admin-range';
import {
  listCategoriesHandler,
  listSettingsHandler,
  updateCategoryHandler,
  updateSettingHandler,
  updateSettingSchema,
  vehicleCategorySchema,
} from './admin-settings';
import {
  adminUsersQuerySchema,
  listUsersHandler,
  reactivateUserHandler,
  suspendUserHandler,
  userDetailHandler,
  userStatusChangeSchema,
} from './admin-users';
import { adminVehiclesQuerySchema, listVehiclesHandler } from './admin-vehicles';
import { adminMeHandler } from './admin-admins';
import { auditAdminAction, requirePermission } from './permissions';

/**
 * Every admin route names ONE permission (`requirePermission`); holding the ADMIN role opens only
 * `/me`. Anything that changes something sensitive is audited at the route (`auditAdminAction`) with
 * the admin's stated reason. Reads of personal or financial data are audited by their handlers.
 */
export const adminRouter: RouterType = Router();

adminRouter.use(authenticate, requireRole('ADMIN'));

adminRouter.get('/me', adminMeHandler);

// ---- live operations and analytics
adminRouter.get(
  '/dashboard',
  requirePermission('OPERATIONS_VIEW'),
  validateQuery(rangeQuerySchema),
  dashboardHandler,
);
adminRouter.get(
  '/analytics',
  requirePermission('ANALYTICS_VIEW'),
  validateQuery(rangeQuerySchema),
  analyticsHandler,
);
adminRouter.get(
  '/availability/drivers',
  requirePermission('OPERATIONS_VIEW'),
  validateQuery(adminAvailabilityQuerySchema),
  listAvailabilityHandler,
);

// ---- rides and disputes
adminRouter.get(
  '/trips',
  requirePermission('OPERATIONS_VIEW'),
  validateQuery(adminTripsQuerySchema),
  listTripsHandler,
);
adminRouter.get(
  '/trips/:id',
  requirePermission('OPERATIONS_VIEW'),
  validateUuidParam('id'),
  tripDetailHandler,
);
adminRouter.get(
  '/trips/:id/chat',
  requirePermission('TRIP_CHAT_VIEW'),
  validateUuidParam('id'),
  tripChatHandler,
);
adminRouter.post(
  '/trips/:id/cancel',
  requirePermission('RIDES_MANAGE'),
  validateUuidParam('id'),
  validateBody(adminCancelSchema),
  auditAdminAction('TRIP_CANCELLED_BY_ADMIN', 'trip'),
  adminCancelHandler,
);
adminRouter.get(
  '/disputes',
  requirePermission('DISPUTES_MANAGE'),
  validateQuery(adminDisputesQuerySchema),
  listDisputesHandler,
);
adminRouter.post(
  '/disputes/:id/resolve',
  requirePermission('DISPUTES_MANAGE'),
  validateUuidParam('id'),
  validateBody(adminResolveSchema),
  auditAdminAction('DISPUTE_RESOLVED', 'dispute'),
  resolveDisputeHandler,
);

// ---- safety: alerts, incident reports and the signals around them
adminRouter.use(['/sos', '/incidents', '/ratings'], requirePermission('SAFETY_REVIEW'));
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

// ---- users
adminRouter.get(
  '/users',
  requirePermission('USERS_VIEW'),
  validateQuery(adminUsersQuerySchema),
  listUsersHandler,
);
adminRouter.get(
  '/users/:id',
  requirePermission('USERS_VIEW'),
  validateUuidParam('id'),
  userDetailHandler,
);
adminRouter.post(
  '/users/:id/suspend',
  requirePermission('USERS_MANAGE'),
  validateUuidParam('id'),
  validateBody(userStatusChangeSchema),
  suspendUserHandler,
);
adminRouter.post(
  '/users/:id/reactivate',
  requirePermission('USERS_MANAGE'),
  validateUuidParam('id'),
  validateBody(userStatusChangeSchema),
  reactivateUserHandler,
);

// ---- drivers, documents and vehicles (verification)
adminRouter.use(['/drivers', '/documents'], requirePermission('DRIVERS_REVIEW'));
adminRouter.get('/drivers', validateQuery(listDriversQuerySchema), listDriversHandler);
adminRouter.get('/drivers/:id', validateUuidParam('id'), getDriverDetailHandler);
adminRouter.get('/drivers/:id/documents', validateUuidParam('id'), getDriverDocumentsHandler);
adminRouter.get(
  '/drivers/:id/verification-history',
  validateUuidParam('id'),
  getDriverVerificationHistoryHandler,
);
adminRouter.post(
  '/drivers/:id/verify',
  validateUuidParam('id'),
  auditAdminAction('DRIVER_VERIFIED', 'driver'),
  verifyDriverHandler,
);
adminRouter.post(
  '/drivers/:id/reject',
  validateUuidParam('id'),
  validateBody(rejectDriverSchema),
  auditAdminAction('DRIVER_REJECTED', 'driver'),
  rejectDriverHandler,
);
adminRouter.post(
  '/drivers/:id/suspend',
  validateUuidParam('id'),
  validateBody(suspendDriverSchema),
  auditAdminAction('DRIVER_SUSPENDED', 'driver'),
  suspendDriverHandler,
);
adminRouter.get(
  '/documents/:id/download-url',
  validateUuidParam('id'),
  auditAdminAction('VIEW_DOCUMENT', 'document'),
  getDocumentDownloadUrlHandler,
);
adminRouter.post(
  '/documents/:id/approve',
  validateUuidParam('id'),
  auditAdminAction('DOCUMENT_APPROVED', 'document'),
  approveDocumentHandler,
);
adminRouter.post(
  '/documents/:id/reject',
  validateUuidParam('id'),
  validateBody(reviewDocumentRejectSchema),
  auditAdminAction('DOCUMENT_REJECTED', 'document'),
  rejectDocumentHandler,
);
adminRouter.get(
  '/vehicles',
  requirePermission('DRIVERS_REVIEW'),
  validateQuery(adminVehiclesQuerySchema),
  listVehiclesHandler,
);
adminRouter.post(
  '/vehicles/:id/approve',
  requirePermission('DRIVERS_REVIEW'),
  validateUuidParam('id'),
  auditAdminAction('VEHICLE_APPROVED', 'vehicle'),
  approveVehicleHandler,
);
adminRouter.post(
  '/vehicles/:id/reject',
  requirePermission('DRIVERS_REVIEW'),
  validateUuidParam('id'),
  validateBody(reviewDocumentRejectSchema),
  auditAdminAction('VEHICLE_REJECTED', 'vehicle'),
  rejectVehicleHandler,
);

// ---- money (every read is audited by its handler)
adminRouter.get(
  '/finance/summary',
  requirePermission('FINANCE_VIEW'),
  validateQuery(adminFinanceRangeSchema),
  financeSummaryHandler,
);
adminRouter.get(
  '/finance/earnings',
  requirePermission('FINANCE_VIEW'),
  validateQuery(adminEarningsQuerySchema),
  earningsHandler,
);
adminRouter.get(
  '/payments',
  requirePermission('FINANCE_VIEW'),
  validateQuery(adminPaymentsQuerySchema),
  paymentsHandler,
);

// ---- notifications, settings, audit, administrators
adminRouter.get(
  '/notifications/summary',
  requirePermission('NOTIFICATIONS_VIEW'),
  validateQuery(adminNotificationSummarySchema),
  notificationSummaryHandler,
);
adminRouter.get(
  '/notifications',
  requirePermission('NOTIFICATIONS_VIEW'),
  validateQuery(adminNotificationsQuerySchema),
  listNotificationsHandler,
);
adminRouter.get('/settings', requirePermission('SETTINGS_VIEW'), listSettingsHandler);
adminRouter.put(
  '/settings/:key',
  requirePermission('SETTINGS_MANAGE'),
  validateBody(updateSettingSchema),
  updateSettingHandler,
);
adminRouter.get('/vehicle-categories', requirePermission('SETTINGS_VIEW'), listCategoriesHandler);
adminRouter.patch(
  '/vehicle-categories/:id',
  requirePermission('SETTINGS_MANAGE'),
  validateUuidParam('id'),
  validateBody(vehicleCategorySchema),
  updateCategoryHandler,
);
adminRouter.get(
  '/audit',
  requirePermission('AUDIT_VIEW'),
  validateQuery(adminAuditQuerySchema),
  listAuditHandler,
);
adminRouter.use('/admins', requirePermission('ADMINS_MANAGE'), adminAdminsRoutes);
