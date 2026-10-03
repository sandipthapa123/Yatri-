import { pageParam, pageSizeParam } from '../../lib/pagination';
import {
  ORG_REASON_MAX,
  ORG_STATEMENT_STATUSES,
  ORG_STATUSES,
  isStatementPeriod,
  type AdminMarkStatementPaidBody,
  type AdminOrganizationDetail,
  type AdminOrganizationRow,
  type AdminStatementRow,
  type AdminStatementRunResult,
  type ApiResponse,
  type OrgStatementDetail,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import {
  moveOrganization,
  listOrganizations,
  organizationDetail,
} from '../organizations/platform.service';
import {
  adminListStatements,
  issueStatements,
  markStatementPaid,
  statementDetail,
  voidStatement,
} from '../organizations/statements.service';

/** Handlers for the platform's organizations workspace. Thin calls; permissions are named on the routes. */
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};
type Res<T> = Response<ApiResponse<T>>;

const reason = z.string().trim().min(3).max(ORG_REASON_MAX);
const page = pageParam;
const pageSize = pageSizeParam(100, 20);

export const adminOrganizationsQuerySchema = z.object({
  status: z.enum(ORG_STATUSES).optional(),
  search: z.string().trim().max(100).optional(),
  page,
  pageSize,
});
export const adminStatementsQuerySchema = z.object({
  status: z.enum(ORG_STATEMENT_STATUSES).optional(),
  organizationId: z.string().uuid().optional(),
  page,
  pageSize,
});
export const organizationMoveSchema = z.object({ to: z.enum(ORG_STATUSES), reason }).strict();
export const issueStatementsSchema = z
  .object({
    periodKey: z.string().refine(isStatementPeriod, 'Use a month like 2026-09.').optional(),
  })
  .strict();
export const markPaidSchema = z
  .object({
    receivedNpr: z.number().int().min(0).max(1_000_000_000),
    reference: z.string().trim().min(2).max(100),
  })
  .strict();
export const voidSchema = z.object({ reason }).strict();

export async function listOrganizationsHandler(
  req: Request,
  res: Res<{ items: AdminOrganizationRow[]; total: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof adminOrganizationsQuerySchema>;
  res.json({ success: true, data: await listOrganizations(q) });
}
export async function organizationDetailHandler(req: Request, res: Res<AdminOrganizationDetail>) {
  res.json({
    success: true,
    data: await organizationDetail(requireParam(req, 'id'), adminId(req)),
  });
}
export async function moveOrganizationHandler(req: Request, res: Res<AdminOrganizationDetail>) {
  const b = req.body as { to: 'ACTIVE' | 'SUSPENDED'; reason: string };
  await moveOrganization(requireParam(req, 'id'), adminId(req), b.to, b.reason);
  res.json({
    success: true,
    data: await organizationDetail(requireParam(req, 'id'), adminId(req)),
  });
}
export async function listStatementsHandler(
  req: Request,
  res: Res<{ items: AdminStatementRow[]; total: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof adminStatementsQuerySchema>;
  res.json({ success: true, data: await adminListStatements(q) });
}
export async function adminStatementHandler(req: Request, res: Res<OrgStatementDetail>) {
  res.json({ success: true, data: await statementDetail(requireParam(req, 'id')) });
}
export async function issueStatementsHandler(req: Request, res: Res<AdminStatementRunResult>) {
  const b = req.body as { periodKey?: string };
  res.json({ success: true, data: await issueStatements(b.periodKey, adminId(req)) });
}
export async function markPaidHandler(req: Request, res: Res<OrgStatementDetail>) {
  const b = req.body as AdminMarkStatementPaidBody;
  res.json({
    success: true,
    data: await markStatementPaid(
      requireParam(req, 'id'),
      adminId(req),
      b.receivedNpr,
      b.reference,
    ),
  });
}
export async function voidStatementHandler(req: Request, res: Res<OrgStatementDetail>) {
  const b = req.body as { reason: string };
  res.json({
    success: true,
    data: await voidStatement(requireParam(req, 'id'), adminId(req), b.reason),
  });
}
