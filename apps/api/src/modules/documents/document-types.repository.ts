import { query } from '../../lib/db';
import type { DocumentTypeRow } from './documents.types';

export async function listActiveDocumentTypes(): Promise<DocumentTypeRow[]> {
  const result = await query<DocumentTypeRow>(
    `SELECT id, code, label, owner_type, is_required, vehicle_category_id, is_active, sort_order
     FROM document_types WHERE is_active = true ORDER BY owner_type, sort_order ASC`,
  );
  return result.rows;
}

export async function findDocumentTypeByCode(code: string): Promise<DocumentTypeRow | null> {
  const result = await query<DocumentTypeRow>(
    `SELECT id, code, label, owner_type, is_required, vehicle_category_id, is_active, sort_order
     FROM document_types WHERE code = $1 AND is_active = true`,
    [code],
  );
  return result.rows[0] ?? null;
}

export async function findDocumentTypeById(id: string): Promise<DocumentTypeRow | null> {
  const result = await query<DocumentTypeRow>(
    `SELECT id, code, label, owner_type, is_required, vehicle_category_id, is_active, sort_order
     FROM document_types WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** Required document types for a driver, or for a vehicle of the given category. */
export async function listRequiredDocumentTypes(
  ownerType: 'DRIVER' | 'VEHICLE',
  vehicleCategoryId?: string,
): Promise<DocumentTypeRow[]> {
  if (ownerType === 'DRIVER') {
    const result = await query<DocumentTypeRow>(
      `SELECT id, code, label, owner_type, is_required, vehicle_category_id, is_active, sort_order
       FROM document_types WHERE owner_type = 'DRIVER' AND is_required = true AND is_active = true`,
    );
    return result.rows;
  }
  const result = await query<DocumentTypeRow>(
    `SELECT id, code, label, owner_type, is_required, vehicle_category_id, is_active, sort_order
     FROM document_types
     WHERE owner_type = 'VEHICLE' AND is_required = true AND is_active = true
       AND (vehicle_category_id IS NULL OR vehicle_category_id = $1)`,
    [vehicleCategoryId],
  );
  return result.rows;
}
