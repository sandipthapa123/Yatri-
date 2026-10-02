import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ACCESS_TOKEN_ISSUER } from '@yatri/types';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ENV_KEYS, envIssues } from '../config/env';
import { pool } from '../config/database';
import { getRedisClient } from '../config/redis';
import { checkWindowLimit } from '../lib/rate-limit';
import { maskText, redact, serializeError } from '../lib/logger';
import { errorHandler } from '../middleware/errorHandler';
import { ipRateLimit, userMutationRateLimit } from '../middleware/rateLimit';
import { api, onboardUser } from './helpers';
import { auth } from './rides';

const SECRET = process.env.JWT_ACCESS_SECRET as string;
const SRC = join(__dirname, '..');
const REPO = join(SRC, '..', '..', '..');

afterEach(() => vi.restoreAllMocks());

// ============================================================ session and token security

describe('access tokens', () => {
  const claims = (over: Record<string, unknown> = {}) => ({
    sub: '00000000-0000-4000-8000-000000000001',
    sid: '00000000-0000-4000-8000-000000000002',
    role: 'ADMIN',
    ...over,
  });
  const me = (token: string) => api.get('/api/v1/users/me').set(auth(token));
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

  it('refuses a token with no signature at all (alg "none")', async () => {
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...claims(), iss: ACCESS_TOKEN_ISSUER })}.`;
    expect((await me(forged)).status).toBe(401);
  });

  it('refuses a token signed with a different algorithm, even with the right secret', async () => {
    for (const algorithm of ['HS384', 'HS512'] as const) {
      const t = jwt.sign(claims(), SECRET, {
        algorithm,
        issuer: ACCESS_TOKEN_ISSUER,
        expiresIn: '5m',
      });
      expect((await me(t)).status, algorithm).toBe(401);
    }
  });

  it('refuses a token from another issuer, or with none', async () => {
    for (const opts of [{ issuer: 'someone-else' }, {}]) {
      const t = jwt.sign(claims(), SECRET, { algorithm: 'HS256', expiresIn: '5m', ...opts });
      expect((await me(t)).status).toBe(401);
    }
  });

  it('refuses an expired token, a token signed with another secret, and an edited payload', async () => {
    const good = { algorithm: 'HS256' as const, issuer: ACCESS_TOKEN_ISSUER };
    expect((await me(jwt.sign(claims(), SECRET, { ...good, expiresIn: -10 }))).status).toBe(401);
    expect(
      (await me(jwt.sign(claims(), 'x'.repeat(48), { ...good, expiresIn: '5m' }))).status,
    ).toBe(401);
    const p = await onboardUser('PASSENGER');
    const [h, , s] = p.accessToken.split('.');
    const promoted = `${h}.${b64({ ...(jwt.decode(p.accessToken) as object), role: 'ADMIN' })}.${s}`;
    expect((await me(promoted)).status).toBe(401); // a passenger cannot edit "role" into "ADMIN"
  });

  it('accepts a real token and gives an admin route to nobody but an admin', async () => {
    const p = await onboardUser('PASSENGER');
    expect((await me(p.accessToken)).status).toBe(200);
    expect((await api.get('/api/v1/admin/me').set(auth(p.accessToken))).status).toBe(403);
    expect((await api.get('/api/v1/admin/me')).status).toBe(401);
    expect((await me('not-a-token')).status).toBe(401);
    expect((await api.get('/api/v1/users/me').set('Authorization', 'Basic abc')).status).toBe(401);
  });
});

// ============================================================ rate limiting

describe('rate limiting', () => {
  const miniApp = (mw: express.RequestHandler, method: 'get' | 'post' = 'get') => {
    const app = express();
    app.set('trust proxy', 1);
    app[method]('/x', mw, (_req, res) => void res.json({ ok: true }));
    app.use(errorHandler);
    return app;
  };

  it('counts atomically: fifty simultaneous hits against a limit of ten let exactly ten through', async () => {
    const key = `test:atomic:${Date.now()}`;
    const results = await Promise.all(
      Array.from({ length: 50 }, () => checkWindowLimit(key, 10, 60)),
    );
    expect(results.filter((r) => !r.limited)).toHaveLength(10);
    expect(new Set(results.map((r) => r.count)).size).toBe(50); // no two callers saw the same count
  });

  it('gives every window an expiry, and repairs a counter that lost its expiry', async () => {
    const redis = getRedisClient();
    const fresh = `test:ttl:${Date.now()}`;
    await checkWindowLimit(fresh, 5, 30);
    expect(await redis.ttl(fresh)).toBeGreaterThan(0);
    const orphan = `test:orphan:${Date.now()}`;
    await redis.set(orphan, '999'); // what a crash between INCR and EXPIRE used to leave behind
    expect(await redis.ttl(orphan)).toBe(-1);
    const r = await checkWindowLimit(orphan, 5, 30);
    expect(r.limited).toBe(true);
    expect(await redis.ttl(orphan)).toBeGreaterThan(0); // it now expires, so the caller is not blocked forever
  });

  it('answers 429 with Retry-After and tells clients where they stand', async () => {
    const app = miniApp(ipRateLimit(`test:ip:${Date.now()}`, 3, 60));
    for (let i = 0; i < 3; i++) {
      const ok = await request(app).get('/x');
      expect(ok.status).toBe(200);
      expect(ok.headers['ratelimit-limit']).toBe('3');
      expect(ok.headers['ratelimit-remaining']).toBe(String(2 - i));
    }
    const blocked = await request(app).get('/x');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('counts only state-changing requests against the per-user mutation ceiling', async () => {
    const app = express();
    const userId = `u-${Date.now()}`; // one person across every request
    app.use((req, _res, next) => {
      req.auth = { userId, sessionId: 's', role: 'PASSENGER', status: 'ACTIVE' };
      next();
    });
    app.use(userMutationRateLimit(2));
    app.all('/x', (_req, res) => void res.json({ ok: true }));
    app.use(errorHandler);
    for (let i = 0; i < 6; i++) expect((await request(app).get('/x')).status).toBe(200); // reads are free
    expect((await request(app).post('/x')).status).toBe(200);
    expect((await request(app).post('/x')).status).toBe(200);
    expect((await request(app).post('/x')).status).toBe(429);
  });

  it('when the limiter store is down: sensitive routes refuse, the general ceiling lets requests pass', async () => {
    vi.spyOn(getRedisClient(), 'eval').mockRejectedValue(new Error('redis is down'));
    const closed = await request(miniApp(ipRateLimit('test:closed', 1, 60))).get('/x');
    expect(closed.status).toBe(500); // fail closed
    const open = await request(miniApp(ipRateLimit('test:open', 1, 60, { failOpen: true }))).get(
      '/x',
    );
    expect(open.status).toBe(200); // fail open
  });
});

// ============================================================ request handling

describe('request handling', () => {
  it("reports a malformed or oversized body as the caller's mistake, not a server error", async () => {
    const bad = await api
      .post('/api/v1/auth/request-otp')
      .set('Content-Type', 'application/json')
      .send('{"phoneNumber": ');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_JSON');
    const big = await api
      .post('/api/v1/auth/request-otp')
      .send({ phoneNumber: 'x'.repeat(40_000) });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it("gives every response a correlation id, and keeps a caller's only if it is a plain token", async () => {
    const generated = await api.get('/api/v1/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const kept = await api.get('/api/v1/health').set('X-Request-Id', 'client-req-12345');
    expect(kept.headers['x-request-id']).toBe('client-req-12345');
    const replaced = await api.get('/api/v1/health').set('X-Request-Id', 'bad id;drop table');
    expect(replaced.headers['x-request-id']).not.toContain('drop');
  });

  it('marks API answers no-store, hides the framework, and sets browser security headers', async () => {
    const r = await api.get('/api/v1/health');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBeDefined();
  });

  it('answers a server fault with a generic message and the id to quote, never the cause', async () => {
    vi.spyOn(getRedisClient(), 'eval').mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.5:6379'),
    );
    const r = await api
      .post('/api/v1/auth/request-otp')
      .send({ phoneNumber: '+9779800000000', role: 'PASSENGER' });
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(r.body)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|redis/i);
    expect(r.body.error.requestId).toBe(r.headers['x-request-id']);
  });

  it('allows only the configured browser origins', async () => {
    const allowed = await api.get('/api/v1/health').set('Origin', 'http://localhost:3000');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    const foreign = await api.get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await api
      .options('/api/v1/admin/me')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization');
    expect(preflight.headers['access-control-allow-methods']).toContain('POST');
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined(); // no cookies cross-origin
  });

  it('logs the route, never the address: a share token does not reach the log', async () => {
    const lines: string[] = [];
    const prior = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'info';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const token = 'A'.repeat(43);
    await api.get(`/share/${token}/data`);
    await api.get('/api/v1/health?token=secret-query-value');
    vi.restoreAllMocks();
    if (prior === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = prior;
    const text = lines.join('');
    expect(text).toContain('"route":"/share/:token/data"');
    expect(text).not.toContain(token);
    expect(text).not.toContain('secret-query-value');
  });
});

// ============================================================ health

describe('health checks', () => {
  it('answers liveness without touching a dependency', async () => {
    for (const path of ['/api/v1/health', '/api/v1/health/live']) {
      const r = await api.get(path);
      expect(r.status).toBe(200);
      expect(r.body.data.status).toBe('ok');
    }
  });

  it('answers readiness 200 when the database and Redis answer', async () => {
    const r = await api.get('/api/v1/health/ready');
    expect(r.status).toBe(200);
    expect(r.body.data.checks).toEqual({ database: 'ok', redis: 'ok' });
  });

  it('answers 503 naming only the failing dependency, with nothing about its address', async () => {
    // (the platform-settings refresh also reads the database, so the failure lasts the whole request)
    vi.spyOn(pool, 'query').mockRejectedValue(
      new Error('password authentication failed for user "yatri"') as never,
    );
    const db = await api.get('/api/v1/health/ready');
    expect(db.status).toBe(503);
    expect(db.body.error.details).toEqual({ database: 'failing', redis: 'ok' });
    expect(JSON.stringify(db.body)).not.toMatch(/password|yatri/i);
    vi.restoreAllMocks();
    vi.spyOn(getRedisClient(), 'ping').mockRejectedValueOnce(new Error('down'));
    const redis = await api.get('/api/v1/health/ready');
    expect(redis.status).toBe(503);
    expect(redis.body.error.details).toEqual({ database: 'ok', redis: 'failing' });
  });

  it('treats a dependency that never answers as failing, instead of hanging the probe', async () => {
    vi.spyOn(getRedisClient(), 'ping').mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const r = await api.get('/api/v1/health/ready');
    expect(r.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 20_000);
});

// ============================================================ logging never leaks

describe('logging redaction', () => {
  it('removes secrets from text', () => {
    const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
    expect(maskText(`Authorization: Bearer ${jwtLike}`)).toBe('Authorization: Bearer [redacted]');
    expect(maskText(`token ${jwtLike} end`)).toContain('[jwt]');
    expect(maskText('GET https://maps.example/search?q=a&key=SECRETKEY123&x=1')).toBe(
      'GET https://maps.example/search?q=a&key=[redacted]&x=1',
    );
    expect(maskText('connect postgres://yatri:hunter2@db:5432/yatri failed')).not.toContain(
      'hunter2',
    );
    expect(maskText('redis://:pw@cache:6379 refused')).not.toContain('pw@');
  });

  it('removes sensitive fields at any depth, and personal data by name', () => {
    const out = redact({
      userId: 'u1',
      password: 'hunter2',
      nested: {
        refreshToken: 'abc',
        phoneNumber: '+9779800000000',
        deeper: [{ email: 'a@b.c', ok: 1 }],
      },
      latitude: 27.7,
      note: 'plain text is kept',
    }) as {
      userId: string;
      password: string;
      latitude: string;
      note: string;
      nested: {
        refreshToken: string;
        phoneNumber: string;
        deeper: Array<{ email: string; ok: number }>;
      };
    };
    expect(out.userId).toBe('u1');
    expect(out.password).toBe('[redacted]');
    expect(out.nested.refreshToken).toBe('[redacted]');
    expect(out.nested.phoneNumber).toBe('[redacted]');
    expect(out.nested.deeper[0]?.email).toBe('[redacted]');
    expect(out.nested.deeper[0]?.ok).toBe(1);
    expect(out.latitude).toBe('[redacted]');
    expect(out.note).toBe('plain text is kept');
  });

  it("writes errors as name, message and code only: never the database's row values", () => {
    const e = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      detail: 'Key (phone_number)=(+9779800000000) already exists.',
    });
    const s = serializeError(e);
    expect(s.code).toBe('23505');
    expect(JSON.stringify(s)).not.toContain('9779800000000');
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    expect(serializeError(e).stack).toBeUndefined(); // no stack traces in production logs
    process.env.NODE_ENV = prior;
  });
});

// ============================================================ configuration is validated

describe('environment validation', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@db.internal:5432/yatri',
    JWT_ACCESS_SECRET: 'k'.repeat(24) + 'A1b2C3d4E5f6G7h8',
    STORAGE_SIGNING_SECRET: 'q'.repeat(24) + 'Z9y8X7w6V5u4T3s2',
  };
  const production = {
    ...base,
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://admin.example.org',
    PUBLIC_BASE_URL: 'https://api.example.org',
    // A real provider for every need (Phase 25: staging and production may not run on development stand-ins).
    SMS_PROVIDER: 'http',
    SMS_HTTP_ENDPOINT: 'https://sms.example.org/send',
    PUSH_PROVIDER: 'expo',
    LOCATION_PROVIDER: 'mapbox',
    MAPBOX_ACCESS_TOKEN: 'pk.example-token-value',
    STORAGE_PROVIDER: 's3',
    S3_BUCKET: 'yatri-documents',
    S3_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE',
    S3_SECRET_ACCESS_KEY: 'example-secret-access-key-value-0123456789',
    EMAIL_PROVIDER: 'resend',
    RESEND_API_KEY: 're_example_key',
    EMAIL_FROM: 'Yatri <no-reply@example.org>',
    MONITORING_PROVIDER: 'sentry',
    SENTRY_DSN: 'https://publickey@o1.ingest.sentry.io/1',
  };
  const problems = (env: Record<string, string>) => envIssues(env as NodeJS.ProcessEnv);

  it('accepts a complete production configuration', () => {
    expect(problems(production)).toEqual([]);
  });

  it('accepts local development with local addresses', () => {
    expect(problems({ ...base, NODE_ENV: 'development' })).toEqual([]);
  });

  it('refuses production and staging that still carry development settings', () => {
    for (const NODE_ENV of ['production', 'staging']) {
      const at = (over: Record<string, string>) =>
        problems({ ...production, NODE_ENV, ...over }).join(' | ');
      expect(at({ OTP_DEV_MODE: 'true' })).toContain('OTP_DEV_MODE');
      expect(at({ SMS_PROVIDER: 'console' })).toContain('SMS_PROVIDER');
      expect(at({ CORS_ORIGINS: 'http://localhost:3000' })).toContain('CORS_ORIGINS');
      expect(at({ CORS_ORIGINS: 'https://localhost' })).toContain('CORS_ORIGINS');
      expect(at({ CORS_ORIGINS: 'http://admin.example.org' })).toContain('CORS_ORIGINS');
      expect(at({ CORS_ORIGINS: '*' })).toContain('CORS_ORIGINS');
      expect(at({ PUBLIC_BASE_URL: 'http://api.example.org' })).toContain('PUBLIC_BASE_URL');
      expect(at({ PUBLIC_BASE_URL: 'https://127.0.0.1' })).toContain('PUBLIC_BASE_URL');
      expect(at({ STORAGE_SIGNING_SECRET: base.JWT_ACCESS_SECRET })).toContain(
        'STORAGE_SIGNING_SECRET',
      );
    }
  });

  it('refuses weak, placeholder or missing secrets', () => {
    expect(problems({ ...production, JWT_ACCESS_SECRET: 'short' }).join()).toContain(
      'JWT_ACCESS_SECRET',
    );
    expect(
      problems({ ...production, JWT_ACCESS_SECRET: 'change-me-' + 'x'.repeat(30) }).join(),
    ).toContain('JWT_ACCESS_SECRET');
    expect(problems({ ...production, STORAGE_SIGNING_SECRET: '' }).join()).toContain(
      'STORAGE_SIGNING_SECRET',
    );
    expect(problems({ ...production, DATABASE_URL: '' }).join()).toContain('DATABASE_URL');
  });

  it('refuses a seeded admin account and the public map server in production', () => {
    expect(problems({ ...production, ADMIN_SEED_EMAIL: 'admin@example.org' }).join()).toContain(
      'ADMIN_SEED',
    );
    expect(
      problems({
        ...production,
        LOCATION_PROVIDER: 'nominatim',
        LOCATION_PROVIDER_BASE_URL: 'https://nominatim.openstreetmap.org',
      }).join(),
    ).toContain('LOCATION_PROVIDER_BASE_URL');
  });

  it('documents every variable it reads in apps/api/.env.example (one place to look)', () => {
    const example = readFileSync(join(SRC, '..', '.env.example'), 'utf8');
    const missing = ENV_KEYS.filter((k) => !new RegExp(`^#?\\s*${k}=`, 'm').test(example));
    expect(missing).toEqual([]);
  });
});

// ============================================================ repository hygiene (SSOT and secrets)

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory())
      return n === 'test' || n === 'node_modules' || n === 'dist' ? [] : sources(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}
const rel = (p: string) => relative(SRC, p).split('\\').join('/');

describe('repository hygiene', () => {
  it('has one logger: no console output in the API (only the development SMS printer)', () => {
    const offenders = sources(SRC)
      .filter((f) => !f.endsWith('console-sms-provider.ts'))
      .filter((f) => /\bconsole\.(log|warn|error|info|debug)\(/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('reads configuration in one place: process.env appears only in config, the logger and scripts', () => {
    const allowed = ['config/env.ts', 'lib/logger.ts'];
    const offenders = sources(SRC)
      .filter((f) => !allowed.includes(rel(f)))
      .filter((f) => /process\.env\b/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('escapes search wildcards with one character everywhere', () => {
    const offenders = sources(SRC)
      .filter((f) => /ESCAPE '(?!!')/.test(readFileSync(f, 'utf8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('commits no secret: no keys, tokens or credentials in any tracked file', () => {
    const files = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .filter(
        (f) =>
          !/\.(png|jpg|jpeg|gif|ico|webp|ttf|otf|woff2?|lock)$/.test(f) &&
          !f.endsWith('pnpm-lock.yaml'),
      );
    const patterns: Array<[string, RegExp]> = [
      ['private key', /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
      ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
      ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}/],
      ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
      ['signed JWT', /\beyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/],
      [
        'credentials in a URL',
        /\b(postgres(?:ql)?|redis|mongodb):\/\/[^\s:@/]+:(?!yatri@|\$|\{|<|password|pw@)[^\s@/]{6,}@/,
      ],
    ];
    const found: string[] = [];
    for (const f of files) {
      let text = '';
      try {
        text = readFileSync(join(REPO, f), 'utf8');
      } catch {
        continue;
      }
      // this file lists the patterns it looks for
      if (f.endsWith('hardening.test.ts')) continue;
      for (const [name, re] of patterns) if (re.test(text)) found.push(`${f}: ${name}`);
    }
    expect(found).toEqual([]);
  });

  it('keeps real environment files out of git', () => {
    const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' }).split('\n');
    const envFiles = tracked.filter((f) => /(^|\/)\.env($|\.)/.test(f) && !/\.example$/.test(f));
    expect(envFiles).toEqual([]);
    expect(tracked.filter((f) => f.endsWith('compose.env'))).toEqual([]);
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8');
    for (const entry of ['.env', 'compose.env']) expect(ignore).toContain(entry);
  });
});
