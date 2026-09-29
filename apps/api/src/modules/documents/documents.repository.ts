import { query } from '../../lib/db';
import type { DocumentOwnerType, DocumentRow } from './documents.types';

const SELECT_JOINED = `
  SELECT d.id, d.owner_type, d.driver_user_id, d.vehicle_id, d.document_type_id,
         dt.code AS document_type_code, dt.label AS document_type_label,
         d.storage_key, d.original_filename, d.mime_type, d.file_size,
         d.status, d.rejection_reason, d.expiry_date,
         d.reviewed_by, d.reviewed_at, d.uploaded_at
  FROM documents d
  JOIN document_types dt ON dt.id = d.document_type_id
`;

/** Lazily flips APPROVED documents whose expiry has passed to EXPIRED. Cheap; call before any read. */
export async function expireStaleDocuments(): Promise<void> {
  await query(
    `UPDATE documents SET status = 'EXPIRED'
     WHERE status = 'APPROVED' AND expiry_date IS NOT NULL AND expiry_date < CURRENT_DATE`,
  );
}

export interface CreateDocumentInput {
  ownerType: DocumentOwnerType;
  driverUserId: string | null;
  vehicleId: string | null;
  documentTypeId: string;
  storageKey: string;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  expiryDate: string | null;
}

export async function createDocument(input: CreateDocumentInput): Promise<DocumentRow> {
  const result = await query<{ id: string }>(
    `INSERT INTO documents (
       owner_type, driver_user_id, vehicle_id, document_type_id, storage_key,
       original_filename, mime_type, file_size, expiry_date
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      input.ownerType,
      input.driverUserId,
      input.vehicleId,
      input.documentTypeId,
      input.storageKey,
      input.originalFilename,
      input.mimeType,
      input.fileSize,
      input.expiryDate,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error('Failed to create document');
  const row = await findDocumentById(id);
  if (!row) throw new Error('Failed to load created document');
  return row;
}

export async function findDocumentById(id: string): Promise<DocumentRow | null> {
  const result = await query<DocumentRow>(`${SELECT_JOINED} WHERE d.id = $1`, [id]);
  return result.rows[0] ?? null;
}

/** Every document a driver owns: their own driver-level docs plus every document on their vehicles. */
export async function findDocumentsForDriver(
  driverUserId: string,
  vehicleId?: string,
): Promise<DocumentRow[]> {
  if (vehicleId) {
    const result = await query<DocumentRow>(
      `${SELECT_JOINED}
       WHERE (d.owner_type = 'DRIVER' AND d.driver_user_id = $1)
          OR (d.owner_type = 'VEHICLE' AND d.vehicle_id = $2
              AND EXISTS (SELECT 1 FROM vehicles v WHERE v.id = $2 AND v.driver_user_id = $1))
       ORDER BY d.uploaded_at DESC`,
      [driverUserId, vehicleId],
    );
    return result.rows;
  }
  const result = await query<DocumentRow>(
    `${SELECT_JOINED}
     WHERE (d.owner_type = 'DRIVER' AND d.driver_user_id = $1)
        OR (d.owner_type = 'VEHICLE' AND d.vehicle_id IN (
              SELECT id FROM vehicles WHERE driver_user_id = $1
            ))
     ORDER BY d.uploaded_at DESC`,
    [driverUserId],
  );
  return result.rows;
}

/** The current document, if any, occupying this exact owner+type(+vehicle) slot. */
export async function findExistingDocumentForSlot(
  ownerType: DocumentOwnerType,
  driverUserId: string | null,
  vehicleId: string | null,
  documentTypeId: string,
): Promise<DocumentRow | null> {
  const result = await query<DocumentRow>(
    `${SELECT_JOINED}
     WHERE d.owner_type = $1
       AND d.document_type_id = $2
       AND d.driver_user_id IS NOT DISTINCT FROM $3
       AND d.vehicle_id IS NOT DISTINCT FROM $4`,
    [ownerType, documentTypeId, driverUserId, vehicleId],
  );
  return result.rows[0] ?? null;
}

export async function deleteDocument(id: string): Promise<void> {
  await query(`DELETE FROM documents WHERE id = $1`, [id]);
}

export async function setDocumentReview(
  id: string,
  status: 'APPROVED' | 'REJECTED',
  reason: string | null,
  reviewedBy: string,
): Promise<DocumentRow | null> {
  await query(
    `UPDATE documents SET status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = now()
     WHERE id = $1`,
    [id, status, reason, reviewedBy],
  );
  return findDocumentById(id);
}
