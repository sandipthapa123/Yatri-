import type { VehicleCreateBody, VehicleUpdateBody } from '@yatri/types';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import type { VehicleCategoryRow, VehicleRow } from './vehicles.types';

export async function listActiveVehicleCategories(): Promise<VehicleCategoryRow[]> {
  const result = await query<VehicleCategoryRow>(
    `SELECT id, code, label, is_active, sort_order FROM vehicle_categories
     WHERE is_active = true ORDER BY sort_order ASC`,
  );
  return result.rows;
}

export async function findVehicleCategoryById(id: string): Promise<VehicleCategoryRow | null> {
  const result = await query<VehicleCategoryRow>(
    `SELECT id, code, label, is_active, sort_order FROM vehicle_categories WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** The one answer for a registration number that another vehicle already holds. */
export const registrationTaken = () =>
  new HttpError(409, 'REGISTRATION_TAKEN', 'A vehicle with that registration already exists.');

/** Run a write that may collide on the registration number, and answer a collision in words rather than as a server error. */
export async function orRegistrationTaken<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw registrationTaken();
    throw err;
  }
}

export type CreateVehicleInput = VehicleCreateBody;

export async function createVehicle(
  driverUserId: string | null,
  input: CreateVehicleInput,
  fleetId: string | null = null,
): Promise<VehicleRow> {
  const result = await query<VehicleRow>(
    `INSERT INTO vehicles (
       driver_user_id, category_id, make, model, year, color, registration_number, vin,
       registration_expiry_date, insurance_provider, insurance_policy_number, insurance_expiry_date,
       fleet_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      driverUserId,
      input.categoryId,
      input.make,
      input.model,
      input.year,
      input.color,
      input.registrationNumber,
      input.vin ?? null,
      input.registrationExpiryDate ?? null,
      input.insuranceProvider ?? null,
      input.insurancePolicyNumber ?? null,
      input.insuranceExpiryDate ?? null,
      fleetId,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create vehicle');
  return row;
}

export async function findVehiclesByDriver(driverUserId: string): Promise<VehicleRow[]> {
  const result = await query<VehicleRow>(
    `SELECT * FROM vehicles WHERE driver_user_id = $1 ORDER BY created_at ASC`,
    [driverUserId],
  );
  return result.rows;
}

export async function findVehicleById(id: string): Promise<VehicleRow | null> {
  const result = await query<VehicleRow>(`SELECT * FROM vehicles WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export type UpdateVehicleInput = VehicleUpdateBody;

/**
 * Editing any field resets an already-reviewed vehicle back to PENDING —
 * an approval must always reflect the data an admin actually saw.
 */
export async function updateVehicle(
  id: string,
  update: UpdateVehicleInput,
): Promise<VehicleRow | null> {
  const result = await query<VehicleRow>(
    `UPDATE vehicles SET
       make = COALESCE($2, make),
       model = COALESCE($3, model),
       year = COALESCE($4, year),
       color = COALESCE($5, color),
       registration_number = COALESCE($6, registration_number),
       vin = CASE WHEN $12::boolean THEN $7 ELSE vin END,
       registration_expiry_date = CASE WHEN $13::boolean THEN $8 ELSE registration_expiry_date END,
       insurance_provider = CASE WHEN $14::boolean THEN $9 ELSE insurance_provider END,
       insurance_policy_number = CASE WHEN $15::boolean THEN $10 ELSE insurance_policy_number END,
       insurance_expiry_date = CASE WHEN $16::boolean THEN $11 ELSE insurance_expiry_date END,
       verification_status = 'PENDING',
       rejection_reason = NULL,
       reviewed_by = NULL,
       reviewed_at = NULL
     WHERE id = $1
     RETURNING *`,
    [
      id,
      update.make ?? null,
      update.model ?? null,
      update.year ?? null,
      update.color ?? null,
      update.registrationNumber ?? null,
      update.vin ?? null,
      update.registrationExpiryDate ?? null,
      update.insuranceProvider ?? null,
      update.insurancePolicyNumber ?? null,
      update.insuranceExpiryDate ?? null,
      'vin' in update,
      'registrationExpiryDate' in update,
      'insuranceProvider' in update,
      'insurancePolicyNumber' in update,
      'insuranceExpiryDate' in update,
    ],
  );
  return result.rows[0] ?? null;
}

export async function setVehicleVerification(
  id: string,
  status: 'APPROVED' | 'REJECTED',
  reason: string | null,
  reviewedBy: string,
): Promise<VehicleRow | null> {
  const result = await query<VehicleRow>(
    `UPDATE vehicles
     SET verification_status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, status, reason, reviewedBy],
  );
  return result.rows[0] ?? null;
}
