'use server';

import { INCIDENT_STATES, type IncidentStatus } from '@yatri/types';
import { revalidatePath } from 'next/cache';

import {
  ApiError,
  addAdminIncidentNote,
  moveAdminSos,
  setAdminIncidentStatus,
} from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface SafetyActionState {
  error?: string;
  done?: string;
}

const fail = (err: unknown): SafetyActionState => ({
  error: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
});

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * The server decides whether each move is legal and records it in the audit log; these actions
 * only pass the admin's choice on and show the result (the API's own message on a conflict).
 */
export async function moveSosAction(
  _prev: SafetyActionState,
  formData: FormData,
): Promise<SafetyActionState> {
  const id = field(formData, 'sosId');
  const to = field(formData, 'to');
  const note = field(formData, 'note');
  if (to !== 'ACKNOWLEDGED' && to !== 'RESOLVED') return { error: 'Choose what to do.' };
  if (to === 'RESOLVED' && note.length < 3) {
    return { error: 'Write how it was resolved (at least three characters).' };
  }
  const token = await requireAdminAccessToken();
  try {
    await moveAdminSos(token, id, to, note || undefined);
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/safety/sos/${id}`);
  revalidatePath('/safety');
  return {
    done:
      to === 'ACKNOWLEDGED'
        ? 'Alert acknowledged. The person has been told the team is responding.'
        : 'Alert resolved.',
  };
}

export async function incidentStatusAction(
  _prev: SafetyActionState,
  formData: FormData,
): Promise<SafetyActionState> {
  const id = field(formData, 'incidentId');
  const status = field(formData, 'status') as IncidentStatus;
  const note = field(formData, 'note');
  if (!INCIDENT_STATES.includes(status)) return { error: 'Choose a status.' };
  const token = await requireAdminAccessToken();
  try {
    await setAdminIncidentStatus(token, id, status, note || undefined);
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/safety/incidents/${id}`);
  revalidatePath('/safety');
  return { done: 'Status updated. The reporter has been told.' };
}

export async function incidentNoteAction(
  _prev: SafetyActionState,
  formData: FormData,
): Promise<SafetyActionState> {
  const id = field(formData, 'incidentId');
  const kind = field(formData, 'kind');
  const body = field(formData, 'body');
  if (kind !== 'NOTE' && kind !== 'ACTION') return { error: 'Choose a note or an action.' };
  if (body.length < 1) return { error: 'Write something first.' };
  const token = await requireAdminAccessToken();
  try {
    await addAdminIncidentNote(token, id, kind, body);
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/safety/incidents/${id}`);
  return { done: kind === 'ACTION' ? 'Action recorded.' : 'Note added.' };
}
