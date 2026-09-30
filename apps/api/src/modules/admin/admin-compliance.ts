import {
  DATA_REQUEST_KINDS,
  DATA_REQUEST_STATES,
  RETENTION_RECORD_TYPES,
  type AdminDataRequestRow,
  type ApiResponse,
  type ComplianceRecordInfo,
  type DataRequestInfo,
  type PolicyInfo,
  type RetentionPolicyInfo,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { HttpError } from '../../middleware/errorHandler';
import { requireParam } from '../../lib/params';
import { listPolicies, myComplianceRecords, publishPolicy } from '../compliance/compliance.service';
import { actOnDataRequest, listAdminDataRequests } from '../compliance/data-requests.service';
import { listRetentionPolicies, updateRetention } from '../compliance/retention.service';

/** Handlers for the compliance workspace: policies, the data-request queue and retention rules. */
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};
type Res<T> = Response<ApiResponse<T>>;

export const publishPolicySchema = z
  .object({
    version: z.string().trim().min(1).max(40),
    title: z.string().trim().min(2).max(100).optional(),
    contentUrl: z.string().trim().url().max(500).nullable().optional(),
    effectiveAt: z.string().datetime().optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export const dataRequestsQuerySchema = z.object({
  status: z.enum(DATA_REQUEST_STATES).optional(),
  kind: z.enum(DATA_REQUEST_KINDS).optional(),
  open: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export const dataRequestActionSchema = z
  .object({
    to: z.enum(DATA_REQUEST_STATES),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export const retentionSchema = z
  .object({
    retainDays: z.number().int().min(1).max(36500),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export const retentionTypeSchema = z.enum(RETENTION_RECORD_TYPES);

export async function listPoliciesHandler(_req: Request, res: Res<PolicyInfo[]>) {
  res.json({ success: true, data: await listPolicies() });
}
export async function publishPolicyHandler(req: Request, res: Res<PolicyInfo>) {
  res.json({
    success: true,
    data: await publishPolicy(
      requireParam(req, 'key'),
      req.body as z.infer<typeof publishPolicySchema>,
      adminId(req),
    ),
  });
}
export async function listDataRequestsHandler(
  req: Request,
  res: Res<{ items: AdminDataRequestRow[]; total: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof dataRequestsQuerySchema>;
  res.json({ success: true, data: await listAdminDataRequests(q) });
}
export async function dataRequestActionHandler(req: Request, res: Res<DataRequestInfo>) {
  res.json({
    success: true,
    data: await actOnDataRequest(
      adminId(req),
      requireParam(req, 'id'),
      req.body as z.infer<typeof dataRequestActionSchema>,
    ),
  });
}
export async function listRetentionHandler(_req: Request, res: Res<RetentionPolicyInfo[]>) {
  res.json({ success: true, data: await listRetentionPolicies() });
}
export async function updateRetentionHandler(req: Request, res: Res<RetentionPolicyInfo>) {
  const type = retentionTypeSchema.safeParse(requireParam(req, 'type'));
  if (!type.success) throw new HttpError(404, 'NOT_FOUND', 'Retention rule not found.');
  res.json({
    success: true,
    data: await updateRetention(
      type.data,
      req.body as z.infer<typeof retentionSchema>,
      adminId(req),
    ),
  });
}
/** A person's acceptance history, for answering "what did this person agree to?" (every read is recorded). */
export async function userRecordsHandler(req: Request, res: Res<ComplianceRecordInfo[]>) {
  const id = requireParam(req, 'id');
  await recordAudit({
    actorId: adminId(req),
    actorRole: 'ADMIN',
    action: 'VIEW_COMPLIANCE_RECORDS',
    subjectType: 'user',
    subjectIds: [id],
  });
  res.json({ success: true, data: await myComplianceRecords(id) });
}
