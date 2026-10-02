import type {
  AdminCampaignBody,
  ApiResponse,
  CampaignAnalytics,
  CampaignInfo,
  CampaignKind,
  CampaignRedemptionRow,
  CampaignStatus,
  GrowthAdjustBody,
  LedgerEntryInfo,
} from '@yatri/types';
import { CAMPAIGN_KINDS, CAMPAIGN_STATUSES } from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query, withTransaction } from '../../lib/db';
import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import { campaignAnalytics, campaignRedemptions } from '../growth/analytics';
import {
  createCampaign,
  getCampaign,
  listCampaigns,
  transitionCampaign,
  updateCampaign,
} from '../growth/campaigns.service';
import { adjustPoints, balanceOf, rewardsHistory } from '../growth/loyalty';
import { rangeFields, resolveRange } from './admin-range';

/** Handlers for the campaign dashboard. Permissions are named on the routes; the rules are in the growth module. */
type Res<T> = Response<ApiResponse<T>>;
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};

export const campaignListQuerySchema = z.object({
  kind: z.enum(CAMPAIGN_KINDS).optional(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
});
export const growthAnalyticsQuerySchema = z.object(rangeFields);
export const adjustSchema = z
  .object({
    points: z.number().int().min(-1_000_000).max(1_000_000),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

export async function listCampaignsHandler(req: Request, res: Res<CampaignInfo[]>) {
  const q = req.validatedQuery as { kind?: CampaignKind; status?: CampaignStatus };
  res.json({ success: true, data: await listCampaigns(q) });
}
export async function getCampaignHandler(req: Request, res: Res<CampaignInfo>) {
  res.json({ success: true, data: await getCampaign(requireParam(req, 'id')) });
}
export async function createCampaignHandler(req: Request, res: Res<CampaignInfo>) {
  res
    .status(201)
    .json({
      success: true,
      data: await createCampaign(req.body as AdminCampaignBody, adminId(req)),
    });
}
export async function updateCampaignHandler(req: Request, res: Res<CampaignInfo>) {
  res.json({
    success: true,
    data: await updateCampaign(
      requireParam(req, 'id'),
      req.body as AdminCampaignBody,
      adminId(req),
    ),
  });
}
export async function campaignStatusHandler(req: Request, res: Res<CampaignInfo>) {
  const b = req.body as { to: CampaignStatus; version: number; reason: string };
  res.json({
    success: true,
    data: await transitionCampaign(
      requireParam(req, 'id'),
      b.to,
      b.version,
      b.reason,
      adminId(req),
    ),
  });
}
export async function campaignRedemptionsHandler(req: Request, res: Res<CampaignRedemptionRow[]>) {
  res.json({ success: true, data: await campaignRedemptions(requireParam(req, 'id')) });
}
export async function growthAnalyticsHandler(req: Request, res: Res<CampaignAnalytics>) {
  const range = await resolveRange(req.query as z.infer<typeof growthAnalyticsQuerySchema>, '30d');
  res.json({ success: true, data: await campaignAnalytics(range) });
}

/** One rider's points and history, for support ("why is my balance this?"). */
export async function userRewardsHandler(
  req: Request,
  res: Res<{ userId: string; name: string | null; balance: number; items: LedgerEntryInfo[] }>,
) {
  const id = requireParam(req, 'id');
  const u = await query<{ full_name: string | null; role: string }>(
    'SELECT full_name, role FROM users WHERE id = $1',
    [id],
  );
  if (!u.rows[0] || u.rows[0].role !== 'PASSENGER')
    throw new HttpError(404, 'NOT_FOUND', 'Rider not found.');
  res.json({
    success: true,
    data: {
      userId: id,
      name: u.rows[0].full_name,
      balance: await balanceOf(id),
      items: (await rewardsHistory(id, null, 50)).items,
    },
  });
}

/** An administrator corrects a rider's points. The reason is kept in the ledger entry and the audit log. */
export async function adjustRewardsHandler(req: Request, res: Res<{ balance: number }>) {
  const id = requireParam(req, 'id');
  const b = req.body as GrowthAdjustBody;
  const u = await query('SELECT 1 FROM users WHERE id = $1 AND role = $2', [id, 'PASSENGER']);
  if (!u.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Rider not found.');
  await withTransaction(async (c) => {
    await adjustPoints(c, {
      userId: id,
      points: b.points,
      reason: b.reason,
      adminId: adminId(req),
    });
    await recordAudit({
      actorId: adminId(req),
      actorRole: 'ADMIN',
      action: 'REWARD_POINTS_ADJUSTED',
      subjectType: 'user',
      subjectIds: [id],
      detail: { points: b.points, reason: b.reason },
    });
  });
  res.json({ success: true, data: { balance: await balanceOf(id) } });
}
