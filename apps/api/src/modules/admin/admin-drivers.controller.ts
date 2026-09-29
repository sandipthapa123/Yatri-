import type { Request, Response } from 'express';
import type {
  AdminDriverDetail,
  AdminDriverListItem,
  AdminDriverListResponse,
  ApiResponse,
  DocumentSummary,
  VerificationEvent,
} from '@yatri/types';

import { notify } from '../../lib/notifications';
import { HttpError } from '../../middleware/errorHandler';
import { requireParam } from '../../lib/params';
import { findDriverDetails, toDriverDetails } from '../drivers/driver-details.repository';
import { findDriverProfileByUserId, transitionDriverStatus } from '../drivers/drivers.repository';
import { checkVerificationEligibility } from '../drivers/onboarding.service';
import { recordVerificationEvent } from '../drivers/verification-events.repository';
import { listVerificationEvents } from '../drivers/verification-events.repository';
import { toDocumentSummary } from '../documents/documents.types';
import { findDocumentsForDriver, expireStaleDocuments } from '../documents/documents.repository';
import { findVehiclesByDriver } from '../vehicles/vehicles.repository';
import { toPublicVehicle } from '../vehicles/vehicles.types';
import { findUserById } from '../users/users.repository';
import { listDrivers, type AdminDriverListRow } from './admin-drivers.repository';

function toListItem(row: AdminDriverListRow): AdminDriverListItem {
  return {
    id: row.id,
    fullName: row.full_name,
    phoneNumber: row.phone_number,
    accountStatus: row.account_status,
    profilePictureUrl: row.profile_picture_url,
    driverStatus: row.driver_status,
    submittedAt: row.submitted_at ? row.submitted_at.toISOString() : null,
    verifiedAt: row.verified_at ? row.verified_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listDriversHandler(
  req: Request,
  res: Response<ApiResponse<AdminDriverListResponse>>,
) {
  const { search, status, page, pageSize } = req.validatedQuery as {
    search?: string;
    status?: AdminDriverListItem['driverStatus'];
    page: number;
    pageSize: number;
  };
  const { rows, total } = await listDrivers({ search, status, page, pageSize });
  res.json({
    success: true,
    data: { items: rows.map(toListItem), total, page, pageSize },
  });
}

async function loadDriverOr404(driverId: string) {
  const [user, profile] = await Promise.all([
    findUserById(driverId),
    findDriverProfileByUserId(driverId),
  ]);
  if (!user || user.role !== 'DRIVER' || !profile) {
    throw new HttpError(404, 'NOT_FOUND', 'Driver not found.');
  }
  return { user, profile };
}

export async function getDriverDetailHandler(
  req: Request,
  res: Response<ApiResponse<AdminDriverDetail>>,
) {
  const driverId = requireParam(req, 'id');
  const { user, profile } = await loadDriverOr404(driverId);

  // Opening a submitted application starts its review — matches the
  // documented flow (submit -> becomes UNDER_REVIEW -> admin reviews).
  if (profile.status === 'SUBMITTED') {
    await transitionDriverStatus(driverId, ['SUBMITTED'], 'UNDER_REVIEW');
  }

  const [details, vehicles, refreshedProfile] = await Promise.all([
    findDriverDetails(driverId),
    findVehiclesByDriver(driverId),
    findDriverProfileByUserId(driverId),
  ]);
  const status = refreshedProfile?.status ?? profile.status;

  res.json({
    success: true,
    data: {
      id: user.id,
      fullName: user.full_name,
      phoneNumber: user.phone_number,
      accountStatus: user.status,
      profilePictureUrl: user.profile_picture_url,
      driverStatus: status,
      rejectionReason: refreshedProfile?.rejection_reason ?? profile.rejection_reason,
      submittedAt: profile.submitted_at ? profile.submitted_at.toISOString() : null,
      verifiedAt: profile.verified_at ? profile.verified_at.toISOString() : null,
      createdAt: user.created_at.toISOString(),
      details: toDriverDetails(details),
      vehicles: vehicles.map(toPublicVehicle),
    },
  });
}

export async function getDriverDocumentsHandler(
  req: Request,
  res: Response<ApiResponse<DocumentSummary[]>>,
) {
  const driverId = requireParam(req, 'id');
  await loadDriverOr404(driverId);
  await expireStaleDocuments();
  const rows = await findDocumentsForDriver(driverId);
  res.json({ success: true, data: rows.map(toDocumentSummary) });
}

export async function getDriverVerificationHistoryHandler(
  req: Request,
  res: Response<ApiResponse<VerificationEvent[]>>,
) {
  const driverId = requireParam(req, 'id');
  await loadDriverOr404(driverId);
  const rows = await listVerificationEvents(driverId);
  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      actorUserId: r.actor_user_id,
      action: r.action,
      previousStatus: r.previous_status,
      newStatus: r.new_status,
      documentId: r.document_id,
      vehicleId: r.vehicle_id,
      reason: r.reason,
      createdAt: r.created_at.toISOString(),
    })),
  });
}

export async function verifyDriverHandler(
  req: Request,
  res: Response<ApiResponse<{ status: string }>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const driverId = requireParam(req, 'id');
  const { profile } = await loadDriverOr404(driverId);

  const eligibility = await checkVerificationEligibility(driverId);
  if (!eligibility.eligible) {
    throw new HttpError(
      409,
      'NOT_ELIGIBLE',
      'This driver does not yet meet all verification requirements.',
    ).withDetails({ missingRequirements: eligibility.missingRequirements });
  }

  const updated = await transitionDriverStatus(
    driverId,
    ['SUBMITTED', 'UNDER_REVIEW'],
    'VERIFIED',
    { rejectionReason: null, reviewedBy: req.auth.userId, setVerifiedAt: true },
  );
  if (!updated) {
    throw new HttpError(409, 'INVALID_STATE_TRANSITION', 'Driver is not awaiting review.');
  }

  await recordVerificationEvent({
    driverUserId: driverId,
    actorUserId: req.auth.userId,
    action: 'DRIVER_APPROVED',
    previousStatus: profile.status,
    newStatus: 'VERIFIED',
  });
  await notify({
    userId: driverId,
    type: 'DRIVER_APPROVED',
    title: "You're verified!",
    body: 'Your driver application has been approved.',
  });

  res.json({ success: true, data: { status: 'VERIFIED' } });
}

export async function rejectDriverHandler(
  req: Request,
  res: Response<ApiResponse<{ status: string }>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const driverId = requireParam(req, 'id');
  const { profile } = await loadDriverOr404(driverId);
  const { reason } = req.body as { reason: string };

  const updated = await transitionDriverStatus(
    driverId,
    ['SUBMITTED', 'UNDER_REVIEW'],
    'REJECTED',
    { rejectionReason: reason, reviewedBy: req.auth.userId },
  );
  if (!updated) {
    throw new HttpError(409, 'INVALID_STATE_TRANSITION', 'Driver is not awaiting review.');
  }

  await recordVerificationEvent({
    driverUserId: driverId,
    actorUserId: req.auth.userId,
    action: 'DRIVER_REJECTED',
    previousStatus: profile.status,
    newStatus: 'REJECTED',
    reason,
  });
  await notify({
    userId: driverId,
    type: 'DRIVER_REJECTED',
    title: 'Application rejected',
    body: reason,
  });

  res.json({ success: true, data: { status: 'REJECTED' } });
}

export async function suspendDriverHandler(
  req: Request,
  res: Response<ApiResponse<{ status: string }>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const driverId = requireParam(req, 'id');
  const { profile } = await loadDriverOr404(driverId);
  const { reason } = req.body as { reason: string };

  const updated = await transitionDriverStatus(driverId, ['VERIFIED'], 'SUSPENDED', {
    rejectionReason: reason,
    reviewedBy: req.auth.userId,
  });
  if (!updated) {
    throw new HttpError(
      409,
      'INVALID_STATE_TRANSITION',
      'Only a verified driver can be suspended.',
    );
  }

  await recordVerificationEvent({
    driverUserId: driverId,
    actorUserId: req.auth.userId,
    action: 'DRIVER_SUSPENDED',
    previousStatus: profile.status,
    newStatus: 'SUSPENDED',
    reason,
  });
  await notify({
    userId: driverId,
    type: 'DRIVER_SUSPENDED',
    title: 'Account suspended',
    body: reason,
  });

  res.json({ success: true, data: { status: 'SUSPENDED' } });
}
