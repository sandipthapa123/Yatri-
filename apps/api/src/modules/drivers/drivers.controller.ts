import type { Request, Response } from 'express';
import type { ApiResponse } from '@yatri/types';

import { HttpError } from '../../middleware/errorHandler';
import { findUserById, updateProfile, type ProfileUpdate } from '../users/users.repository';
import { toPublicProfile, type PublicProfile } from '../users/users.types';
import { findDriverProfileByUserId } from './drivers.repository';
import type { DriverStatus } from './drivers.types';

type DriverProfileResponse = PublicProfile & { driverStatus: DriverStatus };

async function loadDriverProfile(userId: string): Promise<DriverProfileResponse> {
  const [user, driverProfile] = await Promise.all([
    findUserById(userId),
    findDriverProfileByUserId(userId),
  ]);
  if (!user || !driverProfile) throw new HttpError(404, 'NOT_FOUND', 'Driver profile not found.');
  return { ...toPublicProfile(user), driverStatus: driverProfile.status };
}

export async function getDriverMeHandler(
  req: Request,
  res: Response<ApiResponse<DriverProfileResponse>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  res.json({ success: true, data: await loadDriverProfile(req.auth.userId) });
}

export async function updateDriverMeHandler(
  req: Request,
  res: Response<ApiResponse<DriverProfileResponse>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const body = req.body as { fullName?: string; profilePictureUrl?: string | null };

  const update: ProfileUpdate = { fullName: body.fullName };
  if ('profilePictureUrl' in body) update.profilePictureUrl = body.profilePictureUrl;

  const user = await updateProfile(req.auth.userId, update);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'Driver not found.');

  res.json({ success: true, data: await loadDriverProfile(req.auth.userId) });
}
