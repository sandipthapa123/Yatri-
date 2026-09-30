'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import {
  REFUND_METHODS,
  REFUND_REASONS,
  REFUND_STATES,
  TICKET_OUTCOMES,
  TICKET_STATUSES,
  type RefundMethod,
  type RefundReason,
  type RefundStatus,
  type TicketOutcome,
  type TicketStatus,
} from '@yatri/types';

import {
  ApiError,
  actOnRefundRequest,
  addTicketNote,
  assignTicket,
  attachToTicket,
  getSupportAttachmentUrl,
  raiseRefund,
  replyToTicket,
  setTicketPriority,
  setTicketStatus,
} from '../../../lib/apiClient';
import { apiOrigin } from '../../../lib/env';
import { requireAdminAccessToken } from '../../../lib/session';

export interface SupportActionState {
  error?: string;
  done?: string;
}

const fail = (err: unknown): SupportActionState => ({
  error: err instanceof ApiError ? err.message : 'Something went wrong. Please try again.',
});
const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const refresh = (ticketId: string) => {
  revalidatePath(`/support/${ticketId}`);
  revalidatePath('/support');
};

/**
 * Every action only passes the administrator's choice to the API and shows what it answered. The API
 * decides what is legal (the ticket and refund tables live in @yatri/types and are applied there) and
 * records it; a refusal is shown in its own words.
 */
export async function replyAction(
  _prev: SupportActionState,
  formData: FormData,
): Promise<SupportActionState> {
  const id = field(formData, 'ticketId');
  const body = field(formData, 'body');
  const status = field(formData, 'status');
  const file = formData.get('file');
  const token = await requireAdminAccessToken();
  try {
    if (file instanceof File && file.size > 0) {
      const form = new FormData();
      if (body) form.append('body', body);
      form.append('file', file, file.name);
      await attachToTicket(token, id, form);
    } else {
      if (body.length < 1) return { error: 'Write a message first.' };
      await replyToTicket(token, id, {
        body,
        ...(status && (TICKET_STATUSES as readonly string[]).includes(status)
          ? { status: status as TicketStatus }
          : {}),
      });
    }
  } catch (e) {
    return fail(e);
  }
  refresh(id);
  return { done: 'Reply sent. The person has been told.' };
}

export async function noteAction(
  _prev: SupportActionState,
  formData: FormData,
): Promise<SupportActionState> {
  const id = field(formData, 'ticketId');
  const body = field(formData, 'body');
  if (body.length < 1) return { error: 'Write the note first.' };
  const token = await requireAdminAccessToken();
  try {
    await addTicketNote(token, id, { body });
  } catch (e) {
    return fail(e);
  }
  refresh(id);
  return { done: 'Note added. The person cannot see it.' };
}

export async function statusAction(
  _prev: SupportActionState,
  formData: FormData,
): Promise<SupportActionState> {
  const id = field(formData, 'ticketId');
  const status = field(formData, 'status') as TicketStatus;
  const resolution = field(formData, 'resolution');
  const outcome = field(formData, 'outcome');
  if (!TICKET_STATUSES.includes(status)) return { error: 'Choose a status.' };
  if (status === 'RESOLVED' && resolution.length < 3) {
    return { error: 'Write what was decided (at least three characters).' };
  }
  const token = await requireAdminAccessToken();
  try {
    await setTicketStatus(token, id, {
      status,
      ...(resolution ? { resolution } : {}),
      ...((TICKET_OUTCOMES as readonly string[]).includes(outcome)
        ? { outcome: outcome as TicketOutcome }
        : {}),
    });
  } catch (e) {
    return fail(e);
  }
  refresh(id);
  return { done: 'Status updated. The person has been told.' };
}

export async function assignAction(
  _prev: SupportActionState,
  formData: FormData,
): Promise<SupportActionState> {
  const id = field(formData, 'ticketId');
  const adminId = field(formData, 'adminId');
  const token = await requireAdminAccessToken();
  try {
    await assignTicket(token, id, { adminId: adminId || null });
  } catch (e) {
    return fail(e);
  }
  refresh(id);
  return { done: adminId ? 'Assigned.' : 'Unassigned.' };
}

export async function priorityAction(
  _prev: SupportActionState,
  formData: FormData,
): Promise<SupportActionState> {
  const id = field(formData, 'ticketId');
  const priorityCode = field(formData, 'priorityCode');
  const reason = field(formData, 'reason');
  if (reason.length < 3) return { error: 'Give a reason of at least three characters.' };
  const token = await requireAdminAccessToken();
  try {
    await setTicketPriority(token, id, { priorityCode, reason });
  } catch (e) {
    return fail(e);
  }
  refresh(id);
  return { done: 'Priority changed.' };
}

export async function raiseRefundAction(
  _prev: SupportActionState,
  formData: FormData,
): Promise<SupportActionState> {
  const id = field(formData, 'ticketId');
  const reason = field(formData, 'reason') as RefundReason;
  const amount = field(formData, 'amountNpr');
  const note = field(formData, 'note');
  if (!REFUND_REASONS.includes(reason)) return { error: 'Choose what the refund is for.' };
  if (reason === 'PARTIAL' && !/^\d+$/.test(amount)) {
    return { error: 'Enter the amount in whole rupees.' };
  }
  const token = await requireAdminAccessToken();
  try {
    await raiseRefund(token, id, {
      reason,
      ...(reason === 'PARTIAL' ? { amountNpr: Number(amount) } : {}),
      ...(note ? { note } : {}),
    });
  } catch (e) {
    return fail(e);
  }
  refresh(id);
  return { done: 'Refund raised. Someone else must review and approve it.' };
}

export async function refundAction(
  _prev: SupportActionState,
  formData: FormData,
): Promise<SupportActionState> {
  const ticketId = field(formData, 'ticketId');
  const refundId = field(formData, 'refundId');
  const to = field(formData, 'to') as RefundStatus;
  const method = field(formData, 'method');
  if (!REFUND_STATES.includes(to)) return { error: 'Choose what to do.' };
  const token = await requireAdminAccessToken();
  try {
    await actOnRefundRequest(token, refundId, {
      to,
      ...(field(formData, 'note') ? { note: field(formData, 'note') } : {}),
      ...((REFUND_METHODS as readonly string[]).includes(method)
        ? { method: method as RefundMethod }
        : {}),
      ...(field(formData, 'reference') ? { reference: field(formData, 'reference') } : {}),
      ...(field(formData, 'failedReason') ? { failedReason: field(formData, 'failedReason') } : {}),
    });
  } catch (e) {
    return fail(e);
  }
  refresh(ticketId);
  return { done: 'Refund updated. The person has been told where that applies.' };
}

/** Open an attachment: the API gives a short-lived signed address and records who opened it. */
export async function openAttachmentAction(formData: FormData): Promise<void> {
  const attachmentId = field(formData, 'attachmentId');
  const ticketId = field(formData, 'ticketId');
  const token = await requireAdminAccessToken();
  let signed: string | null = null;
  try {
    signed = (await getSupportAttachmentUrl(token, attachmentId)).url;
  } catch {
    signed = null;
  }
  if (!signed) redirect(`/support/${ticketId}?fileError=1`);
  redirect(new URL(signed, apiOrigin()).toString());
}
