'use server';

import { PAYOUT_STATUSES, type PayoutStatus, formatNpr } from '@yatri/types';
import { revalidatePath } from 'next/cache';

import { ApiError, payoutAccountApi, payoutActionApi, payoutPrepareApi } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface PayoutActionState {
  error?: string;
  done?: string;
  /** The account to pay, shown once in the page after staff asked for it (the API audits that). */
  account?: { kindLabel: string; holder: string; number: string };
}

const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const fail = (e: unknown): PayoutActionState => ({ error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' });

/** Prepare payouts for everyone who has enough ready, or for one driver. The API refuses a ride already in a payout. */
export async function preparePayoutsAction(_prev: PayoutActionState, fd: FormData): Promise<PayoutActionState> {
  const token = await requireAdminAccessToken();
  const driverId = text(fd, 'driverId');
  try {
    const r = (await payoutPrepareApi(token, driverId || undefined)) as { prepared?: number; skipped?: number; totalNpr?: number; amountNpr?: number };
    revalidatePath('/payouts');
    return {
      done:
        r.prepared !== undefined
          ? `${r.prepared} ${r.prepared === 1 ? 'payout' : 'payouts'} prepared (${formatNpr(r.totalNpr ?? 0)}). ${r.skipped ?? 0} ${r.skipped === 1 ? 'driver was' : 'drivers were'} skipped: no payout account, or too little ready.`
          : `A payout of ${formatNpr(r.amountNpr ?? 0)} was prepared.`,
    };
  } catch (e) {
    return fail(e);
  }
}

/** One step of a payout. The one box of words is the reference when paid, the reason when it failed. */
export async function payoutStepAction(_prev: PayoutActionState, fd: FormData): Promise<PayoutActionState> {
  const id = text(fd, 'id');
  const to = text(fd, 'to') as PayoutStatus;
  if (!id || !(PAYOUT_STATUSES as readonly string[]).includes(to)) return { error: 'That step is not recognised.' };
  const words = text(fd, 'reason');
  const token = await requireAdminAccessToken();
  try {
    await payoutActionApi(token, id, {
      to,
      ...(to === 'PAID' && words ? { reference: words } : {}),
      ...(to === 'FAILED' && words ? { failedReason: words } : {}),
      ...(to !== 'PAID' && to !== 'FAILED' && words ? { note: words } : {}),
    });
  } catch (e) {
    return fail(e);
  }
  revalidatePath(`/payouts/${id}`);
  revalidatePath('/payouts');
  return { done: 'Done. The driver is told when a payout is paid or fails.' };
}

/** Show the account to pay. Asking is recorded by the API; the number is not kept in the page after it is shown. */
export async function showAccountAction(_prev: PayoutActionState, fd: FormData): Promise<PayoutActionState> {
  const token = await requireAdminAccessToken();
  try {
    const a = await payoutAccountApi(token, text(fd, 'id'));
    return { account: { kindLabel: a.kindLabel, holder: a.holder, number: a.number } };
  } catch (e) {
    return fail(e);
  }
}
