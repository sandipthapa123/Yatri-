'use server';

import type { AdminAttributeBody } from '@yatri/types';
import { revalidatePath } from 'next/cache';

import { ApiError, decideCapabilityApi, saveAttributeApi } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface AccessibilityActionState {
  error?: string;
  done?: string;
}

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const fail = (e: unknown): AccessibilityActionState => ({
  error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.',
});

/** Approve or reject a driver's claim. The API checks the permission, keeps the reason and tells the driver. */
export async function decideAction(
  _p: AccessibilityActionState,
  fd: FormData,
): Promise<AccessibilityActionState> {
  const token = await requireAdminAccessToken();
  const decision = field(fd, 'decision');
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    return { error: 'Choose approve or reject.' };
  }
  try {
    await decideCapabilityApi(token, field(fd, 'vehicleId'), field(fd, 'code'), {
      decision,
      reason: field(fd, 'reason'),
    });
    revalidatePath('/accessibility');
    return {
      done:
        decision === 'APPROVED'
          ? 'Approved. The driver has been told.'
          : 'Not approved. The driver has been told.',
    };
  } catch (e) {
    return fail(e);
  }
}

/** Add or edit a vehicle feature. A saved edit names the version the administrator saw. */
export async function saveAttributeAction(
  _p: AccessibilityActionState,
  fd: FormData,
): Promise<AccessibilityActionState> {
  const token = await requireAdminAccessToken();
  const code = field(fd, 'code');
  const version = field(fd, 'version');
  const body: AdminAttributeBody = {
    code: code || undefined,
    label: field(fd, 'label'),
    help: field(fd, 'help'),
    requiresApproval: fd.get('requiresApproval') === 'on',
    active: fd.get('active') === 'on',
    version: version ? Number(version) : undefined,
    reason: field(fd, 'reason'),
  };
  try {
    await saveAttributeApi(token, body);
    revalidatePath('/accessibility');
    return { done: code ? 'Saved.' : 'Feature added.' };
  } catch (e) {
    return fail(e);
  }
}
