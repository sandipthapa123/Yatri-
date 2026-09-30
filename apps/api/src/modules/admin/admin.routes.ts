import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { userMutationRateLimit } from '../../middleware/rateLimit';
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
import {
  adminAssignSchema,
  adminNoteSchema,
  adminPrioritySchema,
  adminRefundActionSchema,
  adminRefundCreateSchema,
  adminReplySchema,
  adminStatusSchema,
  adminTicketsQuerySchema,
  assigneesHandler,
  attachmentUrlHandler,
  categoryPatchSchema,
  listSupportConfigHandler,
  listTicketsHandler,
  priorityPatchSchema,
  refundActionHandler,
  refundCreateHandler,
  ticketAssignHandler,
  ticketAttachmentHandler,
  ticketDetailHandler,
  ticketNoteHandler,
  ticketPriorityHandler,
  ticketReplyHandler,
  ticketStatusHandler,
  updateSupportCategoryHandler,
  updatePriorityHandler,
} from './admin-support';
import {
  dataRequestActionHandler,
  dataRequestActionSchema,
  dataRequestsQuerySchema,
  listDataRequestsHandler,
  listPoliciesHandler,
  listRetentionHandler,
  publishPolicyHandler,
  publishPolicySchema,
  retentionSchema,
  updateRetentionHandler,
  userRecordsHandler,
} from './admin-compliance';
import { uploadSingleFile } from '../../middleware/upload';
import {
  awardsQuerySchema,
  createIncentiveRuleHandler,
  createPricingRuleHandler,
  createZoneHandler,
  heatmapHandler,
  optionsHandler,
  listAwardsHandler,
  listIncentiveRulesHandler,
  listPricingRulesHandler,
  listZonesHandler,
  updateIncentiveRuleHandler,
  updatePricingRuleHandler,
  updateZoneHandler,
} from './admin-operations';
import { incentiveRuleSchema } from '../operations/incentives.service';
import { pricingRuleSchema } from '../operations/pricing-rules.service';
import { zoneBodySchema } from '../operations/zones.service';
import { adminAdminsRoutes } from './admin-admins.routes';
import { analyticsHandler } from './admin-analytics';
import { adminAuditQuerySchema, listAuditHandler } from './admin-audit';
import { dashboardHandler } from './admin-dashboard';
import {
  adminCancelHandler,
  adminCancelSchema,
  adminTripsQuerySchema,
  listTripsHandler,
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
adminRouter.use(userMutationRateLimit());

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

// ---- rides
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

// ---- support: tickets, ride disputes and refunds
// A ticket route needs DISPUTES_MANAGE at least; tickets that are not ride problems are narrowed to
// SUPPORT_MANAGE in the service. Raising a refund needs SUPPORT_MANAGE; deciding one, REFUNDS_MANAGE.
adminRouter.get(
  '/support/tickets',
  requirePermission('DISPUTES_MANAGE'),
  validateQuery(adminTicketsQuerySchema),
  listTicketsHandler,
);
adminRouter.get('/support/assignees', requirePermission('DISPUTES_MANAGE'), assigneesHandler);
adminRouter.get(
  '/support/tickets/:id',
  requirePermission('DISPUTES_MANAGE'),
  validateUuidParam('id'),
  ticketDetailHandler,
);
adminRouter.post(
  '/support/tickets/:id/reply',
  requirePermission('DISPUTES_MANAGE'),
  validateUuidParam('id'),
  validateBody(adminReplySchema),
  ticketReplyHandler,
);
adminRouter.post(
  '/support/tickets/:id/attachments',
  requirePermission('DISPUTES_MANAGE'),
  validateUuidParam('id'),
  uploadSingleFile,
  ticketAttachmentHandler,
);
adminRouter.post(
  '/support/tickets/:id/notes',
  requirePermission('DISPUTES_MANAGE'),
  validateUuidParam('id'),
  validateBody(adminNoteSchema),
  ticketNoteHandler,
);
adminRouter.post(
  '/support/tickets/:id/status',
  requirePermission('DISPUTES_MANAGE'),
  validateUuidParam('id'),
  validateBody(adminStatusSchema),
  ticketStatusHandler,
);
adminRouter.post(
  '/support/tickets/:id/assign',
  requirePermission('DISPUTES_MANAGE'),
  validateUuidParam('id'),
  validateBody(adminAssignSchema),
  auditAdminAction('TICKET_ASSIGNED', 'ticket'),
  ticketAssignHandler,
);
adminRouter.post(
  '/support/tickets/:id/priority',
  requirePermission('DISPUTES_MANAGE'),
  validateUuidParam('id'),
  validateBody(adminPrioritySchema),
  auditAdminAction('TICKET_PRIORITY_CHANGED', 'ticket'),
  ticketPriorityHandler,
);
adminRouter.post(
  '/support/tickets/:id/refunds',
  requirePermission('SUPPORT_MANAGE'),
  validateUuidParam('id'),
  validateBody(adminRefundCreateSchema),
  refundCreateHandler,
);
adminRouter.post(
  '/support/refunds/:id/action',
  requirePermission('REFUNDS_MANAGE'),
  validateUuidParam('id'),
  validateBody(adminRefundActionSchema),
  refundActionHandler,
);
adminRouter.get(
  '/support/attachments/:id/download-url',
  requirePermission('DISPUTES_MANAGE'),
  validateUuidParam('id'),
  auditAdminAction('VIEW_SUPPORT_ATTACHMENT', 'support_attachment'),
  attachmentUrlHandler,
);
adminRouter.get('/support/config', requirePermission('SETTINGS_VIEW'), listSupportConfigHandler);
adminRouter.patch(
  '/support/categories/:code',
  requirePermission('SETTINGS_MANAGE'),
  validateBody(categoryPatchSchema),
  updateSupportCategoryHandler,
);
adminRouter.patch(
  '/support/priorities/:code',
  requirePermission('SETTINGS_MANAGE'),
  validateBody(priorityPatchSchema),
  updatePriorityHandler,
);

// ---- compliance: policies, data requests, retention
adminRouter.use('/compliance', requirePermission('COMPLIANCE_MANAGE'));
adminRouter.get('/compliance/policies', listPoliciesHandler);
adminRouter.post(
  '/compliance/policies/:key/publish',
  validateBody(publishPolicySchema),
  publishPolicyHandler,
);
adminRouter.get(
  '/compliance/data-requests',
  validateQuery(dataRequestsQuerySchema),
  listDataRequestsHandler,
);
adminRouter.post(
  '/compliance/data-requests/:id/action',
  validateUuidParam('id'),
  validateBody(dataRequestActionSchema),
  dataRequestActionHandler,
);
adminRouter.get('/compliance/retention', listRetentionHandler);
adminRouter.patch(
  '/compliance/retention/:type',
  validateBody(retentionSchema),
  updateRetentionHandler,
);
adminRouter.get('/compliance/users/:id/records', validateUuidParam('id'), userRecordsHandler);

// ---- advanced operations: demand and supply, zones, dynamic pricing, incentives
// Reading needs OPERATIONS_VIEW; every change needs DISPATCH_MANAGE and is audited with its reason.
adminRouter.get('/operations/options', requirePermission('OPERATIONS_VIEW'), optionsHandler);
adminRouter.get('/operations/heatmap', requirePermission('OPERATIONS_VIEW'), heatmapHandler);
adminRouter.get('/operations/zones', requirePermission('OPERATIONS_VIEW'), listZonesHandler);
adminRouter.post(
  '/operations/zones',
  requirePermission('DISPATCH_MANAGE'),
  validateBody(zoneBodySchema),
  createZoneHandler,
);
adminRouter.put(
  '/operations/zones/:id',
  requirePermission('DISPATCH_MANAGE'),
  validateUuidParam('id'),
  validateBody(zoneBodySchema),
  updateZoneHandler,
);
adminRouter.get(
  '/operations/pricing-rules',
  requirePermission('OPERATIONS_VIEW'),
  listPricingRulesHandler,
);
adminRouter.post(
  '/operations/pricing-rules',
  requirePermission('DISPATCH_MANAGE'),
  validateBody(pricingRuleSchema),
  createPricingRuleHandler,
);
adminRouter.put(
  '/operations/pricing-rules/:id',
  requirePermission('DISPATCH_MANAGE'),
  validateUuidParam('id'),
  validateBody(pricingRuleSchema),
  updatePricingRuleHandler,
);
adminRouter.get(
  '/operations/incentive-rules',
  requirePermission('OPERATIONS_VIEW'),
  listIncentiveRulesHandler,
);
adminRouter.post(
  '/operations/incentive-rules',
  requirePermission('DISPATCH_MANAGE'),
  validateBody(incentiveRuleSchema),
  createIncentiveRuleHandler,
);
adminRouter.put(
  '/operations/incentive-rules/:id',
  requirePermission('DISPATCH_MANAGE'),
  validateUuidParam('id'),
  validateBody(incentiveRuleSchema),
  updateIncentiveRuleHandler,
);
adminRouter.get(
  '/operations/incentive-awards',
  requirePermission('OPERATIONS_VIEW'),
  validateQuery(awardsQuerySchema),
  listAwardsHandler,
);
