'use server';

import { revalidatePath } from 'next/cache';

import { adminCancelTrip, actionFailure } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface RideActionState {
  error?: string;
  done?: string;
}

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
    return actionFailure(e);
  }
  revalidatePath(`/rides/${tripId}`);
  revalidatePath('/rides');
  return { done: 'The ride was cancelled and both people were told.' };
}
