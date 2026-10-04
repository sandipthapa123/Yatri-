'use server';

import {
  INCENTIVE_KINDS,
  INCENTIVE_PERIODS,
  ZONE_KINDS,
  polygonFromText,
  type AdminIncentiveRuleBody,
  type AdminPricingRuleBody,
  type AdminZoneBody,
  type IncentiveKind,
  type IncentivePeriod,
  type TimeWindow,
  type ZoneKind,
} from '@yatri/types';
import { revalidatePath } from 'next/cache';

import {
  saveIncentiveRule,
  savePricingRule,
  saveZone,
  actionFailure,
} from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface OpsActionState {
  error?: string;
  done?: string;
}

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const orNull = (v: string) => (v === '' ? null : v);
const num = (v: string) => (v === '' ? null : Number(v));

/** "HH:MM" from a time input to minutes after midnight (null when empty). */
const minutes = (v: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/**
 * The time window from the shared form fields (days, times of day, event dates). The API checks it again
 * with the one rule in @yatri/types; this only turns form text into the shape the API takes.
 */
function windowFrom(fd: FormData): TimeWindow {
  const days = [1, 2, 3, 4, 5, 6, 7].filter((d) => field(fd, `day_${d}`) === 'on');
  const end = field(fd, 'endTime');
  return {
    daysOfWeek: days.length === 0 || days.length === 7 ? null : days,
    startMinute: minutes(field(fd, 'startTime')),
    // 24:00 is the end of the day; an empty end with a start means "until midnight".
    endMinute: end === '24:00' ? 1440 : minutes(end),
    startsAt: orNull(field(fd, 'startsAt')),
    endsAt: orNull(field(fd, 'endsAt')),
  };
}

export async function zoneAction(_prev: OpsActionState, fd: FormData): Promise<OpsActionState> {
  const polygon = polygonFromText(field(fd, 'polygon'));
  if (!polygon) return { error: 'Write each corner on its own line as "latitude, longitude".' };
  const kind = field(fd, 'kind') as ZoneKind;
  if (!ZONE_KINDS.includes(kind)) return { error: 'Choose the kind of zone.' };
  const body: AdminZoneBody = {
    code: field(fd, 'code'),
    name: field(fd, 'name'),
    kind,
    polygon,
    pickupAllowed: field(fd, 'pickupAllowed') === 'on',
    dropoffAllowed: field(fd, 'dropoffAllowed') === 'on',
    note: orNull(field(fd, 'note')),
    priority: Number(field(fd, 'priority') || 0),
    isActive: field(fd, 'isActive') === 'on',
    reason: field(fd, 'reason'),
  };
  const token = await requireAdminAccessToken();
  try {
    await saveZone(token, orNull(field(fd, 'id')), body);
  } catch (e) {
    return actionFailure(e);
  }
  revalidatePath('/operations/zones');
  revalidatePath('/operations');
  return { done: 'Zone saved.' };
}

export async function pricingRuleAction(
  _prev: OpsActionState,
  fd: FormData,
): Promise<OpsActionState> {
  const multiplier = Number(field(fd, 'multiplier'));
  if (!Number.isFinite(multiplier)) return { error: 'Enter the multiplier, for example 1.5.' };
  const body: AdminPricingRuleBody = {
    name: field(fd, 'name'),
    label: field(fd, 'label'),
    zoneId: orNull(field(fd, 'zoneId')),
    vehicleCategoryId: orNull(field(fd, 'vehicleCategoryId')),
    window: windowFrom(fd),
    minDemandRatio: num(field(fd, 'minDemandRatio')),
    multiplier,
    isActive: field(fd, 'isActive') === 'on',
    reason: field(fd, 'reason'),
  };
  const token = await requireAdminAccessToken();
  try {
    await savePricingRule(token, orNull(field(fd, 'id')), body);
  } catch (e) {
    return actionFailure(e);
  }
  revalidatePath('/operations/pricing');
  revalidatePath('/operations');
  return { done: 'Pricing rule saved. It applies to the next estimate.' };
}

export async function incentiveAction(
  _prev: OpsActionState,
  fd: FormData,
): Promise<OpsActionState> {
  const kind = field(fd, 'kind') as IncentiveKind;
  if (!INCENTIVE_KINDS.includes(kind)) return { error: 'Choose the kind of bonus.' };
  const period = field(fd, 'period') as IncentivePeriod;
  const body: AdminIncentiveRuleBody = {
    name: field(fd, 'name'),
    kind,
    zoneId: orNull(field(fd, 'zoneId')),
    vehicleCategoryId: orNull(field(fd, 'vehicleCategoryId')),
    window: windowFrom(fd),
    period: INCENTIVE_PERIODS.includes(period) ? period : null,
    targetRides: num(field(fd, 'targetRides')),
    bonusNpr: Number(field(fd, 'bonusNpr')),
    isActive: field(fd, 'isActive') === 'on',
    reason: field(fd, 'reason'),
  };
  const token = await requireAdminAccessToken();
  try {
    await saveIncentiveRule(token, orNull(field(fd, 'id')), body);
  } catch (e) {
    return actionFailure(e);
  }
  revalidatePath('/operations/incentives');
  return { done: 'Bonus rule saved.' };
}
