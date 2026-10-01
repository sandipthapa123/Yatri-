import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaceSummary, ReverseGeocodeResult } from '@yatri/types';

import { coordinateSchema } from '../modules/location/coordinates';
import { haversineMeters } from '../modules/location/geo';
import {
  setLocationProviderForTests,
  setRouteProviderForTests,
} from '../modules/location/providers';
import {
  LocationProviderError,
  type LocationProvider,
} from '../modules/location/providers/location-provider';
import { api, onboardUser } from './helpers';

const THAMEL: PlaceSummary = {
  name: 'Thamel',
  address: 'Kathmandu, Bagmati Province',
  latitude: 27.7154,
  longitude: 85.3123,
  city: 'Kathmandu',
  province: 'Bagmati Province',
  country: 'Nepal',
  postalCode: null,
};

class FakeProvider implements LocationProvider {
  readonly name = 'fake';
  searchCalls = 0;
  reverseCalls = 0;
  failWith: LocationProviderError | null = null;
  results: PlaceSummary[] = [THAMEL];
  reverseResult: ReverseGeocodeResult | null = {
    ...THAMEL,
    formattedAddress: 'Thamel, Kathmandu, Bagmati Province, Nepal',
  };
  lastSearchArgs: unknown;

  async search(query: string, options: unknown) {
    this.searchCalls++;
    this.lastSearchArgs = { query, options };
    if (this.failWith) throw this.failWith;
    return this.results;
  }
  async geocode() {
    return this.results[0] ?? null;
  }
  async reverseGeocode() {
    this.reverseCalls++;
    if (this.failWith) throw this.failWith;
    return this.reverseResult;
  }
}

let provider: FakeProvider;
beforeEach(() => {
  provider = new FakeProvider();
  setLocationProviderForTests(provider);
  setRouteProviderForTests(undefined);
});
afterEach(() => setLocationProviderForTests(undefined));

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('coordinate validation', () => {
  const ok = (latitude: unknown, longitude: unknown) =>
    coordinateSchema.safeParse({ latitude, longitude }).success;

  it('accepts valid coordinates, numbers or numeric strings', () => {
    expect(ok(27.7172, 85.324)).toBe(true);
    expect(ok('27.7172', '85.3240')).toBe(true);
    expect(ok(-33.86, 151.2)).toBe(true);
  });

  it('accepts the exact boundary values', () => {
    expect(ok(90, 180)).toBe(true);
    expect(ok(-90, -180)).toBe(true);
    expect(ok(90, -180)).toBe(true);
  });

  it('rejects out-of-range latitude and longitude', () => {
    expect(ok(90.0001, 85)).toBe(false);
    expect(ok(-90.0001, 85)).toBe(false);
    expect(ok(27, 180.0001)).toBe(false);
    expect(ok(27, -180.0001)).toBe(false);
  });

  it('rejects missing, NaN, Infinity, blank and malformed values', () => {
    expect(ok(undefined, 85)).toBe(false);
    expect(ok(27, undefined)).toBe(false);
    expect(ok(null, null)).toBe(false);
    expect(ok(NaN, 85)).toBe(false);
    expect(ok(27, Infinity)).toBe(false);
    expect(ok(-Infinity, 85)).toBe(false);
    expect(ok('', '')).toBe(false);
    expect(ok('  ', '85')).toBe(false);
    expect(ok('abc', '85')).toBe(false);
    expect(ok('27.7,1', '85')).toBe(false);
    expect(ok('0x10', '85')).toBe(false);
    expect(ok('1e2', '85')).toBe(false);
    expect(ok('NaN', '85')).toBe(false);
    expect(ok('Infinity', '85')).toBe(false);
    expect(ok([27], 85)).toBe(false);
    expect(ok({}, 85)).toBe(false);
  });

  it('rejects the 0,0 "no GPS fix" placeholder', () => {
    expect(ok(0, 0)).toBe(false);
    expect(ok(0, 85)).toBe(true);
  });
});

describe('haversine distance', () => {
  const ktm = { latitude: 27.7172, longitude: 85.324 };
  const pkr = { latitude: 28.2096, longitude: 83.9856 };
  const lalitpur = { latitude: 27.6588, longitude: 85.3247 };

  it('is zero for identical points and symmetric', () => {
    expect(haversineMeters(ktm, ktm)).toBe(0);
    expect(haversineMeters(ktm, pkr)).toBeCloseTo(haversineMeters(pkr, ktm), 6);
  });

  it('matches known distances (Kathmandu–Pokhara ≈ 143 km, Kathmandu–Lalitpur ≈ 6.5 km)', () => {
    expect(haversineMeters(ktm, pkr) / 1000).toBeGreaterThan(140);
    expect(haversineMeters(ktm, pkr) / 1000).toBeLessThan(146);
    expect(haversineMeters(ktm, lalitpur) / 1000).toBeGreaterThan(6);
    expect(haversineMeters(ktm, lalitpur) / 1000).toBeLessThan(7);
  });

  it('handles the antimeridian and poles without NaN', () => {
    const d = haversineMeters(
      { latitude: 0.5, longitude: 179.9 },
      { latitude: 0.5, longitude: -179.9 },
    );
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(30_000);
    expect(
      Number.isFinite(
        haversineMeters({ latitude: 90, longitude: 0 }, { latitude: -90, longitude: 0 }),
      ),
    ).toBe(true);
  });
});

describe('GET /location/search', () => {
  it('requires authentication', async () => {
    const res = await api.get('/api/v1/location/search?q=thamel');
    expect(res.status).toBe(401);
  });

  it('returns normalized results for a valid query', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api.get('/api/v1/location/search?q=Thamel').set(auth(accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([THAMEL]);
    // Only the normalized shape is exposed — no provider metadata.
    expect(Object.keys(res.body.data[0]).sort()).toEqual(Object.keys(THAMEL).sort());
  });

  it('works for drivers as well', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await api.get('/api/v1/location/search?q=Thamel').set(auth(accessToken));
    expect(res.status).toBe(200);
  });

  it('passes Nepali text through unchanged (NFC normalised)', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api
      .get(`/api/v1/location/search?q=${encodeURIComponent('थमेल')}`)
      .set(auth(accessToken));
    expect(res.status).toBe(200);
    expect((provider.lastSearchArgs as { query: string }).query).toBe('थमेल');
  });

  it('rejects empty, too-short, too-long and control-character queries', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    for (const q of ['', ' ', 'a', 'x'.repeat(101), 'ab%00cd']) {
      const res = await api.get(`/api/v1/location/search?q=${q}`).set(auth(accessToken));
      expect(res.status, `q=${q}`).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    const missing = await api.get('/api/v1/location/search').set(auth(accessToken));
    expect(missing.status).toBe(400);
    expect(provider.searchCalls).toBe(0);
  });

  it('rejects an out-of-range limit and a half-specified bias point', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    expect(
      (await api.get('/api/v1/location/search?q=thamel&limit=50').set(auth(accessToken))).status,
    ).toBe(400);
    expect(
      (await api.get('/api/v1/location/search?q=thamel&nearLatitude=27.7').set(auth(accessToken)))
        .status,
    ).toBe(400);
    expect(
      (
        await api
          .get('/api/v1/location/search?q=thamel&nearLatitude=200&nearLongitude=85')
          .set(auth(accessToken))
      ).status,
    ).toBe(400);
  });

  it('caches repeated searches (one provider call) and coarsens the bias point', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const url = '/api/v1/location/search?q=Thamel&nearLatitude=27.71549&nearLongitude=85.31234';
    await api.get(url).set(auth(accessToken));
    await api.get(url.replace('Thamel', '%20thamel%20')).set(auth(accessToken));
    expect(provider.searchCalls).toBe(1);
    const sent = provider.lastSearchArgs as { options: { near: { latitude: number } } };
    expect(sent.options.near.latitude).toBe(27.72); // ~1 km, not the exact position
  });

  it('maps provider failures to safe errors without leaking internals', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    provider.failWith = new LocationProviderError(
      'UNAVAILABLE',
      'GET https://secret.example/search?key=SUPERSECRET 500',
    );
    const res = await api.get('/api/v1/location/search?q=thamel').set(auth(accessToken));
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('LOCATION_PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('SUPERSECRET');
    expect(JSON.stringify(res.body)).not.toContain('secret.example');
  });

  it('reports quota / rate-limit exhaustion as a "busy" error', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    for (const kind of ['QUOTA', 'RATE_LIMITED'] as const) {
      provider.failWith = new LocationProviderError(kind, 'x');
      const res = await api.get(`/api/v1/location/search?q=${kind}abc`).set(auth(accessToken));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('LOCATION_PROVIDER_BUSY');
    }
  });

  it('returns 503 when no provider is configured', async () => {
    setLocationProviderForTests(null);
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api.get('/api/v1/location/search?q=thamel').set(auth(accessToken));
    expect(res.status).toBe(503);
  });
});

describe('GET /location/reverse-geocode', () => {
  it('requires authentication', async () => {
    expect(
      (await api.get('/api/v1/location/reverse-geocode?latitude=27.7&longitude=85.3')).status,
    ).toBe(401);
  });

  it('returns the address and echoes the requested coordinates', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api
      .get('/api/v1/location/reverse-geocode?latitude=27.71543&longitude=85.31231')
      .set(auth(accessToken));
    expect(res.status).toBe(200);
    expect(res.body.data.formattedAddress).toBe('Thamel, Kathmandu, Bagmati Province, Nepal');
    expect(res.body.data.latitude).toBe(27.71543);
    expect(res.body.data.longitude).toBe(85.31231);
  });

  it('reuses the cache for taps within ~10 m but keeps each tap’s own coordinates', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    await api
      .get('/api/v1/location/reverse-geocode?latitude=27.71541&longitude=85.31231')
      .set(auth(accessToken));
    const res = await api
      .get('/api/v1/location/reverse-geocode?latitude=27.71543&longitude=85.31233')
      .set(auth(accessToken));
    expect(provider.reverseCalls).toBe(1);
    expect(res.body.data.latitude).toBe(27.71543);
  });

  it('rejects invalid or missing coordinates', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    for (const qs of [
      '',
      'latitude=27.7',
      'longitude=85.3',
      'latitude=91&longitude=85',
      'latitude=27&longitude=181',
      'latitude=abc&longitude=85',
      'latitude=NaN&longitude=85',
      'latitude=Infinity&longitude=85',
      'latitude=&longitude=',
      'latitude=0&longitude=0',
    ]) {
      const res = await api.get(`/api/v1/location/reverse-geocode?${qs}`).set(auth(accessToken));
      expect(res.status, qs).toBe(400);
    }
    expect(provider.reverseCalls).toBe(0);
  });

  it('returns 404 with a helpful message when nothing is known there', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    provider.reverseResult = null;
    const res = await api
      .get('/api/v1/location/reverse-geocode?latitude=28.5&longitude=84.5')
      .set(auth(accessToken));
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LOCATION_NOT_FOUND');
  });

  it('maps provider failure to a safe 503', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    provider.failWith = new LocationProviderError('TIMEOUT', 'boom key=abc');
    const res = await api
      .get('/api/v1/location/reverse-geocode?latitude=28.5&longitude=84.5')
      .set(auth(accessToken));
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('key=abc');
  });
});

describe('POST /location/distance', () => {
  const body = {
    origin: { latitude: 27.7172, longitude: 85.324 },
    destination: { latitude: 28.2096, longitude: 83.9856 },
  };

  it('requires authentication', async () => {
    expect((await api.post('/api/v1/location/distance').send(body)).status).toBe(401);
  });

  it('calculates a straight-line distance on the backend', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api.post('/api/v1/location/distance').set(auth(accessToken)).send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.method).toBe('straight_line');
    expect(res.body.data.distanceKm).toBeGreaterThan(140);
    expect(res.body.data.distanceKm).toBeLessThan(146);
    expect(
      Math.abs(res.body.data.distanceMeters - res.body.data.distanceKm * 1000),
    ).toBeLessThanOrEqual(10);
  });

  it('ignores any client-supplied distance', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api
      .post('/api/v1/location/distance')
      .set(auth(accessToken))
      .send({ ...body, distanceMeters: 1, distanceKm: 0.001 });
    expect(res.body.data.distanceKm).toBeGreaterThan(140);
  });

  it('uses the route provider for method=route and falls back honestly on failure', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    setRouteProviderForTests({
      name: 'fake-route',
      capabilities: { steps: false, traffic: false },
      calculateETA: async () => 1000,
      calculateRoute: async () => ({
        distanceMeters: 200_000,
        durationSeconds: 14_400,
        method: 'route',
      }),
    });
    const ok = await api
      .post('/api/v1/location/distance')
      .set(auth(accessToken))
      .send({ ...body, method: 'route' });
    expect(ok.body.data).toMatchObject({
      method: 'route',
      distanceKm: 200,
      durationSeconds: 14400,
    });

    setRouteProviderForTests({
      name: 'broken',
      capabilities: { steps: false, traffic: false },
      calculateETA: async () => null,
      calculateRoute: async () => {
        throw new LocationProviderError('UNAVAILABLE', 'down');
      },
    });
    const fallback = await api
      .post('/api/v1/location/distance')
      .set(auth(accessToken))
      .send({ ...body, method: 'route' });
    expect(fallback.status).toBe(200);
    expect(fallback.body.data.method).toBe('straight_line');
  });

  it('rejects invalid coordinates and unknown methods', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const bad = [
      {},
      { origin: body.origin },
      { ...body, origin: { latitude: 100, longitude: 85 } },
      { ...body, destination: { latitude: 27, longitude: 'abc' } },
      { ...body, destination: { latitude: null, longitude: null } },
      { ...body, method: 'teleport' },
    ];
    for (const b of bad) {
      const res = await api.post('/api/v1/location/distance').set(auth(accessToken)).send(b);
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
  });
});
