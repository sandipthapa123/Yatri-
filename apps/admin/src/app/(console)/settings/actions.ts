'use server';

import { settingDef } from '@yatri/types';
import { revalidatePath } from 'next/cache';

import { ApiError, updatePlatformSetting, updateVehicleCategory } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';
import type { ConfirmState } from '../ui/ConfirmAction';

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const fail = (e: unknown): ConfirmState => ({
  error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.',
});

/**
 * Change one platform setting (or put it back to the default). The value is checked by the API with
 * the same rule the form shows; a stale `expectedVersion` (someone else changed it first) is refused.
 */
export async function updateSettingAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const key = field(formData, 'key');
  const def = settingDef(key);
  if (!def) return { error: 'Unknown setting.' };
  const reset = field(formData, 'reset') === 'true';
  const reason = field(formData, 'reason');
  const expectedVersion = Number(field(formData, 'expectedVersion'));
  if (reason.length < 3) return { error: 'Give a reason of at least three characters.' };
  if (!Number.isInteger(expectedVersion)) return { error: 'Reload the page and try again.' };
  const raw = field(formData, 'value');
  const value = reset ? null : def.kind === 'boolean' ? field(formData, 'value') === 'true' : raw;
  const token = await requireAdminAccessToken();
  try {
    await updatePlatformSetting(token, key, { value, expectedVersion, reason });
  } catch (e) {
    revalidatePath('/settings');
    return fail(e);
  }
  revalidatePath('/settings');
  return { done: reset ? `${def.label} is back to its default.` : `${def.label} changed.` };
}

const optionalNumber = (fd: FormData, name: string): number | null | undefined => {
  const v = field(fd, name);
  if (v === '') return null; // blank = use the platform default
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export async function updateCategoryAction(
  _prev: ConfirmState,
  formData: FormData,
): Promise<ConfirmState> {
  const id = field(formData, 'categoryId');
  const reason = field(formData, 'reason');
  if (reason.length < 3) return { error: 'Give a reason of at least three characters.' };
  const parts = {
    baseFareNpr: optionalNumber(formData, 'baseFareNpr'),
    perKmNpr: optionalNumber(formData, 'perKmNpr'),
    perMinuteNpr: optionalNumber(formData, 'perMinuteNpr'),
    minimumFareNpr: optionalNumber(formData, 'minimumFareNpr'),
  };
  if (Object.values(parts).some((v) => v === undefined)) {
    return { error: 'Fare figures must be numbers, or left blank to use the platform default.' };
  }
  const sortOrder = Number(field(formData, 'sortOrder'));
  const token = await requireAdminAccessToken();
  try {
    await updateVehicleCategory(token, id, {
      label: field(formData, 'label') || undefined,
      isActive: field(formData, 'isActive') === 'true',
      sortOrder: Number.isInteger(sortOrder) ? sortOrder : undefined,
      baseFareNpr: parts.baseFareNpr as number | null,
      perKmNpr: parts.perKmNpr as number | null,
      perMinuteNpr: parts.perMinuteNpr as number | null,
      minimumFareNpr: parts.minimumFareNpr as number | null,
      reason,
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath('/settings');
  return { done: 'Vehicle category saved. Rides already requested keep the fare they were given.' };
}
