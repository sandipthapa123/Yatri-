import { describe, expect, it } from 'vitest';

import { computeEta } from '../modules/tracking/eta';
import {
  createLocationProvider,
  createRouteProvider,
  type LocationProviderConfig,
} from '../modules/location/providers';
import { NominatimProvider } from '../modules/location/providers/nominatim-provider';
import {
  GraphHopperRouteProvider,
  HaversineRouteProvider,
  OsrmRouteProvider,
  ValhallaRouteProvider,
  type RouteProvider,
} from '../modules/location/providers/route-provider';
import { StaticLocationProvider } from '../modules/location/providers/static-provider';

const base: LocationProviderConfig = {
  LOCATION_PROVIDER: 'nominatim',
  LOCATION_PROVIDER_BASE_URL: 'https://geo.example.test',
  LOCATION_PROVIDER_USER_AGENT: 'Yatri-Test',
  LOCATION_COUNTRY_CODES: ['np'],
  LOCATION_REQUEST_TIMEOUT_MS: 1000,
  LOCATION_ROUTING_PROVIDER: 'haversine',
  LOCATION_ROUTING_BASE_URL: 'https://route.example.test',
};

const from = { latitude: 27.7172, longitude: 85.324 };
const to = { latitude: 27.6727, longitude: 85.325 };

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } });

describe('provider selection is configuration only', () => {
  it('builds the adapter named by config', () => {
    expect(createLocationProvider(base)).toBeInstanceOf(NominatimProvider);
    expect(createLocationProvider({ ...base, LOCATION_PROVIDER: 'static' })).toBeInstanceOf(
      StaticLocationProvider,
    );
    expect(createLocationProvider({ ...base, LOCATION_PROVIDER: 'none' })).toBeNull();

    const r = (p: LocationProviderConfig['LOCATION_ROUTING_PROVIDER']) =>
      createRouteProvider({ ...base, LOCATION_ROUTING_PROVIDER: p });
    expect(r('haversine')).toBeInstanceOf(HaversineRouteProvider);
    expect(r('osrm')).toBeInstanceOf(OsrmRouteProvider);
    expect(r('graphhopper')).toBeInstanceOf(GraphHopperRouteProvider);
    expect(r('valhalla')).toBeInstanceOf(ValhallaRouteProvider);
  });

  it('the same ETA business function works unchanged against every routing engine', async () => {
    const osrm = json({ code: 'Ok', routes: [{ distance: 6100, duration: 660 }] });
    const gh = json({ paths: [{ distance: 6100, time: 660_000 }] });
    const valhalla = json({ trip: { summary: { length: 6.1, time: 660 } } });

    const engines: Array<[LocationProviderConfig['LOCATION_ROUTING_PROVIDER'], Response]> = [
      ['osrm', osrm],
      ['graphhopper', gh],
      ['valhalla', valhalla],
    ];
    for (const [name, response] of engines) {
      const provider: RouteProvider = createRouteProvider(
        { ...base, LOCATION_ROUTING_PROVIDER: name },
        (async () => response.clone()) as typeof fetch,
      );
      const eta = await computeEta(from, to, provider);
      expect(eta, name).toEqual({ distanceMeters: 6100, etaSeconds: 660, basis: 'route' });
    }

    // …and against the no-network fallback, with the same signature and an honest `basis`.
    const fallback = await computeEta(from, to, createRouteProvider(base));
    expect(fallback.basis).toBe('estimate');
    expect(fallback.etaSeconds).toBeGreaterThan(0);
    expect(fallback.distanceMeters).toBeGreaterThan(4000);
  });

  it('falls back to an estimate when the routing engine fails', async () => {
    for (const status of [429, 403, 500]) {
      const p = createRouteProvider(
        { ...base, LOCATION_ROUTING_PROVIDER: 'osrm' },
        (async () => new Response('x', { status })) as typeof fetch,
      );
      expect((await computeEta(from, to, p)).basis).toBe('estimate');
    }
    const throwing = createRouteProvider(
      { ...base, LOCATION_ROUTING_PROVIDER: 'valhalla' },
      (async () => {
        throw new TypeError('ECONNREFUSED key=SECRET');
      }) as typeof fetch,
    );
    expect((await computeEta(from, to, throwing)).basis).toBe('estimate');
  });
});

describe('GraphHopper & Valhalla adapters', () => {
  it('GraphHopper: lat,lng point order, converts ms -> s, sends the key server-side', async () => {
    const urls: string[] = [];
    const p = createRouteProvider(
      { ...base, LOCATION_ROUTING_PROVIDER: 'graphhopper', LOCATION_ROUTING_API_KEY: 'gh-key' },
      (async (u: string) => {
        urls.push(String(u));
        return json({
          paths: [{ distance: 1234.5, time: 90_000, points: { coordinates: [[85.3, 27.7]] } }],
        });
      }) as unknown as typeof fetch,
    );
    const r = await p.calculateRoute(from, to, { geometry: true });
    expect(r).toMatchObject({ distanceMeters: 1234.5, durationSeconds: 90, method: 'route' });
    expect(r.geometry).toEqual([[85.3, 27.7]]);
    expect(urls[0]).toContain('point=27.7172%2C85.324');
    expect(urls[0]).toContain('key=gh-key');
  });

  it('Valhalla: POSTs lat/lon, converts km -> m', async () => {
    let body = '';
    const p = createRouteProvider({ ...base, LOCATION_ROUTING_PROVIDER: 'valhalla' }, (async (
      _u: string,
      init: RequestInit,
    ) => {
      body = String(init.body);
      return json({ trip: { summary: { length: 2.5, time: 300 } } });
    }) as unknown as typeof fetch);
    const r = await p.calculateRoute(from, to);
    expect(r).toMatchObject({ distanceMeters: 2500, durationSeconds: 300 });
    expect(JSON.parse(body).locations[0]).toEqual({ lat: 27.7172, lon: 85.324 });
  });

  it('rejects malformed engine responses', async () => {
    const bad = [
      ['graphhopper', json({ paths: [] })],
      ['graphhopper', json({ paths: [{ distance: 'x', time: 1 }] })],
      ['valhalla', json({})],
      ['valhalla', json({ trip: { summary: { length: -1, time: 5 } } })],
      ['osrm', json({ code: 'NoRoute', routes: [] })],
    ] as const;
    for (const [name, res] of bad) {
      const p = createRouteProvider({ ...base, LOCATION_ROUTING_PROVIDER: name }, (async () =>
        res.clone()) as typeof fetch);
      await expect(p.calculateRoute(from, to), name).rejects.toMatchObject({
        name: 'LocationProviderError',
      });
    }
  });
});

describe('StaticLocationProvider (offline adapter)', () => {
  const p = new StaticLocationProvider();

  it('searches in English and Nepali script', async () => {
    expect((await p.search('thamel', { limit: 3 }))[0]?.name).toBe('Thamel');
    expect((await p.search('थमेल', { limit: 3 }))[0]?.name).toBe('Thamel');
    expect((await p.search('पोखरा', { limit: 3 }))[0]?.city).toBe('Pokhara');
    expect(await p.search('zzzz-nothing', { limit: 3 })).toEqual([]);
  });

  it('reverse geocodes nearby points, with road vs place kind, and nothing far away', async () => {
    const r = await p.reverseGeocode({ latitude: 27.7043, longitude: 85.3132 });
    expect(r).toMatchObject({ name: 'New Road', kind: 'road' });
    expect(r?.formattedAddress).toContain('Kathmandu');
    expect(await p.reverseGeocode({ latitude: 29.5, longitude: 82.0 })).toBeNull();
  });

  it.each([
    ['Kathmandu Durbar Square', 'Kathmandu'],
    ['Patan Durbar Square', 'Lalitpur'],
    ['Bhaktapur Durbar Square', 'Bhaktapur'],
    ['Biratnagar', 'Biratnagar'],
    ['Bharatpur', 'Bharatpur'],
    ['Nepalgunj', 'Nepalgunj'],
  ])('finds %s', async (q, city) => {
    expect((await p.search(q, { limit: 1 }))[0]?.city).toBe(city);
  });
});
