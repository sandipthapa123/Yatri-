import type { Request, Response } from 'express';
import type { ApiResponse, DriverAvailabilityStatus, DriverLocationSample } from '@yatri/types';

import { HttpError } from '../../middleware/errorHandler';
import { getStatus, goOffline, goOnline } from './availability.service';

function driverId(req: Request): string {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
}

export async function getAvailabilityHandler(
  req: Request,
  res: Response<ApiResponse<DriverAvailabilityStatus>>,
) {
  res.json({ success: true, data: await getStatus(driverId(req)) });
}

export async function goOnlineHandler(
  req: Request,
  res: Response<ApiResponse<DriverAvailabilityStatus>>,
) {
  res.json({
    success: true,
    data: await goOnline(driverId(req), req.body as DriverLocationSample),
  });
}

export async function goOfflineHandler(
  req: Request,
  res: Response<ApiResponse<DriverAvailabilityStatus>>,
) {
  res.json({ success: true, data: await goOffline(driverId(req)) });
}
