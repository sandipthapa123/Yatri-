import type { Request, Response } from 'express';
import type { ApiResponse, DocumentSummary, DocumentTypeRef } from '@yatri/types';

import { env } from '../../config/env';
import { detectFileType } from '../../lib/file-signature';
import { generateStorageKey, sanitizeDisplayFilename } from '../../lib/safe-filename';
import { getStorageProvider } from '../../lib/storage';
import { HttpError } from '../../middleware/errorHandler';
import { requireParam } from '../../lib/params';
import { markOnboardingInProgress } from '../drivers/onboarding-status';
import { findVehicleById } from '../vehicles/vehicles.repository';
import { findDocumentTypeByCode } from './document-types.repository';
import {
  createDocument,
  deleteDocument,
  expireStaleDocuments,
  findDocumentById,
  findDocumentsForDriver,
  findExistingDocumentForSlot,
} from './documents.repository';
import { toDocumentSummary } from './documents.types';
import { listActiveDocumentTypes } from './document-types.repository';

function toDocumentTypeRef(row: {
  id: string;
  code: string;
  label: string;
  owner_type: 'DRIVER' | 'VEHICLE';
  is_required: boolean;
  vehicle_category_id: string | null;
}): DocumentTypeRef {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    ownerType: row.owner_type,
    isRequired: row.is_required,
    vehicleCategoryId: row.vehicle_category_id,
  };
}

export async function listDocumentTypesHandler(
  _req: Request,
  res: Response<ApiResponse<DocumentTypeRef[]>>,
) {
  const rows = await listActiveDocumentTypes();
  res.json({ success: true, data: rows.map(toDocumentTypeRef) });
}

export async function uploadDocumentHandler(
  req: Request,
  res: Response<ApiResponse<DocumentSummary>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const file = req.file;
  if (!file) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'A file is required.').withDetails({
      file: ['A file is required'],
    });
  }

  const { documentTypeCode, vehicleId, expiryDate } = req.body as {
    documentTypeCode: string;
    vehicleId?: string;
    expiryDate?: string;
  };

  const documentType = await findDocumentTypeByCode(documentTypeCode);
  if (!documentType) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown document type.').withDetails({
      documentTypeCode: ['Unknown document type'],
    });
  }

  let ownerVehicleId: string | null = null;
  if (documentType.owner_type === 'VEHICLE') {
    if (!vehicleId) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'vehicleId is required for this document type.',
      ).withDetails({ vehicleId: ['Required for a vehicle document'] });
    }
    const vehicle = await findVehicleById(vehicleId);
    if (!vehicle || vehicle.driver_user_id !== req.auth.userId) {
      throw new HttpError(404, 'NOT_FOUND', 'Vehicle not found.');
    }
    if (
      documentType.vehicle_category_id &&
      documentType.vehicle_category_id !== vehicle.category_id
    ) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'This document type does not apply to this vehicle.',
      );
    }
    ownerVehicleId = vehicle.id;
  }

  if (file.size > env.MAX_UPLOAD_FILE_SIZE_BYTES) {
    throw new HttpError(413, 'FILE_TOO_LARGE', 'File exceeds the maximum allowed size.');
  }

  const detected = detectFileType(file.buffer);
  if (!detected) {
    throw new HttpError(400, 'INVALID_FILE_TYPE', 'Only JPEG, PNG, or PDF files are accepted.');
  }

  const driverUserId = documentType.owner_type === 'DRIVER' ? req.auth.userId : null;

  const existing = await findExistingDocumentForSlot(
    documentType.owner_type,
    driverUserId,
    ownerVehicleId,
    documentType.id,
  );
  if (existing) {
    if (existing.status === 'APPROVED') {
      throw new HttpError(
        409,
        'DOCUMENT_ALREADY_APPROVED',
        'This document has already been approved. Contact support if it needs to change.',
      );
    }
    await getStorageProvider().delete(existing.storage_key);
    await deleteDocument(existing.id);
  }

  const ownerSegment =
    documentType.owner_type === 'DRIVER'
      ? `driver/${req.auth.userId}`
      : `vehicle/${ownerVehicleId}`;
  const storageKey = generateStorageKey(ownerSegment, detected.extension);
  await getStorageProvider().upload({
    key: storageKey,
    buffer: file.buffer,
    contentType: detected.mimeType,
  });

  const document = await createDocument({
    ownerType: documentType.owner_type,
    driverUserId,
    vehicleId: ownerVehicleId,
    documentTypeId: documentType.id,
    storageKey,
    originalFilename: sanitizeDisplayFilename(file.originalname),
    mimeType: detected.mimeType,
    fileSize: file.size,
    expiryDate: expiryDate ?? null,
  });

  await markOnboardingInProgress(req.auth.userId);

  res.status(201).json({ success: true, data: toDocumentSummary(document) });
}

export async function listMyDocumentsHandler(
  req: Request,
  res: Response<ApiResponse<DocumentSummary[]>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  await expireStaleDocuments();
  const vehicleId = typeof req.query.vehicleId === 'string' ? req.query.vehicleId : undefined;
  const rows = await findDocumentsForDriver(req.auth.userId, vehicleId);
  res.json({ success: true, data: rows.map(toDocumentSummary) });
}

async function assertOwnsDocument(userId: string, documentId: string) {
  const doc = await findDocumentById(documentId);
  if (!doc) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');

  if (doc.owner_type === 'DRIVER') {
    if (doc.driver_user_id !== userId) throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
    return doc;
  }
  const vehicle = doc.vehicle_id ? await findVehicleById(doc.vehicle_id) : null;
  if (!vehicle || vehicle.driver_user_id !== userId) {
    throw new HttpError(404, 'NOT_FOUND', 'Document not found.');
  }
  return doc;
}

export async function deleteDocumentHandler(
  req: Request,
  res: Response<ApiResponse<{ deleted: true }>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const doc = await assertOwnsDocument(req.auth.userId, requireParam(req, 'id'));

  if (doc.status === 'APPROVED') {
    throw new HttpError(
      409,
      'DOCUMENT_ALREADY_APPROVED',
      'An approved document cannot be deleted.',
    );
  }

  await getStorageProvider().delete(doc.storage_key);
  await deleteDocument(doc.id);
  res.json({ success: true, data: { deleted: true } });
}

export async function getMyDocumentDownloadUrlHandler(
  req: Request,
  res: Response<ApiResponse<{ url: string; expiresInSeconds: number }>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const doc = await assertOwnsDocument(req.auth.userId, requireParam(req, 'id'));

  const url = await getStorageProvider().createTemporaryAccessUrl(
    doc.storage_key,
    env.STORAGE_SIGNED_URL_TTL_SECONDS,
    { contentType: doc.mime_type, filename: doc.original_filename },
  );
  res.json({ success: true, data: { url, expiresInSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS } });
}
