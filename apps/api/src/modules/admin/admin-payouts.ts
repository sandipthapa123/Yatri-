import { pageSizeParam } from '../../lib/pagination';
import {
  PAYOUT_STATUSES,
  type AdminPayoutAccountReveal,
  type AdminPayoutDetail,
  type AdminPayoutList,
  type AdminPayoutRow,
  type ApiResponse,
  type PayoutInfo,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import {
  actOnPayout,
  adminDetail,
  adminList,
  prepareAll,
  prepareForDriver,
  revealAccount,
} from '../payouts/payouts.service';

/**
 * Handlers for the payouts screens. Seeing payouts needs PAYOUTS_VIEW; preparing one, seeing the account to pay and recording a
 * step need PAYOUTS_MANAGE (named on the routes). The rules are in the payouts module.
 */
type Res<T> = Response<ApiResponse<T>>;
const adminId = (req: Request): string => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};

export const payoutListQuerySchema = z.object({
  status: z.enum(PAYOUT_STATUSES).optional(),
  limit: pageSizeParam(100, 25),
  offset: z.coerce.number().int().min(0).default(0),
});
export const payoutPrepareSchema = z.object({ driverId: z.string().uuid().optional() }).strict();
export const payoutActionSchema = z
  .object({
    to: z.enum(PAYOUT_STATUSES),
    reference: z.string().trim().min(3).max(100).optional(),
    failedReason: z.string().trim().min(3).max(300).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();

export async function listPayoutsHandler(req: Request, res: Res<AdminPayoutList>) {
  const q = req.validatedQuery as z.infer<typeof payoutListQuerySchema>;
  res.json({ success: true, data: await adminList(q) });
}
export async function getPayoutHandler(req: Request, res: Res<AdminPayoutDetail>) {
  res.json({ success: true, data: await adminDetail(requireParam(req, 'id')) });
}
export async function payoutAccountHandler(req: Request, res: Res<AdminPayoutAccountReveal>) {
  res.json({ success: true, data: await revealAccount(adminId(req), requireParam(req, 'id')) });
}
export async function preparePayoutsHandler(
  req: Request,
  res: Res<{ prepared: number; skipped: number; totalNpr: number } | PayoutInfo>,
) {
  const body = req.body as z.infer<typeof payoutPrepareSchema>;
  const id = adminId(req);
  res.status(201).json({
    success: true,
    data: body.driverId ? await prepareForDriver(id, body.driverId) : await prepareAll(id),
  });
}
export async function payoutActionHandler(req: Request, res: Res<AdminPayoutRow>) {
  res.json({
    success: true,
    data: await actOnPayout(
      adminId(req),
      requireParam(req, 'id'),
      req.body as z.infer<typeof payoutActionSchema>,
    ),
  });
}
