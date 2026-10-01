'use server';

import {
  CITY_STATUSES,
  CITY_OVERRIDABLE_SETTINGS,
  PROVINCE_CODES,
  type AdminCityBody,
  type CityHoursWindow,
  type CityStatus,
} from '@yatri/types';
import { revalidatePath } from 'next/cache';

import { ApiError, createCityApi, putCityApi } from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface CityActionState {
  error?: string;
  done?: string;
  /** Set when a city was just created, so the form can send the person to it. */
  createdId?: string;
}

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const num = (fd: FormData, name: string) => Number(field(fd, name));

/**
 * Every action only passes the administrator's choices to the API and shows what it answered. The API applies the
 * rules (the moves allowed, the version check, what a city may set) and writes the audit entry.
 */
async function run<T>(
  work: (token: string) => Promise<T>,
  done: string,
  paths: string[],
): Promise<CityActionState> {
  const token = await requireAdminAccessToken();
  try {
    await work(token);
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' };
  }
  for (const p of paths) revalidatePath(p);
  return { done };
}

const profile = (fd: FormData): AdminCityBody | { error: string } => {
  const provinceCode = field(fd, 'provinceCode') as AdminCityBody['provinceCode'];
  if (!PROVINCE_CODES.includes(provinceCode)) return { error: 'Choose a province.' };
  const centerLatitude = num(fd, 'centerLatitude');
  const centerLongitude = num(fd, 'centerLongitude');
  if (!Number.isFinite(centerLatitude) || !Number.isFinite(centerLongitude)) {
    return {
      error: 'Give the map centre as a latitude and a longitude, for example 27.7172 and 85.324.',
    };
  }
  return {
    code: field(fd, 'code').toUpperCase(),
    name: field(fd, 'name'),
    provinceCode,
    centerLatitude,
    centerLongitude,
    timeZone: field(fd, 'timeZone'),
    reason: field(fd, 'reason'),
  };
};

export async function createCityAction(
  _p: CityActionState,
  fd: FormData,
): Promise<CityActionState> {
  const body = profile(fd);
  if ('error' in body) return body;
  const token = await requireAdminAccessToken();
  try {
    const c = await createCityApi(token, body);
    revalidatePath('/cities');
    return { done: `${c.name} was added. Give it a service area, then open it.`, createdId: c.id };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' };
  }
}

export async function profileAction(_p: CityActionState, fd: FormData): Promise<CityActionState> {
  const body = profile(fd);
  if ('error' in body) return body;
  const id = field(fd, 'cityId');
  return run(
    (t) => putCityApi(t, id, '', { ...body, expectedVersion: num(fd, 'expectedVersion') }),
    'Saved.',
    [`/cities/${id}`, '/cities'],
  );
}

export async function cityStatusAction(
  _p: CityActionState,
  fd: FormData,
): Promise<CityActionState> {
  const to = field(fd, 'to') as CityStatus;
  if (!CITY_STATUSES.includes(to)) return { error: 'Choose what to do.' };
  const id = field(fd, 'cityId');
  return run(
    (t) =>
      putCityApi(t, id, '/status', {
        to,
        expectedVersion: num(fd, 'expectedVersion'),
        reason: field(fd, 'reason'),
      }),
    to === 'ACTIVE'
      ? 'The city is open.'
      : 'The city is paused. Riders and drivers are told when they try.',
    [`/cities/${id}`, '/cities'],
  );
}

/** Up to three opening windows: each has days, a start and an end; an empty row is ignored; none at all is open all day. */
export async function hoursAction(_p: CityActionState, fd: FormData): Promise<CityActionState> {
  const id = field(fd, 'cityId');
  const windows: CityHoursWindow[] = [];
  for (let i = 0; i < 3; i++) {
    const start = field(fd, `start${i}`);
    const end = field(fd, `end${i}`);
    const days = fd
      .getAll(`days${i}`)
      .map(Number)
      .filter((d) => d >= 1 && d <= 7);
    if (!start && !end && days.length === 0) continue;
    const minutes = (t: string) => (t ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);
    windows.push({
      daysOfWeek: days.length === 0 || days.length === 7 ? null : days,
      startMinute: minutes(start),
      endMinute: minutes(end),
    });
  }
  return run(
    (t) =>
      putCityApi(t, id, '/hours', {
        windows,
        expectedVersion: num(fd, 'expectedVersion'),
        reason: field(fd, 'reason'),
      }),
    windows.length === 0 ? 'Saved. The city is open all day, every day.' : 'Opening hours saved.',
    [`/cities/${id}`, '/cities'],
  );
}

/** A checkbox list: the ids shown (`all`) say which were offered, the ticked ones (`on`) say which are on. */
const ticks = (fd: FormData, all: string, on: string): Record<string, boolean> => {
  const ticked = new Set(fd.getAll(on).map(String));
  return Object.fromEntries(fd.getAll(all).map((v) => [String(v), ticked.has(String(v))]));
};

export async function categoriesAction(
  _p: CityActionState,
  fd: FormData,
): Promise<CityActionState> {
  const id = field(fd, 'cityId');
  return run(
    (t) =>
      putCityApi(t, id, '/categories', {
        categories: ticks(fd, 'shown', 'on'),
        expectedVersion: num(fd, 'expectedVersion'),
        reason: field(fd, 'reason'),
      }),
    'Vehicle types saved.',
    [`/cities/${id}`],
  );
}

export async function paymentsAction(_p: CityActionState, fd: FormData): Promise<CityActionState> {
  const id = field(fd, 'cityId');
  return run(
    (t) =>
      putCityApi(t, id, '/payments', {
        methods: ticks(fd, 'shown', 'on'),
        expectedVersion: num(fd, 'expectedVersion'),
        reason: field(fd, 'reason'),
      }),
    'Payment options saved.',
    [`/cities/${id}`],
  );
}

export async function zonesAction(_p: CityActionState, fd: FormData): Promise<CityActionState> {
  const id = field(fd, 'cityId');
  return run(
    (t) =>
      putCityApi(t, id, '/zones', {
        zones: ticks(fd, 'shown', 'on'),
        expectedVersion: num(fd, 'expectedVersion'),
        reason: field(fd, 'reason'),
      }),
    'The boundary was saved.',
    [`/cities/${id}`, '/cities', '/operations/zones'],
  );
}

export async function documentsAction(_p: CityActionState, fd: FormData): Promise<CityActionState> {
  const id = field(fd, 'cityId');
  return run(
    (t) =>
      putCityApi(t, id, '/documents', {
        documentTypeIds: fd.getAll('on').map(String),
        expectedVersion: num(fd, 'expectedVersion'),
        reason: field(fd, 'reason'),
      }),
    'Driver requirements saved.',
    [`/cities/${id}`],
  );
}

/** A blank box means "use the platform value"; a number is this city's own. */
export async function settingsAction(_p: CityActionState, fd: FormData): Promise<CityActionState> {
  const id = field(fd, 'cityId');
  const settings: Record<string, number | null> = {};
  for (const key of CITY_OVERRIDABLE_SETTINGS) {
    const raw = field(fd, key);
    if (raw === '') settings[key] = null;
    else if (!Number.isFinite(Number(raw)))
      return {
        error: `${key.replaceAll('_', ' ').toLowerCase()} must be a number, or empty to use the platform value.`,
      };
    else settings[key] = Number(raw);
  }
  return run(
    (t) =>
      putCityApi(t, id, '/settings', {
        settings,
        expectedVersion: num(fd, 'expectedVersion'),
        reason: field(fd, 'reason'),
      }),
    'Fare, waiting and cancellation values saved.',
    [`/cities/${id}`],
  );
}
