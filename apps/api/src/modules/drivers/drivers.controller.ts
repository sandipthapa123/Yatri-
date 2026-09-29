import type { Request, Response } from 'express';
import type { ApiResponse, DriverOnboardingProgress } from '@yatri/types';

import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { findUserById, updateProfile, type ProfileUpdate } from '../users/users.repository';
import { toPublicProfile, type PublicProfile } from '../users/users.types';
import { upsertDriverDetails, type DriverDetailsUpdate } from './driver-details.repository';
import { findDriverProfileByUserId, transitionDriverStatus } from './drivers.repository';
import { markOnboardingInProgress } from './onboarding-status';
import { computeOnboardingProgress } from './onboarding.service';
import { recordVerificationEvent } from './verification-events.repository';
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

export async function getOnboardingHandler(
  req: Request,
  res: Response<ApiResponse<DriverOnboardingProgress>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  res.json({ success: true, data: await computeOnboardingProgress(req.auth.userId) });
}

export async function updateOnboardingHandler(
  req: Request,
  res: Response<ApiResponse<DriverOnboardingProgress>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  await upsertDriverDetails(req.auth.userId, req.body as DriverDetailsUpdate);
  await markOnboardingInProgress(req.auth.userId);
  res.json({ success: true, data: await computeOnboardingProgress(req.auth.userId) });
}

export async function getVerificationStatusHandler(
  req: Request,
  res: Response<ApiResponse<{ status: DriverStatus; rejectionReason: string | null }>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const profile = await findDriverProfileByUserId(req.auth.userId);
  if (!profile) throw new HttpError(404, 'NOT_FOUND', 'Driver profile not found.');
  res.json({
    success: true,
    data: { status: profile.status, rejectionReason: profile.rejection_reason },
  });
}

export async function submitVerificationHandler(
  req: Request,
  res: Response<ApiResponse<DriverOnboardingProgress>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');

  const progress = await computeOnboardingProgress(req.auth.userId);
  const { personalInfo, driverInfo, vehicle, documents } = progress.steps;
  if (!personalInfo || !driverInfo || !vehicle || !documents) {
    throw new HttpError(
      400,
      'ONBOARDING_INCOMPLETE',
      'Complete every onboarding step before submitting.',
    ).withDetails({ missingRequirements: progress.missingRequirements });
  }

  // A driver may submit from IN_PROGRESS (first submission) or REJECTED
  // (resubmission after correcting rejected information/documents) — never
  // from SUBMITTED/UNDER_REVIEW/VERIFIED/SUSPENDED.
  const updated = await transitionDriverStatus(
    req.auth.userId,
    ['IN_PROGRESS', 'REJECTED'],
    'SUBMITTED',
    { rejectionReason: null, setSubmittedAt: true },
  );
  if (!updated) {
    throw new HttpError(
      409,
      'INVALID_STATE_TRANSITION',
      'The application cannot be submitted from its current status.',
    );
  }

  await recordVerificationEvent({
    driverUserId: req.auth.userId,
    action: 'SUBMITTED',
    previousStatus: progress.status,
    newStatus: 'SUBMITTED',
  });
  await notify({
    userId: req.auth.userId,
    type: 'DRIVER_APPLICATION_SUBMITTED',
    title: 'Application submitted',
    body: 'Your driver application has been submitted for review.',
  });

  res.json({ success: true, data: await computeOnboardingProgress(req.auth.userId) });
}
