import { authApi, type PickedFile } from '@yatri/mobile-auth';
import type {
  DocumentSummary,
  DocumentTypeRef,
  DriverOnboardingProgress,
  Vehicle,
  VehicleCategory,
} from '@yatri/types';

/**
 * Domain API calls for driver onboarding/vehicles/documents — kept in the
 * driver app rather than the shared mobile-auth package because they're
 * driver-only concerns, not auth. Reuses mobile-auth's `request`/
 * `requestMultipart` so the fetch/error-unwrapping logic isn't duplicated.
 */

export interface OnboardingUpdate {
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

export function getOnboarding(accessToken: string): Promise<DriverOnboardingProgress> {
  return authApi.request<DriverOnboardingProgress>('/drivers/me/onboarding', { accessToken });
}

export function updateOnboarding(
  accessToken: string,
  update: OnboardingUpdate,
): Promise<DriverOnboardingProgress> {
  return authApi.request<DriverOnboardingProgress>('/drivers/me/onboarding', {
    method: 'PATCH',
    accessToken,
    body: update,
  });
}

export function submitVerification(accessToken: string): Promise<DriverOnboardingProgress> {
  return authApi.request<DriverOnboardingProgress>('/drivers/me/submit-verification', {
    method: 'POST',
    accessToken,
  });
}

export function getVehicleCategories(accessToken: string): Promise<VehicleCategory[]> {
  return authApi.request<VehicleCategory[]>('/vehicles/categories', { accessToken });
}

export interface CreateVehicleInput {
  categoryId: string;
  make: string;
  model: string;
  year: number;
  color: string;
  registrationNumber: string;
  vin?: string;
  registrationExpiryDate?: string;
  insuranceProvider?: string;
  insurancePolicyNumber?: string;
  insuranceExpiryDate?: string;
}

export function listVehicles(accessToken: string): Promise<Vehicle[]> {
  return authApi.request<Vehicle[]>('/vehicles', { accessToken });
}

export function createVehicle(accessToken: string, input: CreateVehicleInput): Promise<Vehicle> {
  return authApi.request<Vehicle>('/vehicles', { method: 'POST', accessToken, body: input });
}

export type UpdateVehicleInput = Partial<CreateVehicleInput>;

export function updateVehicle(
  accessToken: string,
  vehicleId: string,
  update: UpdateVehicleInput,
): Promise<Vehicle> {
  return authApi.request<Vehicle>(`/vehicles/${vehicleId}`, {
    method: 'PATCH',
    accessToken,
    body: update,
  });
}

export function listDocumentTypes(accessToken: string): Promise<DocumentTypeRef[]> {
  return authApi.request<DocumentTypeRef[]>('/documents/types', { accessToken });
}

export function listDocuments(accessToken: string, vehicleId?: string): Promise<DocumentSummary[]> {
  const query = vehicleId ? `?vehicleId=${encodeURIComponent(vehicleId)}` : '';
  return authApi.request<DocumentSummary[]>(`/documents${query}`, { accessToken });
}

export function uploadDocument(
  accessToken: string,
  input: { documentTypeCode: string; vehicleId?: string; expiryDate?: string; file: PickedFile },
): Promise<DocumentSummary> {
  const form = new FormData();
  form.append('documentTypeCode', input.documentTypeCode);
  if (input.vehicleId) form.append('vehicleId', input.vehicleId);
  if (input.expiryDate) form.append('expiryDate', input.expiryDate);
  form.append('file', {
    uri: input.file.uri,
    name: input.file.name,
    type: input.file.type,
  } as unknown as Blob);
  return authApi.requestMultipart<DocumentSummary>('/documents', accessToken, form);
}

export function deleteDocument(
  accessToken: string,
  documentId: string,
): Promise<{ deleted: true }> {
  return authApi.request<{ deleted: true }>(`/documents/${documentId}`, {
    method: 'DELETE',
    accessToken,
  });
}
