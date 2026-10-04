'use server';

import { ADMIN_PERMISSIONS, type AdminPermission } from '@yatri/types';
import { revalidatePath } from 'next/cache';

import { setAdminPermissions, actionFailure } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import type { ConfirmState } from '../ui/ConfirmAction';

/** Replace one administrator's permissions. The API enforces who may grant what, and audits it. */
export async function setPermissionsAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const id = String(formData.get('adminId') ?? '');
  const reason = String(formData.get('reason') ?? '').trim();
  const permissions = formData
    .getAll('permissions')
    .map(String)
    .filter((p): p is AdminPermission => (ADMIN_PERMISSIONS as readonly string[]).includes(p));
  if (reason.length < 3) return { error: 'Give a reason of at least three characters.' };
  const token = await requireAdminAccessToken();
  try {
    await setAdminPermissions(token, id, { permissions, reason });
  } catch (e) {
    return actionFailure(e);
  }
  revalidatePath('/admins');
  return { done: 'Permissions saved.' };
}
