'use server';

import { revalidatePath } from 'next/cache';

import { ApiError, setAdminUserStatus } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import type { ConfirmState } from '../ui/ConfirmAction';

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** Suspend or reactivate an account; the API applies the rules and writes the audit entry. */
export async function userStatusAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const id = field(formData, 'userId');
  const to = field(formData, 'to');
  const reason = field(formData, 'reason');
  if (to !== 'suspend' && to !== 'reactivate') return { error: 'Choose what to do.' };
  if (reason.length < 3) return { error: 'Give a reason of at least three characters.' };
  const token = await requireAdminAccessToken();
  try {
    await setAdminUserStatus(token, id, to, reason);
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' };
  }
  revalidatePath(`/users/${id}`);
  revalidatePath('/users');
  return {
    done:
      to === 'suspend'
        ? 'Account suspended. The person has been signed out of every device.'
        : 'Account reactivated. The person can sign in again.',
  };
}
