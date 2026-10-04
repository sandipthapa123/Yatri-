'use server';

import {
  type AdminCampaignBody,
  type CampaignEligibility,
  type CampaignKind,
  type CampaignOffer,
  type CampaignStatus,
  type OfferType,
  CAMPAIGN_KINDS,
  OFFER_TYPES,
} from '@yatri/types';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  adjustRewardsApi,
  campaignStatusApi,
  createCampaignApi,
  updateCampaignApi,
  actionFailure,
} from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface CampaignActionState {
  error?: string;
  done?: string;
}

const text = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const num = (fd: FormData, name: string): number | undefined => {
  const v = text(fd, name);
  if (v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const list = (fd: FormData, name: string): string[] | undefined => {
  const v = text(fd, name);
  return v === ''
    ? undefined
    : v
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
};
/** A <input type="datetime-local"> value is read in the administrator's own time; the API stores an instant. */
const when = (fd: FormData, name: string): string | null => {
  const v = text(fd, name);
  if (v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/** Reads the form into the one body shape. The API validates it (the same rules as the form's hints) and decides. */
function bodyOf(fd: FormData, kind: CampaignKind): AdminCampaignBody {
  const eligibility: CampaignEligibility = {};
  const e = (k: keyof CampaignEligibility, v: unknown) => {
    if (v !== undefined) (eligibility as Record<string, unknown>)[k] = v;
  };
  e('maxCompletedRides', num(fd, 'maxCompletedRides'));
  e('minCompletedRides', num(fd, 'minCompletedRides'));
  e('newUserWithinDays', num(fd, 'newUserWithinDays'));
  e('inactiveForDays', num(fd, 'inactiveForDays'));
  e('vehicleCategoryCodes', list(fd, 'vehicleCategoryCodes'));
  e('minFareNpr', num(fd, 'minFareNpr'));
  // A disability benefit is always for riders with a verified benefit; any other campaign may also be limited to them.
  e('requiresDisabilityVerified', kind === 'DISABILITY_BENEFIT' || fd.get('requiresDisabilityVerified') === 'on' ? true : undefined);
  // Whether it still applies when a companion rides along: only the "no" is stored (yes is the default).
  if (fd.get('companionField') === '1' && fd.get('companionAllowed') !== 'on') e('companionAllowed', false);

  const offerType = text(fd, 'offerType') as OfferType | '';
  let offer: CampaignOffer | null = null;
  if (offerType && (OFFER_TYPES as readonly string[]).includes(offerType)) {
    offer = { type: offerType };
    const set = (k: keyof CampaignOffer, v: number | undefined) => {
      if (v !== undefined) (offer as unknown as Record<string, unknown>)[k] = v;
    };
    set('percent', num(fd, 'percent'));
    set('fixedNpr', num(fd, 'fixedNpr'));
    set('maxDiscountNpr', num(fd, 'maxDiscountNpr'));
    set('points', num(fd, 'points'));
    set('multiplier', num(fd, 'multiplier'));
  }
  const title = text(fd, 'messageTitle');
  const bodyText = text(fd, 'messageBody');
  const version = num(fd, 'version');
  return {
    kind,
    name: text(fd, 'name'),
    description: text(fd, 'description'),
    code: text(fd, 'code') === '' ? null : text(fd, 'code').toUpperCase(),
    startsAt: when(fd, 'startsAt'),
    endsAt: when(fd, 'endsAt'),
    eligibility,
    offer,
    referrerPoints: num(fd, 'referrerPoints') ?? null,
    stackable: fd.get('stackable') === 'on',
    limits: {
      perUser: num(fd, 'perUser') ?? null,
      total: num(fd, 'total') ?? null,
      validDaysAfterGrant: num(fd, 'validDaysAfterGrant') ?? null,
    },
    message: title || bodyText ? { title, body: bodyText } : null,
    ...(version !== undefined ? { version } : {}),
    reason: text(fd, 'reason'),
  };
}

export async function createCampaignAction(
  _p: CampaignActionState,
  fd: FormData,
): Promise<CampaignActionState> {
  const token = await requireAdminAccessToken();
  const kind = text(fd, 'kind') as CampaignKind;
  if (!(CAMPAIGN_KINDS as readonly string[]).includes(kind))
    return { error: 'Choose the kind of campaign.' };
  let id: string;
  try {
    id = (await createCampaignApi(token, bodyOf(fd, kind))).id;
  } catch (e) {
    return actionFailure(e);
  }
  revalidatePath('/campaigns');
  redirect(`/campaigns/${id}`);
}

export async function updateCampaignAction(
  _p: CampaignActionState,
  fd: FormData,
): Promise<CampaignActionState> {
  const token = await requireAdminAccessToken();
  const id = text(fd, 'id');
  const kind = text(fd, 'kind') as CampaignKind;
  try {
    await updateCampaignApi(token, id, bodyOf(fd, kind));
  } catch (e) {
    return actionFailure(e);
  }
  revalidatePath(`/campaigns/${id}`);
  return { done: 'Saved.' };
}

export async function campaignStatusAction(
  _p: CampaignActionState,
  fd: FormData,
): Promise<CampaignActionState> {
  const token = await requireAdminAccessToken();
  const id = text(fd, 'id');
  const to = text(fd, 'to') as CampaignStatus;
  try {
    await campaignStatusApi(token, id, {
      to,
      version: num(fd, 'version') ?? 0,
      reason: text(fd, 'reason'),
    });
  } catch (e) {
    return actionFailure(e);
  }
  revalidatePath(`/campaigns/${id}`);
  revalidatePath('/campaigns');
  return {
    done: {
      ACTIVE: 'The campaign is live.',
      PAUSED: 'The campaign is paused.',
      ENDED: 'The campaign has ended.',
      DRAFT: 'Saved.',
    }[to],
  };
}

export async function adjustRewardsAction(
  _p: CampaignActionState,
  fd: FormData,
): Promise<CampaignActionState> {
  const token = await requireAdminAccessToken();
  const userId = text(fd, 'userId');
  try {
    const r = await adjustRewardsApi(token, userId, {
      points: num(fd, 'points') ?? 0,
      reason: text(fd, 'reason'),
    });
    revalidatePath('/campaigns/rewards');
    return { done: `Done. The rider now has ${r.balance} points.` };
  } catch (e) {
    return actionFailure(e);
  }
}
