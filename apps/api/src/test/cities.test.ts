import {
  CITY_OVERRIDABLE_SETTINGS,
  CITY_STATUS_TRANSITIONS,
  PROVINCES,
  cityOverridableDefs,
  cityServiceState,
  describeCityClosed,
  describeCityHours,
  localParts,
  type AdminPermission,
  type CityDetail,
} from '@yatri/types';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { cityAtPoint, dropCityCache } from '../modules/cities/cities.service';
import { cancellationRulesFor, pricingConfigFor } from '../modules/cities/city-rules';
import { findEligibleDrivers } from '../modules/dispatch/matching';
import { dropZoneCache } from '../modules/operations/zones.service';
import { pricingConfig } from '../modules/pricing/pricing.config';
import { api, createVerifiedDriver, loginTestAdmin, onboardUser } from './helpers';
import { PATAN, THAMEL, acceptCurrentOffer, auth, forceDriverOnline } from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
const POKHARA = {
  latitude: 28.2096,
  longitude: 83.9856,
  address: 'Lakeside, Pokhara',
  name: 'Lakeside',
};
const POKHARA_2 = {
  latitude: 28.2192,
  longitude: 83.9889,
  address: 'Bagar, Pokhara',
  name: 'Bagar',
};

async function admin(permissions: AdminPermission[]) {
  const email = `city-admin-${Date.now()}-${++n}@example.com`;
  return loginTestAdmin(email, 'a-strong-test-password-1', permissions);
}
const get = (t: string, path: string) => api.get(`/api/v1/admin/cities${path}`).set(auth(t));
const send = (m: 'post' | 'put', t: string, path: string, body: object) =>
  api[m](`/api/v1/admin/cities${path}`).set(auth(t)).send(body);

const box = (c: { latitude: number; longitude: number }, half: number) => {
  const dLat = half / 111_195;
  const dLng = dLat / Math.cos((c.latitude * Math.PI) / 180);
  return JSON.stringify([
    [c.latitude - dLat, c.longitude - dLng],
    [c.latitude - dLat, c.longitude + dLng],
    [c.latitude + dLat, c.longitude + dLng],
    [c.latitude + dLat, c.longitude - dLng],
  ]);
};
async function zone(
  code: string,
  kind: string,
  centre: { latitude: number; longitude: number },
  half: number,
  priority = 0,
) {
  const r = await pool.query(
    `INSERT INTO service_zones (code, name, kind, polygon, priority) VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
    [code, `${code} zone`, kind, box(centre, half), priority],
  );
  dropZoneCache();
  return r.rows[0].id as string;
}
const cityBody = (over: Record<string, unknown> = {}) => ({
  code: `CITY_${Date.now() % 100000}_${++n}`,
  name: 'Testville',
  provinceCode: 'BAGMATI',
  centerLatitude: 27.7,
  centerLongitude: 85.3,
  timeZone: 'Asia/Kathmandu',
  reason: 'Set up the city',
  ...over,
});
async function makeCity(t: string, over: Record<string, unknown> = {}) {
  const r = await send('post', t, '', cityBody(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as CityDetail;
}
const act = async (t: string, id: string, path: string, body: Record<string, unknown>) => {
  const cur = (await get(t, `/${id}`)).body.data as CityDetail;
  return send('put', t, `/${id}${path}`, {
    expectedVersion: cur.version,
    reason: 'A change for the test',
    ...body,
  });
};
/** An open city with a boundary around a place. */
async function openCity(
  t: string,
  name: string,
  centre: { latitude: number; longitude: number },
  half = 9000,
  over: Record<string, unknown> = {},
) {
  const c = await makeCity(t, {
    name,
    centerLatitude: centre.latitude,
    centerLongitude: centre.longitude,
    ...over,
  });
  const zoneId = await zone(`Z_${c.code}`, 'SERVICE_AREA', centre, half);
  expect((await act(t, c.id, '/zones', { zones: { [zoneId]: true } })).status).toBe(200);
  expect((await act(t, c.id, '/status', { to: 'ACTIVE' })).status).toBe(200);
  return { id: c.id, code: c.code, zoneId };
}
const hereNow = (tz = 'Asia/Kathmandu') => localParts(new Date(), tz);
const estimate = (
  token: string,
  pickup: object,
  destination: object,
  extra: Record<string, unknown> = {},
) =>
  api
    .post('/api/v1/trips/estimate')
    .set(auth(token))
    .send({ pickup, destination, ...extra });
const place = (p: { latitude: number; longitude: number; address?: string; name?: string }) => ({
  latitude: p.latitude,
  longitude: p.longitude,
  address: p.address ?? 'A place',
  ...(p.name ? { name: p.name } : {}),
});
const request = (token: string, pickup: object, destination: object, category = 'CAR') =>
  api
    .post('/api/v1/trips/request')
    .set(auth(token))
    .send({ pickup, destination, vehicleCategory: category });

// ---------------------------------------------------------------- the definitions

describe('city definitions', () => {
  it('lists the seven provinces and a status table with one way into each state', () => {
    expect(PROVINCES).toHaveLength(7);
    expect(new Set(PROVINCES.map((p) => p.code)).size).toBe(7);
    expect(CITY_STATUS_TRANSITIONS.COMING_SOON).toEqual(['ACTIVE']);
    expect(CITY_STATUS_TRANSITIONS.ACTIVE).toEqual(['PAUSED']);
    expect(CITY_STATUS_TRANSITIONS.PAUSED).toEqual(['ACTIVE']);
  });

  it('decides whether service is on from status and hours, using the one window rule', () => {
    const at = new Date('2026-10-05T04:30:00Z'); // Monday 10:15 in Kathmandu (UTC+5:45)
    const base = { timeZone: 'Asia/Kathmandu', at };
    expect(cityServiceState({ ...base, status: 'ACTIVE', hours: [] })).toEqual({ open: true });
    expect(cityServiceState({ ...base, status: 'COMING_SOON', hours: [] })).toEqual({
      open: false,
      reason: 'COMING_SOON',
    });
    expect(cityServiceState({ ...base, status: 'PAUSED', hours: [] })).toEqual({
      open: false,
      reason: 'PAUSED',
    });
    const day = { daysOfWeek: [1, 2, 3, 4, 5], startMinute: 6 * 60, endMinute: 22 * 60 };
    expect(cityServiceState({ ...base, status: 'ACTIVE', hours: [day] })).toEqual({ open: true });
    expect(
      cityServiceState({ ...base, status: 'ACTIVE', hours: [{ ...day, daysOfWeek: [6, 7] }] }),
    ).toEqual({ open: false, reason: 'CLOSED_FOR_NOW' });
    expect(
      cityServiceState({ ...base, status: 'ACTIVE', hours: [{ ...day, startMinute: 11 * 60 }] }),
    ).toEqual({ open: false, reason: 'CLOSED_FOR_NOW' });
    // a second window opens it; an overnight window works
    expect(
      cityServiceState({
        ...base,
        status: 'ACTIVE',
        hours: [
          { ...day, startMinute: 11 * 60 },
          { daysOfWeek: null, startMinute: 10 * 60, endMinute: 11 * 60 },
        ],
      }).open,
    ).toBe(true);
    expect(
      cityServiceState({
        ...base,
        status: 'ACTIVE',
        hours: [{ daysOfWeek: null, startMinute: 22 * 60, endMinute: 11 * 60 }],
      }).open,
    ).toBe(true);
  });

  it('says hours and closures in words', () => {
    expect(describeCityHours([])).toBe('Open all day, every day');
    expect(describeCityHours([{ daysOfWeek: null, startMinute: 360, endMinute: 1320 }])).toBe(
      'Every day, 06:00 to 22:00',
    );
    expect(
      describeCityHours([
        { daysOfWeek: [1, 2], startMinute: 480, endMinute: 1080 },
        { daysOfWeek: [6], startMinute: null, endMinute: null },
      ]),
    ).toContain('Saturday');
    const c = { name: 'Pokhara', hoursText: 'Every day, 06:00 to 22:00' };
    expect(describeCityClosed(c, 'COMING_SOON')).toBe('Yatri is not open in Pokhara yet.');
    expect(describeCityClosed(c, 'PAUSED')).toMatch(/paused in Pokhara/);
    expect(describeCityClosed(c, 'CLOSED_FOR_NOW')).toBe(
      'Yatri is closed in Pokhara right now. We run every day, 06:00 to 22:00.',
    );
  });

  it('lets a city override only fare, waiting and cancellation values, each defined by its platform setting', () => {
    expect([...CITY_OVERRIDABLE_SETTINGS].sort()).toEqual(
      [
        'CANCEL_FEE_NPR',
        'CANCEL_FREE_SECONDS',
        'FARE_BASE_NPR',
        'FARE_MINIMUM_NPR',
        'FARE_PER_KM_NPR',
        'FARE_PER_MINUTE_NPR',
        'NO_SHOW_AFTER_SECONDS',
        'WAITING_FREE_SECONDS',
        'WAITING_PER_MINUTE_NPR',
      ].sort(),
    );
    expect(cityOverridableDefs().map((d) => d.key)).toEqual([...CITY_OVERRIDABLE_SETTINGS]);
    for (const d of cityOverridableDefs()) expect(['int', 'number']).toContain(d.kind);
    // with no city, the values are the platform's, unchanged
    expect(pricingConfigFor(null)).toEqual(pricingConfig());
    expect(cancellationRulesFor(null).feeNpr).toBeGreaterThanOrEqual(0);
  });
});

describe('no city is named in the code', () => {
  it('has no hard-coded city centre in the apps or the shared packages: the map starts where the platform says', () => {
    const roots = [
      'apps/passenger/src',
      'apps/driver/src',
      'apps/admin/src',
      'packages/mobile-location/src',
      'packages/mobile-ride/src',
      'packages/mobile-business/src',
      'packages/mobile-preferences/src',
    ];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) {
          if (/27\.71\d*\s*,\s*85\.3\d*/.test(readFileSync(p, 'utf8'))) hits.push(p);
        }
      }
    };
    for (const r of roots) walk(path.resolve(__dirname, '../../../..', r));
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------- administration and authorization

describe('city administration and authorization', () => {
  it('creates and edits a city with validation, versions and an audit entry', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const c = await makeCity(t, { name: 'Biratnagar', provinceCode: 'KOSHI' });
    expect(c).toMatchObject({
      name: 'Biratnagar',
      provinceName: 'Koshi',
      status: 'COMING_SOON',
      version: 1,
      openNow: false,
    });
    expect(c.hoursText).toBe('Open all day, every day');
    expect(c.categories.every((k) => k.enabled)).toBe(true);
    expect(c.settings.map((s) => s.cityValue)).toEqual(Array(9).fill(null));
    for (const bad of [
      { code: 'lower' },
      { name: 'X' },
      { provinceCode: 'ATLANTIS' },
      { centerLatitude: 95 },
      { timeZone: 'Not/AZone' },
      { reason: 'x' },
      { extra: true },
    ]) {
      expect((await send('post', t, '', cityBody(bad))).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await send('post', t, '', cityBody({ code: c.code }))).status).toBe(409);
    const edited = await send('put', t, `/${c.id}`, {
      ...cityBody({ code: c.code, name: 'Biratnagar City' }),
      expectedVersion: 1,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body.data).toMatchObject({ name: 'Biratnagar City', version: 2 });
    expect(
      (await send('put', t, `/${c.id}`, { ...cityBody({ code: c.code }), expectedVersion: 1 }))
        .status,
    ).toBe(409);
    const log = await pool.query(
      "SELECT action, detail FROM audit_log WHERE subject_type = 'city' ORDER BY id",
    );
    expect(log.rows.map((r) => r.action)).toEqual(['CITY_CREATED', 'CITY_UPDATED']);
    expect(log.rows[1].detail.reason).toBe('Set up the city');
  });

  it('opens each read to OPERATIONS_VIEW and each change to DISPATCH_MANAGE only', async () => {
    const manager = await admin(['DISPATCH_MANAGE']);
    const viewer = await admin(['OPERATIONS_VIEW']);
    const nobody = await admin(['USERS_VIEW']);
    const passenger = await onboardUser('PASSENGER');
    const c = await makeCity(manager);
    for (const path of ['', `/${c.id}`, `/${c.id}/analytics`]) {
      expect((await api.get(`/api/v1/admin/cities${path}`)).status, path).toBe(401);
      expect((await get(passenger.accessToken, path)).status, path).toBe(403);
      expect((await get(nobody, path)).status, path).toBe(403);
      expect((await get(viewer, path)).status, path).toBe(200);
      expect((await get(manager, path)).status, path).toBe(200);
    }
    const writes: Array<['post' | 'put', string, object]> = [
      ['post', '', cityBody()],
      ['put', `/${c.id}`, { ...cityBody(), expectedVersion: 1 }],
      ['put', `/${c.id}/status`, { to: 'ACTIVE', expectedVersion: 1, reason: 'open it' }],
      ['put', `/${c.id}/hours`, { windows: [], expectedVersion: 1, reason: 'hours' }],
      ['put', `/${c.id}/categories`, { categories: {}, expectedVersion: 1, reason: 'categories' }],
      ['put', `/${c.id}/payments`, { methods: {}, expectedVersion: 1, reason: 'payments' }],
      ['put', `/${c.id}/settings`, { settings: {}, expectedVersion: 1, reason: 'settings' }],
      [
        'put',
        `/${c.id}/documents`,
        { documentTypeIds: [], expectedVersion: 1, reason: 'documents' },
      ],
      ['put', `/${c.id}/zones`, { zones: {}, expectedVersion: 1, reason: 'zones' }],
    ];
    for (const [m, path, body] of writes) {
      expect((await send(m, viewer, path, body)).status, `viewer ${path}`).toBe(403);
      expect((await send(m, nobody, path, body)).status, `nobody ${path}`).toBe(403);
      expect((await send(m, passenger.accessToken, path, body)).status, `rider ${path}`).toBe(403);
    }
    expect(
      (
        await send('put', manager, '/00000000-0000-4000-8000-000000000001/hours', {
          windows: [],
          expectedVersion: 1,
          reason: 'nothing',
        })
      ).status,
    ).toBe(404);
    // nothing changed
    expect(((await get(manager, `/${c.id}`)).body.data as CityDetail).version).toBe(1);
  });

  it('lets exactly one of two simultaneous edits through, and counts versions one by one', async () => {
    const a = await admin(['DISPATCH_MANAGE']);
    const b = await admin(['DISPATCH_MANAGE']);
    const c = await openCity(a, 'Concurrent', THAMEL);
    const v = ((await get(a, `/${c.id}`)).body.data as CityDetail).version;
    const [x, y] = await Promise.all([
      send('put', a, `/${c.id}/settings`, {
        settings: { FARE_BASE_NPR: 100 },
        expectedVersion: v,
        reason: 'Raise the base fare',
      }),
      send('put', b, `/${c.id}/settings`, {
        settings: { FARE_BASE_NPR: 120 },
        expectedVersion: v,
        reason: 'Raise it more',
      }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(((await get(a, `/${c.id}`)).body.data as CityDetail).version).toBe(v + 1);
    const hours = await Promise.all([
      send('put', a, `/${c.id}/hours`, {
        windows: [],
        expectedVersion: v + 1,
        reason: 'Open all day',
      }),
      send('put', b, `/${c.id}/categories`, {
        categories: {},
        expectedVersion: v + 1,
        reason: 'No change really',
      }),
    ]);
    expect(hours.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

// ---------------------------------------------------------------- boundaries: many cities, one geofence

describe('service boundaries and many cities', () => {
  it('puts a place in the city whose boundary holds it, from the existing zones, for any number of cities', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const ktm = await openCity(t, 'Kathmandu', THAMEL);
    const pkr = await openCity(t, 'Pokhara', POKHARA, 6000);
    dropCityCache();
    expect((await cityAtPoint(THAMEL)).city?.info.name).toBe('Kathmandu');
    expect((await cityAtPoint(PATAN)).city?.info.name).toBe('Kathmandu');
    expect((await cityAtPoint(POKHARA)).city?.info.name).toBe('Pokhara');
    expect((await cityAtPoint({ latitude: 26.4, longitude: 87.3 })).city).toBeNull();
    // a third city is data, not code
    const bir = await openCity(t, 'Biratnagar', { latitude: 26.4525, longitude: 87.2718 }, 5000, {
      provinceCode: 'KOSHI',
    });
    dropCityCache();
    expect((await cityAtPoint({ latitude: 26.4525, longitude: 87.2718 })).city?.info.id).toBe(
      bir.id,
    );
    expect(ktm.id).not.toBe(pkr.id);
    // the highest-priority boundary wins where two overlap
    const inner = await zone('INNER', 'CITY', THAMEL, 1500, 50);
    await act(t, pkr.id, '/zones', { zones: { [inner]: true } });
    dropCityCache();
    expect((await cityAtPoint(THAMEL)).city?.info.name).toBe('Pokhara');
    expect((await cityAtPoint(PATAN)).city?.info.name).toBe('Kathmandu');
  });

  it('keeps platform-wide rules for a service area that belongs to no city', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    await zone('WIDE_AREA', 'SERVICE_AREA', THAMEL, 12000);
    dropCityCache();
    expect(await cityAtPoint(THAMEL)).toMatchObject({ city: null, platformWide: true });
    const p = await onboardUser('PASSENGER');
    expect((await estimate(p.accessToken, place(THAMEL), place(PATAN))).status).toBe(200);
    expect(t).toBeTruthy();
  });

  it('tells the apps which city a place is in, and why service is not there, without signing in', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const c = await openCity(t, 'Pokhara', POKHARA, 6000);
    const at = (p: { latitude: number; longitude: number }) =>
      api.get(`/api/v1/config/service-at?latitude=${p.latitude}&longitude=${p.longitude}`);
    const here = await at(POKHARA);
    expect(here.status).toBe(200);
    expect(here.body.data.city).toMatchObject({
      name: 'Pokhara',
      openNow: true,
      provinceName: 'Bagmati',
    });
    expect(here.body.data.unavailableMessage).toBeNull();
    expect((await at(THAMEL)).body.data.city).toBeNull();
    expect((await act(t, c.id, '/status', { to: 'PAUSED' })).status).toBe(200);
    const paused = await at(POKHARA);
    expect(paused.body.data.unavailableMessage).toMatch(/paused in Pokhara/);
    expect((await api.get('/api/v1/config/service-at?latitude=abc&longitude=1')).status).toBe(400);
    const cfg = (await api.get('/api/v1/config/platform')).body.data;
    expect(cfg.cities).toHaveLength(1);
    expect(cfg.cities[0]).toMatchObject({ name: 'Pokhara', status: 'PAUSED', openNow: false });
    expect(cfg.cities[0].vehicleCategories.length).toBeGreaterThan(0);
    expect(cfg.cities[0].paymentMethods).toEqual(['CASH']);
    expect(JSON.stringify(cfg.cities)).not.toMatch(/FARE_|settings|zone/i);
  });

  it('assigns only boundary zones to a city, moves them between cities and keeps an open city bounded', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const a = await openCity(t, 'City A', THAMEL);
    const b = await makeCity(t, { name: 'City B' });
    const airport = await zone('AIR', 'AIRPORT', THAMEL, 500);
    const bad = await act(t, a.id, '/zones', { zones: { [airport]: true } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('NOT_A_BOUNDARY');
    // the open city cannot lose its last boundary
    const refused = await act(t, a.id, '/zones', { zones: { [a.zoneId]: false } });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('NO_SERVICE_AREA');
    // a city with no boundary cannot be opened
    const noArea = await act(t, b.id, '/status', { to: 'ACTIVE' });
    expect(noArea.status).toBe(409);
    expect(noArea.body.error.code).toBe('NO_SERVICE_AREA');
    // moving a zone to another city
    expect((await act(t, b.id, '/zones', { zones: { [a.zoneId]: true } })).status).toBe(200);
    const detail = (await get(t, `/${b.id}`)).body.data as CityDetail;
    expect(detail.zones.find((z) => z.id === a.zoneId)).toMatchObject({ inThisCity: true });
    expect(
      ((await get(t, `/${a.id}`)).body.data as CityDetail).zones.find((z) => z.id === a.zoneId),
    ).toMatchObject({ inThisCity: false, otherCityName: 'City B' });
    expect(
      (await act(t, b.id, '/zones', { zones: { '00000000-0000-4000-8000-0000000000aa': true } }))
        .status,
    ).toBe(400);
  });

  it('refuses illegal status moves', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const c = await makeCity(t);
    for (const to of ['PAUSED', 'COMING_SOON']) {
      const r = await act(t, c.id, '/status', { to });
      expect(r.status, to).toBe(409);
      expect(r.body.error.code).toBe('ILLEGAL_MOVE');
    }
  });
});

// ---------------------------------------------------------------- rides cannot be made where service is unavailable

describe('rides and service availability', () => {
  it('refuses rides in a city that is coming soon, paused, or closed for now, with the words for it', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const c = await openCity(t, 'Kathmandu', THAMEL);
    const p = await onboardUser('PASSENGER');
    const ok = await estimate(p.accessToken, place(THAMEL), place(PATAN));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);

    expect((await act(t, c.id, '/status', { to: 'PAUSED' })).status).toBe(200);
    for (const call of [
      () => estimate(p.accessToken, place(THAMEL), place(PATAN)),
      () => request(p.accessToken, place(THAMEL), place(PATAN)),
    ]) {
      const r = await call();
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('SERVICE_UNAVAILABLE_HERE');
      expect(r.body.error.message).toMatch(/paused in Kathmandu/);
    }
    expect((await pool.query('SELECT count(*)::int AS n FROM trips')).rows[0].n).toBe(0); // nothing was created

    expect((await act(t, c.id, '/status', { to: 'ACTIVE' })).status).toBe(200);
    // closed for now: a one-minute window that is not now
    const m = hereNow();
    const start = (m.minute + 180) % 1440;
    expect(
      (
        await act(t, c.id, '/hours', {
          windows: [{ daysOfWeek: null, startMinute: start, endMinute: (start + 1) % 1440 }],
        })
      ).status,
    ).toBe(200);
    const closed = await request(p.accessToken, place(THAMEL), place(PATAN));
    expect(closed.status).toBe(422);
    expect(closed.body.error.code).toBe('OUTSIDE_OPERATING_HOURS');
    expect(closed.body.error.message).toMatch(/closed in Kathmandu right now/);
    expect(closed.body.error.details.hours).toBeTruthy();
    // a window that contains now opens it again
    const around = [
      {
        daysOfWeek: null,
        startMinute: Math.max(0, m.minute - 30),
        endMinute: Math.min(1440, m.minute + 30),
      },
    ];
    if (m.minute >= 30 && m.minute <= 1410) {
      expect((await act(t, c.id, '/hours', { windows: around })).status).toBe(200);
      expect((await estimate(p.accessToken, place(THAMEL), place(PATAN))).status).toBe(200);
    }
    // no hours at all is open all day
    expect((await act(t, c.id, '/hours', { windows: [] })).status).toBe(200);
    expect((await request(p.accessToken, place(THAMEL), place(PATAN))).status).toBe(201);
  });

  it('refuses a ride that would cross from one city into another, and one that ends outside every area', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    await openCity(t, 'Kathmandu', THAMEL);
    await openCity(t, 'Pokhara', POKHARA, 6000);
    const p = await onboardUser('PASSENGER');
    for (const call of [
      () => estimate(p.accessToken, place(THAMEL), place(POKHARA)),
      () => request(p.accessToken, place(THAMEL), place(POKHARA)),
      () => request(p.accessToken, place(POKHARA), place(THAMEL)),
    ]) {
      const r = await call();
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('CROSS_CITY_RIDE');
      expect(r.body.error.message).toMatch(/inside one city/);
    }
    // outside every service area is the zones' own refusal
    const out = await request(
      p.accessToken,
      place(THAMEL),
      place({ latitude: 26.4, longitude: 87.3 }),
    );
    expect(out.status).toBe(422);
    expect(out.body.error.code).toBe('OUTSIDE_SERVICE_AREA');
    // inside one city is fine in both
    expect((await request(p.accessToken, place(POKHARA), place(POKHARA_2))).status).toBe(201);
    expect((await pool.query('SELECT count(*)::int AS n FROM trips')).rows[0].n).toBe(1);
  });

  it('records the city on the ride, and a business booking is held to the same rules', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const c = await openCity(t, 'Kathmandu', THAMEL);
    const p = await onboardUser('PASSENGER');
    const r = await request(p.accessToken, place(THAMEL), place(PATAN));
    expect(r.status).toBe(201);
    expect(
      (await pool.query('SELECT city_id FROM trips WHERE id = $1', [r.body.data.id])).rows[0]
        .city_id,
    ).toBe(c.id);
    await act(t, c.id, '/status', { to: 'PAUSED' });
    const org = await api
      .post('/api/v1/organizations')
      .set(auth(p.accessToken))
      .send({ name: 'Acme Travel' });
    expect(org.status).toBe(201);
    await api.post(`/api/v1/trips/${r.body.data.id}/cancel`).set(auth(p.accessToken)).send({});
    const b = await api
      .post(`/api/v1/organizations/${org.body.data.id}/bookings`)
      .set(auth(p.accessToken))
      .send({ pickup: place(THAMEL), destination: place(PATAN), vehicleCategory: 'CAR' });
    expect(b.status).toBe(422);
    expect(b.body.error.code).toBe('SERVICE_UNAVAILABLE_HERE');
  });
});

// ---------------------------------------------------------------- city-specific configuration

describe('city-specific vehicle, fare, cancellation, payment and driver rules', () => {
  it('offers only the vehicle types a city offers, and never lets a city offer none', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const a = await openCity(t, 'Kathmandu', THAMEL);
    const b = await openCity(t, 'Pokhara', POKHARA, 6000);
    const p = await onboardUser('PASSENGER');
    const suv = (await pool.query("SELECT id FROM vehicle_categories WHERE code = 'SUV'")).rows[0]
      .id as string;
    const codes = async (pickup: object, dest: object) =>
      (
        (await estimate(p.accessToken, pickup, dest)).body.data.categories as Array<{
          code: string;
        }>
      ).map((o) => o.code);
    expect(await codes(place(THAMEL), place(PATAN))).toContain('SUV');
    expect((await act(t, a.id, '/categories', { categories: { [suv]: false } })).status).toBe(200);
    expect(await codes(place(THAMEL), place(PATAN))).not.toContain('SUV');
    expect(await codes(place(POKHARA), place(POKHARA_2))).toContain('SUV'); // the other city is unaffected
    const r = await request(p.accessToken, place(THAMEL), place(PATAN), 'SUV');
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('CATEGORY_NOT_OFFERED_HERE');
    const cfg = (await api.get('/api/v1/config/platform')).body.data.cities as Array<{
      name: string;
      vehicleCategories: string[];
    }>;
    expect(cfg.find((c) => c.name === 'Kathmandu')!.vehicleCategories).not.toContain('SUV');
    expect(cfg.find((c) => c.name === 'Pokhara')!.vehicleCategories).toContain('SUV');
    // not all of them
    const all = Object.fromEntries(
      ((await get(t, `/${a.id}`)).body.data as CityDetail).categories.map((k) => [
        k.categoryId,
        false,
      ]),
    );
    const none = await act(t, a.id, '/categories', { categories: all });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('NO_CATEGORY');
    expect((await act(t, a.id, '/categories', { categories: { [suv]: true } })).status).toBe(200);
    expect(await codes(place(THAMEL), place(PATAN))).toContain('SUV');
    expect(b.id).toBeTruthy();
  });

  it('prices a city with its own fare values and leaves other cities and the platform alone', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const a = await openCity(t, 'Kathmandu', THAMEL);
    await openCity(t, 'Pokhara', POKHARA, 6000);
    const p = await onboardUser('PASSENGER');
    const fare = async (pickup: object, dest: object) => {
      const r = await estimate(p.accessToken, pickup, dest, { vehicleCategory: 'CAR' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body.data as {
        fare: { totalNpr: number; baseNpr: number };
        waitingRule: { freeSeconds: number; perMinuteNpr: number };
      };
    };
    const before = await fare(place(THAMEL), place(PATAN));
    const pokharaBefore = await fare(place(POKHARA), place(POKHARA_2));
    const set = await act(t, a.id, '/settings', {
      settings: {
        FARE_BASE_NPR: before.fare.baseNpr + 200,
        FARE_MINIMUM_NPR: 100,
        WAITING_FREE_SECONDS: 30,
        WAITING_PER_MINUTE_NPR: 9,
      },
    });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(
      (set.body.data as CityDetail).settings.find((s) => s.key === 'FARE_BASE_NPR'),
    ).toMatchObject({ cityValue: before.fare.baseNpr + 200, platformValue: before.fare.baseNpr });
    const after = await fare(place(THAMEL), place(PATAN));
    expect(after.fare.totalNpr - before.fare.totalNpr).toBe(200);
    expect(after.waitingRule).toEqual({ freeSeconds: 30, perMinuteNpr: 9 });
    expect(await fare(place(POKHARA), place(POKHARA_2))).toEqual(pokharaBefore); // another city: unchanged
    expect(pricingConfig().baseNpr).toBe(before.fare.baseNpr); // the platform value: unchanged
    // the ride is requested at the city's price
    const r = await request(p.accessToken, place(THAMEL), place(PATAN));
    expect(r.status).toBe(201);
    expect(r.body.data.fare.estimateNpr).toBe(after.fare.totalNpr);
    // putting a value back to null inherits again
    expect((await act(t, a.id, '/settings', { settings: { FARE_BASE_NPR: null } })).status).toBe(
      200,
    );
    await api.post(`/api/v1/trips/${r.body.data.id}/cancel`).set(auth(p.accessToken)).send({});
    expect((await fare(place(THAMEL), place(PATAN))).fare.totalNpr).toBe(before.fare.totalNpr);
  });

  it('checks a city value with the platform setting’s own rules, and refuses anything else', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const c = await makeCity(t);
    for (const settings of [
      { FARE_BASE_NPR: -5 },
      { FARE_BASE_NPR: 1.5 },
      { FARE_BASE_NPR: 99999999 },
      { SERVICE_REQUESTS_ENABLED: 1 },
      { FARE_NOT_A_SETTING: 1 },
      { DISPATCH_RADIUS_METERS: 100 },
    ]) {
      expect((await act(t, c.id, '/settings', { settings })).status, JSON.stringify(settings)).toBe(
        400,
      );
    }
    expect(
      ((await get(t, `/${c.id}`)).body.data as CityDetail).settings.every(
        (s) => s.cityValue === null,
      ),
    ).toBe(true);
  });

  it('applies a city’s cancellation rule to the rides of that city only', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const a = await openCity(t, 'Kathmandu', THAMEL);
    await openCity(t, 'Pokhara', POKHARA, 6000);
    expect(
      (
        await act(t, a.id, '/settings', {
          settings: { CANCEL_FREE_SECONDS: 0, CANCEL_FEE_NPR: 70 },
        })
      ).status,
    ).toBe(200);
    const feeFor = async (
      pickup: { latitude: number; longitude: number; address: string },
      dest: object,
    ) => {
      const p = await onboardUser('PASSENGER');
      const d = await onboardUser('DRIVER');
      await forceDriverOnline(d.user.id as string, {
        latitude: pickup.latitude + 0.002,
        longitude: pickup.longitude,
      });
      const r = await request(p.accessToken, pickup, dest);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect((await acceptCurrentOffer(d.accessToken)).status).toBe(200);
      await pool.query("UPDATE trips SET matched_at = now() - interval '5 minutes' WHERE id = $1", [
        r.body.data.id,
      ]);
      const c = await api
        .post(`/api/v1/trips/${r.body.data.id}/cancel`)
        .set(auth(p.accessToken))
        .send({});
      expect(c.status, JSON.stringify(c.body)).toBe(200);
      return (
        await pool.query('SELECT cancellation_fee_npr FROM trips WHERE id = $1', [r.body.data.id])
      ).rows[0].cancellation_fee_npr as number;
    };
    expect(cancellationRulesFor(null).feeNpr).not.toBe(70);
    expect(await feeFor(place(THAMEL), place(PATAN))).toBe(70);
    expect(await feeFor(place(POKHARA), place(POKHARA_2))).toBe(cancellationRulesFor(null).feeNpr); // the platform's fee applies elsewhere
  }, 90_000);

  it('offers the payment methods a city offers and never none', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const c = await openCity(t, 'Kathmandu', THAMEL);
    const detail = (await get(t, `/${c.id}`)).body.data as CityDetail;
    expect(detail.paymentMethods).toEqual([{ method: 'CASH', enabled: true }]);
    const none = await act(t, c.id, '/payments', { methods: { CASH: false } });
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('NO_PAYMENT_METHOD');
    expect((await act(t, c.id, '/payments', { methods: { ORGANIZATION: false } })).status).toBe(
      400,
    ); // a business pays by its own policy
    expect((await act(t, c.id, '/payments', { methods: { CASH: true } })).status).toBe(200);
  });

  it('asks a driver for the documents the city requires, and for the city to be open, before they go online', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const c = await openCity(t, 'Kathmandu', THAMEL);
    const { driver } = await createVerifiedDriver();
    const online = () =>
      api.post('/api/v1/drivers/me/availability/online').set(auth(driver.accessToken)).send({
        latitude: THAMEL.latitude,
        longitude: THAMEL.longitude,
        accuracyMeters: 8,
        deviceTimeMs: Date.now(),
      });
    const type = await pool.query(
      `INSERT INTO document_types (code, label, owner_type, is_required) VALUES ($1, 'City taxi permit', 'DRIVER', false) RETURNING id`,
      [`PERMIT_${Date.now()}`],
    );
    const typeId = type.rows[0].id as string;
    try {
      expect((await act(t, c.id, '/documents', { documentTypeIds: [typeId] })).status).toBe(200);
      const refused = await online();
      expect(refused.status).toBe(403);
      expect(refused.body.error.details.reasons.join(' ')).toMatch(
        /Kathmandu also needs your City taxi permit/,
      );
      await pool.query(
        `INSERT INTO documents (owner_type, driver_user_id, document_type_id, storage_key, original_filename, mime_type, file_size, status)
         VALUES ('DRIVER', $1, $2, 'k', 'p.pdf', 'application/pdf', 10, 'APPROVED')`,
        [driver.user.id, typeId],
      );
      const ok = await online();
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      await api.post('/api/v1/drivers/me/availability/offline').set(auth(driver.accessToken));
      // a paused city does not let them start work, and says why
      await act(t, c.id, '/status', { to: 'PAUSED' });
      const paused = await online();
      expect(paused.status).toBe(403);
      expect(paused.body.error.details.reasons.join(' ')).toMatch(/paused in Kathmandu/);
    } finally {
      await pool.query('DELETE FROM city_requirements WHERE document_type_id = $1', [typeId]);
      await pool.query('DELETE FROM documents WHERE document_type_id = $1', [typeId]);
      await pool.query('DELETE FROM document_types WHERE id = $1', [typeId]);
    }
  }, 120_000);

  it('offers a ride only to drivers who are in the same city', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    await openCity(t, 'Kathmandu', THAMEL);
    await openCity(t, 'Pokhara', POKHARA, 6000);
    const near = await onboardUser('DRIVER');
    const far = await onboardUser('DRIVER');
    await forceDriverOnline(near.user.id as string, {
      latitude: THAMEL.latitude + 0.002,
      longitude: THAMEL.longitude,
    });
    await forceDriverOnline(far.user.id as string, {
      latitude: POKHARA.latitude,
      longitude: POKHARA.longitude,
    });
    const categoryId = (await pool.query("SELECT id FROM vehicle_categories WHERE code = 'CAR'"))
      .rows[0].id as string;
    const inKathmandu = await findEligibleDrivers({
      pickup: THAMEL,
      vehicleCategoryId: categoryId,
      radiusMeters: 400_000,
    });
    expect(inKathmandu.map((c) => c.driverId)).toEqual([near.user.id]);
    const inPokhara = await findEligibleDrivers({
      pickup: POKHARA,
      vehicleCategoryId: categoryId,
      radiusMeters: 400_000,
    });
    expect(inPokhara.map((c) => c.driverId)).toEqual([far.user.id]);
  });
});

// ---------------------------------------------------------------- operations and analytics

describe('city operations and analytics', () => {
  it('shows each city its own rides, drivers online and completion, over a range', async () => {
    const t = await admin(['DISPATCH_MANAGE']);
    const a = await openCity(t, 'Kathmandu', THAMEL);
    const b = await openCity(t, 'Pokhara', POKHARA, 6000);
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string, {
      latitude: THAMEL.latitude + 0.002,
      longitude: THAMEL.longitude,
    });
    for (let i = 0; i < 2; i++) {
      const p = await onboardUser('PASSENGER');
      const r = await request(p.accessToken, place(THAMEL), place(PATAN));
      expect(r.status).toBe(201);
      await api.post(`/api/v1/trips/${r.body.data.id}/cancel`).set(auth(p.accessToken)).send({});
    }
    const p2 = await onboardUser('PASSENGER');
    expect((await request(p2.accessToken, place(POKHARA), place(POKHARA_2))).status).toBe(201);
    const list = (await get(t, '')).body.data as Array<{
      id: string;
      ridesThisMonth: number;
      driversOnlineNow: number;
      zones: number;
      openNow: boolean;
    }>;
    expect(list.find((c) => c.id === a.id)).toMatchObject({
      ridesThisMonth: 2,
      driversOnlineNow: 1,
      zones: 1,
      openNow: true,
    });
    expect(list.find((c) => c.id === b.id)).toMatchObject({
      ridesThisMonth: 1,
      driversOnlineNow: 0,
    });
    const stats = (await get(t, `/${a.id}/analytics?range=30d`)).body.data;
    expect(stats).toMatchObject({
      rides: 2,
      cancelled: 2,
      completed: 0,
      driversOnlineNow: 1,
      completionRatePercent: 0,
    });
    expect(stats.byCategory.reduce((s: number, c: { rides: number }) => s + c.rides, 0)).toBe(2);
    expect(stats.range.label).toBeTruthy();
    expect((await get(t, `/${a.id}/analytics?from=2026-01-01`)).status).toBe(400);
    expect((await get(t, '/00000000-0000-4000-8000-000000000001/analytics')).status).toBe(404);
  }, 90_000);
});
