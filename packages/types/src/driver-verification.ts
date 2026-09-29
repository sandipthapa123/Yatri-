/**
 * Driver onboarding, vehicles, documents, and verification — Phase 3.
 * These mirror the API's public response shapes (camelCase), not the DB's
 * internal row shapes.
 */

export const DRIVER_STATUSES = [
  'NOT_STARTED',
  'IN_PROGRESS',
  'SUBMITTED',
  'UNDER_REVIEW',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export type VehicleVerificationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type DocumentStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
export type DocumentOwnerType = 'DRIVER' | 'VEHICLE';

export interface VehicleCategory {
  id: string;
  code: string;
  label: string;
}

export interface DocumentTypeRef {
  id: string;
  code: string;
  label: string;
  ownerType: DocumentOwnerType;
  isRequired: boolean;
  vehicleCategoryId: string | null;
}

/** Sensitive/regulatory driver info — kept out of the base AppUser profile. */
export interface DriverDetails {
  fullLegalName: string | null;
  dateOfBirth: string | null;
  licenseNumber: string | null;
  licenseExpiryDate: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
}

export interface Vehicle {
  id: string;
  categoryId: string;
  make: string;
  model: string;
  year: number;
  color: string;
  registrationNumber: string;
  vin: string | null;
  registrationExpiryDate: string | null;
  insuranceProvider: string | null;
  insurancePolicyNumber: string | null;
  insuranceExpiryDate: string | null;
  verificationStatus: VehicleVerificationStatus;
  rejectionReason: string | null;
  createdAt: string;
}

export interface DocumentSummary {
  id: string;
  ownerType: DocumentOwnerType;
  vehicleId: string | null;
  documentType: { id: string; code: string; label: string };
  originalFilename: string;
  fileSize: number;
  status: DocumentStatus;
  rejectionReason: string | null;
  expiryDate: string | null;
  uploadedAt: string;
  reviewedAt: string | null;
}

export interface OnboardingStepStatus {
  personalInfo: boolean;
  driverInfo: boolean;
  vehicle: boolean;
  documents: boolean;
  submitted: boolean;
}

export interface DriverOnboardingProgress {
  status: DriverStatus;
  rejectionReason: string | null;
  steps: OnboardingStepStatus;
  /** Human-readable list of what's still missing before submission/approval is possible. */
  missingRequirements: string[];
  /** Previously-saved personal/licence info, so a resumed wizard never asks for it again. */
  details: DriverDetails;
}

// --- Admin-facing shapes ---

export interface AdminDriverListItem {
  id: string;
  fullName: string | null;
  phoneNumber: string | null;
  accountStatus: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  profilePictureUrl: string | null;
  driverStatus: DriverStatus;
  submittedAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

export interface AdminDriverListResponse {
  items: AdminDriverListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminDriverDetail extends AdminDriverListItem {
  rejectionReason: string | null;
  details: DriverDetails;
  vehicles: Vehicle[];
}

export interface VerificationEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  previousStatus: DriverStatus | null;
  newStatus: DriverStatus | null;
  documentId: string | null;
  vehicleId: string | null;
  reason: string | null;
  createdAt: string;
}
