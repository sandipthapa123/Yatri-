'use server';

import {
  DATA_REQUEST_STATES,
  RETENTION_RECORD_TYPES,
  type DataRequestStatus,
  type RetentionRecordType,
} from '@yatri/types';
import { revalidatePath } from 'next/cache';

import {
  ApiError,
  actOnDataRequestById,
  publishPolicy,
  updateRetentionRule,
} from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface ComplianceActionState {
  error?: string;
  done?: string;
}

const fail = (err: unknown): ComplianceActionState => ({
  error: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
});
const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/** Publish a new version of a policy: earlier acceptances stay; everyone is asked to accept the new one. */
export async function publishPolicyAction(
  _prev: ComplianceActionState,
  formData: FormData,
): Promise<ComplianceActionState> {
  const key = field(formData, 'key');
  const version = field(formData, 'version');
  const reason = field(formData, 'reason');
  const url = field(formData, 'contentUrl');
  if (!version) return { error: 'Give the new version a label, for example 2.' };
  if (reason.length < 3) return { error: 'Give a reason of at least three characters.' };
  const token = await requireAdminAccessToken();
  try {
    await publishPolicy(token, key, {
      version,
      reason,
      ...(field(formData, 'title') ? { title: field(formData, 'title') } : {}),
      ...(url ? { contentUrl: url } : {}),
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath('/compliance');
  return { done: `Version ${version} is published. People will be asked to accept it.` };
}

export async function dataRequestAction(
  _prev: ComplianceActionState,
  formData: FormData,
): Promise<ComplianceActionState> {
  const id = field(formData, 'requestId');
  const to = field(formData, 'to') as DataRequestStatus;
  const note = field(formData, 'note');
  if (!DATA_REQUEST_STATES.includes(to)) return { error: 'Choose what to do.' };
  const token = await requireAdminAccessToken();
  try {
    await actOnDataRequestById(token, id, { to, ...(note ? { note } : {}) });
  } catch (e) {
    return fail(e);
  }
  revalidatePath('/compliance');
  return {
    done:
      to === 'COMPLETED'
        ? 'Completed. The person has been told (a deleted account has nobody left to tell).'
        : 'Updated. The person has been told.',
  };
}

export async function retentionAction(
  _prev: ComplianceActionState,
  formData: FormData,
): Promise<ComplianceActionState> {
  const type = field(formData, 'recordType') as RetentionRecordType;
  const days = field(formData, 'retainDays');
  const reason = field(formData, 'reason');
  if (!RETENTION_RECORD_TYPES.includes(type)) return { error: 'Unknown kind of record.' };
  if (!/^\d+$/.test(days)) return { error: 'Enter a whole number of days.' };
  if (reason.length < 3) return { error: 'Give a reason of at least three characters.' };
  const token = await requireAdminAccessToken();
  try {
    await updateRetentionRule(token, type, { retainDays: Number(days), reason });
  } catch (e) {
    return fail(e);
  }
  revalidatePath('/compliance');
  return { done: 'Retention period changed. The next hourly clean-up applies it.' };
}
