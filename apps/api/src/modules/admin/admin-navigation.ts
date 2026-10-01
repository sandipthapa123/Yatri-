import type { ApiResponse, NavigationMetrics } from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { navigationMetrics } from '../navigation/navigation-admin';
import { rangeFields, resolveRange } from './admin-range';

export const navigationMetricsQuerySchema = z.object(rangeFields);

/** Route and arrival-time figures for operations. Counts and percentages only: no place, track or person. */
export async function navigationMetricsHandler(
  req: Request,
  res: Response<ApiResponse<NavigationMetrics>>,
) {
  const range = await resolveRange(req.query as z.infer<typeof navigationMetricsQuerySchema>, '7d');
  res.json({ success: true, data: await navigationMetrics(range) });
}
