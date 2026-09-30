import type {
  Vehicle,
  VehicleCategory,
  VehicleLifecycle,
  VehicleVerificationStatus,
} from '@yatri/types';

export type { VehicleVerificationStatus };

export interface VehicleCategoryRow {
  id: string;
  code: string;
  label: string;
  is_active: boolean;
  sort_order: number;
}

export interface VehicleRow {
  id: string;
  /** The ONE record of who drives this vehicle; null for a fleet vehicle not yet assigned. */
  driver_user_id: string | null;
  fleet_id: string | null;
  lifecycle_status: VehicleLifecycle;
  category_id: string;
  make: string;
  model: string;
  year: number;
  color: string;
  registration_number: string;
  vin: string | null;
  registration_expiry_date: string | null;
  insurance_provider: string | null;
  insurance_policy_number: string | null;
  insurance_expiry_date: string | null;
  verification_status: VehicleVerificationStatus;
  rejection_reason: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toPublicVehicleCategory(row: VehicleCategoryRow): VehicleCategory {
  return { id: row.id, code: row.code, label: row.label };
}

export function toPublicVehicle(row: VehicleRow): Vehicle {
  return {
    id: row.id,
    categoryId: row.category_id,
    make: row.make,
    model: row.model,
    year: row.year,
    color: row.color,
    registrationNumber: row.registration_number,
    vin: row.vin,
    registrationExpiryDate: row.registration_expiry_date,
    insuranceProvider: row.insurance_provider,
    insurancePolicyNumber: row.insurance_policy_number,
    insuranceExpiryDate: row.insurance_expiry_date,
    verificationStatus: row.verification_status,
    rejectionReason: row.rejection_reason,
    createdAt: row.created_at.toISOString(),
  };
}
