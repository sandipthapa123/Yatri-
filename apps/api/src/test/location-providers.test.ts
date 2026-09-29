import { describe, expect, it } from 'vitest';

import { NominatimProvider } from '../modules/location/providers/nominatim-provider';
import { OsrmRouteProvider } from '../modules/location/providers/route-provider';

function fakeFetch(handler: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    return handler(url);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function makeProvider(f: typeof fetch, apiKey?: string) {
  return new NominatimProvider({
    baseUrl: 'https://geo.example.test/',
    apiKey,
    userAgent: 'Yatri-Test',
    countryCodes: ['np'],
    timeoutMs: 1000,
    fetchImpl: f,
  });
}

describe('NominatimProvider', () => {
  it('normalizes results, builds Nepal-style labels and dedupes', async () => {
    const { impl, calls } = fakeFetch(() =>
      json([
        {
          lat: '27.7154',
          lon: '85.3123',
          name: 'Thamel',
          address: {
            suburb: 'Thamel',
            city: 'Kathmandu',
            state: 'Bagmati Province',
            country: 'Nepal',
          },
        },
        // same place returned twice -> deduped
        {
          lat: '27.71541',
          lon: '85.31231',
          name: 'Thamel',
          address: { city: 'Kathmandu', state: 'Bagmati Province', country: 'Nepal' },
        },
        {
          lat: '27.7160',
          lon: '85.3130',
          name: 'Thamel Chowk',
          display_name: 'Thamel Chowk, Kathmandu',
          address: {
            city: 'Kathmandu',
            state: 'Bagmati Province',
            country: 'Nepal',
            postcode: '44600',
          },
        },
        { lat: 'nonsense', lon: '85', name: 'Broken' },
        { lat: '95', lon: '85', name: 'Impossible' },
      ]),
    );
    const results = await makeProvider(impl, 'k-123').search('thamel', { limit: 5 });

    expect(results.map((r) => r.name)).toEqual(['Thamel', 'Thamel Chowk']);
    expect(results[1]).toMatchObject({
      address: 'Kathmandu, Bagmati Province',
      postalCode: '44600',
      province: 'Bagmati Province',
    });
    // Restricts to configured countries, asks for Nepali + English names, sends the key server-side.
    expect(calls[0]).toContain('countrycodes=np');
    expect(calls[0]).toContain('accept-language=en%2Cne');
    expect(calls[0]).toContain('key=k-123');
    expect(calls[0]).toContain('https://geo.example.test/search?');
  });

  it('honours the result limit', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      lat: String(27 + i / 100),
      lon: '85',
      name: `Place ${i}`,
    }));
    const { impl } = fakeFetch(() => json(items));
    expect(await makeProvider(impl).search('place', { limit: 3 })).toHaveLength(3);
  });

  it('handles Nepali-script names and other cities (Pokhara, Biratnagar, Bharatpur, Nepalgunj)', async () => {
    const cases = [
      ['पोखरा', 'Pokhara', 'Gandaki Province'],
      ['विराटनगर', 'Biratnagar', 'Koshi Province'],
      ['भरतपुर', 'Bharatpur', 'Bagmati Province'],
      ['नेपालगञ्ज', 'Nepalgunj', 'Lumbini Province'],
    ] as const;
    for (const [ne, en, province] of cases) {
      const { impl } = fakeFetch(() =>
        json([
          {
            lat: '28.2',
            lon: '84.0',
            name: ne,
            address: { city: en, state: province, country: 'Nepal' },
          },
        ]),
      );
      const [r] = await makeProvider(impl).search(ne, { limit: 1 });
      expect(r?.name).toBe(ne);
      expect(r?.city).toBe(en);
      expect(r?.province).toBe(province);
    }
  });

  it('reverse geocodes to a full address', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({
        lat: '27.7154',
        lon: '85.3123',
        name: 'Thamel',
        address: { city: 'Kathmandu', state: 'Bagmati Province', country: 'Nepal' },
      }),
    );
    const r = await makeProvider(impl).reverseGeocode({ latitude: 27.7154, longitude: 85.3123 });
    expect(r?.formattedAddress).toBe('Thamel, Kathmandu, Bagmati Province, Nepal');
    expect(calls[0]).toContain('/reverse?');
    expect(calls[0]).toContain('lat=27.7154');
  });

  it('treats "Unable to geocode" as no result, not a failure', async () => {
    const { impl } = fakeFetch(() => json({ error: 'Unable to geocode' }));
    expect(await makeProvider(impl).reverseGeocode({ latitude: 28, longitude: 84 })).toBeNull();
  });

  it('classifies failures without exposing upstream text', async () => {
    const kinds: Array<[() => Response | Promise<Response>, string]> = [
      [() => new Response('nope', { status: 429 }), 'RATE_LIMITED'],
      [() => new Response('nope', { status: 403 }), 'QUOTA'],
      [() => new Response('nope', { status: 401 }), 'QUOTA'],
      [() => new Response('nope', { status: 502 }), 'UNAVAILABLE'],
      [() => new Response('<html>not json</html>', { status: 200 }), 'BAD_RESPONSE'],
      [() => json({ not: 'an array' }), 'BAD_RESPONSE'],
      [
        () => {
          throw new TypeError('fetch failed: ECONNREFUSED https://geo.example.test/?key=SECRET');
        },
        'UNAVAILABLE',
      ],
      [
        () => {
          throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
        },
        'TIMEOUT',
      ],
    ];
    for (const [handler, kind] of kinds) {
      const { impl } = fakeFetch(handler);
      await expect(
        makeProvider(impl, 'SECRET').search('thamel', { limit: 3 }),
      ).rejects.toMatchObject({
        kind,
      });
    }
    const { impl } = fakeFetch(() => {
      throw new TypeError('ECONNREFUSED key=SECRET');
    });
    await expect(makeProvider(impl, 'SECRET').search('x y', { limit: 1 })).rejects.toSatisfy(
      (e: Error) => !e.message.includes('SECRET'),
    );
  });
});

describe('OsrmRouteProvider', () => {
  const from = { latitude: 27.7172, longitude: 85.324 };
  const to = { latitude: 27.6588, longitude: 85.3247 };
  const make = (f: typeof fetch) =>
    new OsrmRouteProvider({ baseUrl: 'https://osrm.example.test', timeoutMs: 1000, fetchImpl: f });

  it('parses distance, duration and optional geometry (lng,lat order in the URL)', async () => {
    const { impl, calls } = fakeFetch(() =>
      json({
        code: 'Ok',
        routes: [{ distance: 8123.4, duration: 900, geometry: { coordinates: [[85.3, 27.7]] } }],
      }),
    );
    const r = await make(impl).calculateRoute(from, to, { geometry: true });
    expect(r).toMatchObject({ distanceMeters: 8123.4, durationSeconds: 900, method: 'route' });
    expect(r.geometry).toEqual([[85.3, 27.7]]);
    expect(calls[0]).toContain('/route/v1/driving/85.324,27.7172;85.3247,27.6588');
    expect(await make(impl).calculateETA(from, to)).toBe(900);
  });

  it('fails cleanly on NoRoute / bad responses / outages', async () => {
    for (const handler of [
      () => json({ code: 'NoRoute', routes: [] }),
      () => json({ code: 'Ok', routes: [{ distance: 'x' }] }),
      () => new Response('', { status: 500 }),
      () => new Response('', { status: 429 }),
    ]) {
      const { impl } = fakeFetch(handler);
      await expect(make(impl).calculateRoute(from, to)).rejects.toMatchObject({
        name: 'LocationProviderError',
      });
    }
  });
});
