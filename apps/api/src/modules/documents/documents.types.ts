import type { DocumentOwnerType, DocumentStatus, DocumentSummary } from '@yatri/types';

export type { DocumentOwnerType, DocumentStatus };

export interface DocumentTypeRow {
  id: string;
  code: string;
  label: string;
  owner_type: DocumentOwnerType;
  is_required: boolean;
  vehicle_category_id: string | null;
  is_active: boolean;
  sort_order: number;
}

/** A `documents` row joined with its document_type's code/label. */
export interface DocumentRow {
  id: string;
  owner_type: DocumentOwnerType;
  driver_user_id: string | null;
  vehicle_id: string | null;
  document_type_id: string;
  document_type_code: string;
  document_type_label: string;
  storage_key: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  status: DocumentStatus;
  rejection_reason: string | null;
  expiry_date: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  uploaded_at: Date;
}

export function toDocumentSummary(row: DocumentRow): DocumentSummary {
  return {
    id: row.id,
    ownerType: row.owner_type,
    vehicleId: row.vehicle_id,
    documentType: {
      id: row.document_type_id,
      code: row.document_type_code,
      label: row.document_type_label,
    },
    originalFilename: row.original_filename,
    fileSize: row.file_size,
    status: row.status,
    rejectionReason: row.rejection_reason,
    expiryDate: row.expiry_date,
    uploadedAt: row.uploaded_at.toISOString(),
    reviewedAt: row.reviewed_at ? row.reviewed_at.toISOString() : null,
  };
}
