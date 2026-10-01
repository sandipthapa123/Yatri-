import { Router, type RequestHandler, type Router as RouterType } from 'express';
import type { z } from 'zod';

import { authenticate } from '../../middleware/authenticate';
import { idempotent } from '../../middleware/idempotency';
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
import {
  assignHandler,
  assignSchema,
  completeMaintenanceHandler,
  createFleetHandler,
  createFleetVehicleHandler,
  driverDetailHandler,
  driverFleetHandler,
  driverFleetSchema,
  expiringHandler,
  expiringQuerySchema,
  fleetDetailHandler,
  fleetDriversQuerySchema,
  fleetVehicleSchema,
  fleetVehiclesQuerySchema,
  fleetHistoryHandler,
  fleetHistoryQuerySchema,
  inspectionHandler,
  inspectionSchema,
  lifecycleHandler,
  lifecycleSchema,
  listFleetDriversHandler,
  listFleetsHandler,
  listFleetVehiclesHandler,
  maintenanceCompleteSchema,
  maintenanceStartSchema,
  operationalHandler,
  operationalSchema,
  fleetOptionsHandler,
  runMonitorHandler,
  serviceLogHandler,
  serviceLogSchema,
  serviceRecordsHandler,
  serviceRecordsQuerySchema,
  startMaintenanceHandler,
  unassignHandler,
  unassignSchema,
  updateFleetHandler,
  vehicleDetailHandler,
} from './admin-fleet';
import { fleetBodySchema } from '../fleet/fleets.service';
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
import {
  riskEventHandler,
  riskEventsHandler,
  riskEventsQuerySchema,
  riskHistoryHandler,
  riskHistoryQuerySchema,
  riskLiftHandler,
  riskLiftSchema,
  riskNoteHandler,
  riskNoteSchema,
  riskOverviewHandler,
  riskRestrictHandler,
  riskRestrictSchema,
  riskReviewHandler,
  riskReviewSchema,
  riskRuleHandler,
  riskRuleSchema,
  riskRulesHandler,
  riskSweepHandler,
  riskTripHandler,
  riskUserHandler,
  riskUsersHandler,
  riskUsersQuerySchema,
} from './admin-risk';
import {
  adminOrganizationsQuerySchema,
  adminStatementsQuerySchema,
  issueStatementsHandler,
  issueStatementsSchema,
  listOrganizationsHandler,
  listStatementsHandler,
  markPaidHandler,
  markPaidSchema,
  moveOrganizationHandler,
  organizationDetailHandler,
  organizationMoveSchema,
  adminStatementHandler,
  voidSchema as orgVoidSchema,
  voidStatementHandler,
} from './admin-organizations';
import {
  cityAnalyticsHandler,
  cityAnalyticsQuerySchema,
  cityCategoriesHandler,
  cityDetailHandler,
  cityDocumentsHandler,
  cityHoursHandler,
  cityPaymentsHandler,
  citySettingsHandler,
  cityStatusHandler,
  cityZonesHandler,
  createCityHandler,
  listCitiesHandler,
  updateCityHandler,
} from './admin-cities';
import {
  jobHistoryHandler,
  jobHistoryQuerySchema,
  listJobsHandler,
  runJobHandler,
} from './admin-jobs';
import {
  accessibilityStatsHandler,
  accessibilityStatsQuerySchema,
  decideCapabilityHandler,
  listAttributesHandler,
  pendingReviewsHandler,
  saveAttributeHandler,
  tripAccessibilityHandler,
} from './admin-accessibility';
import { navigationMetricsHandler, navigationMetricsQuerySchema } from './admin-navigation';
import { attributeBodySchema, decisionSchema } from '../accessibility/accessibility.validators';
import {
  cityBodySchema,
  cityCategoriesSchema,
  cityDocumentsSchema,
  cityHoursSchema,
  cityPaymentsSchema,
  citySettingsSchema,
  cityStatusSchema,
  cityZonesSchema,
} from '../cities/cities-admin.service';
import { auditAdminAction, requirePermission } from './permissions';

/**
 * Every admin route names ONE permission (`requirePermission`); holding the ADMIN role opens only
 * `/me`. Anything that changes something sensitive is audited at the route (`auditAdminAction`) with
 * the admin's stated reason. Reads of personal or financial data are audited by their handlers.
 */
export const adminRouter: RouterType = Router();

adminRouter.use(authenticate, requireRole('ADMIN'));
adminRouter.use(userMutationRateLimit());
adminRouter.use(idempotent()); // an admin retry of a refund, decision or edit replays instead of repeating

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

// ---- fleets, vehicles and driver operations
// Reading needs FLEET_VIEW; every change needs FLEET_MANAGE and is audited with its reason.
adminRouter.get('/fleet/options', requirePermission('FLEET_VIEW'), fleetOptionsHandler);
adminRouter.get('/fleet/fleets', requirePermission('FLEET_VIEW'), listFleetsHandler);
adminRouter.get(
  '/fleet/fleets/:id',
  requirePermission('FLEET_VIEW'),
  validateUuidParam('id'),
  fleetDetailHandler,
);
adminRouter.post(
  '/fleet/fleets',
  requirePermission('FLEET_MANAGE'),
  validateBody(fleetBodySchema),
  createFleetHandler,
);
adminRouter.put(
  '/fleet/fleets/:id',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(fleetBodySchema),
  updateFleetHandler,
);
adminRouter.get(
  '/fleet/vehicles',
  requirePermission('FLEET_VIEW'),
  validateQuery(fleetVehiclesQuerySchema),
  listFleetVehiclesHandler,
);
adminRouter.get(
  '/fleet/vehicles/:id',
  requirePermission('FLEET_VIEW'),
  validateUuidParam('id'),
  vehicleDetailHandler,
);
adminRouter.post(
  '/fleet/vehicles',
  requirePermission('FLEET_MANAGE'),
  validateBody(fleetVehicleSchema),
  createFleetVehicleHandler,
);
adminRouter.post(
  '/fleet/vehicles/:id/lifecycle',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(lifecycleSchema),
  lifecycleHandler,
);
adminRouter.post(
  '/fleet/vehicles/:id/assign',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(assignSchema),
  assignHandler,
);
adminRouter.post(
  '/fleet/vehicles/:id/unassign',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(unassignSchema),
  unassignHandler,
);
adminRouter.post(
  '/fleet/vehicles/:id/maintenance',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(maintenanceStartSchema),
  startMaintenanceHandler,
);
adminRouter.post(
  '/fleet/vehicles/:id/inspections',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(inspectionSchema),
  inspectionHandler,
);
adminRouter.post(
  '/fleet/vehicles/:id/services',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(serviceLogSchema),
  serviceLogHandler,
);
adminRouter.post(
  '/fleet/service-records/:id/complete',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(maintenanceCompleteSchema),
  completeMaintenanceHandler,
);
adminRouter.get(
  '/fleet/service-records',
  requirePermission('FLEET_VIEW'),
  validateQuery(serviceRecordsQuerySchema),
  serviceRecordsHandler,
);
adminRouter.get(
  '/fleet/drivers',
  requirePermission('FLEET_VIEW'),
  validateQuery(fleetDriversQuerySchema),
  listFleetDriversHandler,
);
adminRouter.get(
  '/fleet/drivers/:id',
  requirePermission('FLEET_VIEW'),
  validateUuidParam('id'),
  driverDetailHandler,
);
adminRouter.post(
  '/fleet/drivers/:id/operational',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(operationalSchema),
  operationalHandler,
);
adminRouter.post(
  '/fleet/drivers/:id/fleet',
  requirePermission('FLEET_MANAGE'),
  validateUuidParam('id'),
  validateBody(driverFleetSchema),
  driverFleetHandler,
);
adminRouter.get(
  '/fleet/expiring',
  requirePermission('FLEET_VIEW'),
  validateQuery(expiringQuerySchema),
  expiringHandler,
);
adminRouter.get(
  '/fleet/history',
  requirePermission('FLEET_VIEW'),
  validateQuery(fleetHistoryQuerySchema),
  fleetHistoryHandler,
);
adminRouter.post('/fleet/monitor/run', requirePermission('FLEET_MANAGE'), runMonitorHandler);

// Fraud and risk: reading needs RISK_VIEW, every change RISK_MANAGE (and each change is audited by the service).
adminRouter.get('/risk/overview', requirePermission('RISK_VIEW'), riskOverviewHandler);
adminRouter.get(
  '/risk/events',
  requirePermission('RISK_VIEW'),
  validateQuery(riskEventsQuerySchema),
  riskEventsHandler,
);
adminRouter.get(
  '/risk/events/:id',
  requirePermission('RISK_VIEW'),
  validateUuidParam('id'),
  riskEventHandler,
);
adminRouter.post(
  '/risk/events/:id/review',
  requirePermission('RISK_MANAGE'),
  validateUuidParam('id'),
  validateBody(riskReviewSchema),
  riskReviewHandler,
);
adminRouter.get(
  '/risk/users',
  requirePermission('RISK_VIEW'),
  validateQuery(riskUsersQuerySchema),
  riskUsersHandler,
);
adminRouter.get(
  '/risk/users/:id',
  requirePermission('RISK_VIEW'),
  validateUuidParam('id'),
  riskUserHandler,
);
adminRouter.post(
  '/risk/users/:id/restrict',
  requirePermission('RISK_MANAGE'),
  validateUuidParam('id'),
  validateBody(riskRestrictSchema),
  riskRestrictHandler,
);
adminRouter.post(
  '/risk/users/:id/lift',
  requirePermission('RISK_MANAGE'),
  validateUuidParam('id'),
  validateBody(riskLiftSchema),
  riskLiftHandler,
);
adminRouter.get(
  '/risk/trips/:id',
  requirePermission('RISK_VIEW'),
  validateUuidParam('id'),
  riskTripHandler,
);
adminRouter.post(
  '/risk/notes',
  requirePermission('RISK_MANAGE'),
  validateBody(riskNoteSchema),
  riskNoteHandler,
);
adminRouter.get('/risk/rules', requirePermission('RISK_VIEW'), riskRulesHandler);
adminRouter.put(
  '/risk/rules/:code',
  requirePermission('RISK_MANAGE'),
  validateBody(riskRuleSchema),
  riskRuleHandler,
);
adminRouter.get(
  '/risk/history',
  requirePermission('RISK_VIEW'),
  validateQuery(riskHistoryQuerySchema),
  riskHistoryHandler,
);
adminRouter.post('/risk/sweep/run', requirePermission('RISK_MANAGE'), riskSweepHandler);

// Navigation: route and arrival-time figures (counts and percentages, never a place or a track).
adminRouter.get(
  '/navigation/metrics',
  requirePermission('OPERATIONS_VIEW'),
  validateQuery(navigationMetricsQuerySchema),
  navigationMetricsHandler,
);

// Accessibility: reading features, the review queue and counts needs ACCESSIBILITY_VIEW (no rider details); changing
// features and deciding a driver's claim needs ACCESSIBILITY_MANAGE; a ride's protected details need SUPPORT_MANAGE and are audited.
adminRouter.get(
  '/accessibility/stats',
  requirePermission('ACCESSIBILITY_VIEW'),
  validateQuery(accessibilityStatsQuerySchema),
  accessibilityStatsHandler,
);
adminRouter.get(
  '/accessibility/attributes',
  requirePermission('ACCESSIBILITY_VIEW'),
  listAttributesHandler,
);
adminRouter.post(
  '/accessibility/attributes',
  requirePermission('ACCESSIBILITY_MANAGE'),
  validateBody(attributeBodySchema),
  saveAttributeHandler,
);
adminRouter.put(
  '/accessibility/attributes/:code',
  requirePermission('ACCESSIBILITY_MANAGE'),
  validateBody(attributeBodySchema),
  saveAttributeHandler,
);
adminRouter.get(
  '/accessibility/reviews',
  requirePermission('ACCESSIBILITY_VIEW'),
  pendingReviewsHandler,
);
adminRouter.post(
  '/accessibility/reviews/:vehicleId/:code',
  requirePermission('ACCESSIBILITY_MANAGE'),
  validateUuidParam('vehicleId'),
  validateBody(decisionSchema),
  decideCapabilityHandler,
);
adminRouter.get(
  '/trips/:id/accessibility',
  requirePermission('SUPPORT_MANAGE'),
  validateUuidParam('id'),
  tripAccessibilityHandler,
);

// Background jobs: reading needs OPERATIONS_VIEW, running one by hand SETTINGS_MANAGE.
adminRouter.get('/jobs', requirePermission('OPERATIONS_VIEW'), listJobsHandler);
adminRouter.get(
  '/jobs/:name/runs',
  requirePermission('OPERATIONS_VIEW'),
  validateQuery(jobHistoryQuerySchema),
  jobHistoryHandler,
);
adminRouter.post('/jobs/:name/run', requirePermission('SETTINGS_MANAGE'), runJobHandler);

// Cities: reading needs OPERATIONS_VIEW, every change DISPATCH_MANAGE (the same permission as zones and pricing).
adminRouter.get('/cities', requirePermission('OPERATIONS_VIEW'), listCitiesHandler);
adminRouter.post(
  '/cities',
  requirePermission('DISPATCH_MANAGE'),
  validateBody(cityBodySchema),
  createCityHandler,
);
adminRouter.get(
  '/cities/:id',
  requirePermission('OPERATIONS_VIEW'),
  validateUuidParam('id'),
  cityDetailHandler,
);
adminRouter.get(
  '/cities/:id/analytics',
  requirePermission('OPERATIONS_VIEW'),
  validateUuidParam('id'),
  validateQuery(cityAnalyticsQuerySchema),
  cityAnalyticsHandler,
);
const cityEdits: Array<[string, z.ZodType, RequestHandler]> = [
  ['', cityBodySchema, updateCityHandler],
  ['/status', cityStatusSchema, cityStatusHandler],
  ['/hours', cityHoursSchema, cityHoursHandler],
  ['/categories', cityCategoriesSchema, cityCategoriesHandler],
  ['/payments', cityPaymentsSchema, cityPaymentsHandler],
  ['/settings', citySettingsSchema, citySettingsHandler],
  ['/documents', cityDocumentsSchema, cityDocumentsHandler],
  ['/zones', cityZonesSchema, cityZonesHandler],
];
for (const [path, schema, handler] of cityEdits) {
  adminRouter.put(
    `/cities/:id${path}`,
    requirePermission('DISPATCH_MANAGE'),
    validateUuidParam('id'),
    validateBody(schema),
    handler,
  );
}

// Business accounts, from the platform's side: ORGANIZATIONS_VIEW reads, ORGANIZATIONS_MANAGE changes.
adminRouter.get(
  '/organizations',
  requirePermission('ORGANIZATIONS_VIEW'),
  validateQuery(adminOrganizationsQuerySchema),
  listOrganizationsHandler,
);
adminRouter.get(
  '/organizations/statements',
  requirePermission('ORGANIZATIONS_VIEW'),
  validateQuery(adminStatementsQuerySchema),
  listStatementsHandler,
);
adminRouter.post(
  '/organizations/statements/issue',
  requirePermission('ORGANIZATIONS_MANAGE'),
  validateBody(issueStatementsSchema),
  issueStatementsHandler,
);
adminRouter.get(
  '/organizations/statements/:id',
  requirePermission('ORGANIZATIONS_VIEW'),
  validateUuidParam('id'),
  adminStatementHandler,
);
adminRouter.post(
  '/organizations/statements/:id/paid',
  requirePermission('ORGANIZATIONS_MANAGE'),
  validateUuidParam('id'),
  validateBody(markPaidSchema),
  markPaidHandler,
);
adminRouter.post(
  '/organizations/statements/:id/void',
  requirePermission('ORGANIZATIONS_MANAGE'),
  validateUuidParam('id'),
  validateBody(orgVoidSchema),
  voidStatementHandler,
);
adminRouter.get(
  '/organizations/:id',
  requirePermission('ORGANIZATIONS_VIEW'),
  validateUuidParam('id'),
  organizationDetailHandler,
);
adminRouter.post(
  '/organizations/:id/status',
  requirePermission('ORGANIZATIONS_MANAGE'),
  validateUuidParam('id'),
  validateBody(organizationMoveSchema),
  moveOrganizationHandler,
);
