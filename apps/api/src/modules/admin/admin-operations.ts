import { pageParam, pageSizeParam } from '../../lib/pagination';
import type {
  AdminIncentiveRuleBody,
  AdminPricingRuleBody,
  AdminZoneBody,
  ApiResponse,
  HeatmapData,
  IncentiveAwardRow,
  IncentiveRuleInfo,
  PricingRuleInfo,
  ZoneDef,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { HttpError } from '../../middleware/errorHandler';
import { requireParam } from '../../lib/params';
import { buildHeatmap } from '../operations/heatmap';
import {
  createIncentiveRule,
  listAwards,
  listIncentiveRules,
  updateIncentiveRule,
} from '../operations/incentives.service';
import {
  createPricingRule,
  listPricingRules,
  updatePricingRule,
} from '../operations/pricing-rules.service';
import { listActiveCategories } from '../pricing/categories';
import { allZones, createZone, updateZone } from '../operations/zones.service';

/** Handlers for the operations workspace: heatmap, zones, pricing rules, incentives. Thin calls into the services. */
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};
type Res<T> = Response<ApiResponse<T>>;

export const awardsQuerySchema = z.object({
  page: pageParam,
  pageSize: pageSizeParam(50, 20),
});

/** The zones and vehicle categories a rule can be limited to (names only), for the editing forms. */
export async function optionsHandler(
  _req: Request,
  res: Res<{
    zones: Array<{ id: string; name: string; isActive: boolean }>;
    categories: Array<{ id: string; label: string }>;
  }>,
) {
  const [zones, categories] = await Promise.all([allZones(), listActiveCategories()]);
  res.json({
    success: true,
    data: {
      zones: zones.map((z) => ({ id: z.id, name: z.name, isActive: z.isActive })),
      categories: categories.map((c) => ({ id: c.id, label: c.label })),
    },
  });
}

export async function heatmapHandler(_req: Request, res: Res<HeatmapData>) {
  res.json({ success: true, data: await buildHeatmap() });
}
export async function listZonesHandler(_req: Request, res: Res<ZoneDef[]>) {
  res.json({ success: true, data: await allZones() });
}
export async function createZoneHandler(req: Request, res: Res<ZoneDef>) {
  res
    .status(201)
    .json({ success: true, data: await createZone(req.body as AdminZoneBody, adminId(req)) });
}
export async function updateZoneHandler(req: Request, res: Res<ZoneDef>) {
  res.json({
    success: true,
    data: await updateZone(requireParam(req, 'id'), req.body as AdminZoneBody, adminId(req)),
  });
}
export async function listPricingRulesHandler(_req: Request, res: Res<PricingRuleInfo[]>) {
  res.json({ success: true, data: await listPricingRules() });
}
export async function createPricingRuleHandler(req: Request, res: Res<PricingRuleInfo>) {
  res.status(201).json({
    success: true,
    data: await createPricingRule(req.body as AdminPricingRuleBody, adminId(req)),
  });
}
export async function updatePricingRuleHandler(req: Request, res: Res<PricingRuleInfo>) {
  res.json({
    success: true,
    data: await updatePricingRule(
      requireParam(req, 'id'),
      req.body as AdminPricingRuleBody,
      adminId(req),
    ),
  });
}
export async function listIncentiveRulesHandler(_req: Request, res: Res<IncentiveRuleInfo[]>) {
  res.json({ success: true, data: await listIncentiveRules() });
}
export async function createIncentiveRuleHandler(req: Request, res: Res<IncentiveRuleInfo>) {
  res.status(201).json({
    success: true,
    data: await createIncentiveRule(req.body as AdminIncentiveRuleBody, adminId(req)),
  });
}
export async function updateIncentiveRuleHandler(req: Request, res: Res<IncentiveRuleInfo>) {
  res.json({
    success: true,
    data: await updateIncentiveRule(
      requireParam(req, 'id'),
      req.body as AdminIncentiveRuleBody,
      adminId(req),
    ),
  });
}
export async function listAwardsHandler(
  req: Request,
  res: Res<{ items: IncentiveAwardRow[]; total: number; totalAwardedNpr: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof awardsQuerySchema>;
  res.json({ success: true, data: await listAwards(q.page, q.pageSize) });
}
