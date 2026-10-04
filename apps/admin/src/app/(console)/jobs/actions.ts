'use server';

import { revalidatePath } from 'next/cache';

import { runJobApi, actionFailure } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface JobActionState {
  error?: string;
  done?: string;
}

/** Runs one job now. The API decides whether it may (permission, lock) and says in words what happened. */
export async function runJobAction(_p: JobActionState, fd: FormData): Promise<JobActionState> {
  const token = await requireAdminAccessToken();
  const name = fd.get('name');
  if (typeof name !== 'string' || name === '') return { error: 'Choose a job.' };
  try {
    const r = await runJobApi(token, name);
    revalidatePath('/jobs');
    return r.status === 'FAILED' ? { error: r.message } : { done: r.message };
  } catch (e) {
    return actionFailure(e);
  }
}
