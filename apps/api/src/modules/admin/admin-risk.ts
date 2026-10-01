import {
  RISK_CATEGORIES,
  RISK_EVENT_STATUSES,
  RISK_LEVELS,
  RISK_NOTE_MAX,
  RISK_RULE_CODES,
  type AdminRiskLiftBody,
  type AdminRiskNoteBody,
  type AdminRiskReviewBody,
  type AdminRiskRestrictBody,
  type AdminRiskRuleBody,
  type ApiResponse,
  type AuditEntry,
  type RiskEventInfo,
  type RiskNoteInfo,
  type RiskOverview,
  type RiskRestrictionInfo,
  type RiskRuleInfo,
  type RiskSweepResult,
  type RiskTripDetail,
  type RiskUserDetail,
  type RiskUserRow,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recentAudit } from '../../lib/audit';
import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import { getEvent, listEvents, reviewEvent } from '../risk/events.service';
import {
  addNote,
  listRiskUsers,
  riskOverview,
  tripDetail,
  userDetail,
} from '../risk/investigation.service';
import { applyRestriction, liftRestriction } from '../risk/restriction.service';
import { effectiveRules, updateRule } from '../risk/rules';
import { runRiskSweep } from '../risk/sweep';
import { settingNumber } from '../settings/settings.service';
import { hasPermission } from './permissions';

/** Handlers for the risk workspace. Thin calls into the risk services; permissions are named on the routes. */
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};
type Res<T> = Response<ApiResponse<T>>;

const reason = z.string().trim().min(3).max(300);
const uuid = z.string().uuid();
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);

export const riskEventsQuerySchema = z.object({
  status: z.enum(RISK_EVENT_STATUSES).optional(),
  category: z.enum(RISK_CATEGORIES).optional(),
  ruleCode: z.enum(RISK_RULE_CODES as [string, ...string[]]).optional(),
  userId: uuid.optional(),
  tripId: uuid.optional(),
  page,
  pageSize,
});
export const riskUsersQuerySchema = z.object({
  level: z.enum(RISK_LEVELS).optional(),
  search: z.string().trim().max(100).optional(),
  page,
  pageSize,
});
export const riskHistoryQuerySchema = z.object({ page, pageSize });
export const riskReviewSchema = z.object({ status: z.enum(RISK_EVENT_STATUSES), reason }).strict();
export const riskNoteSchema = z
  .object({
    note: z.string().trim().min(1).max(RISK_NOTE_MAX),
    userId: uuid.nullish(),
    tripId: uuid.nullish(),
    eventId: uuid.nullish(),
  })
  .strict();
export const riskRestrictSchema = z
  .object({ days: z.number().int().min(1).max(90), reason })
  .strict();
export const riskLiftSchema = z.object({ reason }).strict();
export const riskRuleSchema = z
  .object({
    enabled: z.boolean(),
    points: z.number().int().min(0).max(100),
    threshold: z.number().int().min(1).max(1_000_000),
    windowHours: z.number().int().min(1).max(2160),
    reason,
  })
  .strict();

export async function riskOverviewHandler(_req: Request, res: Res<RiskOverview>) {
  res.json({ success: true, data: await riskOverview() });
}
export async function riskEventsHandler(
  req: Request,
  res: Res<{ items: RiskEventInfo[]; total: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof riskEventsQuerySchema>;
  res.json({ success: true, data: await listEvents(q) });
}
export async function riskEventHandler(req: Request, res: Res<RiskEventInfo>) {
  res.json({ success: true, data: await getEvent(requireParam(req, 'id')) });
}
export async function riskReviewHandler(req: Request, res: Res<RiskEventInfo>) {
  const b = req.body as AdminRiskReviewBody;
  res.json({
    success: true,
    data: await reviewEvent(requireParam(req, 'id'), b.status, b.reason, adminId(req)),
  });
}
export async function riskUsersHandler(
  req: Request,
  res: Res<{ items: RiskUserRow[]; total: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof riskUsersQuerySchema>;
  res.json({ success: true, data: await listRiskUsers(q) });
}
export async function riskUserHandler(req: Request, res: Res<RiskUserDetail>) {
  const id = adminId(req);
  const [manageRisk, manageUsers] = await Promise.all([
    hasPermission(id, 'RISK_MANAGE'),
    hasPermission(id, 'USERS_MANAGE'),
  ]);
  res.json({
    success: true,
    data: await userDetail(requireParam(req, 'id'), id, { manageRisk, manageUsers }),
  });
}
export async function riskTripHandler(req: Request, res: Res<RiskTripDetail>) {
  res.json({ success: true, data: await tripDetail(requireParam(req, 'id'), adminId(req)) });
}
export async function riskRestrictHandler(req: Request, res: Res<RiskRestrictionInfo>) {
  const b = req.body as AdminRiskRestrictBody;
  const max = settingNumber('RISK_MAX_RESTRICTION_DAYS');
  if (b.days > max) {
    throw new HttpError(
      400,
      'RESTRICTION_TOO_LONG',
      `A restriction can last at most ${max} days. For longer, suspend the account instead.`,
    );
  }
  res.status(201).json({
    success: true,
    data: await applyRestriction({
      userId: requireParam(req, 'id'),
      hours: b.days * 24,
      reason: b.reason,
      source: 'ADMIN',
      actorId: adminId(req),
    }),
  });
}
export async function riskLiftHandler(req: Request, res: Res<{ lifted: true }>) {
  const b = req.body as AdminRiskLiftBody;
  await liftRestriction(requireParam(req, 'id'), b.reason, adminId(req));
  res.json({ success: true, data: { lifted: true } });
}
export async function riskNoteHandler(req: Request, res: Res<RiskNoteInfo>) {
  const b = req.body as AdminRiskNoteBody;
  res.status(201).json({
    success: true,
    data: await addNote(adminId(req), b, b.note),
  });
}
export async function riskRulesHandler(_req: Request, res: Res<RiskRuleInfo[]>) {
  res.json({ success: true, data: await effectiveRules() });
}
export async function riskRuleHandler(req: Request, res: Res<RiskRuleInfo>) {
  res.json({
    success: true,
    data: await updateRule(requireParam(req, 'code'), req.body as AdminRiskRuleBody, adminId(req)),
  });
}
export async function riskHistoryHandler(
  req: Request,
  res: Res<{
    items: Array<AuditEntry & { subjectType: string; subjectId: string | null }>;
    total: number;
  }>,
) {
  const q = req.validatedQuery as z.infer<typeof riskHistoryQuerySchema>;
  res.json({
    success: true,
    data: await recentAudit(
      ['risk_user', 'risk_trip', 'risk_rule'],
      q.pageSize,
      (q.page - 1) * q.pageSize,
    ),
  });
}
export async function riskSweepHandler(_req: Request, res: Res<RiskSweepResult>) {
  res.json({ success: true, data: await runRiskSweep() });
}
