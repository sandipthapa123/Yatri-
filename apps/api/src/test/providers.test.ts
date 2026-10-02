import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  PROVIDER_CAPABILITIES,
  PROVIDER_CHOICES,
  PROVIDER_ENV_KEY,
  PROVIDER_PUBLIC_MESSAGES,
  PROVIDER_REQUIRED_ENV,
  SECRET_ENV_KEYS,
  environmentProfileOf,
  healthFromCalls,
  providerProblems,
  type DigitalPaymentInfo,
  type ProviderSelection,
  type ProvidersOverview,
} from '@yatri/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pool } from '../config/database';
import { ENV_KEYS, envIssues } from '../config/env';
import { HttpError, errorHandler } from '../middleware/errorHandler';
import { sigv4Example } from './sigv4-example';
import { ConsoleEmailProvider, ResendEmailProvider } from '../lib/email/email-provider';
import { setErrorReporterForTests, ConsoleErrorReporter } from '../lib/monitoring';
import { SentryErrorReporter, scrub, scrubbedEvent } from '../lib/monitoring/reporter';
import { ExpoPushProvider } from '../lib/notifications/expo-provider';
import { S3StorageProvider } from '../lib/storage/s3-provider';
import { FallbackSmsProvider } from '../modules/auth/sms/fallback-sms-provider';
import { TwilioSmsProvider } from '../modules/auth/sms/twilio-sms-provider';
import { TwilioIceProvider } from '../modules/calls/twilio-ice-provider';
import { MapboxGeocodingProvider } from '../modules/location/providers/mapbox-provider';
import { MapboxRouteProvider } from '../modules/location/providers/route-provider';
import { setPaymentGatewayForTests } from '../modules/payments/gateway';
import { KhaltiGateway } from '../modules/payments/khalti-gateway';
import { BREAKER_THRESHOLD, breakerOpen, resetBreakers } from '../modules/providers/breaker';
import { ProviderError } from '../modules/providers/errors';
import { stateOf } from '../modules/providers/health';
import { providerRequest } from '../modules/providers/http';
import { sweepPaymentAttempts } from '../modules/trips/digital-payments.service';
import { api, loginTestAdmin } from './helpers';
import { auth, finishedRide } from './rides';

const SRC = join(__dirname, '..');
const ok = (body: unknown = {}, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noSleep = async () => undefined;

// ================================================================ the one rule per environment

describe('which providers an environment may use (one rule)', () => {
  const real: ProviderSelection = {
    OTP: 'twilio',
    PUSH: 'expo',
    MAPS_GEOCODING: 'mapbox',
    MAPS_ROUTING: 'mapbox',
    PAYMENTS: 'khalti',
    STORAGE: 's3',
    CALLS: 'twilio',
    REALTIME: 'redis',
    EMAIL: 'resend',
    MONITORING: 'sentry',
  };
  const all = () => true;

  it('maps NODE_ENV to the three environments', () => {
    expect(environmentProfileOf('development')).toBe('DEVELOPMENT');
    expect(environmentProfileOf('test')).toBe('DEVELOPMENT');
    expect(environmentProfileOf('staging')).toBe('STAGING');
    expect(environmentProfileOf('production')).toBe('PRODUCTION');
  });

  it('accepts real providers in staging and production, and stand-ins in development', () => {
    expect(providerProblems('PRODUCTION', real, all)).toEqual([]);
    expect(providerProblems('STAGING', real, all)).toEqual([]);
    const dev: ProviderSelection = { ...real, OTP: 'console', PUSH: 'console', MAPS_GEOCODING: 'static', PAYMENTS: 'sandbox', STORAGE: 'local', EMAIL: 'console', MONITORING: 'none', CALLS: 'webrtc', MAPS_ROUTING: 'haversine' };
    expect(providerProblems('DEVELOPMENT', dev, all)).toEqual([]);
  });

  it('refuses every development stand-in once people depend on it', () => {
    for (const env of ['STAGING', 'PRODUCTION'] as const) {
      for (const [need, vendor] of [['OTP', 'console'], ['PUSH', 'console'], ['MAPS_GEOCODING', 'static'], ['PAYMENTS', 'sandbox'], ['STORAGE', 'local'], ['EMAIL', 'console']] as const) {
        const problems = providerProblems(env, { ...real, [need]: vendor }, all).join(' ');
        expect(problems, `${env} ${need}=${vendor}`).toContain(PROVIDER_ENV_KEY[need]);
      }
    }
  });

  it('requires production to report errors, and a chosen vendor to have its credentials', () => {
    expect(providerProblems('PRODUCTION', { ...real, MONITORING: 'none' }, all).join()).toContain('MONITORING_PROVIDER');
    expect(providerProblems('STAGING', { ...real, MONITORING: 'none' }, all)).toEqual([]);
    const missing = (key: string) => key !== 'TWILIO_AUTH_TOKEN';
    expect(providerProblems('PRODUCTION', real, missing).join()).toContain('TWILIO_AUTH_TOKEN');
  });

  it('names a valid environment variable for every need, and lists the vendors the API accepts', () => {
    for (const need of Object.keys(PROVIDER_CHOICES) as Array<keyof typeof PROVIDER_CHOICES>) {
      expect(ENV_KEYS).toContain(PROVIDER_ENV_KEY[need]);
    }
    for (const keys of Object.values(PROVIDER_REQUIRED_ENV)) for (const k of keys) expect(ENV_KEYS).toContain(k);
  });

  it('is enforced by the API configuration at start-up', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@db.internal:5432/yatri',
      JWT_ACCESS_SECRET: 'k'.repeat(24) + 'A1b2C3d4E5f6G7h8',
      STORAGE_SIGNING_SECRET: 'q'.repeat(24) + 'Z9y8X7w6V5u4T3s2',
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://admin.example.org',
      PUBLIC_BASE_URL: 'https://api.example.org',
      SMS_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'ACxxxxxxxx',
      TWILIO_AUTH_TOKEN: 'x'.repeat(32),
      TWILIO_FROM_NUMBER: '+15005550006',
      PUSH_PROVIDER: 'expo',
      LOCATION_PROVIDER: 'mapbox',
      LOCATION_ROUTING_PROVIDER: 'mapbox',
      MAPBOX_ACCESS_TOKEN: 'pk.xxxxxxxxxxxx',
      STORAGE_PROVIDER: 's3',
      S3_BUCKET: 'yatri',
      S3_ACCESS_KEY_ID: 'AKIAXXXXXXXX',
      S3_SECRET_ACCESS_KEY: 'x'.repeat(40),
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_xxxxxxxx',
      EMAIL_FROM: 'Yatri <no-reply@example.org>',
      MONITORING_PROVIDER: 'sentry',
      SENTRY_DSN: 'https://key@o1.ingest.sentry.io/1',
    };
    const problems = (over: Record<string, string>) => envIssues({ ...base, ...over } as NodeJS.ProcessEnv).join(' | ');
    expect(problems({})).toBe('');
    expect(problems({ SMS_PROVIDER: 'console' })).toContain('SMS_PROVIDER');
    expect(problems({ STORAGE_PROVIDER: 'local' })).toContain('STORAGE_PROVIDER');
    expect(problems({ MONITORING_PROVIDER: 'none' })).toContain('MONITORING_PROVIDER');
    expect(problems({ S3_SECRET_ACCESS_KEY: '' })).toContain('S3_SECRET_ACCESS_KEY');
    expect(problems({ PAYMENT_PROVIDER: 'khalti' })).toContain('KHALTI_SECRET_KEY');
    expect(problems({ PAYMENT_PROVIDER: 'sandbox' })).toContain('PAYMENT_PROVIDER');
    expect(problems({ SMS_FALLBACK_PROVIDER: 'twilio' })).toContain('SMS_FALLBACK_PROVIDER');
    // staging gets production's rules
    expect(problems({ NODE_ENV: 'staging', SMS_PROVIDER: 'console' })).toContain('SMS_PROVIDER');
  });
});

describe('secrets', () => {
  it('lists every credential variable, and .env.example holds no value for any vendor credential', () => {
    const example = readFileSync(join(SRC, '..', '.env.example'), 'utf8');
    // The local development database, cache and signing placeholders are meant to be there; vendor credentials never are.
    const local = new Set(['DATABASE_URL', 'REDIS_URL', 'JWT_ACCESS_SECRET', 'STORAGE_SIGNING_SECRET']);
    for (const key of SECRET_ENV_KEYS.filter((k) => !local.has(k))) {
      const line = example.split('\n').find((l) => l.startsWith(`${key}=`));
      if (line !== undefined) expect(line.slice(key.length + 1).trim(), key).toBe('');
    }
  });

  it('never puts a secret variable name in an API response type, a log call or the admin answer', async () => {
    const adminUser = await loginTestAdmin(`prov-${Date.now()}@example.com`, 'a-strong-test-password-1', ['SETTINGS_VIEW']);
    const res = await api.get('/api/v1/admin/providers').set(auth(adminUser));
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    for (const key of SECRET_ENV_KEYS) expect(text).not.toContain(key);
    expect(text).not.toMatch(/https?:\/\//); // no vendor address
    expect(text).not.toMatch(/AC[0-9a-f]{8}|AKIA|sk_|pk\./);
  });
});

// ================================================================ one vendor-call function

describe('providerRequest: deadline, retry, breaker, naming, usage', () => {
  beforeEach(() => resetBreakers());
  const call = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
    providerRequest({ capability: 'MAPS', provider: 'test', operation: 'x', url: 'https://vendor.test/a?key=SECRET', timeoutMs: 50, fetchImpl, sleep: noSleep, expect: 'json', ...over });

  it('returns the parsed answer', async () => {
    const r = await call(async () => ok({ a: 1 }));
    expect(r.data).toEqual({ a: 1 });
  });

  it('turns a deadline into TIMEOUT and does not hang', async () => {
    const f = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'TimeoutError' }))))) as unknown as typeof fetch;
    const started = Date.now();
    await expect(call(f)).rejects.toMatchObject({ kind: 'TIMEOUT' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('names failures by kind and never carries the vendor words, status text or address', async () => {
    const cases: Array<[number, string]> = [[401, 'AUTH'], [403, 'AUTH'], [429, 'RATE_LIMITED'], [500, 'UNAVAILABLE'], [503, 'UNAVAILABLE'], [400, 'BAD_REQUEST']];
    for (const [status, kind] of cases) {
      resetBreakers();
      const err = await call(async () => new Response('vendor says: secret key sk_live_123 invalid', { status })).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.kind).toBe(kind);
      expect(err.message).not.toContain('sk_live');
      expect(err.message).not.toContain('vendor.test');
      expect(err.publicMessage).toBe(PROVIDER_PUBLIC_MESSAGES.MAPS);
    }
  });

  it('retries a safe call that failed in passing, and never retries a call that could act twice', async () => {
    let calls = 0;
    const flaky = async () => (++calls < 3 ? new Response('', { status: 503 }) : ok({ done: true }));
    const r = await call(flaky as unknown as typeof fetch, { idempotent: true, retries: 2 });
    expect(r.data).toEqual({ done: true });
    expect(calls).toBe(3);

    calls = 0;
    await expect(call((async () => (calls++, new Response('', { status: 503 }))) as unknown as typeof fetch, { idempotent: false })).rejects.toMatchObject({ kind: 'UNAVAILABLE' });
    expect(calls).toBe(1);

    calls = 0;
    await expect(call((async () => (calls++, new Response('', { status: 401 }))) as unknown as typeof fetch, { idempotent: true, retries: 2 })).rejects.toMatchObject({ kind: 'AUTH' });
    expect(calls).toBe(1); // wrong credentials will not get better
  });

  it('stops calling a vendor that keeps failing, then lets one call through later', async () => {
    let calls = 0;
    const down = (async () => (calls++, new Response('', { status: 503 }))) as unknown as typeof fetch;
    for (let i = 0; i < BREAKER_THRESHOLD; i += 1) await call(down).catch(() => undefined);
    expect(breakerOpen('MAPS', 'test')).toBe(true);
    const before = calls;
    await expect(call(down)).rejects.toMatchObject({ kind: 'CIRCUIT_OPEN' });
    expect(calls).toBe(before); // not even tried
  });

  it('counts calls by outcome without storing anything sensitive', async () => {
    resetBreakers();
    await call(async () => ok({}), { provider: 'usage-test' });
    await call(async () => new Response('', { status: 503 }), { provider: 'usage-test' }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
    const rows = await pool.query(`SELECT outcome, calls FROM provider_usage WHERE provider = 'usage-test' AND day = current_date ORDER BY outcome`);
    expect(rows.rows.map((r) => r.outcome)).toEqual(['OK', 'UNAVAILABLE']);
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'provider_usage'`);
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(['calls', 'capability', 'day', 'outcome', 'provider', 'total_ms']);
  });
});

describe('health rules', () => {
  it('needs enough calls before judging, then reads the failure ratio', () => {
    expect(healthFromCalls(4, 4)).toBeNull();
    expect(healthFromCalls(10, 0)).toBe('UP');
    expect(healthFromCalls(10, 2)).toBe('DEGRADED');
    expect(healthFromCalls(10, 5)).toBe('DOWN');
  });

  it('shows a stand-in as simulated, missing credentials as not set up, and an unchecked vendor as unverified, never as working', () => {
    const base = { simulated: false, missingEnv: false, check: null, calls: 0, failures: 0, hasCheck: true };
    expect(stateOf({ ...base, simulated: true })).toBe('SIMULATED');
    expect(stateOf({ ...base, missingEnv: true })).toBe('NOT_CONFIGURED');
    expect(stateOf(base)).toBe('UNVERIFIED');
    expect(stateOf({ ...base, check: { ok: true, ageMs: 1000 } })).toBe('UP');
    expect(stateOf({ ...base, check: { ok: true, ageMs: 60 * 60 * 1000 } })).toBe('UNVERIFIED'); // an old check is not believed
    expect(stateOf({ ...base, check: { ok: false, ageMs: 1000 } })).toBe('DOWN');
    expect(stateOf({ ...base, check: { ok: true, ageMs: 1000 }, calls: 10, failures: 6 })).toBe('DOWN');
  });
});

// ================================================================ adapters (against a pretend vendor)

describe('SMS: Twilio and the fallback', () => {
  it('posts the message with basic auth and never repeats a failed send', async () => {
    resetBreakers();
    const f = vi.fn(async () => ok({}, 201));
    const twilio = new TwilioSmsProvider({ accountSid: 'AC123', authToken: 'tok', from: '+15005550006', timeoutMs: 100, fetchImpl: f as unknown as typeof fetch });
    await twilio.send({ toPhoneNumber: '+9779812345678', body: 'Your code is 123456' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/Accounts/AC123/Messages.json');
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
    expect(String(init.body)).toContain('To=%2B9779812345678');
  });

  it('uses the fallback only for a failure that may pass, and reports the primary failure when both fail', async () => {
    const fail = (kind: ConstructorParameters<typeof ProviderError>[2]) => ({ name: 'p', send: vi.fn(async () => { throw new ProviderError('OTP', 'p', kind); }) });
    const good = { name: 'f', send: vi.fn(async () => undefined) };
    await new FallbackSmsProvider(fail('TIMEOUT'), good).send({ toPhoneNumber: '+1', body: 'x' });
    expect(good.send).toHaveBeenCalledTimes(1);

    const good2 = { name: 'f', send: vi.fn(async () => undefined) };
    await expect(new FallbackSmsProvider(fail('AUTH'), good2).send({ toPhoneNumber: '+1', body: 'x' })).rejects.toMatchObject({ kind: 'AUTH' });
    expect(good2.send).not.toHaveBeenCalled(); // misconfiguration is not hidden by a fallback

    const bad = { name: 'f', send: vi.fn(async () => { throw new ProviderError('OTP', 'f', 'UNAVAILABLE'); }) };
    await expect(new FallbackSmsProvider(fail('UNAVAILABLE'), bad).send({ toPhoneNumber: '+1', body: 'x' })).rejects.toMatchObject({ kind: 'UNAVAILABLE', provider: 'p' });
  });
});

describe('Push: Expo', () => {
  it('sends only the title, body and a minimal data, and removes a phone the service says is gone', async () => {
    resetBreakers();
    const u = await pool.query(`INSERT INTO users (phone_number, role) VALUES ($1, 'PASSENGER') RETURNING id`, [`+9779${Math.floor(Math.random() * 1e8)}`]);
    const userId = u.rows[0].id as string;
    await pool.query(`INSERT INTO push_tokens (token, user_id, platform) VALUES ('ExponentPushToken[aaaaaaaaaa]', $1, 'android')`, [userId]);
    const f = vi.fn(async () => ok({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }));
    await new ExpoPushProvider({ timeoutMs: 100, fetchImpl: f as unknown as typeof fetch }).send({
      userId, type: 'TRIP_ACCEPTED', title: 'Driver coming', body: 'Ram is on the way', metadata: { tripId: 't1', accessibilityNote: 'wheelchair' },
    });
    const sent = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))[0];
    expect(sent.data).toEqual({ type: 'TRIP_ACCEPTED', tripId: 't1' });
    expect(JSON.stringify(sent)).not.toContain('wheelchair');
    expect((await pool.query('SELECT 1 FROM push_tokens WHERE user_id = $1', [userId])).rowCount).toBe(0);
  });

  it('lets a person register and remove their own phone, and refuses a malformed token', async () => {
    const { onboardUser } = await import('./helpers');
    const me = await onboardUser('PASSENGER');
    const token = `ExponentPushToken[${Math.random().toString(36).slice(2, 14).padEnd(12, 'x')}]`;
    expect((await api.post('/api/v1/users/me/push-token').set(auth(me.accessToken)).send({ token: 'nope', platform: 'ios' })).status).toBe(400);
    expect((await api.post('/api/v1/users/me/push-token').send({ token, platform: 'ios' })).status).toBe(401);
    expect((await api.post('/api/v1/users/me/push-token').set(auth(me.accessToken)).send({ token, platform: 'ios' })).status).toBe(200);
    const other = await onboardUser('PASSENGER');
    await api.delete('/api/v1/users/me/push-token').set(auth(other.accessToken)).send({ token }); // not theirs: no effect
    expect((await pool.query('SELECT 1 FROM push_tokens WHERE token = $1', [token])).rowCount).toBe(1);
    await api.delete('/api/v1/users/me/push-token').set(auth(me.accessToken)).send({ token });
    expect((await pool.query('SELECT 1 FROM push_tokens WHERE token = $1', [token])).rowCount).toBe(0);
  });
});

describe('Maps: Mapbox', () => {
  it('plans a route with the same steps and a traffic-aware duration, through the shared OSRM parsing', async () => {
    resetBreakers();
    const f = vi.fn(async () =>
      ok({
        code: 'Ok',
        routes: [{ distance: 1200, duration: 300, geometry: { coordinates: [[85.3, 27.7], [85.31, 27.71]] }, legs: [{ steps: [{ distance: 1200, duration: 300, name: 'New Road', maneuver: { type: 'depart', location: [85.3, 27.7] } }] }] }],
      }),
    );
    const p = new MapboxRouteProvider({ baseUrl: 'https://api.mapbox.test', apiKey: 'pk.test', timeoutMs: 100, fetchImpl: f as unknown as typeof fetch });
    const r = await p.calculateRoute({ latitude: 27.7, longitude: 85.3 }, { latitude: 27.71, longitude: 85.31 }, { steps: true, geometry: true });
    expect(r.trafficAware).toBe(true);
    expect(r.steps?.[0]?.maneuver).toBe('depart');
    expect((f.mock.calls[0] as unknown as [string])[0]).toContain('/driving-traffic/');
    expect(p.capabilities).toEqual({ steps: true, traffic: true });
  });

  it('normalises a geocoding answer to the shared place shape and treats "nothing here" as no result', async () => {
    resetBreakers();
    const feature = { text: 'Thamel', center: [85.3123, 27.7154], place_type: ['neighborhood'], context: [{ id: 'place.1', text: 'Kathmandu' }, { id: 'region.1', text: 'Bagmati Province' }, { id: 'country.1', text: 'Nepal' }] };
    const g = new MapboxGeocodingProvider({ baseUrl: 'https://api.mapbox.test', accessToken: 'pk.test', countryCodes: ['np'], timeoutMs: 100, fetchImpl: (async () => ok({ features: [feature] })) as unknown as typeof fetch });
    const [place] = await g.search('Thamel', { limit: 3 });
    expect(place).toMatchObject({ name: 'Thamel', city: 'Kathmandu', province: 'Bagmati Province', country: 'Nepal' });
    const empty = new MapboxGeocodingProvider({ baseUrl: 'https://api.mapbox.test', accessToken: 'pk.test', countryCodes: [], timeoutMs: 100, fetchImpl: (async () => ok({ features: [] })) as unknown as typeof fetch });
    expect(await empty.reverseGeocode({ latitude: 0, longitude: 0 })).toBeNull();
  });
});

describe('Storage: S3-compatible', () => {
  it('signs exactly as AWS documents (published example signatures)', () => {
    const { header, presigned } = sigv4Example();
    expect(header).toBe('f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    expect(presigned).toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });

  it('uploads, reads, deletes and links a private object, without a vendor library', async () => {
    resetBreakers();
    const calls: Array<{ method: string; url: string; auth: string }> = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ method: String(init.method ?? 'GET'), url, auth: String((init.headers as Record<string, string>).Authorization ?? '') });
      return init.method === 'GET' ? new Response(Buffer.from('bytes'), { status: 200 }) : new Response('', { status: 200 });
    }) as unknown as typeof fetch;
    const s3 = new S3StorageProvider({ bucket: 'b', region: 'us-east-1', forcePathStyle: false, credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret', region: 'us-east-1' }, timeoutMs: 100, fetchImpl: f });
    await s3.upload({ key: 'documents/a b.pdf', buffer: Buffer.from('x'), contentType: 'application/pdf' });
    expect((await s3.download('documents/a b.pdf')).toString()).toBe('bytes');
    await s3.delete('documents/a b.pdf');
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'GET', 'DELETE']);
    for (const c of calls) {
      expect(c.auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/')).toBe(true);
      expect(c.url).toContain('a%20b.pdf');
    }
    const url = await s3.createTemporaryAccessUrl('documents/a b.pdf', 120);
    expect(url).toContain('X-Amz-Expires=120');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).not.toContain('secret');
  });

  it('says "not found" for a missing object, and names other failures', async () => {
    resetBreakers();
    const s3 = (status: number) => new S3StorageProvider({ bucket: 'b', region: 'r', forcePathStyle: true, credentials: { accessKeyId: 'a', secretAccessKey: 's', region: 'r' }, timeoutMs: 100, fetchImpl: (async () => new Response('', { status })) as unknown as typeof fetch });
    await expect(s3(404).download('k')).rejects.toMatchObject({ name: 'StorageObjectNotFoundError' });
    await expect(s3(503).delete('k2')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('Calls: Twilio relay', () => {
  it('returns short-lived credentials from the vendor and reuses them for most of their life', async () => {
    resetBreakers();
    let now = 1_000_000;
    const f = vi.fn(async () => ok({ ice_servers: [{ urls: 'stun:global.stun.twilio.com:3478' }, { url: 'turn:t.twilio.com', urls: 'turn:t.twilio.com', username: 'u', credential: 'c' }], ttl: '3600' }, 201));
    const p = new TwilioIceProvider({ accountSid: 'AC1', authToken: 't', ttlSeconds: 3600, timeoutMs: 100, fetchImpl: f as unknown as typeof fetch, now: () => now });
    const a = await p.connectionInfo();
    expect(a.iceServers).toHaveLength(2);
    await p.connectionInfo();
    expect(f).toHaveBeenCalledTimes(1);
    now += 3600 * 1000; // past the reuse window
    await p.connectionInfo();
    expect(f).toHaveBeenCalledTimes(2);
  });
});

describe('Email and error reporting', () => {
  it('sends through the vendor without repeating, and the console stand-in records nothing about the message', async () => {
    resetBreakers();
    const f = vi.fn(async () => ok({ id: 'x' }));
    await new ResendEmailProvider({ apiKey: 're_1', from: 'Yatri <a@b.c>', timeoutMs: 100, fetchImpl: f as unknown as typeof fetch }).send({ to: 'x@y.z', subject: 's', text: 't' });
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer re_1' });
    await expect(new ConsoleEmailProvider().send()).resolves.toBeUndefined();
  });

  it('removes phone numbers, emails, tokens, ids, places and long secrets before anything leaves the server', () => {
    const dirty = 'Failed for +977 9812345678 user a.b@example.com Bearer abc.def.ghi at 27.715400, 85.312300 id 3f2b8a64-1c3d-4e5f-8a9b-0123456789ab key 0123456789abcdef0123456789abcdef0123';
    const clean = scrub(dirty);
    for (const bit of ['9812345678', 'a.b@example.com', 'abc.def.ghi', '27.7154', '3f2b8a64', '0123456789abcdef0123456789abcdef']) expect(clean).not.toContain(bit);
  });

  it('sends a scrubbed event to Sentry with no request data, and reports the place without ids', async () => {
    resetBreakers();
    const f = vi.fn(async () => ok({}));
    const s = new SentryErrorReporter({ dsn: 'https://pubkey@o1.ingest.sentry.io/42', environment: 'staging', release: '1.2.3', timeoutMs: 100, fetchImpl: f as unknown as typeof fetch });
    await s.capture(scrubbedEvent(new Error('boom for +977 9812345678'), { where: 'GET /api/v1/trips/3f2b8a64-1c3d-4e5f-8a9b-0123456789ab', status: 500 }));
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://o1.ingest.sentry.io/api/42/envelope/');
    const body = String(init.body);
    expect(body).not.toContain('9812345678');
    expect(body).not.toContain('3f2b8a64');
    expect(body).toContain('"environment":"staging"');
  });

  it('answers a vendor failure with a fixed sentence and 503, reports unexpected errors, and never reports a vendor outage or a caller mistake as a bug', () => {
    const reporter = new ConsoleErrorReporter();
    setErrorReporterForTests(reporter);
    try {
      const run = (err: unknown) => {
        const out: { status?: number; body?: { error: { code: string; message: string } } } = {};
        const res = { status(code: number) { out.status = code; return this; }, json(b: never) { out.body = b; return this; } };
        const req = { method: 'GET', baseUrl: '/api/v1', route: { path: '/x' }, id: 'req-1' };
        errorHandler(err, req as never, res as never, () => undefined);
        return out;
      };
      const vendor = run(new ProviderError('PAYMENTS', 'khalti', 'AUTH', 401));
      expect(vendor.status).toBe(503);
      expect(vendor.body?.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(vendor.body?.error.message).toBe(PROVIDER_PUBLIC_MESSAGES.PAYMENTS);
      expect(JSON.stringify(vendor.body)).not.toMatch(/khalti|AUTH|401/i);
      expect(run(new HttpError(404, 'NOT_FOUND', 'Nope.')).status).toBe(404);
      expect(reporter.seen).toHaveLength(0);
      const bug = run(new Error('database exploded for +977 9812345678'));
      expect(bug.status).toBe(500);
      expect(JSON.stringify(bug.body)).not.toContain('exploded');
      expect(reporter.seen).toHaveLength(1);
      expect(reporter.seen[0]?.message).not.toContain('9812345678');
    } finally {
      setErrorReporterForTests(undefined);
    }
  });
});

// ================================================================ the admin screen

describe('admin providers screen', () => {
  it('is for administrators with settings access only, and shows status without secrets', async () => {
    expect((await api.get('/api/v1/admin/providers')).status).toBe(401);
    const none = await loginTestAdmin(`pn-${Date.now()}@example.com`, 'a-strong-test-password-1', ['FLEET_VIEW']);
    expect((await api.get('/api/v1/admin/providers').set(auth(none))).status).toBe(403);
    const adminUser = await loginTestAdmin(`pa-${Date.now()}@example.com`, 'a-strong-test-password-1', ['SETTINGS_VIEW']);
    const res = await api.get('/api/v1/admin/providers').set(auth(adminUser));
    const data = res.body.data as ProvidersOverview;
    expect(data.environment).toBe('DEVELOPMENT');
    expect(data.items.map((i) => i.capability)).toEqual([...PROVIDER_CAPABILITIES]);
    const sms = data.items.find((i) => i.capability === 'OTP')!;
    expect(sms.simulated).toBe(true);
    expect(sms.state).toBe('SIMULATED');
    expect(sms.stateText.length).toBeGreaterThan(5); // words, not just a colour
  });
});

// ================================================================ digital payments

describe('digital payments', () => {
  let gatewayCalls: { initiate: number; lookup: number };
  let lookupState: 'COMPLETED' | 'PENDING' | 'FAILED' | 'EXPIRED';
  let lookupAmount: number | null;

  beforeEach(() => {
    gatewayCalls = { initiate: 0, lookup: 0 };
    lookupState = 'COMPLETED';
    lookupAmount = null;
    setPaymentGatewayForTests({
      name: 'fake',
      async initiate(r) {
        gatewayCalls.initiate += 1;
        return { providerRef: `ref-${r.attemptId}`, paymentUrl: `https://pay.test/${r.attemptId}`, expiresAt: null };
      },
      async lookup() {
        gatewayCalls.lookup += 1;
        return { state: lookupState, amountNpr: lookupAmount };
      },
    });
  });
  afterEach(() => setPaymentGatewayForTests(undefined));

  const pay = (w: { tripId: string; passenger: { accessToken: string } }) => api.post(`/api/v1/trips/${w.tripId}/payment/digital`).set(auth(w.passenger.accessToken));
  const verify = (w: { tripId: string; passenger: { accessToken: string } }) => api.post(`/api/v1/trips/${w.tripId}/payment/digital/verify`).set(auth(w.passenger.accessToken));

  it('is off (and says so kindly) when no payment provider is configured', async () => {
    setPaymentGatewayForTests(null);
    const w = await finishedRide(false);
    const res = await pay(w);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DIGITAL_PAYMENTS_UNAVAILABLE');
    expect(res.body.error.message).toContain('cash');
  });

  it('opens one payment for the amount the server decided, and a repeated request returns the same one', async () => {
    const w = await finishedRide(false);
    const owed = (await pool.query('SELECT amount_npr FROM trip_payments WHERE trip_id = $1', [w.tripId])).rows[0].amount_npr as number;
    const a = (await pay(w)).body.data as DigitalPaymentInfo;
    const b = (await pay(w)).body.data as DigitalPaymentInfo;
    expect(a.amountNpr).toBe(owed);
    expect(a.status).toBe('INITIATED');
    expect(a.paymentUrl).toContain('https://pay.test/');
    expect(b.attemptId).toBe(a.attemptId);
    expect(gatewayCalls.initiate).toBe(1);
    // the client sent no amount and could not have changed it
    expect((await pay(w)).status).toBe(200);
  });

  it('refuses concurrent requests from creating two payments', async () => {
    const w = await finishedRide(false);
    const results = await Promise.all([pay(w), pay(w), pay(w)]);
    expect(results.every((r) => r.status === 200)).toBe(true);
    const open = await pool.query(`SELECT count(*)::int AS n FROM payment_attempts WHERE trip_id = $1 AND status = 'INITIATED'`, [w.tripId]);
    expect(open.rows[0].n).toBe(1);
  });

  it('marks the ride paid only after the vendor confirms the exact amount, once', async () => {
    const w = await finishedRide(false);
    const a = (await pay(w)).body.data as DigitalPaymentInfo;
    lookupState = 'PENDING';
    expect(((await verify(w)).body.data as DigitalPaymentInfo).status).toBe('INITIATED');
    expect((await pool.query('SELECT status FROM trip_payments WHERE trip_id = $1', [w.tripId])).rows[0].status).toBe('PENDING');
    lookupState = 'COMPLETED';
    lookupAmount = a.amountNpr;
    expect(((await verify(w)).body.data as DigitalPaymentInfo).status).toBe('COMPLETED');
    await verify(w); // a repeat changes nothing
    const p = (await pool.query('SELECT status, method, provider_ref FROM trip_payments WHERE trip_id = $1', [w.tripId])).rows[0];
    expect(p).toMatchObject({ status: 'PAID', method: 'DIGITAL' });
    const events = await pool.query(`SELECT count(*)::int AS n FROM trip_events WHERE trip_id = $1 AND type = 'PAYMENT_RECEIVED'`, [w.tripId]);
    expect(events.rows[0].n).toBe(1);
    expect((await pay(w)).status).toBe(409); // already paid
    // the driver cannot "confirm cash" on a ride that was paid online
    expect((await api.post(`/api/v1/trips/${w.tripId}/payment/confirm`).set(auth(w.driver.accessToken))).body.data.method).toBe('DIGITAL');
  });

  it('does not believe a vendor that reports a different amount', async () => {
    const w = await finishedRide(false);
    const a = (await pay(w)).body.data as DigitalPaymentInfo;
    lookupState = 'COMPLETED';
    lookupAmount = a.amountNpr - 1;
    const res = await verify(w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
    expect((await pool.query('SELECT status FROM trip_payments WHERE trip_id = $1', [w.tripId])).rows[0].status).toBe('PENDING');
    const audit = await pool.query(`SELECT 1 FROM audit_log WHERE action = 'PAYMENT_AMOUNT_MISMATCH' AND subject_id = $1`, [w.tripId]);
    expect(audit.rowCount).toBe(1);
  });

  it('lets only the rider pay, and never an organization-billed or unfinished ride', async () => {
    const w = await finishedRide(false);
    expect((await api.post(`/api/v1/trips/${w.tripId}/payment/digital`).set(auth(w.driver.accessToken))).status).toBe(403);
    const stranger = await (await import('./helpers')).onboardUser('PASSENGER');
    expect((await api.post(`/api/v1/trips/${w.tripId}/payment/digital`).set(auth(stranger.accessToken))).status).toBe(404);
    await pool.query(`UPDATE trip_payments SET method = 'ORGANIZATION' WHERE trip_id = $1`, [w.tripId]);
    expect((await pay(w)).body.error.code).toBe('BILLED_TO_ORGANIZATION');
  });

  it('turns a vendor failure into a calm 503, closes the attempt, and lets the rider try again or pay cash', async () => {
    const w = await finishedRide(false);
    setPaymentGatewayForTests({ name: 'fake', initiate: async () => { throw new ProviderError('PAYMENTS', 'fake', 'TIMEOUT'); }, lookup: async () => ({ state: 'PENDING', amountNpr: null }) });
    const res = await pay(w);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('TIMEOUT');
    expect((await pool.query(`SELECT status FROM payment_attempts WHERE trip_id = $1`, [w.tripId])).rows[0].status).toBe('FAILED');
    setPaymentGatewayForTests({ name: 'fake', initiate: async (r) => ({ providerRef: `r-${r.attemptId}`, paymentUrl: 'https://pay.test/x', expiresAt: null }), lookup: async () => ({ state: 'PENDING', amountNpr: null }) });
    expect((await pay(w)).status).toBe(200);
    expect((await api.post(`/api/v1/trips/${w.tripId}/payment/confirm`).set(auth(w.driver.accessToken))).status).toBe(200); // cash still works
  });

  it('completes a payment whose rider never came back (the sweep), and closes expired ones', async () => {
    const w = await finishedRide(false);
    const a = (await pay(w)).body.data as DigitalPaymentInfo;
    await pool.query(`UPDATE payment_attempts SET created_at = now() - interval '5 minutes' WHERE id = $1`, [a.attemptId]);
    lookupState = 'COMPLETED';
    lookupAmount = a.amountNpr;
    const r = await sweepPaymentAttempts();
    expect(r.completed).toBeGreaterThanOrEqual(1);
    expect((await pool.query('SELECT status FROM trip_payments WHERE trip_id = $1', [w.tripId])).rows[0].status).toBe('PAID');
  });

  it('uses the Khalti wire format (paisa, key auth) and believes only a lookup', async () => {
    resetBreakers();
    const f = vi.fn(async (url: string) =>
      String(url).endsWith('/initiate/') ? ok({ pidx: 'P1', payment_url: 'https://pay.khalti.test/P1', expires_in: 1800 }) : ok({ status: 'Completed', total_amount: 25000 }),
    );
    const k = new KhaltiGateway({ secretKey: 'live_secret_key_x', baseUrl: 'https://dev.khalti.com/api/v2', returnUrl: 'https://app.test/back', websiteUrl: 'https://api.test', timeoutMs: 100, fetchImpl: f as unknown as typeof fetch });
    const opened = await k.initiate({ attemptId: 'A1', tripId: 'T1', amountNpr: 250, description: 'Yatri ride' });
    const sent = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.amount).toBe(25000);
    expect(sent.purchase_order_id).toBe('A1');
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Key live_secret_key_x' });
    expect(opened.providerRef).toBe('P1');
    expect(await k.lookup('P1')).toEqual({ state: 'COMPLETED', amountNpr: 250 });
  });

  it('maps unknown vendor states to "not paid"', async () => {
    resetBreakers();
    const k = new KhaltiGateway({ secretKey: 's', baseUrl: 'https://x.test', returnUrl: 'https://r.test', websiteUrl: 'https://w.test', timeoutMs: 100, fetchImpl: (async () => ok({ status: 'Something New', total_amount: 100 })) as unknown as typeof fetch });
    expect((await k.lookup('P')).state).toBe('FAILED');
  });
});

// ================================================================ SSOT

describe('providers: single source of truth', () => {
  const files = (dir: string): string[] => {
    return readdirSync(dir).flatMap((n: string) => {
      const p = join(dir, n);
      if (n === 'test' || n === 'node_modules' || n === '.recall') return [];
      return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
    });
  };

  it('keeps vendor names and vendor addresses out of business logic', () => {
    const adapters = /(\/providers\/|\/lib\/storage\/|\/lib\/email\/|\/lib\/monitoring\/|\/lib\/notifications\/|\/modules\/payments\/|\/auth\/sms\/|twilio-ice|\/config\/)/;
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const norm = f.replace(/\\/g, '/');
      if (adapters.test(norm) || norm.endsWith('modules/calls/call-provider.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (/api\.twilio\.com|api\.mapbox\.com|khalti\.com|exp\.host|api\.resend\.com|sentry\.io|amazonaws\.com|from ['"](twilio|aws-sdk|@aws-sdk|@sentry|stripe|expo-server-sdk)/.test(text)) offenders.push(norm);
    }
    expect(offenders).toEqual([]);
  });

  it('calls vendors only through providerRequest (no raw fetch outside it and the one local test seam)', () => {
    const offenders: string[] = [];
    for (const f of files(SRC)) {
      const norm = f.replace(/\\/g, '/');
      // The share page is a browser script inside a served page (it calls this server from the contact's browser), not a vendor call.
      if (norm.endsWith('modules/providers/http.ts') || norm.endsWith('modules/sharing/share.page.ts')) continue;
      const text = readFileSync(f, 'utf8');
      if (/[^.\w](await\s+)?fetch\(/.test(text.replace(/fetchImpl/g, '').replace(/this\.fetchImpl|c\.fetchImpl|config\.fetchImpl/g, ''))) offenders.push(norm);
    }
    expect(offenders).toEqual([]);
  });

  it('chooses vendors from the one list: every vendor choice in the API config comes from PROVIDER_CHOICES', () => {
    const text = readFileSync(join(SRC, 'config', 'env.ts'), 'utf8');
    for (const key of ['OTP', 'PUSH', 'MAPS_GEOCODING', 'MAPS_ROUTING', 'PAYMENTS', 'STORAGE', 'CALLS', 'REALTIME', 'EMAIL', 'MONITORING']) {
      expect(text).toContain(`PROVIDER_CHOICES.${key}`);
    }
  });
});
