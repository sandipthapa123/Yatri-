import {
  DAY_NAMES,
  applySurge,
  checkZoneAccess,
  describeSurge,
  insideCoverage,
  periodKey,
  pointInPolygon,
  polygonFromText,
  polygonProblem,
  polygonToText,
  windowActive,
  windowProblem,
  type AdminPermission,
  type PolygonPoints,
  type TimeWindow,
  type ZoneDef,
} from '@yatri/types';
import { beforeEach, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import {
  etaWorkloadStrategy,
  findEligibleDrivers,
  matchDrivers,
  proximityStrategy,
  searchRadius,
} from '../modules/dispatch/matching';
import { dropDemandCache } from '../modules/operations/demand';
import { evaluateIncentives } from '../modules/operations/incentives.service';
import { dropPricingRuleCache } from '../modules/operations/pricing-rules.service';
import { pickSurge, type SurgeContext } from '../modules/operations/surge';
import { dropZoneCache } from '../modules/operations/zones.service';
import { estimateFare, finalFare } from '../modules/pricing/pricing';
import { pricingConfig } from '../modules/pricing/pricing.config';
import { pricingFor, getCategoryById } from '../modules/pricing/categories';
import { refreshSettings } from '../modules/settings/settings.service';
import { api, loginTestAdmin, onboardUser } from './helpers';
import {
  PATAN,
  THAMEL,
  auth,
  finishedRide,
  forceDriverOnline,
  north,
  requestRide,
  rideWorld,
} from './rides';

// ---------------------------------------------------------------- helpers

let n = 0;
async function admin(permissions: AdminPermission[] = ['OPERATIONS_VIEW', 'DISPATCH_MANAGE']) {
  const email = `ops-admin-${Date.now()}-${++n}@example.com`;
  const token = await loginTestAdmin(email, 'a-strong-test-password-1', permissions);
  const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  return { token, id: id as string };
}
const ops = (token: string, path: string) =>
  api.get(`/api/v1/admin/operations${path}`).set(auth(token));
const opsSend = (method: 'post' | 'put', token: string, path: string, body: object) =>
  api[method](`/api/v1/admin/operations${path}`).set(auth(token)).send(body);

/** A square boundary `half` metres from a centre. */
const box = (c: { latitude: number; longitude: number }, half: number): PolygonPoints => {
  const dLat = half / 111_195;
  const dLng = dLat / Math.cos((c.latitude * Math.PI) / 180);
  return [
    [c.latitude - dLat, c.longitude - dLng],
    [c.latitude - dLat, c.longitude + dLng],
    [c.latitude + dLat, c.longitude + dLng],
    [c.latitude + dLat, c.longitude - dLng],
  ];
};

const zoneBody = (over: Record<string, unknown> = {}) => ({
  code: 'THAMEL_AREA',
  name: 'Thamel area',
  kind: 'SERVICE_AREA',
  polygon: box(THAMEL, 6000),
  pickupAllowed: true,
  dropoffAllowed: true,
  note: null,
  priority: 0,
  isActive: true,
  reason: 'Set up the service area',
  ...over,
});
const makeZone = async (token: string, over: Record<string, unknown> = {}) => {
  const r = await opsSend('post', token, '/zones', zoneBody(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string };
};

const NO_WINDOW = {
  daysOfWeek: null,
  startMinute: null,
  endMinute: null,
  startsAt: null,
  endsAt: null,
};
const ruleBody = (over: Record<string, unknown> = {}) => ({
  name: 'Busy evening',
  label: 'Busy time',
  zoneId: null,
  vehicleCategoryId: null,
  window: NO_WINDOW,
  minDemandRatio: null,
  multiplier: 1.5,
  isActive: true,
  reason: 'Test rule',
  ...over,
});
const makeRule = async (token: string, over: Record<string, unknown> = {}) => {
  const r = await opsSend('post', token, '/pricing-rules', ruleBody(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string };
};

const estimate = (token: string, extra: Record<string, unknown> = {}) =>
  api
    .post('/api/v1/trips/estimate')
    .set(auth(token))
    .send({ pickup: THAMEL, destination: PATAN, vehicleCategory: 'CAR', ...extra });

async function setSetting(key: string, value: number | null) {
  if (value === null) await pool.query('DELETE FROM platform_settings WHERE key = $1', [key]);
  else {
    await pool.query(
      `INSERT INTO platform_settings (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb`,
      [key, JSON.stringify(value)],
    );
  }
  await refreshSettings();
}
const categoryId = async (code: string) =>
  (await pool.query('SELECT id FROM vehicle_categories WHERE code = $1', [code])).rows[0]
    .id as string;

beforeEach(() => {
  dropZoneCache();
  dropPricingRuleCache();
  dropDemandCache();
});

// ---------------------------------------------------------------- geometry, windows, money (pure)

describe('geometry: one point-in-polygon', () => {
  const square: PolygonPoints = [
    [0.001, 0.001],
    [0.001, 0.003],
    [0.003, 0.003],
    [0.003, 0.001],
  ];
  it('says inside, outside and on the edge (the edge counts as inside)', () => {
    expect(pointInPolygon({ latitude: 0.002, longitude: 0.002 }, square)).toBe(true);
    expect(pointInPolygon({ latitude: 0.004, longitude: 0.002 }, square)).toBe(false);
    expect(pointInPolygon({ latitude: 0.002, longitude: 0.0009 }, square)).toBe(false);
    expect(pointInPolygon({ latitude: 0.001, longitude: 0.002 }, square)).toBe(true); // on an edge
    expect(pointInPolygon({ latitude: 0.001, longitude: 0.001 }, square)).toBe(true); // on a corner
    expect(pointInPolygon({ latitude: 0.002, longitude: 0.002 }, [[0, 0]])).toBe(false);
  });
  it('handles a concave boundary', () => {
    const l: PolygonPoints = [
      [0, 0],
      [0, 4],
      [2, 4],
      [2, 2],
      [4, 2],
      [4, 0],
    ];
    expect(pointInPolygon({ latitude: 1, longitude: 3 }, l)).toBe(true);
    expect(pointInPolygon({ latitude: 3, longitude: 1 }, l)).toBe(true);
    expect(pointInPolygon({ latitude: 3, longitude: 3 }, l)).toBe(false); // the notch
  });
  it('rejects boundaries that cannot work, and round-trips the corner text', () => {
    expect(polygonProblem(square)).toBeNull();
    expect(polygonProblem('x')).not.toBeNull();
    expect(polygonProblem([[1, 1]])).toContain('at least');
    expect(
      polygonProblem([
        [1, 1],
        [2, 2],
        [3, 3],
      ]),
    ).toContain('no area');
    expect(
      polygonProblem([
        [1, 1],
        [1, 1],
        [2, 2],
      ]),
    ).toContain('three different');
    expect(
      polygonProblem([
        [91, 1],
        [2, 2],
        [3, 5],
      ]),
    ).toContain('outside');
    expect(
      polygonProblem([
        [0, 0],
        [2, 2],
        [3, 5],
      ]),
    ).toContain('0, 0');
    expect(
      polygonProblem([
        [1, 'a'],
        [2, 2],
        [3, 5],
      ]),
    ).toContain('latitude and a longitude');
    expect(polygonFromText(polygonToText(square))).toEqual(square);
    expect(polygonFromText('1,2\nnope')).toBeNull();
  });
});

const zone = (over: Partial<ZoneDef>): ZoneDef => ({
  id: over.code ?? 'Z',
  code: 'Z',
  name: 'Zone',
  kind: 'SERVICE_AREA',
  polygon: box(THAMEL, 2000),
  pickupAllowed: true,
  dropoffAllowed: true,
  note: null,
  priority: 0,
  isActive: true,
  ...over,
});

describe('zone rules', () => {
  it('is open everywhere until a service area is configured', () => {
    expect(checkZoneAccess([], PATAN, 'PICKUP').ok).toBe(true);
    expect(insideCoverage([], PATAN)).toBe(true);
    expect(checkZoneAccess([zone({ kind: 'AIRPORT', code: 'A' })], PATAN, 'PICKUP').ok).toBe(true);
  });
  it('requires a service area once one exists, for pickups and drop-offs, and ignores inactive zones', () => {
    const area = zone({ code: 'A' });
    const far = checkZoneAccess([area], PATAN, 'PICKUP');
    expect(far).toMatchObject({ ok: false, code: 'OUTSIDE_SERVICE_AREA' });
    expect(checkZoneAccess([area], THAMEL, 'DROPOFF').ok).toBe(true);
    expect(checkZoneAccess([zone({ code: 'A', isActive: false })], PATAN, 'PICKUP').ok).toBe(true);
    expect(insideCoverage([area], PATAN)).toBe(false);
    expect(insideCoverage([area], THAMEL)).toBe(true);
  });
  it('applies restrictions and notes, highest priority first, separately for pickup and drop-off', () => {
    const area = zone({ code: 'A' });
    const curb = zone({
      code: 'AIR',
      kind: 'AIRPORT',
      polygon: box(THAMEL, 300),
      pickupAllowed: false,
      dropoffAllowed: true,
      note: 'Airport pickups are at bay 3.',
      priority: 5,
    });
    const no = checkZoneAccess([area, curb], THAMEL, 'PICKUP');
    expect(no).toEqual({
      ok: false,
      code: 'NOT_ALLOWED_HERE',
      message: 'Airport pickups are at bay 3.',
    });
    const yes = checkZoneAccess([area, curb], THAMEL, 'DROPOFF');
    expect(yes.ok && yes.zones.map((z) => z.code)).toEqual(['AIR', 'A']);
    const banned = zone({
      code: 'R',
      kind: 'RESTRICTED',
      polygon: box(THAMEL, 300),
      pickupAllowed: false,
      dropoffAllowed: false,
    });
    expect(checkZoneAccess([area, banned], THAMEL, 'DROPOFF')).toMatchObject({
      ok: false,
      code: 'NOT_ALLOWED_HERE',
    });
  });
});

describe('time windows and periods', () => {
  // 2026-10-05 is a Monday; Kathmandu is UTC+5:45, so 04:15Z is 10:00 local.
  const monday10 = new Date('2026-10-05T04:15:00Z');
  const tz = 'Asia/Kathmandu';
  const w = (over: Partial<TimeWindow>): TimeWindow => ({
    daysOfWeek: null,
    startMinute: null,
    endMinute: null,
    startsAt: null,
    endsAt: null,
    ...over,
  });
  it('matches days, hours and dates in the platform time zone', () => {
    expect(windowActive(w({}), monday10, tz)).toBe(true);
    expect(windowActive(w({ daysOfWeek: [1] }), monday10, tz)).toBe(true);
    expect(windowActive(w({ daysOfWeek: [2, 3] }), monday10, tz)).toBe(false);
    expect(windowActive(w({ startMinute: 9 * 60, endMinute: 11 * 60 }), monday10, tz)).toBe(true);
    expect(windowActive(w({ startMinute: 10 * 60 + 1, endMinute: 11 * 60 }), monday10, tz)).toBe(
      false,
    );
    expect(windowActive(w({ startMinute: 9 * 60, endMinute: 10 * 60 }), monday10, tz)).toBe(false); // end is exclusive
    // the same instant is a different local time in another zone: the rule reads the platform zone
    expect(windowActive(w({ startMinute: 9 * 60, endMinute: 11 * 60 }), monday10, 'UTC')).toBe(
      false,
    );
  });
  it('supports overnight windows and special-event dates', () => {
    const night = w({ startMinute: 22 * 60, endMinute: 2 * 60, daysOfWeek: [5] }); // Friday night
    expect(windowActive(night, new Date('2026-10-09T17:30:00Z'), tz)).toBe(true); // Fri 23:15
    expect(windowActive(night, new Date('2026-10-09T20:30:00Z'), tz)).toBe(false); // Sat 02:15: the night has ended
    expect(windowActive(night, new Date('2026-10-09T19:00:00Z'), tz)).toBe(true); // Sat 00:45 still Friday night
    expect(windowActive(night, new Date('2026-10-10T17:30:00Z'), tz)).toBe(false); // Saturday night is not Friday
    const event = w({ startsAt: '2026-10-05T00:00:00Z', endsAt: '2026-10-05T12:00:00Z' });
    expect(windowActive(event, monday10, tz)).toBe(true);
    expect(windowActive(event, new Date('2026-10-05T12:00:00Z'), tz)).toBe(false);
  });
  it('validates windows and names periods by the platform day and week', () => {
    expect(windowProblem(w({ daysOfWeek: [0] }))).toContain('Days');
    expect(windowProblem(w({ startMinute: 60, endMinute: 60 }))).toContain('same');
    expect(
      windowProblem(w({ startsAt: '2026-10-06T00:00:00Z', endsAt: '2026-10-05T00:00:00Z' })),
    ).toContain('end after');
    expect(windowProblem(w({}))).toBeNull();
    expect(DAY_NAMES).toHaveLength(7);
    expect(periodKey(monday10, 'DAILY', tz)).toBe('2026-10-05');
    expect(periodKey(monday10, 'WEEKLY', tz)).toBe('2026-10-05');
    expect(periodKey(new Date('2026-10-08T04:15:00Z'), 'WEEKLY', tz)).toBe('2026-10-05'); // Thursday
    expect(periodKey(new Date('2026-10-11T12:00:00Z'), 'WEEKLY', tz)).toBe('2026-10-05'); // Sunday
    expect(periodKey(new Date('2026-10-04T20:00:00Z'), 'DAILY', tz)).toBe('2026-10-05'); // 01:45 local Monday
  });
});

describe('the surge engine', () => {
  const rule = (over: Record<string, unknown>) => ({
    id: 'r',
    name: 'Rule',
    label: 'Busy',
    zoneId: null,
    zoneName: null,
    vehicleCategoryId: null,
    vehicleCategoryLabel: null,
    window: NO_WINDOW,
    minDemandRatio: null,
    multiplier: 1.5,
    isActive: true,
    createdAt: '',
    updatedAt: '',
    ...over,
  });
  const ctx = (over: Partial<SurgeContext> = {}): SurgeContext => ({
    zoneIds: new Set(['zone-a']),
    categoryId: 'car',
    at: new Date('2026-10-05T04:15:00Z'),
    timeZone: 'Asia/Kathmandu',
    cap: 3,
    ratioFor: async () => 0,
    ...over,
  });
  it('takes the highest matching multiplier, never stacks, and never passes the cap', async () => {
    const two = [
      rule({ name: 'A', multiplier: 1.3 }),
      rule({ name: 'B', multiplier: 1.8, label: 'Big' }),
    ];
    expect(await pickSurge(two, ctx())).toMatchObject({
      multiplier: 1.8,
      label: 'Big',
      rules: ['B'],
    });
    expect((await pickSurge([rule({ multiplier: 9 })], ctx())).multiplier).toBe(3);
    expect((await pickSurge([rule({ multiplier: 9 })], ctx({ cap: 1 }))).multiplier).toBe(1);
    expect((await pickSurge([], ctx())).multiplier).toBe(1);
  });
  it('matches by zone, vehicle category, window, demand and whether the rule is on', async () => {
    expect((await pickSurge([rule({ zoneId: 'zone-a' })], ctx())).multiplier).toBe(1.5);
    expect((await pickSurge([rule({ zoneId: 'zone-b' })], ctx())).multiplier).toBe(1);
    expect((await pickSurge([rule({ vehicleCategoryId: 'suv' })], ctx())).multiplier).toBe(1);
    expect((await pickSurge([rule({ vehicleCategoryId: 'car' })], ctx())).multiplier).toBe(1.5);
    expect(
      (await pickSurge([rule({ window: { ...NO_WINDOW, daysOfWeek: [3] } })], ctx())).multiplier,
    ).toBe(1);
    expect((await pickSurge([rule({ isActive: false })], ctx())).multiplier).toBe(1);
    const needs = rule({ minDemandRatio: 2, zoneId: 'zone-a' });
    expect((await pickSurge([needs], ctx({ ratioFor: async () => 1.9 }))).multiplier).toBe(1);
    expect(
      (await pickSurge([needs], ctx({ ratioFor: async (z) => (z === 'zone-a' ? 2 : 0) })))
        .multiplier,
    ).toBe(1.5);
  });
  it('keeps the fare parts adding up: the total is always the normal fare plus the extra', () => {
    const cfg = pricingConfig();
    for (const m of [1, 1.05, 1.25, 1.5, 2.5, 3]) {
      for (const meters of [500, 4200, 15_000]) {
        const f = estimateFare(
          { distanceMeters: meters, durationSeconds: 900, routeBased: true },
          cfg,
          {
            multiplier: m,
            label: 'Busy',
          },
        );
        const normal = estimateFare(
          { distanceMeters: meters, durationSeconds: 900, routeBased: true },
          cfg,
        );
        expect(f.totalNpr).toBe(normal.totalNpr + f.surgeNpr);
        expect(f.surgeNpr).toBe(applySurge(normal.totalNpr, m).surgeNpr);
        expect(f.surgeMultiplier).toBe(m);
        expect(f.surgeLabel).toBe(m > 1 ? 'Busy' : null);
        expect(f.totalNpr).toBeGreaterThanOrEqual(normal.totalNpr);
      }
    }
    expect(describeSurge(1, null, 0)).toBe('Normal pricing applies.');
    expect(describeSurge(1.5, 'Busy time', 40)).toContain('1.5 times normal, NPR 40 more');
  });
});

// ---------------------------------------------------------------- zones through the API

describe('service zones: administration', () => {
  it('needs DISPATCH_MANAGE to change and OPERATIONS_VIEW to read, and audits every change', async () => {
    const a = await admin();
    const viewer = await admin(['OPERATIONS_VIEW']);
    const none = await admin(['SETTINGS_VIEW']);
    const p = await onboardUser('PASSENGER');
    expect((await api.get('/api/v1/admin/operations/zones')).status).toBe(401);
    expect((await ops(p.accessToken, '/zones')).status).toBe(403);
    expect((await ops(none.token, '/zones')).status).toBe(403);
    expect((await ops(viewer.token, '/zones')).status).toBe(200);
    expect((await opsSend('post', viewer.token, '/zones', zoneBody())).status).toBe(403);
    const z = await makeZone(a.token);
    expect((await opsSend('put', viewer.token, `/zones/${z.id}`, zoneBody())).status).toBe(403);
    const upd = await opsSend(
      'put',
      a.token,
      `/zones/${z.id}`,
      zoneBody({ name: 'Bigger area', reason: 'Renamed' }),
    );
    expect(upd.body.data.name).toBe('Bigger area');
    const audited = await pool.query(
      `SELECT action FROM audit_log WHERE subject_type = 'zone' ORDER BY id`,
    );
    expect(audited.rows.map((r) => r.action)).toEqual(['ZONE_CREATED', 'ZONE_UPDATED']);
    expect((await ops(viewer.token, '/zones')).body.data).toHaveLength(1);
  });

  it('validates boundaries, codes and reasons', async () => {
    const a = await admin();
    const bad = (over: Record<string, unknown>) =>
      opsSend('post', a.token, '/zones', zoneBody(over));
    expect(
      (
        await bad({
          polygon: [
            [27.7, 85.3],
            [27.8, 85.4],
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await bad({
          polygon: [
            [27.7, 85.3],
            [27.8, 85.4],
            [27.9, 85.5],
          ],
        })
      ).status,
    ).toBe(400); // a line
    expect(
      (
        await bad({
          polygon: [
            [95, 85.3],
            [27.8, 85.4],
            [27.9, 85.0],
          ],
        })
      ).status,
    ).toBe(400);
    expect((await bad({ code: 'bad code' })).status).toBe(400);
    expect((await bad({ kind: 'MOON' })).status).toBe(400);
    expect((await bad({ reason: 'x' })).status).toBe(400);
    expect((await bad({ extra: 1 })).status).toBe(400);
    await makeZone(a.token);
    expect((await bad({})).status).toBe(409); // the code is taken
    expect(
      (await opsSend('put', a.token, '/zones/00000000-0000-4000-8000-000000000000', zoneBody()))
        .status,
    ).toBe(404);
  });
});

describe('service zones: enforced on estimate and request', () => {
  it('serves everywhere until a service area exists, then only inside it (boundary included)', async () => {
    const a = await admin();
    const p = await onboardUser('PASSENGER');
    expect((await estimate(p.accessToken)).status).toBe(200);
    const z = await makeZone(a.token, { polygon: box(THAMEL, 1500), name: 'Thamel only' });
    const out = await estimate(p.accessToken); // the destination (Patan) is outside
    expect(out.status).toBe(422);
    expect(out.body.error.code).toBe('OUTSIDE_SERVICE_AREA');
    expect(out.body.error.message).toContain('outside the area we serve');
    const farPickup = await estimate(p.accessToken, {
      pickup: { ...PATAN },
      destination: { ...THAMEL },
    });
    expect(farPickup.status).toBe(422);
    // widen it: both ends inside, and a request works
    await opsSend(
      'put',
      a.token,
      `/zones/${z.id}`,
      zoneBody({ polygon: box(THAMEL, 6000), reason: 'Widened' }),
    );
    expect((await estimate(p.accessToken)).status).toBe(200);
    // a pickup exactly on the boundary is inside; a metre beyond is outside
    const edge = box(THAMEL, 1000);
    const onEdge = {
      ...THAMEL,
      latitude: (edge[0] as [number, number])[0],
      longitude: THAMEL.longitude,
    };
    await opsSend(
      'put',
      a.token,
      `/zones/${z.id}`,
      zoneBody({ polygon: edge, reason: 'Small box' }),
    );
    const dest = {
      ...THAMEL,
      latitude: THAMEL.latitude + 0.002,
      longitude: THAMEL.longitude + 0.002,
    };
    expect((await estimate(p.accessToken, { pickup: onEdge, destination: dest })).status).toBe(200);
    const beyond = { ...onEdge, latitude: onEdge.latitude - 0.00001 };
    expect((await estimate(p.accessToken, { pickup: beyond, destination: dest })).status).toBe(422);
    // the request path refuses it too, and starts no ride
    expect((await requestRide(p.accessToken, beyond, dest)).status).toBe(422);
    expect((await pool.query('SELECT count(*)::int AS n FROM trips')).rows[0].n).toBe(0);
  });

  it('restricts pickups and drop-offs separately and shows a zone notice before confirming', async () => {
    const a = await admin();
    const p = await onboardUser('PASSENGER');
    await makeZone(a.token);
    await makeZone(a.token, {
      code: 'AIRPORT',
      name: 'Airport',
      kind: 'AIRPORT',
      polygon: box(THAMEL, 400),
      pickupAllowed: false,
      dropoffAllowed: true,
      note: 'Airport pickups are at bay 3, not at the terminal door.',
      priority: 5,
    });
    const pickup = await estimate(p.accessToken);
    expect(pickup.status).toBe(422);
    expect(pickup.body.error.code).toBe('NOT_ALLOWED_HERE');
    expect(pickup.body.error.message).toContain('bay 3');
    const drop = await estimate(p.accessToken, {
      pickup: { ...PATAN },
      destination: { ...THAMEL },
    });
    expect(drop.status).toBe(200); // drop-offs at the airport are allowed
    expect(drop.body.data.notices).toEqual([
      'Airport pickups are at bay 3, not at the terminal door.',
    ]);
    await makeZone(a.token, {
      code: 'STADIUM',
      name: 'Stadium',
      kind: 'VENUE',
      polygon: box(PATAN, 300),
      pickupAllowed: true,
      dropoffAllowed: false,
      note: null,
    });
    const closed = await estimate(p.accessToken, {
      pickup: { ...THAMEL, latitude: THAMEL.latitude + 0.01 },
      destination: { ...PATAN },
    });
    expect(closed.status).toBe(422);
    expect(closed.body.error.message).toContain('Stadium: drop-offs are not allowed here.');
  });

  it('records the pickup zone and ignores a zone once it is switched off', async () => {
    const a = await admin();
    const z = await makeZone(a.token);
    const airport = await makeZone(a.token, {
      code: 'VENUE_A',
      name: 'Venue',
      kind: 'VENUE',
      polygon: box(THAMEL, 300),
      priority: 4,
    });
    const w = await rideWorld();
    const row = (await pool.query('SELECT pickup_zone_id FROM trips WHERE id = $1', [w.tripId]))
      .rows[0];
    expect(row.pickup_zone_id).toBe(airport.id); // the named place, not just the service area
    await opsSend(
      'put',
      a.token,
      `/zones/${z.id}`,
      zoneBody({ isActive: false, reason: 'Paused' }),
    );
    const p = await onboardUser('PASSENGER');
    expect((await estimate(p.accessToken)).status).toBe(200); // no active service area: open again
  });
});

// ---------------------------------------------------------------- dynamic pricing through the API

describe('dynamic pricing', () => {
  it('shows the applicable fare before confirming and explains it', async () => {
    const a = await admin();
    const p = await onboardUser('PASSENGER');
    const normal = (await estimate(p.accessToken)).body.data;
    expect(normal.fare).toMatchObject({ surgeMultiplier: 1, surgeNpr: 0, surgeLabel: null });
    await makeRule(a.token, { multiplier: 1.5, label: 'Festival rush' });
    const busy = (await estimate(p.accessToken)).body.data;
    expect(busy.fare).toMatchObject({ surgeMultiplier: 1.5, surgeLabel: 'Festival rush' });
    expect(busy.fare.totalNpr).toBe(normal.fare.totalNpr + busy.fare.surgeNpr);
    expect(busy.fare.surgeNpr).toBe(Math.round(normal.fare.totalNpr * 0.5));
    // every category in the picker carries its own (surged) fare from the same engine
    for (const c of busy.categories) expect(c.fare.surgeMultiplier).toBe(1.5);
  });

  it('applies rules by zone, vehicle category, window and special event, and respects the cap', async () => {
    const a = await admin();
    const p = await onboardUser('PASSENGER');
    const carId = await categoryId('CAR');
    const zone = await makeZone(a.token, {
      kind: 'VENUE',
      polygon: box(THAMEL, 300),
      name: 'Venue',
    });
    const far = await makeZone(a.token, {
      code: 'FAR_ZONE',
      name: 'Far',
      kind: 'VENUE',
      polygon: box(PATAN, 300),
    });
    const mult = async (extra: Record<string, unknown> = {}) =>
      (await estimate(p.accessToken, extra)).body.data.fare.surgeMultiplier as number;
    await makeRule(a.token, { name: 'Venue only', zoneId: far.id, multiplier: 2 });
    expect(await mult()).toBe(1); // a rule for another zone
    await makeRule(a.token, { name: 'Venue', zoneId: zone.id, multiplier: 1.4 });
    expect(await mult()).toBe(1.4);
    await makeRule(a.token, {
      name: 'Suv only',
      vehicleCategoryId: await categoryId('SUV'),
      multiplier: 2.2,
    });
    expect(await mult()).toBe(1.4); // the SUV rule does not touch a car
    await makeRule(a.token, { name: 'Car only', vehicleCategoryId: carId, multiplier: 1.7 });
    expect(await mult()).toBe(1.7); // the highest, not a product
    // an event that has not started, then one that is on
    const day = 86_400_000;
    await makeRule(a.token, {
      name: 'Future event',
      multiplier: 2.9,
      window: {
        ...NO_WINDOW,
        startsAt: new Date(Date.now() + day).toISOString(),
        endsAt: new Date(Date.now() + 2 * day).toISOString(),
      },
    });
    expect(await mult()).toBe(1.7);
    await makeRule(a.token, {
      name: 'On now',
      multiplier: 2.4,
      window: {
        ...NO_WINDOW,
        startsAt: new Date(Date.now() - day).toISOString(),
        endsAt: new Date(Date.now() + day).toISOString(),
      },
    });
    expect(await mult()).toBe(2.4);
    await setSetting('SURGE_MAX_MULTIPLIER', 2);
    try {
      expect(await mult()).toBe(2);
    } finally {
      await setSetting('SURGE_MAX_MULTIPLIER', null);
    }
  });

  it('reacts to demand: a rule with a demand condition applies only while requests outrun drivers', async () => {
    const a = await admin();
    await makeRule(a.token, { name: 'Demand', minDemandRatio: 2, multiplier: 1.6 });
    const watcher = await onboardUser('PASSENGER');
    const mult = async () => {
      dropDemandCache();
      return (await estimate(watcher.accessToken)).body.data.fare.surgeMultiplier as number;
    };
    expect(await mult()).toBe(1);
    // three riders ask and nobody is online: requests per available driver = 3
    for (let i = 0; i < 3; i++) {
      const rider = await onboardUser('PASSENGER');
      expect((await requestRide(rider.accessToken)).status).toBe(201);
    }
    // the first three requests were priced before demand rose: they stay at the price they were quoted
    const prices = (
      await pool.query('SELECT surge_multiplier FROM trips ORDER BY requested_at')
    ).rows.map((r) => Number(r.surge_multiplier));
    expect(prices[0]).toBe(1);
    expect(await mult()).toBe(1.6);
    // a driver comes online: 3 requests for 1 driver is still above 2; a second driver brings it to 1.5
    const d1 = await onboardUser('DRIVER');
    const d2 = await onboardUser('DRIVER');
    await forceDriverOnline(d1.user.id as string, north(THAMEL, 10_000));
    await forceDriverOnline(d2.user.id as string, north(THAMEL, 10_200));
    expect(await mult()).toBe(1);
  });

  it('locks the price on the ride and asks the rider to confirm when it changed', async () => {
    const a = await admin();
    const p = await onboardUser('PASSENGER');
    const rule = await makeRule(a.token, { multiplier: 1.5 });
    const shown = (await estimate(p.accessToken)).body.data.fare;
    // the rider confirms the total they were shown
    const okRes = await api.post('/api/v1/trips/request').set(auth(p.accessToken)).send({
      pickup: THAMEL,
      destination: PATAN,
      vehicleCategory: 'CAR',
      confirmedTotalNpr: shown.totalNpr,
    });
    expect(okRes.status).toBe(201);
    expect(okRes.body.data.fare.estimateNpr).toBe(shown.totalNpr);
    const locked = (
      await pool.query('SELECT surge_multiplier, surge_label FROM trips WHERE id = $1', [
        okRes.body.data.id,
      ])
    ).rows[0];
    expect(Number(locked.surge_multiplier)).toBe(1.5);
    await api.post(`/api/v1/trips/${okRes.body.data.id}/cancel`).set(auth(p.accessToken)).send({});
    // the rules change: a request that confirms the old total is refused with the new fare
    await opsSend(
      'put',
      a.token,
      `/pricing-rules/${rule.id}`,
      ruleBody({ multiplier: 2, reason: 'Busier' }),
    );
    const changed = await api.post('/api/v1/trips/request').set(auth(p.accessToken)).send({
      pickup: THAMEL,
      destination: PATAN,
      vehicleCategory: 'CAR',
      confirmedTotalNpr: shown.totalNpr,
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('FARE_CHANGED');
    expect(changed.body.error.details.fare.surgeMultiplier).toBe(2);
    expect(
      (await pool.query("SELECT count(*)::int AS n FROM trips WHERE status = 'SEARCHING'")).rows[0]
        .n,
    ).toBe(0);
    // a client cannot name a price; only confirm one
    const bad = await api.post('/api/v1/trips/request').set(auth(p.accessToken)).send({
      pickup: THAMEL,
      destination: PATAN,
      vehicleCategory: 'CAR',
      fareNpr: 10,
      surgeMultiplier: 1,
    });
    expect(bad.status).toBe(400);
  });

  it('charges the quoted multiplier at the end, whatever the rules say by then', async () => {
    const a = await admin();
    const rule = await makeRule(a.token, { multiplier: 1.5 });
    const w = await finishedRide(true);
    await opsSend(
      'put',
      a.token,
      `/pricing-rules/${rule.id}`,
      ruleBody({ isActive: false, reason: 'Over' }),
    );
    const t = (await pool.query('SELECT * FROM trips WHERE id = $1', [w.tripId])).rows[0];
    const cat = await getCategoryById(t.vehicle_category_id);
    const expected = finalFare(
      { distanceMeters: t.actual_distance_meters, durationSeconds: t.actual_duration_seconds },
      pricingFor(cat),
      t.waiting_charge_npr,
      { multiplier: 1.5, label: null },
    ).totalNpr;
    const normal = finalFare(
      { distanceMeters: t.actual_distance_meters, durationSeconds: t.actual_duration_seconds },
      pricingFor(cat),
      t.waiting_charge_npr,
    ).totalNpr;
    expect(t.fare_final_npr).toBe(expected);
    expect(expected).toBeGreaterThan(normal);
    // the payment is exactly that fare: no second calculation anywhere
    const pay = (
      await pool.query('SELECT amount_npr FROM trip_payments WHERE trip_id = $1', [w.tripId])
    ).rows[0];
    expect(pay.amount_npr).toBe(expected);
    // and the price was explained in the audit log
    const why = await pool.query(
      `SELECT detail FROM audit_log WHERE action = 'SURGE_APPLIED' AND subject_id = $1`,
      [w.tripId],
    );
    expect(why.rows[0].detail).toMatchObject({ multiplier: 1.5, rules: ['Busy evening'] });
  });

  it('administers rules with validation, RBAC and audit', async () => {
    const a = await admin();
    const viewer = await admin(['OPERATIONS_VIEW']);
    const bad = (over: Record<string, unknown>) =>
      opsSend('post', a.token, '/pricing-rules', ruleBody(over));
    expect((await bad({ multiplier: 1 })).status).toBe(400);
    expect((await bad({ multiplier: 11 })).status).toBe(400);
    expect((await bad({ window: { ...NO_WINDOW, daysOfWeek: [9] } })).status).toBe(400);
    expect((await bad({ window: { ...NO_WINDOW, startMinute: 600, endMinute: 600 } })).status).toBe(
      400,
    );
    expect((await bad({ zoneId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await bad({ vehicleCategoryId: '00000000-0000-4000-8000-000000000000' })).status).toBe(
      400,
    );
    expect((await bad({ reason: 'x' })).status).toBe(400);
    expect((await opsSend('post', viewer.token, '/pricing-rules', ruleBody())).status).toBe(403);
    const r = await makeRule(a.token);
    expect((await opsSend('put', viewer.token, `/pricing-rules/${r.id}`, ruleBody())).status).toBe(
      403,
    );
    expect((await ops(viewer.token, '/pricing-rules')).body.data).toHaveLength(1);
    const audited = await pool.query(
      `SELECT action FROM audit_log WHERE subject_type = 'pricing_rule'`,
    );
    expect(audited.rows.map((x) => x.action)).toEqual(['PRICING_RULE_CREATED']);
  });
});

// ---------------------------------------------------------------- dispatch

describe('dispatch: ranking, radius, zones and limits', () => {
  it('ranks by arrival time plus a penalty for recent rides, stably, without adding or dropping anyone', () => {
    const sample = [
      { driverId: 'near-busy', distanceMeters: 400, etaSeconds: 60, recentRides: 3 },
      { driverId: 'far-rested', distanceMeters: 900, etaSeconds: 120, recentRides: 0 },
      { driverId: 'mid', distanceMeters: 600, etaSeconds: 90, recentRides: 1 },
    ];
    // default penalty 60 s/ride: busy = 240, rested = 120, mid = 150
    const out = etaWorkloadStrategy.rank(sample, { pickup: THAMEL, vehicleCategoryId: null });
    expect(out.map((c) => c.driverId)).toEqual(['far-rested', 'mid', 'near-busy']);
    expect(
      proximityStrategy.rank(sample, { pickup: THAMEL, vehicleCategoryId: null })[0]?.driverId,
    ).toBe('near-busy');
    expect(sample.map((c) => c.driverId)).toEqual(['near-busy', 'far-rested', 'mid']); // input untouched
    const tie = [
      { driverId: 'b', distanceMeters: 500, etaSeconds: 80, recentRides: 0 },
      { driverId: 'a', distanceMeters: 500, etaSeconds: 80, recentRides: 0 },
    ];
    expect(
      etaWorkloadStrategy
        .rank(tie, { pickup: THAMEL, vehicleCategoryId: null })
        .map((c) => c.driverId),
    ).toEqual(['a', 'b']);
  });

  it('shares work between drivers: a recently busy driver is offered the ride after a rested one', async () => {
    const busy = await onboardUser('DRIVER');
    const rested = await onboardUser('DRIVER');
    // the busy driver is closer; the rested one is a little farther
    await forceDriverOnline(busy.user.id as string, north(THAMEL, 300));
    await forceDriverOnline(rested.user.id as string, north(THAMEL, 700));
    await setSetting('DISPATCH_WORKLOAD_PENALTY_SECONDS', 600);
    try {
      const carId = await categoryId('CAR');
      const before = await matchDrivers({ pickup: THAMEL, vehicleCategoryId: carId });
      expect(before[0]?.driverId).toBe(busy.user.id);
      // three rides finished in the window
      for (let i = 0; i < 3; i++) {
        const p = await onboardUser('PASSENGER');
        const loc = await pool.query(
          `INSERT INTO locations (latitude, longitude, address) VALUES (27.7, 85.3, 'x'), (27.71, 85.31, 'y') RETURNING id`,
        );
        await pool.query(
          `INSERT INTO trips (passenger_id, driver_id, pickup_location_id, destination_location_id, status, ended_at, vehicle_category_id)
           VALUES ($1, $2, $3, $4, 'COMPLETED', now() - interval '10 minutes', $5)`,
          [p.user.id, busy.user.id, loc.rows[0].id, loc.rows[1].id, carId],
        );
      }
      const after = await matchDrivers({ pickup: THAMEL, vehicleCategoryId: carId });
      expect(after.map((c) => c.recentRides)).toEqual([0, 3]);
      expect(after[0]?.driverId).toBe(rested.user.id);
    } finally {
      await setSetting('DISPATCH_WORKLOAD_PENALTY_SECONDS', null);
    }
  });

  it('widens the search radius with each unanswered offer, up to a limit, and finds a farther driver', async () => {
    expect(searchRadius(0)).toBe(5000);
    expect(searchRadius(1)).toBe(6250);
    expect(searchRadius(2)).toBe(7500);
    expect(searchRadius(40)).toBe(12_000); // capped
    const far = await onboardUser('DRIVER');
    await forceDriverOnline(far.user.id as string, north(THAMEL, 7000));
    const carId = await categoryId('CAR');
    const pick = (offers: number) =>
      findEligibleDrivers({
        pickup: THAMEL,
        vehicleCategoryId: carId,
        radiusMeters: searchRadius(offers),
      });
    expect(await pick(0)).toHaveLength(0);
    expect(await pick(1)).toHaveLength(0);
    expect((await pick(2)).map((c) => c.driverId)).toEqual([far.user.id]);
    await setSetting('DISPATCH_RADIUS_EXPANSION_PERCENT', 0);
    try {
      expect(searchRadius(5)).toBe(5000); // widening switched off
    } finally {
      await setSetting('DISPATCH_RADIUS_EXPANSION_PERCENT', null);
    }
    await setSetting('DISPATCH_MAX_RADIUS_METERS', 6000);
    try {
      expect(searchRadius(40)).toBe(6000);
    } finally {
      await setSetting('DISPATCH_MAX_RADIUS_METERS', null);
    }
  });

  it('never offers to a driver outside the service area, with a stale location, or over a limit', async () => {
    const a = await admin();
    const inside = await onboardUser('DRIVER');
    const outside = await onboardUser('DRIVER');
    const stale = await onboardUser('DRIVER');
    const tired = await onboardUser('DRIVER');
    const carId = await categoryId('CAR');
    await forceDriverOnline(inside.user.id as string, north(THAMEL, 300));
    await forceDriverOnline(outside.user.id as string, north(THAMEL, 3000));
    await forceDriverOnline(stale.user.id as string, north(THAMEL, 400));
    await forceDriverOnline(tired.user.id as string, north(THAMEL, 500));
    const ids = async () =>
      (await findEligibleDrivers({ pickup: THAMEL, vehicleCategoryId: carId }))
        .map((c) => c.driverId)
        .sort();
    const all = [inside, outside, stale, tired].map((d) => d.user.id as string).sort();
    expect(await ids()).toEqual(all);

    // a service area around Thamel: the driver who wandered 3 km out is left out
    await makeZone(a.token, { polygon: box(THAMEL, 1500) });
    expect(await ids()).toEqual([inside, stale, tired].map((d) => d.user.id as string).sort());

    // a location saved long ago is not matchable even with the driver still marked online
    await pool.query(
      `UPDATE driver_last_locations SET recorded_at = now() - interval '1 hour' WHERE driver_id = $1`,
      [stale.user.id],
    );
    expect(await ids()).toEqual([inside, tired].map((d) => d.user.id as string).sort());

    // online too long without a break
    await setSetting('DRIVER_MAX_ONLINE_HOURS', 10);
    try {
      await pool.query(
        `UPDATE driver_availability SET online_since = now() - interval '11 hours' WHERE driver_id = $1`,
        [tired.user.id],
      );
      expect(await ids()).toEqual([inside.user.id as string]);
    } finally {
      await setSetting('DRIVER_MAX_ONLINE_HOURS', null);
    }
    expect(await ids()).toEqual([inside, tired].map((d) => d.user.id as string).sort()); // limit off again
  });

  it('enforces the daily ride limit at go-online and in matching, and lifts it tomorrow', async () => {
    const w = await finishedRide(true);
    const driver = w.driver;
    await setSetting('DRIVER_MAX_RIDES_PER_DAY', 1);
    try {
      await forceDriverOnline(driver.user.id as string, north(THAMEL, 300));
      const carId = await categoryId('CAR');
      expect(
        (await findEligibleDrivers({ pickup: THAMEL, vehicleCategoryId: carId })).map(
          (c) => c.driverId,
        ),
      ).not.toContain(driver.user.id);
      const { evaluateDriverEligibility } = await import('../modules/availability/eligibility');
      const e = await evaluateDriverEligibility(driver.user.id as string);
      expect(e.reasons.join(' ')).toContain('most allowed in a day');
      // yesterday's ride does not count today
      await pool.query(`UPDATE trips SET ended_at = now() - interval '2 days' WHERE id = $1`, [
        w.tripId,
      ]);
      expect(
        (await findEligibleDrivers({ pickup: THAMEL, vehicleCategoryId: carId })).map(
          (c) => c.driverId,
        ),
      ).toContain(driver.user.id);
    } finally {
      await setSetting('DRIVER_MAX_RIDES_PER_DAY', null);
    }
  });

  it('gives one driver to only one of two simultaneous requests', async () => {
    const d = await onboardUser('DRIVER');
    await forceDriverOnline(d.user.id as string, north(THAMEL, 300));
    const p1 = await onboardUser('PASSENGER');
    const p2 = await onboardUser('PASSENGER');
    const results = await Promise.all([requestRide(p1.accessToken), requestRide(p2.accessToken)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const open = await pool.query(
      `SELECT count(*)::int AS n FROM trip_offers WHERE driver_id = $1 AND status = 'OFFERED'`,
      [d.user.id],
    );
    expect(open.rows[0].n).toBe(1); // a driver never holds two offers
    const offer = await api.get('/api/v1/trips/offers/current').set(auth(d.accessToken));
    expect(offer.body.data).not.toBeNull();
  });
});

// ---------------------------------------------------------------- heatmap

describe('the heatmap and demand/supply monitoring', () => {
  it('aggregates into squares, hides small counts, and never shows a driver or an exact position', async () => {
    const a = await admin();
    const viewer = await admin(['OPERATIONS_VIEW']);
    const zone = await makeZone(a.token);
    // five rides requested from one spot, two drivers online nearby (fewer than the minimum of three)
    for (let i = 0; i < 5; i++) {
      const p = await onboardUser('PASSENGER');
      expect((await requestRide(p.accessToken)).status).toBe(201);
      await pool.query(`UPDATE trips SET status = 'CANCELLED' WHERE passenger_id = $1`, [
        p.user.id,
      ]);
    }
    const d1 = await onboardUser('DRIVER');
    const d2 = await onboardUser('DRIVER');
    await forceDriverOnline(d1.user.id as string, north(THAMEL, 100));
    await forceDriverOnline(d2.user.id as string, north(THAMEL, 120));
    dropDemandCache();
    const res = await ops(viewer.token, '/heatmap');
    expect(res.status).toBe(200);
    const map = res.body.data;
    expect(map.minCount).toBe(3);
    const hot = map.cells.find((c: { requests: number | null }) => c.requests === 5);
    expect(hot).toBeDefined();
    expect(hot.drivers).toBeNull(); // two drivers: fewer than the minimum, so no number
    // nothing identifies anyone
    const text = JSON.stringify(map);
    expect(text).not.toContain(d1.user.id as string);
    expect(text).not.toContain(d2.user.id as string);
    expect(text).not.toContain(String(north(THAMEL, 100).latitude));
    expect(hot.centre.latitude).not.toBe(THAMEL.latitude);
    // a square with one request and one driver is left out altogether
    expect(
      map.cells.every(
        (c: { requests: number | null; drivers: number | null }) =>
          c.requests !== null || c.drivers !== null,
      ),
    ).toBe(true);
    // the zone table carries the figures pricing uses
    const row = map.zones.find((z: { zoneId: string | null }) => z.zoneId === zone.id);
    expect(row).toMatchObject({ requests: 5, availableDrivers: 2, ratio: 2.5, surgeMultiplier: 1 });
    expect(map.zones[0]).toMatchObject({ zoneId: null, requests: 5, availableDrivers: 2 });
  });

  it('shows the multiplier a zone has right now, and needs OPERATIONS_VIEW', async () => {
    const a = await admin();
    const none = await admin(['SETTINGS_VIEW']);
    const zone = await makeZone(a.token);
    await makeRule(a.token, { zoneId: zone.id, multiplier: 1.8 });
    const map = (await ops(a.token, '/heatmap')).body.data;
    expect(
      map.zones.find((z: { zoneId: string | null }) => z.zoneId === zone.id).surgeMultiplier,
    ).toBe(1.8);
    expect((await ops(none.token, '/heatmap')).status).toBe(403);
    const p = await onboardUser('PASSENGER');
    expect((await ops(p.accessToken, '/heatmap')).status).toBe(403);
    expect((await api.get('/api/v1/admin/operations/heatmap')).status).toBe(401);
  });
});

// ---------------------------------------------------------------- incentives

const NO_WIN = NO_WINDOW;
const incentiveBody = (over: Record<string, unknown> = {}) => ({
  name: 'Two rides a day',
  kind: 'RIDE_TARGET',
  zoneId: null,
  vehicleCategoryId: null,
  window: NO_WIN,
  period: 'DAILY',
  targetRides: 2,
  bonusNpr: 100,
  isActive: true,
  reason: 'Test incentive',
  ...over,
});
const makeIncentive = async (token: string, over: Record<string, unknown> = {}) => {
  const r = await opsSend('post', token, '/incentive-rules', incentiveBody(over));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.data as { id: string };
};
const awards = async () =>
  (await pool.query('SELECT * FROM incentive_awards ORDER BY created_at')).rows;

describe('driver incentives', () => {
  it('validates each kind of rule and needs DISPATCH_MANAGE', async () => {
    const a = await admin();
    const viewer = await admin(['OPERATIONS_VIEW']);
    const bad = (over: Record<string, unknown>) =>
      opsSend('post', a.token, '/incentive-rules', incentiveBody(over));
    expect((await bad({ targetRides: null })).status).toBe(400);
    expect((await bad({ period: null })).status).toBe(400);
    expect((await bad({ bonusNpr: 0 })).status).toBe(400);
    expect((await bad({ kind: 'ZONE_BONUS', zoneId: null })).status).toBe(400);
    expect((await bad({ kind: 'TIME_BONUS' })).status).toBe(400);
    expect((await bad({ kind: 'NOPE' })).status).toBe(400);
    expect((await bad({ zoneId: '00000000-0000-4000-8000-000000000000' })).status).toBe(400);
    expect((await bad({ reason: '' })).status).toBe(400);
    expect((await opsSend('post', viewer.token, '/incentive-rules', incentiveBody())).status).toBe(
      403,
    );
    const r = await makeIncentive(a.token);
    expect(
      (await opsSend('put', viewer.token, `/incentive-rules/${r.id}`, incentiveBody())).status,
    ).toBe(403);
    const upd = await opsSend(
      'put',
      a.token,
      `/incentive-rules/${r.id}`,
      incentiveBody({ bonusNpr: 150, reason: 'Raised' }),
    );
    expect(upd.body.data.bonusNpr).toBe(150);
    const audited = await pool.query(
      `SELECT action FROM audit_log WHERE subject_type = 'incentive_rule' ORDER BY id`,
    );
    expect(audited.rows.map((x) => x.action)).toEqual([
      'INCENTIVE_RULE_CREATED',
      'INCENTIVE_RULE_UPDATED',
    ]);
  });

  it('pays a ride-target bonus exactly once, when the target is reached, and tells the driver', async () => {
    const a = await admin();
    await makeIncentive(a.token);
    const first = await finishedRide(true);
    const driver = first.driver;
    expect(await awards()).toHaveLength(0); // one ride of two
    const second = await finishedRide(true, driver);
    const rows = await awards();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ driver_id: driver.user.id, amount_npr: 100, trip_id: null });
    // evaluating again (a repeat completion, another instance) cannot pay twice
    expect(await evaluateIncentives(second.tripId)).toEqual([]);
    expect(await evaluateIncentives(first.tripId)).toEqual([]);
    expect(await awards()).toHaveLength(1);
    // a third ride the same day adds nothing more for this target
    await finishedRide(true, driver);
    expect(await awards()).toHaveLength(1);
    const told = await pool.query(
      `SELECT body FROM notifications WHERE user_id = $1 AND type = 'INCENTIVE_EARNED'`,
      [driver.user.id],
    );
    expect(told.rows).toHaveLength(1);
    expect(told.rows[0].body).toContain('NPR 100');
    const audited = await pool.query(
      `SELECT detail FROM audit_log WHERE action = 'INCENTIVE_AWARDED'`,
    );
    expect(audited.rows[0].detail).toMatchObject({ rule: 'Two rides a day', amountNpr: 100 });
  });

  it('pays per-ride time and zone bonuses, by window, zone and vehicle category', async () => {
    const a = await admin();
    const zone = await makeZone(a.token, {
      code: 'BONUS_ZONE',
      name: 'Bonus zone',
      kind: 'VENUE',
      polygon: box(THAMEL, 400),
    });
    const other = await makeZone(a.token, {
      code: 'OTHER_ZONE',
      name: 'Other',
      kind: 'VENUE',
      polygon: box(PATAN, 400),
    });
    await makeIncentive(a.token, {
      name: 'Zone bonus',
      kind: 'ZONE_BONUS',
      zoneId: zone.id,
      period: null,
      targetRides: null,
      bonusNpr: 30,
    });
    await makeIncentive(a.token, {
      name: 'Other zone',
      kind: 'ZONE_BONUS',
      zoneId: other.id,
      period: null,
      targetRides: null,
      bonusNpr: 99,
    });
    await makeIncentive(a.token, {
      name: 'Anytime',
      kind: 'TIME_BONUS',
      period: null,
      targetRides: null,
      bonusNpr: 20,
      window: { ...NO_WIN, startMinute: 0, endMinute: 1440 },
    });
    await makeIncentive(a.token, {
      name: 'Wrong day',
      kind: 'TIME_BONUS',
      period: null,
      targetRides: null,
      bonusNpr: 50,
      window: { ...NO_WIN, daysOfWeek: [], startMinute: 0, endMinute: 1 },
    });
    await makeIncentive(a.token, {
      name: 'Suv only',
      kind: 'TIME_BONUS',
      vehicleCategoryId: await categoryId('SUV'),
      period: null,
      targetRides: null,
      bonusNpr: 70,
      window: { ...NO_WIN, startMinute: 0, endMinute: 1440 },
    });
    await makeIncentive(a.token, {
      name: 'Off',
      kind: 'TIME_BONUS',
      isActive: false,
      period: null,
      targetRides: null,
      bonusNpr: 80,
      window: { ...NO_WIN, startMinute: 0, endMinute: 1440 },
    });
    const w = await finishedRide(true);
    const names = (
      await pool.query(
        `SELECT r.name FROM incentive_awards a JOIN incentive_rules r ON r.id = a.rule_id WHERE a.trip_id = $1 ORDER BY r.name`,
        [w.tripId],
      )
    ).rows.map((r) => r.name);
    expect(names).toEqual(['Anytime', 'Zone bonus']);
    expect(await evaluateIncentives(w.tripId)).toEqual([]); // once per ride
    expect(await awards()).toHaveLength(2);
  });

  it('never touches the fare, the payment or a refund quote', async () => {
    const a = await admin();
    await makeIncentive(a.token, {
      name: 'Every ride',
      kind: 'TIME_BONUS',
      period: null,
      targetRides: null,
      bonusNpr: 500,
      window: { ...NO_WIN, startMinute: 0, endMinute: 1440 },
    });
    const w = await finishedRide(true);
    const trip = (await pool.query('SELECT fare_final_npr FROM trips WHERE id = $1', [w.tripId]))
      .rows[0];
    const pay = (
      await pool.query('SELECT amount_npr, status FROM trip_payments WHERE trip_id = $1', [
        w.tripId,
      ])
    ).rows[0];
    expect(pay.amount_npr).toBe(trip.fare_final_npr); // the bonus is not in the fare
    expect(pay.status).toBe('PAID');
    const ticket = await api
      .post('/api/v1/support/tickets')
      .set(auth(w.passenger.accessToken))
      .send({
        categoryCode: 'RIDE_FARE',
        subject: 'Fare',
        body: 'The fare looked high to me',
        tripId: w.tripId,
      });
    const quote = await api
      .get(`/api/v1/support/tickets/${ticket.body.data.id}/refund-quote`)
      .set(auth(w.passenger.accessToken));
    expect(quote.body.data.paidNpr).toBe(trip.fare_final_npr);
    expect(quote.body.data.remainingNpr).toBe(trip.fare_final_npr);
    // a bonus is a record of what is owed to the driver, one row per award
    expect((await awards()).reduce((n, r) => n + r.amount_npr, 0)).toBe(500);
    expect((await pool.query('SELECT count(*)::int AS n FROM refunds')).rows[0].n).toBe(0);
  });

  it('shows the driver their own progress in words, and only to drivers', async () => {
    const a = await admin();
    await makeIncentive(a.token, { targetRides: 3 });
    const w = await finishedRide(true);
    const view = await api.get('/api/v1/drivers/me/incentives').set(auth(w.driver.accessToken));
    expect(view.status).toBe(200);
    const row = view.body.data.progress[0];
    expect(row.text).toContain('Complete 3 rides');
    expect(row).toMatchObject({ completed: 1, target: 3 });
    expect(row.status).toBe('1 of 3 rides done this day; 2 to go.');
    expect(view.body.data.note).toContain('separate from the fares');
    const other = await onboardUser('DRIVER');
    expect(
      (await api.get('/api/v1/drivers/me/incentives').set(auth(other.accessToken))).body.data
        .progress[0].completed,
    ).toBe(0);
    expect(
      (await api.get('/api/v1/drivers/me/incentives').set(auth(w.passenger.accessToken))).status,
    ).toBe(403);
    expect((await api.get('/api/v1/drivers/me/incentives')).status).toBe(401);
  });

  it('lists awards for administrators with the total, and keeps them readable only with OPERATIONS_VIEW', async () => {
    const a = await admin();
    const none = await admin(['SETTINGS_VIEW']);
    await makeIncentive(a.token, {
      name: 'Every ride',
      kind: 'TIME_BONUS',
      period: null,
      targetRides: null,
      bonusNpr: 40,
      window: { ...NO_WIN, startMinute: 0, endMinute: 1440 },
    });
    await finishedRide(true);
    await finishedRide(true);
    const res = await ops(a.token, '/incentive-awards');
    expect(res.body.data).toMatchObject({ total: 2, totalAwardedNpr: 80 });
    expect(res.body.data.items[0]).toMatchObject({ ruleName: 'Every ride', amountNpr: 40 });
    expect((await ops(none.token, '/incentive-awards')).status).toBe(403);
    expect(
      (await ops(a.token, '/incentive-awards?pageSize=1&page=2')).body.data.items,
    ).toHaveLength(1);
  });
});
