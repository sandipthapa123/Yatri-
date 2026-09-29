'use server';

import { revalidatePath } from 'next/cache';

import { ApiError, adminCancelTrip, resolveAdminDispute } from '../../lib/apiClient';
import { requireAdminAccessToken } from '../../lib/session';

export interface RideActionState {
  error?: string;
  done?: string;
}

const fail = (err: unknown): RideActionState => ({
  error: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
});

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** Operator override for a stuck or disputed ride. The API records the admin as the actor. */
export async function cancelRideAction(
  _prev: RideActionState,
  formData: FormData,
): Promise<RideActionState> {
  const tripId = field(formData, 'tripId');
  const reason = field(formData, 'reason');
  if (reason.length < 3) return { error: 'Give a reason of at least three characters.' };
  const token = await requireAdminAccessToken();
  try {
    await adminCancelTrip(token, tripId, reason);
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/rides/${tripId}`);
  revalidatePath('/rides');
  return { done: 'The ride was cancelled and both people were told.' };
}

export async function resolveDisputeAction(
  _prev: RideActionState,
  formData: FormData,
): Promise<RideActionState> {
  const disputeId = field(formData, 'disputeId');
  const status = field(formData, 'status');
  const resolution = field(formData, 'resolution');
  if (status !== 'RESOLVED' && status !== 'REJECTED') return { error: 'Choose an outcome.' };
  if (resolution.length < 3) return { error: 'Write the resolution (at least three characters).' };
  const token = await requireAdminAccessToken();
  try {
    await resolveAdminDispute(token, disputeId, status, resolution);
  } catch (e) {
    return fail(e);
  }
  revalidatePath('/disputes');
  revalidatePath('/rides');
  return { done: 'Dispute updated.' };
}
