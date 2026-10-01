'use server';

import { RISK_EVENT_STATUSES, type RiskEventStatus } from '@yatri/types';
import { revalidatePath } from 'next/cache';

import {
  ApiError,
  addRiskNote,
  liftRiskRestriction,
  restrictRiskUser,
  reviewRiskEvent,
  runRiskSweepApi,
  saveRiskRule,
} from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface RiskActionState {
  error?: string;
  done?: string;
}

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};

/**
 * Every action only passes the administrator's choices to the API and shows what it answered. The API decides
 * (the review moves allowed, the longest restriction, who can be restricted) and writes the audit entry.
 */
async function run(
  work: (token: string) => Promise<unknown>,
  done: string,
  paths: string[],
): Promise<RiskActionState> {
  const token = await requireAdminAccessToken();
  try {
    await work(token);
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' };
  }
  for (const p of paths) revalidatePath(p);
  return { done };
}

export async function reviewAction(_p: RiskActionState, fd: FormData): Promise<RiskActionState> {
  const status = field(fd, 'status') as RiskEventStatus;
  if (!RISK_EVENT_STATUSES.includes(status)) return { error: 'Choose a decision.' };
  const id = field(fd, 'eventId');
  return run(
    (t) => reviewRiskEvent(t, id, { status, reason: field(fd, 'reason') }),
    status === 'DISMISSED'
      ? 'Marked as a false alarm. It no longer counts towards the score.'
      : 'Confirmed. It counts towards the score.',
    [`/risk/events/${id}`, '/risk/events', '/risk'],
  );
}

export async function restrictAction(_p: RiskActionState, fd: FormData): Promise<RiskActionState> {
  const id = field(fd, 'userId');
  const days = Number(field(fd, 'days'));
  if (!Number.isInteger(days) || days < 1) return { error: 'Enter a whole number of days.' };
  return run(
    (t) => restrictRiskUser(t, id, { days, reason: field(fd, 'reason') }),
    'Restricted. It ends by itself; you can lift it sooner.',
    [`/risk/users/${id}`, '/risk'],
  );
}

export async function liftAction(_p: RiskActionState, fd: FormData): Promise<RiskActionState> {
  const id = field(fd, 'userId');
  return run((t) => liftRiskRestriction(t, id, field(fd, 'reason')), 'Restriction lifted.', [
    `/risk/users/${id}`,
    '/risk',
  ]);
}

export async function riskNoteAction(_p: RiskActionState, fd: FormData): Promise<RiskActionState> {
  const userId = field(fd, 'userId') || null;
  const tripId = field(fd, 'tripId') || null;
  const eventId = field(fd, 'eventId') || null;
  return run(
    (t) => addRiskNote(t, { note: field(fd, 'note'), userId, tripId, eventId }),
    'Note added.',
    [
      ...(userId ? [`/risk/users/${userId}`] : []),
      ...(tripId ? [`/risk/trips/${tripId}`] : []),
      ...(eventId ? [`/risk/events/${eventId}`] : []),
    ],
  );
}

export async function ruleAction(_p: RiskActionState, fd: FormData): Promise<RiskActionState> {
  const code = field(fd, 'code');
  return run(
    (t) =>
      saveRiskRule(t, code, {
        enabled: fd.get('enabled') === 'on',
        points: Number(field(fd, 'points')),
        threshold: Number(field(fd, 'threshold')),
        windowHours: Number(field(fd, 'windowHours')),
        reason: field(fd, 'reason'),
      }),
    'Rule saved. It applies from the next check.',
    ['/risk/rules'],
  );
}

export async function sweepAction(_p: RiskActionState): Promise<RiskActionState> {
  const token = await requireAdminAccessToken();
  try {
    const r = await runRiskSweepApi(token);
    revalidatePath('/risk');
    return {
      done: `Checked. ${r.eventsCreated} new signal${r.eventsCreated === 1 ? '' : 's'}, ${r.restricted} automatic restriction${r.restricted === 1 ? '' : 's'}, ${r.lifted} restriction${r.lifted === 1 ? '' : 's'} ended.`,
    };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' };
  }
}
