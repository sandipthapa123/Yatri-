import { forceSuspend } from '../availability/availability.service';
import type { Request, Response } from 'express';
import type { ApiResponse } from '@yatri/types';

import { env } from '../../config/env';
import { detectFileType } from '../../lib/file-signature';
import { generateStorageKey } from '../../lib/safe-filename';
import { getStorageProvider } from '../../lib/storage/local-disk-provider';
import { HttpError } from '../../middleware/errorHandler';
import { recordAuthEvent } from '../auth/auth-event.repository';
import { revokeAllUserSessions } from '../auth/session.repository';
import {
  deactivateUser,
  findUserById,
  updateProfile,
  type ProfileUpdate,
} from './users.repository';
import { PROFILE_PICTURE_URL_TTL_SECONDS, publicProfileWithPicture } from './profile-picture';
import type { PublicProfile } from './users.types';

export async function getMeHandler(req: Request, res: Response<ApiResponse<PublicProfile>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const user = await findUserById(req.auth.userId);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  res.json({ success: true, data: await publicProfileWithPicture(user) });
}

export async function updateMeHandler(req: Request, res: Response<ApiResponse<PublicProfile>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const body = req.body as { fullName?: string; profilePictureUrl?: string | null };

  const update: ProfileUpdate = { fullName: body.fullName };
  if ('profilePictureUrl' in body) update.profilePictureUrl = body.profilePictureUrl;

  const user = await updateProfile(req.auth.userId, update);
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  res.json({ success: true, data: await publicProfileWithPicture(user) });
}

export async function uploadProfilePictureHandler(
  req: Request,
  res: Response<ApiResponse<PublicProfile>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const file = req.file;
  if (!file) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'A file is required.').withDetails({
      file: ['A file is required'],
    });
  }
  if (file.size > env.MAX_UPLOAD_FILE_SIZE_BYTES) {
    throw new HttpError(413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size.');
  }

  const detected = detectFileType(file.buffer);
  if (!detected || detected.mimeType === 'application/pdf') {
    throw new HttpError(400, 'INVALID_FILE_TYPE', 'Only JPEG or PNG images are accepted.');
  }

  const storageKey = generateStorageKey(`profile-pictures/${req.auth.userId}`, detected.extension);
  await getStorageProvider().upload({
    key: storageKey,
    buffer: file.buffer,
    contentType: detected.mimeType,
  });

  // A signed URL, not a permanent public one — see docs/PHASE_3.md for why,
  // and the production swap-out this implies for a real object store.
  const url = await getStorageProvider().createTemporaryAccessUrl(
    storageKey,
    PROFILE_PICTURE_URL_TTL_SECONDS,
    { contentType: detected.mimeType },
  );

  const user = await updateProfile(req.auth.userId, { profilePictureUrl: url });
  if (!user) throw new HttpError(404, 'NOT_FOUND', 'User not found.');
  res.status(201).json({ success: true, data: await publicProfileWithPicture(user) });
}

export async function deactivateMeHandler(
  req: Request,
  res: Response<ApiResponse<{ deactivated: true }>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');

  const user = await deactivateUser(req.auth.userId);
  if (!user) {
    throw new HttpError(409, 'INVALID_STATE_TRANSITION', 'Account is not active.');
  }
  await revokeAllUserSessions(req.auth.userId);
  if (req.auth.role === 'DRIVER') {
    await forceSuspend(req.auth.userId, req.auth.userId, 'ACCOUNT_DEACTIVATED');
  }
  await recordAuthEvent({
    eventType: 'SESSION_REVOKED',
    userId: req.auth.userId,
    ipAddress: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
    metadata: { reason: 'self_deactivation' },
  });

  res.json({ success: true, data: { deactivated: true } });
}
