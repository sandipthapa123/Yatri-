'use server';

import {
  DISABILITY_ADMIN_ACTIONS,
  DISABILITY_ADMIN_ACTION_LABELS,
  type DisabilityAdminAction,
} from '@yatri/types';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { disabilityActionApi, disabilityDocumentApi, actionFailure } from '../../../lib/apiClient';
import { apiOrigin } from '../../../lib/env';
import { requireAdminAccessToken } from '../../../lib/session';

export interface DisabilityActionState {
  error?: string;
  done?: string;
}

const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * One server action for every decision on a verification. The form carries only the case, the action and the words the
 * administrator wrote; the API checks the permission and the legal move, audits it, and tells the rider. The form's single
 * "reason" box is the reason, the correction message or the approval note, depending on the action.
 */
export async function disabilityDecisionAction(
  _prev: DisabilityActionState,
  fd: FormData,
): Promise<DisabilityActionState> {
  const id = text(fd, 'id');
  const action = text(fd, 'action') as DisabilityAdminAction;
  if (!id || !(DISABILITY_ADMIN_ACTIONS as readonly string[]).includes(action)) {
    return { error: 'That action is not recognised.' };
  }
  const words = text(fd, 'reason');
  const needs = DISABILITY_ADMIN_ACTION_LABELS[action].needs;
  const token = await requireAdminAccessToken();
  try {
    await disabilityActionApi(token, id, action, {
      ...(needs === 'reason' && words ? { reason: words } : {}),
      ...(needs === 'message' && words ? { message: words } : {}),
      ...(needs === 'none' && words ? { note: words } : {}),
      ...(fd.get('acknowledgeDuplicate') === 'on' ? { acknowledgeDuplicate: true } : {}),
    });
  } catch (e) {
    return actionFailure(e);
  }
  revalidatePath(`/disability/${id}`);
  revalidatePath('/disability');
  return {
    done: `${DISABILITY_ADMIN_ACTION_LABELS[action].label}: done. The rider has been told.`,
  };
}

/** Open the card's document through a short-lived link. Every opening is audited by the API. */
export async function openDisabilityDocumentAction(
  _prev: DisabilityActionState,
  fd: FormData,
): Promise<DisabilityActionState> {
  const id = text(fd, 'id');
  const token = await requireAdminAccessToken();
  let url: string;
  try {
    url = (await disabilityDocumentApi(token, id)).url;
  } catch {
    return { error: 'Could not open this document.' };
  }
  redirect(new URL(url, apiOrigin()).toString());
}
