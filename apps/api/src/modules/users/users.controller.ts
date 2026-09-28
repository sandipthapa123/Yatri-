import type { Request, Response } from 'express';
import type { ApiResponse } from '@yatri/types';

import { HttpError } from '../../middleware/errorHandler';
import { findUserById, updateProfile, type ProfileUpdate } from './users.repository';
import { toPublicProfile, type PublicProfile } from './users.types';

export async function getMeHandler(req: Request, res: Response<ApiResponse<PublicProfile>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const user = await findUserById(req.auth.userId);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  res.json({ success: true, data: toPublicProfile(user) });
}

export async function updateMeHandler(req: Request, res: Response<ApiResponse<PublicProfile>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const body = req.body as { fullName?: string; profilePictureUrl?: string | null };

  const update: ProfileUpdate = { fullName: body.fullName };
  if ('profilePictureUrl' in body) update.profilePictureUrl = body.profilePictureUrl;

  const user = await updateProfile(req.auth.userId, update);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  res.json({ success: true, data: toPublicProfile(user) });
}
