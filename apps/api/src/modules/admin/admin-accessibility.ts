import type {
  AccessibilityStats,
  AdminAttributeBody,
  AdminCapabilityDecisionBody,
  AdminCapabilityReview,
  AdminTripAccessibility,
  ApiResponse,
  VehicleAttributeInfo,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import {
  accessibilityStats,
  adminTripAccessibility,
  decideCapability,
  listAttributes,
  pendingReviews,
  saveAttribute,
} from '../accessibility/accessibility.service';
import { rangeFields, resolveRange } from './admin-range';
import { recordAdminAccess } from './permissions';

/** Handlers for the accessibility workspace. Permissions are named on the routes; the rules are in the service. */
type Res<T> = Response<ApiResponse<T>>;
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};

export const accessibilityStatsQuerySchema = z.object(rangeFields);

export async function accessibilityStatsHandler(req: Request, res: Res<AccessibilityStats>) {
  const range = await resolveRange(
    req.query as z.infer<typeof accessibilityStatsQuerySchema>,
    '30d',
  );
  res.json({ success: true, data: await accessibilityStats(range) });
}
export async function listAttributesHandler(_req: Request, res: Res<VehicleAttributeInfo[]>) {
  res.json({ success: true, data: await listAttributes() });
}
export async function saveAttributeHandler(req: Request, res: Res<VehicleAttributeInfo>) {
  const body = req.body as AdminAttributeBody;
  // The code in the URL (an edit) wins over any in the body.
  const fromUrl = req.params.code;
  const code = typeof fromUrl === 'string' ? fromUrl : body.code;
  res.json({ success: true, data: await saveAttribute({ ...body, code }, adminId(req)) });
}
export async function pendingReviewsHandler(_req: Request, res: Res<AdminCapabilityReview[]>) {
  res.json({ success: true, data: await pendingReviews() });
}
export async function decideCapabilityHandler(req: Request, res: Res<{ decided: true }>) {
  const body = req.body as AdminCapabilityDecisionBody;
  await decideCapability(
    requireParam(req, 'vehicleId'),
    requireParam(req, 'code'),
    body.decision,
    body.reason,
    adminId(req),
  );
  res.json({ success: true, data: { decided: true } });
}
/** The protected details of a ride, for staff handling a case about it. Every read is audited. */
export async function tripAccessibilityHandler(req: Request, res: Res<AdminTripAccessibility>) {
  const data = await adminTripAccessibility(requireParam(req, 'id'));
  await recordAdminAccess(adminId(req), 'VIEW_TRIP_ACCESSIBILITY', 'trip', [data.tripId]);
  res.json({ success: true, data });
}
