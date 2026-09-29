import type { DriverOnboardingProgress } from '@yatri/types';

import { listRequiredDocumentTypes } from '../documents/document-types.repository';
import { expireStaleDocuments, findDocumentsForDriver } from '../documents/documents.repository';
import type { DocumentRow } from '../documents/documents.types';
import { findVehiclesByDriver } from '../vehicles/vehicles.repository';
import type { VehicleRow } from '../vehicles/vehicles.types';
import { findDriverDetails, toDriverDetails } from './driver-details.repository';
import type { DriverDetailsRow } from './driver-details.repository';
import { findDriverProfileByUserId } from './drivers.repository';

function isPastDate(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return new Date(dateStr) < today;
}

function hasPersonalInfo(details: DriverDetailsRow | null): boolean {
  return !!(
    details?.full_legal_name &&
    details.date_of_birth &&
    details.address_line1 &&
    details.city
  );
}

function hasDriverInfo(details: DriverDetailsRow | null): boolean {
  return !!(details?.license_number && details.license_expiry_date);
}

function documentSatisfies(
  documents: DocumentRow[],
  documentTypeId: string,
  vehicleId: string | null,
  requireApproved: boolean,
): boolean {
  const doc = documents.find(
    (d) => d.document_type_id === documentTypeId && d.vehicle_id === vehicleId,
  );
  if (!doc) return false;
  if (requireApproved) {
    return doc.status === 'APPROVED' && !isPastDate(doc.expiry_date);
  }
  return true;
}

/** The vehicle (if any) eligible to represent this driver's fleet for verification purposes. */
function pickApprovedVehicle(vehicles: VehicleRow[]): VehicleRow | undefined {
  return vehicles.find(
    (v) =>
      v.verification_status === 'APPROVED' &&
      !isPastDate(v.registration_expiry_date) &&
      !isPastDate(v.insurance_expiry_date),
  );
}

interface OnboardingData {
  status: DriverOnboardingProgress['status'];
  rejectionReason: string | null;
  details: DriverDetailsRow | null;
  vehicles: VehicleRow[];
  documents: DocumentRow[];
}

async function loadOnboardingData(userId: string): Promise<OnboardingData> {
  await expireStaleDocuments();
  const [profile, details, vehicles, documents] = await Promise.all([
    findDriverProfileByUserId(userId),
    findDriverDetails(userId),
    findVehiclesByDriver(userId),
    findDocumentsForDriver(userId),
  ]);
  if (!profile) throw new Error(`No driver_profiles row for user ${userId}`);
  return {
    status: profile.status,
    rejectionReason: profile.rejection_reason,
    details,
    vehicles,
    documents,
  };
}

export async function computeOnboardingProgress(userId: string): Promise<DriverOnboardingProgress> {
  const data = await loadOnboardingData(userId);
  const requiredDriverTypes = await listRequiredDocumentTypes('DRIVER');

  const documentsStepComplete =
    requiredDriverTypes.every((t) => documentSatisfies(data.documents, t.id, null, false)) &&
    (data.vehicles.length === 0 ||
      (await allVehicleDocumentsPresent(data.vehicles[0]!, data.documents)));

  const missingRequirements: string[] = [];
  if (!hasPersonalInfo(data.details)) missingRequirements.push('Complete personal information.');
  if (!hasDriverInfo(data.details)) missingRequirements.push('Add driving licence details.');
  if (data.vehicles.length === 0) missingRequirements.push('Add at least one vehicle.');
  for (const t of requiredDriverTypes) {
    if (!documentSatisfies(data.documents, t.id, null, false)) {
      missingRequirements.push(`Upload ${t.label}.`);
    }
  }
  if (data.vehicles.length > 0) {
    const vehicle = data.vehicles[0]!;
    const requiredVehicleTypes = await listRequiredDocumentTypes('VEHICLE', vehicle.category_id);
    for (const t of requiredVehicleTypes) {
      if (!documentSatisfies(data.documents, t.id, vehicle.id, false)) {
        missingRequirements.push(`Upload ${t.label} for your vehicle.`);
      }
    }
  }

  return {
    status: data.status,
    rejectionReason: data.rejectionReason,
    steps: {
      personalInfo: hasPersonalInfo(data.details),
      driverInfo: hasDriverInfo(data.details),
      vehicle: data.vehicles.length > 0,
      documents: documentsStepComplete,
      submitted: !['NOT_STARTED', 'IN_PROGRESS'].includes(data.status),
    },
    missingRequirements,
    details: toDriverDetails(data.details),
  };
}

async function allVehicleDocumentsPresent(
  vehicle: VehicleRow,
  documents: DocumentRow[],
): Promise<boolean> {
  const requiredVehicleTypes = await listRequiredDocumentTypes('VEHICLE', vehicle.category_id);
  return requiredVehicleTypes.every((t) => documentSatisfies(documents, t.id, vehicle.id, false));
}

export interface EligibilityResult {
  eligible: boolean;
  missingRequirements: string[];
}

/**
 * The strict gate for VERIFIED — every requirement must be APPROVED (not
 * merely uploaded) and unexpired. This is the only function allowed to
 * decide "yes, this driver may become VERIFIED"; the admin controller
 * calls it and refuses to approve if it returns ineligible.
 */
export async function checkVerificationEligibility(userId: string): Promise<EligibilityResult> {
  const data = await loadOnboardingData(userId);
  const missing: string[] = [];

  if (data.status === 'SUSPENDED') missing.push('Driver account is suspended.');
  if (!hasPersonalInfo(data.details)) missing.push('Personal information is incomplete.');
  if (!hasDriverInfo(data.details)) missing.push('Driving licence details are incomplete.');
  if (hasDriverInfo(data.details) && isPastDate(data.details!.license_expiry_date)) {
    missing.push('Driving licence has expired.');
  }

  const approvedVehicle = pickApprovedVehicle(data.vehicles);
  if (!approvedVehicle) {
    missing.push('No approved, currently valid vehicle on file.');
  }

  const requiredDriverTypes = await listRequiredDocumentTypes('DRIVER');
  for (const t of requiredDriverTypes) {
    if (!documentSatisfies(data.documents, t.id, null, true)) {
      missing.push(`${t.label} is missing, rejected, or expired.`);
    }
  }

  if (approvedVehicle) {
    const requiredVehicleTypes = await listRequiredDocumentTypes(
      'VEHICLE',
      approvedVehicle.category_id,
    );
    for (const t of requiredVehicleTypes) {
      if (!documentSatisfies(data.documents, t.id, approvedVehicle.id, true)) {
        missing.push(`${t.label} is missing, rejected, or expired.`);
      }
    }
  }

  return { eligible: missing.length === 0, missingRequirements: missing };
}
