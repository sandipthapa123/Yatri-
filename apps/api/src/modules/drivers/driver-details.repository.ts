import type { DriverDetails } from '@yatri/types';

import { query } from '../../lib/db';

export interface DriverDetailsRow {
  user_id: string;
  full_legal_name: string | null;
  date_of_birth: string | null;
  license_number: string | null;
  license_expiry_date: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function findDriverDetails(userId: string): Promise<DriverDetailsRow | null> {
  const result = await query<DriverDetailsRow>(`SELECT * FROM driver_details WHERE user_id = $1`, [
    userId,
  ]);
  return result.rows[0] ?? null;
}

export function toDriverDetails(row: DriverDetailsRow | null): DriverDetails {
  return {
    fullLegalName: row?.full_legal_name ?? null,
    dateOfBirth: row?.date_of_birth ?? null,
    licenseNumber: row?.license_number ?? null,
    licenseExpiryDate: row?.license_expiry_date ?? null,
    addressLine1: row?.address_line1 ?? null,
    addressLine2: row?.address_line2 ?? null,
    city: row?.city ?? null,
    emergencyContactName: row?.emergency_contact_name ?? null,
    emergencyContactPhone: row?.emergency_contact_phone ?? null,
  };
}

export interface DriverDetailsUpdate {
  fullLegalName?: string;
  dateOfBirth?: string;
  licenseNumber?: string;
  licenseExpiryDate?: string;
  addressLine1?: string;
  addressLine2?: string | null;
  city?: string;
  emergencyContactName?: string | null;
  emergencyContactPhone?: string | null;
}

/** Upserts — a driver may not have a `driver_details` row yet on first save. */
export async function upsertDriverDetails(
  userId: string,
  update: DriverDetailsUpdate,
): Promise<DriverDetailsRow> {
  const result = await query<DriverDetailsRow>(
    `INSERT INTO driver_details (
       user_id, full_legal_name, date_of_birth, license_number, license_expiry_date,
       address_line1, address_line2, city, emergency_contact_name, emergency_contact_phone
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (user_id) DO UPDATE SET
       full_legal_name = COALESCE($2, driver_details.full_legal_name),
       date_of_birth = COALESCE($3, driver_details.date_of_birth),
       license_number = COALESCE($4, driver_details.license_number),
       license_expiry_date = COALESCE($5, driver_details.license_expiry_date),
       address_line1 = COALESCE($6, driver_details.address_line1),
       address_line2 = CASE WHEN $11::boolean THEN $7 ELSE driver_details.address_line2 END,
       city = COALESCE($8, driver_details.city),
       emergency_contact_name = CASE WHEN $12::boolean THEN $9 ELSE driver_details.emergency_contact_name END,
       emergency_contact_phone = CASE WHEN $13::boolean THEN $10 ELSE driver_details.emergency_contact_phone END
     RETURNING *`,
    [
      userId,
      update.fullLegalName ?? null,
      update.dateOfBirth ?? null,
      update.licenseNumber ?? null,
      update.licenseExpiryDate ?? null,
      update.addressLine1 ?? null,
      update.addressLine2 ?? null,
      update.city ?? null,
      update.emergencyContactName ?? null,
      update.emergencyContactPhone ?? null,
      'addressLine2' in update,
      'emergencyContactName' in update,
      'emergencyContactPhone' in update,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to save driver details');
  return row;
}
