import { pageParam, pageSizeParam } from '../../lib/pagination';
import {
  ORG_APPROVAL_STATUSES,
  ORG_NAME_MAX,
  ORG_PURPOSE_MAX,
  ORG_REASON_MAX,
  ORG_ROLES,
  ORG_STATEMENT_STATUSES,
  orgRoleHolds,
  type ApiResponse,
  type ChangeMemberBody,
  type CostCenterBody,
  type CreateOrganizationBody,
  type DecideApprovalBody,
  type InviteMemberBody,
  type OrgActivityEntry,
  type OrgApprovalInfo,
  type OrgBookingBody,
  type OrgBookingPreview,
  type OrgBookingResult,
  type OrgCostCenterInfo,
  type OrgInvitationInfo,
  type OrgMemberInfo,
  type OrgPolicy,
  type OrgPolicyView,
  type OrgRideRow,
  type OrgStatementDetail,
  type OrgStatementInfo,
  type OrgUsageReport,
  type OrganizationInfo,
  type UpdateOrganizationBody,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { auditTrail } from '../../lib/audit';
import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import { rangeFields, resolveRange } from '../admin/admin-range';
import { phoneNumberSchema } from '../auth/auth.validators';
import { tripRequestSchema } from '../trips/trips.validators';
import { assertRider, callerId, orgContext } from './access';
import { cancelApproval, decideApproval } from './approvals.service';
import { listApprovals } from './approval-view';
import { bookRide, prepareBooking } from './booking.service';
import { listOrgRides, usageReport } from './history.service';
import {
  answerInvitation,
  changeMember,
  inviteMember,
  listMembers,
  myMemberId,
  removeMember,
} from './members.service';
import {
  createOrganization,
  getOrganization,
  myInvitations,
  myOrganizations,
  updateOrganization,
} from './organizations.service';
import { getPolicyView, listCostCenters, saveCostCenter, updatePolicy } from './policy.service';
import { listStatements, statementDetail } from './statements.service';

/** Thin handlers for the business endpoints. The rules are in the services and in @yatri/types. */
type Res<T> = Response<ApiResponse<T>>;
const uuid = z.string().uuid();
const email = z.string().trim().email().max(200);

export const createOrganizationSchema = z
  .object({
    name: z.string().trim().min(2).max(ORG_NAME_MAX),
    legalName: z.string().trim().max(150).nullish(),
    billingEmail: email.nullish(),
    billingContactName: z.string().trim().max(100).nullish(),
  })
  .strict();
export const inviteSchema = z
  .object({ phoneNumber: phoneNumberSchema, role: z.enum(ORG_ROLES) })
  .strict();
export const changeMemberSchema = z
  .object({ role: z.enum(ORG_ROLES).optional(), defaultCostCenterId: uuid.nullable().optional() })
  .strict()
  .refine(
    (b) => b.role !== undefined || 'defaultCostCenterId' in b,
    'Change a role or a cost centre.',
  );
export const orgBookingSchema = tripRequestSchema.extend({
  passengerId: uuid.optional(),
  costCenterId: uuid.nullish(),
  purpose: z.string().trim().max(ORG_PURPOSE_MAX).nullish(),
});
export const approvalDecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'DECLINE']),
    note: z.string().trim().max(ORG_REASON_MAX).nullish(),
  })
  .strict();
const page = pageParam;
const pageSize = pageSizeParam(100, 20);
export const ridesQuerySchema = z.object({
  status: z.string().trim().max(30).optional(),
  costCenterId: uuid.optional(),
  passengerId: uuid.optional(),
  page,
  pageSize,
});
export const approvalsQuerySchema = z.object({ status: z.enum(ORG_APPROVAL_STATUSES).optional() });
export const reportQuerySchema = z.object(rangeFields);
export const statementsQuerySchema = z.object({
  status: z.enum(ORG_STATEMENT_STATUSES).optional(),
});

const idParam = (req: Request, name: string) => {
  const v = requireParam(req, name);
  if (!uuid.safeParse(v).success)
    throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid identifier.');
  return v;
};

// ------------------------------------------------------------------ organizations and invitations
export async function listMineHandler(req: Request, res: Res<OrganizationInfo[]>) {
  res.json({ success: true, data: await myOrganizations(callerId(req)) });
}
export async function invitationsHandler(req: Request, res: Res<OrgInvitationInfo[]>) {
  res.json({ success: true, data: await myInvitations(callerId(req)) });
}
export async function createOrganizationHandler(req: Request, res: Res<OrganizationInfo>) {
  assertRider(req);
  res.status(201).json({
    success: true,
    data: await createOrganization(callerId(req), req.body as CreateOrganizationBody),
  });
}
export async function answerInvitationHandler(req: Request, res: Res<{ accepted: boolean }>) {
  const accept = req.path.endsWith('/accept');
  await answerInvitation(callerId(req), idParam(req, 'orgId'), accept);
  res.json({ success: true, data: { accepted: accept } });
}
export async function getOrgHandler(req: Request, res: Res<OrganizationInfo>) {
  res.json({ success: true, data: await getOrganization(orgContext(res).orgId, callerId(req)) });
}
export async function updateOrgHandler(req: Request, res: Res<OrganizationInfo>) {
  res.json({
    success: true,
    data: await updateOrganization(
      orgContext(res).orgId,
      callerId(req),
      req.body as UpdateOrganizationBody,
    ),
  });
}
export async function activityHandler(_req: Request, res: Res<OrgActivityEntry[]>) {
  const trail = await auditTrail('organization', orgContext(res).orgId);
  res.json({
    success: true,
    data: trail
      .map((e) => ({ ...e, subjectType: 'organization' }))
      .reverse()
      .slice(0, 200),
  });
}

// ------------------------------------------------------------------ members
export async function listMembersHandler(_req: Request, res: Res<OrgMemberInfo[]>) {
  res.json({ success: true, data: await listMembers(orgContext(res)) });
}
export async function inviteHandler(req: Request, res: Res<{ message: string }>) {
  res.status(202).json({
    success: true,
    data: { message: await inviteMember(orgContext(res), req.body as InviteMemberBody) },
  });
}
export async function changeMemberHandler(req: Request, res: Res<OrgMemberInfo[]>) {
  res.json({
    success: true,
    data: await changeMember(
      orgContext(res),
      idParam(req, 'memberId'),
      req.body as ChangeMemberBody,
    ),
  });
}
export async function removeMemberHandler(req: Request, res: Res<{ removed: true }>) {
  await removeMember(orgContext(res), idParam(req, 'memberId'));
  res.json({ success: true, data: { removed: true } });
}
export async function leaveHandler(_req: Request, res: Res<{ left: true }>) {
  const ctx = orgContext(res);
  await removeMember(ctx, await myMemberId(ctx));
  res.json({ success: true, data: { left: true } });
}

// ------------------------------------------------------------------ policy and cost centres
export async function getPolicyHandler(_req: Request, res: Res<OrgPolicyView>) {
  res.json({ success: true, data: await getPolicyView(orgContext(res).orgId) });
}
export async function updatePolicyHandler(req: Request, res: Res<OrgPolicyView>) {
  res.json({ success: true, data: await updatePolicy(orgContext(res), req.body as OrgPolicy) });
}
export async function listCostCentersHandler(_req: Request, res: Res<OrgCostCenterInfo[]>) {
  res.json({ success: true, data: await listCostCenters(orgContext(res).orgId) });
}
export async function createCostCenterHandler(req: Request, res: Res<OrgCostCenterInfo>) {
  res.status(201).json({
    success: true,
    data: await saveCostCenter(orgContext(res), null, req.body as CostCenterBody),
  });
}
export async function updateCostCenterHandler(req: Request, res: Res<OrgCostCenterInfo>) {
  res.json({
    success: true,
    data: await saveCostCenter(
      orgContext(res),
      idParam(req, 'costCenterId'),
      req.body as CostCenterBody,
    ),
  });
}

// ------------------------------------------------------------------ booking and approvals
export async function bookHandler(req: Request, res: Res<OrgBookingResult>) {
  const r = await bookRide(orgContext(res), req.body as OrgBookingBody);
  res.status(r.outcome === 'REQUESTED' ? 201 : 202).json({ success: true, data: r });
}
export async function previewHandler(req: Request, res: Res<OrgBookingPreview>) {
  const ctx = orgContext(res);
  const body = req.body as OrgBookingBody;
  const passengerId = body.passengerId ?? ctx.userId;
  const forSelf = passengerId === ctx.userId;
  if (!orgRoleHolds(ctx.role, forSelf ? 'RIDES_BOOK_SELF' : 'RIDES_BOOK_FOR_OTHERS')) {
    throw new HttpError(
      403,
      'FORBIDDEN',
      'Your role in this organization does not allow booking this ride.',
    );
  }
  const p = await prepareBooking(ctx.orgId, ctx.userId, ctx.role, body, passengerId);
  res.json({
    success: true,
    data: { outcome: p.decision.outcome, reasons: p.decision.reasons, fareNpr: p.fareNpr },
  });
}
export async function listApprovalsHandler(req: Request, res: Res<OrgApprovalInfo[]>) {
  const q = req.validatedQuery as z.infer<typeof approvalsQuerySchema>;
  res.json({ success: true, data: await listApprovals(orgContext(res), q.status) });
}
export async function decideHandler(req: Request, res: Res<OrgApprovalInfo>) {
  res.json({
    success: true,
    data: await decideApproval(
      orgContext(res),
      idParam(req, 'approvalId'),
      req.body as DecideApprovalBody,
    ),
  });
}
export async function cancelApprovalHandler(req: Request, res: Res<OrgApprovalInfo>) {
  res.json({
    success: true,
    data: await cancelApproval(orgContext(res), idParam(req, 'approvalId')),
  });
}

// ------------------------------------------------------------------ history, reports, statements
export async function ridesHandler(req: Request, res: Res<{ items: OrgRideRow[]; total: number }>) {
  const q = req.validatedQuery as z.infer<typeof ridesQuerySchema>;
  res.json({ success: true, data: await listOrgRides(orgContext(res), q) });
}
export async function usageHandler(req: Request, res: Res<OrgUsageReport>) {
  const q = req.validatedQuery as z.infer<typeof reportQuerySchema>;
  res.json({
    success: true,
    data: await usageReport(orgContext(res), await resolveRange(q, '30d')),
  });
}
export async function statementsHandler(_req: Request, res: Res<OrgStatementInfo[]>) {
  res.json({ success: true, data: await listStatements(orgContext(res).orgId) });
}
export async function statementHandler(req: Request, res: Res<OrgStatementDetail>) {
  res.json({
    success: true,
    data: await statementDetail(idParam(req, 'statementId'), orgContext(res).orgId),
  });
}
