'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  ApiError,
  approveDocument,
  approveVehicle,
  getAdminDocumentDownloadUrl,
  rejectDocument,
  rejectDriver,
  rejectVehicle,
  suspendDriver,
  verifyDriver,
} from '../../../lib/apiClient';
import { apiOrigin } from '../../../lib/env';
import { requireAdminAccessToken } from '../../../lib/session';

export interface ActionState {
  error?: string;
  missingRequirements?: string[];
}

function friendlyError(err: unknown): ActionState {
  if (err instanceof ApiError) {
    const missing = err.details?.missingRequirements;
    return {
      error: err.message,
      missingRequirements: Array.isArray(missing) ? (missing as string[]) : undefined,
    };
  }
  return { error: 'Something went wrong. Please try again.' };
}

function requireField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing required field: ${name}`);
  }
  return value;
}

export async function verifyDriverAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const driverId = requireField(formData, 'driverId');
  const token = await requireAdminAccessToken();
  try {
    await verifyDriver(token, driverId);
  } catch (err) {
    return friendlyError(err);
  }
  revalidatePath(`/drivers/${driverId}`);
  revalidatePath('/drivers');
  return {};
}

export async function rejectDriverAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const driverId = requireField(formData, 'driverId');
  const reason = requireField(formData, 'reason').trim();
  if (reason.length < 5) return { error: 'Enter a reason of at least 5 characters.' };
  const token = await requireAdminAccessToken();
  try {
    await rejectDriver(token, driverId, reason);
  } catch (err) {
    return friendlyError(err);
  }
  revalidatePath(`/drivers/${driverId}`);
  revalidatePath('/drivers');
  return {};
}

export async function suspendDriverAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const driverId = requireField(formData, 'driverId');
  const reason = requireField(formData, 'reason').trim();
  if (reason.length < 5) return { error: 'Enter a reason of at least 5 characters.' };
  const token = await requireAdminAccessToken();
  try {
    await suspendDriver(token, driverId, reason);
  } catch (err) {
    return friendlyError(err);
  }
  revalidatePath(`/drivers/${driverId}`);
  revalidatePath('/drivers');
  return {};
}

export async function approveDocumentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const driverId = requireField(formData, 'driverId');
  const documentId = requireField(formData, 'documentId');
  const token = await requireAdminAccessToken();
  try {
    await approveDocument(token, documentId);
  } catch (err) {
    return friendlyError(err);
  }
  revalidatePath(`/drivers/${driverId}`);
  return {};
}

export async function rejectDocumentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const driverId = requireField(formData, 'driverId');
  const documentId = requireField(formData, 'documentId');
  const reason = requireField(formData, 'reason').trim();
  if (reason.length < 5) return { error: 'Enter a reason of at least 5 characters.' };
  const token = await requireAdminAccessToken();
  try {
    await rejectDocument(token, documentId, reason);
  } catch (err) {
    return friendlyError(err);
  }
  revalidatePath(`/drivers/${driverId}`);
  return {};
}

export async function approveVehicleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const driverId = requireField(formData, 'driverId');
  const vehicleId = requireField(formData, 'vehicleId');
  const token = await requireAdminAccessToken();
  try {
    await approveVehicle(token, vehicleId);
  } catch (err) {
    return friendlyError(err);
  }
  revalidatePath(`/drivers/${driverId}`);
  return {};
}

export async function rejectVehicleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const driverId = requireField(formData, 'driverId');
  const vehicleId = requireField(formData, 'vehicleId');
  const reason = requireField(formData, 'reason').trim();
  if (reason.length < 5) return { error: 'Enter a reason of at least 5 characters.' };
  const token = await requireAdminAccessToken();
  try {
    await rejectVehicle(token, vehicleId, reason);
  } catch (err) {
    return friendlyError(err);
  }
  revalidatePath(`/drivers/${driverId}`);
  return {};
}

export async function viewDocumentAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const documentId = requireField(formData, 'documentId');
  const token = await requireAdminAccessToken();
  let signedPath: string;
  try {
    const result = await getAdminDocumentDownloadUrl(token, documentId);
    signedPath = result.url;
  } catch {
    return { error: 'Could not open this document.' };
  }
  redirect(new URL(signedPath, apiOrigin()).toString());
}
