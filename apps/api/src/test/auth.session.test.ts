import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { getRedisClient } from '../config/redis';
import { api, onboardUser } from './helpers';

describe('Authentication sessions', () => {
  it('logs in successfully and can access a protected route', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
  });

  it('fails login for a suspended account', async () => {
    const { phoneNumber, user } = await onboardUser('PASSENGER');
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [user.id]);

    // onboardUser already requested one OTP for this phone; clear the
    // resend cooldown so this test's own request-otp call isn't blocked.
    await getRedisClient().del(`otp:cooldown:PASSENGER:${phoneNumber}`);
    const requestRes = await api
      .post('/api/v1/auth/request-otp')
      .send({ phoneNumber, role: 'PASSENGER' });
    const verifyRes = await api
      .post('/api/v1/auth/verify-otp')
      .send({ phoneNumber, role: 'PASSENGER', code: requestRes.body.data.devOtp });

    expect(verifyRes.status).toBe(403);
    expect(verifyRes.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('blocks a suspended account from protected routes even with a still-valid token', async () => {
    const { accessToken, user } = await onboardUser('PASSENGER');
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [user.id]);

    const res = await api.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('blocks a deactivated account from protected routes', async () => {
    const { accessToken, user } = await onboardUser('PASSENGER');
    await pool.query(`UPDATE users SET status = 'DEACTIVATED' WHERE id = $1`, [user.id]);

    const res = await api.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DEACTIVATED');
  });

  it('logs out and revokes the session', async () => {
    const { accessToken } = await onboardUser('PASSENGER');

    const logoutRes = await api
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(logoutRes.status).toBe(200);

    const afterLogout = await api
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(afterLogout.status).toBe(401);
  });

  it('rejects requests once the underlying session has expired', async () => {
    const { accessToken, user } = await onboardUser('PASSENGER');
    await pool.query(
      `UPDATE auth_sessions SET expires_at = now() - interval '1 day' WHERE user_id = $1`,
      [user.id],
    );

    const res = await api.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });

  it('refreshes to a new token pair and rotates the refresh token', async () => {
    const { refreshToken } = await onboardUser('PASSENGER');

    const res = await api.post('/api/v1/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).not.toBe(refreshToken);

    // The old refresh token was rotated away — reusing it must fail.
    const reuse = await api.post('/api/v1/auth/refresh').send({ refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('lets only one of several simultaneous refreshes with the same token win, and the winner keeps a working session', async () => {
    const { refreshToken } = await onboardUser('PASSENGER');
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => api.post('/api/v1/auth/refresh').send({ refreshToken })),
    );
    const won = results.filter((r) => r.status === 200);
    expect(won).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(3);
    // the winner's new refresh token was not overwritten by a loser: it still works, and rotates again
    const next = await api
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: won[0]?.body.data.refreshToken });
    expect(next.status).toBe(200);
    expect(next.body.data.refreshToken).not.toBe(won[0]?.body.data.refreshToken);
  });

  it('rejects an unknown or garbage refresh token', async () => {
    const res = await api.post('/api/v1/auth/refresh').send({ refreshToken: 'not-a-real-token' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rejects a revoked refresh token', async () => {
    const { accessToken, refreshToken } = await onboardUser('PASSENGER');
    await api.post('/api/v1/auth/logout').set('Authorization', `Bearer ${accessToken}`).send({});

    const res = await api.post('/api/v1/auth/refresh').send({ refreshToken });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('rejects requests with no Authorization header', async () => {
    const res = await api.get('/api/v1/users/me');
    expect(res.status).toBe(401);
  });

  it('rejects requests with a malformed token', async () => {
    const res = await api.get('/api/v1/users/me').set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
  });
});
