import { Router, type Router as RouterType } from 'express';

import { authenticate } from '../../middleware/authenticate';
import { userMutationRateLimit, userRateLimit } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/requireRole';
import { validateBody } from '../../middleware/validate';
import { validateQuery } from '../../middleware/validateQuery';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import { requireOrgPermission } from './access';
import {
  activityHandler,
  answerInvitationHandler,
  approvalsQuerySchema,
  bookHandler,
  cancelApprovalHandler,
  changeMemberHandler,
  changeMemberSchema,
  createCostCenterHandler,
  createOrganizationHandler,
  createOrganizationSchema,
  decideHandler,
  decisionSchema,
  getOrgHandler,
  getPolicyHandler,
  inviteHandler,
  inviteSchema,
  invitationsHandler,
  leaveHandler,
  listApprovalsHandler,
  listCostCentersHandler,
  listMembersHandler,
  listMineHandler,
  orgBookingSchema,
  previewHandler,
  removeMemberHandler,
  reportQuerySchema,
  ridesHandler,
  ridesQuerySchema,
  statementHandler,
  statementsHandler,
  updateCostCenterHandler,
  updateOrgHandler,
  updatePolicyHandler,
  usageHandler,
} from './organizations.handlers';
import { costCenterSchema, policySchema } from './policy.service';

/**
 * Business endpoints, for rider accounts acting through an organization membership. Platform roles say who may
 * use the app; the ORGANIZATION role (read on every request) says what they may do for each organization, and
 * every route names the one organization permission it needs (or none: any active member).
 */
export const organizationsRouter: RouterType = Router();

organizationsRouter.use(authenticate, requireRole('PASSENGER'));
organizationsRouter.use(userMutationRateLimit());

organizationsRouter.get('/', listMineHandler);
organizationsRouter.post(
  '/',
  userRateLimit('org-create', 5, 3600),
  validateBody(createOrganizationSchema),
  createOrganizationHandler,
);
organizationsRouter.get('/invitations', invitationsHandler);
organizationsRouter.post(
  '/invitations/:orgId/accept',
  validateUuidParam('orgId'),
  answerInvitationHandler,
);
organizationsRouter.post(
  '/invitations/:orgId/decline',
  validateUuidParam('orgId'),
  answerInvitationHandler,
);

const org = '/:orgId';
organizationsRouter.use(org, validateUuidParam('orgId'));
organizationsRouter.get(org, requireOrgPermission(null), getOrgHandler);
organizationsRouter.put(
  org,
  requireOrgPermission('ORG_MANAGE'),
  validateBody(createOrganizationSchema),
  updateOrgHandler,
);
organizationsRouter.get(`${org}/activity`, requireOrgPermission('ORG_MANAGE'), activityHandler);

organizationsRouter.get(`${org}/members`, requireOrgPermission(null), listMembersHandler);
organizationsRouter.post(
  `${org}/members`,
  requireOrgPermission('MEMBERS_MANAGE'),
  userRateLimit('org-invite', 30, 3600),
  validateBody(inviteSchema),
  inviteHandler,
);
organizationsRouter.patch(
  `${org}/members/:memberId`,
  requireOrgPermission('MEMBERS_MANAGE'),
  validateBody(changeMemberSchema),
  changeMemberHandler,
);
organizationsRouter.delete(
  `${org}/members/:memberId`,
  requireOrgPermission('MEMBERS_MANAGE'),
  removeMemberHandler,
);
organizationsRouter.post(`${org}/leave`, requireOrgPermission(null), leaveHandler);

organizationsRouter.get(`${org}/policy`, requireOrgPermission(null), getPolicyHandler);
organizationsRouter.put(
  `${org}/policy`,
  requireOrgPermission('ORG_MANAGE'),
  validateBody(policySchema),
  updatePolicyHandler,
);
organizationsRouter.get(`${org}/cost-centers`, requireOrgPermission(null), listCostCentersHandler);
organizationsRouter.post(
  `${org}/cost-centers`,
  requireOrgPermission('ORG_MANAGE'),
  validateBody(costCenterSchema),
  createCostCenterHandler,
);
organizationsRouter.put(
  `${org}/cost-centers/:costCenterId`,
  requireOrgPermission('ORG_MANAGE'),
  validateBody(costCenterSchema),
  updateCostCenterHandler,
);

// Booking checks the booking permission itself (self or for others), because which one depends on the body.
organizationsRouter.post(
  `${org}/bookings`,
  requireOrgPermission(null),
  userRateLimit('org-booking', 20, 60),
  validateBody(orgBookingSchema),
  bookHandler,
);
organizationsRouter.post(
  `${org}/bookings/preview`,
  requireOrgPermission(null),
  userRateLimit('org-booking-preview', 60, 60),
  validateBody(orgBookingSchema),
  previewHandler,
);
organizationsRouter.get(
  `${org}/approvals`,
  requireOrgPermission(null),
  validateQuery(approvalsQuerySchema),
  listApprovalsHandler,
);
organizationsRouter.post(
  `${org}/approvals/:approvalId/decision`,
  requireOrgPermission('RIDES_APPROVE'),
  validateUuidParam('approvalId'),
  validateBody(decisionSchema),
  decideHandler,
);
organizationsRouter.post(
  `${org}/approvals/:approvalId/cancel`,
  requireOrgPermission(null),
  validateUuidParam('approvalId'),
  cancelApprovalHandler,
);

organizationsRouter.get(
  `${org}/rides`,
  requireOrgPermission(null),
  validateQuery(ridesQuerySchema),
  ridesHandler,
);
organizationsRouter.get(
  `${org}/reports/usage`,
  requireOrgPermission('REPORTS_VIEW'),
  validateQuery(reportQuerySchema),
  usageHandler,
);
organizationsRouter.get(
  `${org}/statements`,
  requireOrgPermission('BILLING_VIEW'),
  statementsHandler,
);
organizationsRouter.get(
  `${org}/statements/:statementId`,
  requireOrgPermission('BILLING_VIEW'),
  validateUuidParam('statementId'),
  statementHandler,
);
