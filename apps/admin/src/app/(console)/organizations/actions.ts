'use server';

import { ORG_STATUSES, isStatementPeriod, type OrgStatus } from '@yatri/types';
import { revalidatePath } from 'next/cache';

import {
  ApiError,
  issueStatementsApi,
  markStatementPaidApi,
  moveOrganizationApi,
  voidStatementApi,
} from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface OrgActionState {
  error?: string;
  done?: string;
}

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * Every action only passes the administrator's choices to the API and shows what it answered. The API applies
 * the rules (the moves allowed, the exact amount, one payment record per statement) and writes the audit entry.
 */
async function run(
  work: (token: string) => Promise<unknown>,
  done: string,
  paths: string[],
): Promise<OrgActionState> {
  const token = await requireAdminAccessToken();
  try {
    await work(token);
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' };
  }
  for (const p of paths) revalidatePath(p);
  return { done };
}

export async function moveAction(_p: OrgActionState, fd: FormData): Promise<OrgActionState> {
  const to = field(fd, 'to') as OrgStatus;
  if (!ORG_STATUSES.includes(to)) return { error: 'Choose what to do.' };
  const id = field(fd, 'organizationId');
  return run(
    (t) => moveOrganizationApi(t, id, to, field(fd, 'reason')),
    to === 'SUSPENDED'
      ? 'Suspended. New business rides cannot be booked; rides under way and money owed are unchanged.'
      : 'Reactivated. Business rides can be booked again.',
    [`/organizations/${id}`, '/organizations'],
  );
}

export async function issueAction(_p: OrgActionState, fd: FormData): Promise<OrgActionState> {
  const period = field(fd, 'periodKey');
  if (period && !isStatementPeriod(period)) return { error: 'Use a month like 2026-09.' };
  const token = await requireAdminAccessToken();
  try {
    const r = await issueStatementsApi(token, period || undefined);
    revalidatePath('/organizations/statements');
    return {
      done: `Statements for ${r.periodKey}: ${r.issued} issued, ${r.skipped} already done or nothing to bill.`,
    };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' };
  }
}

export async function paidAction(_p: OrgActionState, fd: FormData): Promise<OrgActionState> {
  const id = field(fd, 'statementId');
  const received = Number(field(fd, 'receivedNpr'));
  if (!Number.isInteger(received) || received < 0)
    return { error: 'Enter the amount received in whole rupees.' };
  return run(
    (t) =>
      markStatementPaidApi(t, id, { receivedNpr: received, reference: field(fd, 'reference') }),
    'Recorded as paid. Every ride on the statement is now paid.',
    [`/organizations/statements/${id}`, '/organizations/statements', '/organizations'],
  );
}

export async function voidAction(_p: OrgActionState, fd: FormData): Promise<OrgActionState> {
  const id = field(fd, 'statementId');
  return run(
    (t) => voidStatementApi(t, id, field(fd, 'reason')),
    'Cancelled. Its rides will be billed on the next statement.',
    [`/organizations/statements/${id}`, '/organizations/statements', '/organizations'],
  );
}
