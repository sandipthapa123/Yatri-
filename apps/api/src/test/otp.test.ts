import { describe, expect, it } from 'vitest';

import { env } from '../config/env';
import { pool } from '../config/database';
import { getRedisClient } from '../config/redis';
import { api, uniquePhone } from './helpers';

describe('OTP', () => {
  it('accepts a valid OTP and creates an account', async () => {
    const phoneNumber = uniquePhone();

    const requestRes = await api
      .post('/api/v1/auth/request-otp')
      .send({ phoneNumber, role: 'PASSENGER' });
    expect(requestRes.status).toBe(200);
    expect(requestRes.body.data.devOtp).toMatch(/^\d{6}$/);

    const verifyRes = await api
      .post('/api/v1/auth/verify-otp')
      .send({ phoneNumber, role: 'PASSENGER', code: requestRes.body.data.devOtp });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.isNewUser).toBe(true);
    expect(verifyRes.body.data.user.phoneNumber).toBe(phoneNumber);
    expect(verifyRes.body.data.accessToken).toEqual(expect.any(String));
    expect(verifyRes.body.data.refreshToken).toEqual(expect.any(String));
  });

  it('rejects an invalid code', async () => {
    const phoneNumber = uniquePhone();
    await api.post('/api/v1/auth/request-otp').send({ phoneNumber, role: 'PASSENGER' });

    const res = await api
      .post('/api/v1/auth/verify-otp')
      .send({ phoneNumber, role: 'PASSENGER', code: '000000' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_OTP');
  });

  it('rejects an expired code', async () => {
    const phoneNumber = uniquePhone();
    const requestRes = await api
      .post('/api/v1/auth/request-otp')
      .send({ phoneNumber, role: 'PASSENGER' });
    const devOtp = requestRes.body.data.devOtp;

    // Backdate the OTP's expiry instead of waiting out OTP_TTL_MINUTES.
    await pool.query(
      `UPDATE otp_requests SET expires_at = now() - interval '1 minute' WHERE phone_number = $1`,
      [phoneNumber],
    );

    const res = await api
      .post('/api/v1/auth/verify-otp')
      .send({ phoneNumber, role: 'PASSENGER', code: devOtp });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_OTP');
  });

  it('rejects reusing an already-consumed code', async () => {
    const phoneNumber = uniquePhone();
    const requestRes = await api
      .post('/api/v1/auth/request-otp')
      .send({ phoneNumber, role: 'PASSENGER' });
    const devOtp = requestRes.body.data.devOtp;

    const first = await api
      .post('/api/v1/auth/verify-otp')
      .send({ phoneNumber, role: 'PASSENGER', code: devOtp });
    expect(first.status).toBe(200);

    const second = await api
      .post('/api/v1/auth/verify-otp')
      .send({ phoneNumber, role: 'PASSENGER', code: devOtp });
    expect(second.status).toBe(401);
    expect(second.body.error.code).toBe('INVALID_OTP');
  });

  it('locks the code after too many incorrect attempts', async () => {
    const phoneNumber = uniquePhone();
    await api.post('/api/v1/auth/request-otp').send({ phoneNumber, role: 'PASSENGER' });

    let lastStatus = 0;
    let lastCode = '';
    for (let i = 0; i < env.OTP_MAX_ATTEMPTS; i++) {
      const res = await api
        .post('/api/v1/auth/verify-otp')
        .send({ phoneNumber, role: 'PASSENGER', code: '111111' });
      lastStatus = res.status;
      lastCode = res.body.error.code;
    }
    expect(lastStatus).toBe(429);
    expect(lastCode).toBe('OTP_LOCKED');

    // Even the real code is now refused, because the OTP is locked, not just guessed wrong.
    const afterLock = await api
      .post('/api/v1/auth/verify-otp')
      .send({ phoneNumber, role: 'PASSENGER', code: '111111' });
    expect(afterLock.status).toBe(429);
    expect(afterLock.body.error.code).toBe('OTP_LOCKED');
  });

  it('counts a guess before comparing it, so parallel guesses cannot exceed the limit', async () => {
    const { reserveOtpAttempt } = await import('../modules/auth/otp.repository');
    const phoneNumber = uniquePhone();
    await api.post('/api/v1/auth/request-otp').send({ phoneNumber, role: 'PASSENGER' });
    const row = (await pool.query('SELECT id, max_attempts FROM otp_requests WHERE phone_number = $1', [phoneNumber])).rows[0];
    const results = await Promise.all(Array.from({ length: 25 }, () => reserveOtpAttempt(row.id)));
    expect(results.filter((r) => r !== null)).toHaveLength(row.max_attempts); // exactly the allowed number of guesses
    expect([...results.filter((r) => r !== null)].sort()).toEqual(Array.from({ length: row.max_attempts }, (_, i) => i + 1));
  });

  it('lets a correct code sign in once, even when it is sent twice at the same moment', async () => {
    const phoneNumber = uniquePhone();
    const requestRes = await api.post('/api/v1/auth/request-otp').send({ phoneNumber, role: 'PASSENGER' });
    const code = requestRes.body.data.devOtp;
    const answers = await Promise.all([1, 2, 3].map(() => api.post('/api/v1/auth/verify-otp').send({ phoneNumber, role: 'PASSENGER', code })));
    expect(answers.filter((r) => r.status === 200)).toHaveLength(1);
    const sessions = await pool.query('SELECT count(*)::int AS n FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE u.phone_number = $1', [phoneNumber]);
    expect(sessions.rows[0].n).toBe(1);
  });

  it('enforces a resend cooldown', async () => {
    const phoneNumber = uniquePhone();
    const first = await api
      .post('/api/v1/auth/request-otp')
      .send({ phoneNumber, role: 'PASSENGER' });
    expect(first.status).toBe(200);

    const second = await api
      .post('/api/v1/auth/request-otp')
      .send({ phoneNumber, role: 'PASSENGER' });
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('RATE_LIMITED');
    expect(second.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(
      env.OTP_RESEND_COOLDOWN_SECONDS,
    );
  });

  it('rate-limits repeated OTP requests beyond the per-phone window', async () => {
    const phoneNumber = uniquePhone();
    const cooldownKey = `otp:cooldown:PASSENGER:${phoneNumber}`;

    let lastRes;
    for (let i = 0; i < env.OTP_REQUEST_MAX_PER_WINDOW + 1; i++) {
      // Clear the short resend cooldown between iterations so we're testing
      // the *window* limit specifically, not just hitting the cooldown again.
      await getRedisClient().del(cooldownKey);
      lastRes = await api.post('/api/v1/auth/request-otp').send({ phoneNumber, role: 'PASSENGER' });
    }

    expect(lastRes!.status).toBe(429);
    expect(lastRes!.body.error.code).toBe('RATE_LIMITED');
    // A window-limit retry-after is measured in minutes, not the ~60s cooldown.
    expect(lastRes!.body.error.details.retryAfterSeconds).toBeGreaterThan(
      env.OTP_RESEND_COOLDOWN_SECONDS,
    );
  });

  it('invalidates a previous OTP when a new one is requested', async () => {
    const phoneNumber = uniquePhone();
    const cooldownKey = `otp:cooldown:PASSENGER:${phoneNumber}`;

    const first = await api
      .post('/api/v1/auth/request-otp')
      .send({ phoneNumber, role: 'PASSENGER' });
    const firstOtp = first.body.data.devOtp;

    await getRedisClient().del(cooldownKey);
    await api.post('/api/v1/auth/request-otp').send({ phoneNumber, role: 'PASSENGER' });

    const res = await api
      .post('/api/v1/auth/verify-otp')
      .send({ phoneNumber, role: 'PASSENGER', code: firstOtp });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_OTP');
  });
});
