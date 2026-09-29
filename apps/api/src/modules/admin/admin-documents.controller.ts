import type { Request, Response } from 'express';
import type { ApiResponse, DocumentSummary } from '@yatri/types';

import { env } from '../../config/env';
import { notify } from '../../lib/notifications';
import { getStorageProvider } from '../../lib/storage/local-disk-provider';
import { HttpError } from '../../middleware/errorHandler';
import { requireParam } from '../../lib/params';
import { recordVerificationEvent } from '../drivers/verification-events.repository';
import { findDocumentById, setDocumentReview } from '../documents/documents.repository';
import { toDocumentSummary, type DocumentRow } from '../documents/documents.types';
import { findVehicleById, setVehicleVerification } from '../vehicles/vehicles.repository';

async function resolveDriverUserId(doc: DocumentRow): Promise<string> {
  if (doc.owner_type === 'DRIVER') return doc.driver_user_id!;
  const vehicle = await findVehicleById(doc.vehicle_id!);
  if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
  return vehicle.driver_user_id;
}

async function loadDocumentOr404(id: string): Promise<DocumentRow> {
  const doc = await findDocumentById(id);
  if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
  return doc;
}

export async function approveDocumentHandler(
  req: Request,
  res: Response<ApiResponse<DocumentSummary>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const doc = await loadDocumentOr404(requireParam(req, 'id'));
  const driverUserId = await resolveDriverUserId(doc);

  const updated = await setDocumentReview(doc.id, 'APPROVED', null, req.auth.userId);
  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');

  await recordVerificationEvent({
    driverUserId,
    actorUserId: req.auth.userId,
    action: 'DOCUMENT_APPROVED',
    documentId: doc.id,
    vehicleId: doc.vehicle_id,
  });
  await notify({
    userId: driverUserId,
    type: 'DOCUMENT_APPROVED',
    title: 'Document approved',
    body: `Your ${doc.document_type_label} was approved.`,
  });

  res.json({ success: true, data: toDocumentSummary(updated) });
}

export async function rejectDocumentHandler(
  req: Request,
  res: Response<ApiResponse<DocumentSummary>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const doc = await loadDocumentOr404(requireParam(req, 'id'));
  const driverUserId = await resolveDriverUserId(doc);
  const { reason } = req.body as { reason: string };

  const updated = await setDocumentReview(doc.id, 'REJECTED', reason, req.auth.userId);
  if (!updated) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');

  await recordVerificationEvent({
    driverUserId,
    actorUserId: req.auth.userId,
    action: 'DOCUMENT_REJECTED',
    documentId: doc.id,
    vehicleId: doc.vehicle_id,
    reason,
  });
  await notify({
    userId: driverUserId,
    type: 'DOCUMENT_REJECTED',
    title: 'Document rejected',
    body: `Your ${doc.document_type_label} was rejected: ${reason}`,
  });

  res.json({ success: true, data: toDocumentSummary(updated) });
}

export async function getDocumentDownloadUrlHandler(
  req: Request,
  res: Response<ApiResponse<{ url: string; expiresInSeconds: number }>>,
) {
  const doc = await loadDocumentOr404(requireParam(req, 'id'));
  const url = await getStorageProvider().createTemporaryAccessUrl(
    doc.storage_key,
    env.STORAGE_SIGNED_URL_TTL_SECONDS,
    { contentType: doc.mime_type, filename: doc.original_filename },
  );
  res.json({ success: true, data: { url, expiresInSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS } });
}

export async function approveVehicleHandler(
  req: Request,
  res: Response<ApiResponse<{ status: string }>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const vehicle = await findVehicleById(requireParam(req, 'id'));
  if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');

  await setVehicleVerification(vehicle.id, 'APPROVED', null, req.auth.userId);
  await recordVerificationEvent({
    driverUserId: vehicle.driver_user_id,
    actorUserId: req.auth.userId,
    action: 'VEHICLE_APPROVED',
    vehicleId: vehicle.id,
  });
  await notify({
    userId: vehicle.driver_user_id,
    type: 'VEHICLE_APPROVED',
    title: 'Vehicle approved',
    body: `Your ${vehicle.make} ${vehicle.model} was approved.`,
  });

  res.json({ success: true, data: { status: 'APPROVED' } });
}

export async function rejectVehicleHandler(
  req: Request,
  res: Response<ApiResponse<{ status: string }>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const vehicle = await findVehicleById(requireParam(req, 'id'));
  if (!vehicle) throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
  const { reason } = req.body as { reason: string };

  await setVehicleVerification(vehicle.id, 'REJECTED', reason, req.auth.userId);
  await recordVerificationEvent({
    driverUserId: vehicle.driver_user_id,
    actorUserId: req.auth.userId,
    action: 'VEHICLE_REJECTED',
    vehicleId: vehicle.id,
    reason,
  });
  await notify({
    userId: vehicle.driver_user_id,
    type: 'VEHICLE_REJECTED',
    title: 'Vehicle rejected',
    body: `Your ${vehicle.make} ${vehicle.model} was rejected: ${reason}`,
  });

  res.json({ success: true, data: { status: 'REJECTED' } });
}
