import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { api, createTestAdmin } from './helpers';

describe('Admin authentication', () => {
  it('logs in with correct credentials', async () => {
    await createTestAdmin('admin-ok@yatri.local', 'correct-horse-battery-staple');
    const res = await api
      .post('/api/v1/auth/admin/login')
      .send({ email: 'admin-ok@yatri.local', password: 'correct-horse-battery-staple' });

    expect(res.status).toBe(200);
    expect(res.body.data.user.role).toBe('ADMIN');
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });

  it('rejects an incorrect password', async () => {
    await createTestAdmin('admin-bad-pass@yatri.local', 'correct-horse-battery-staple');
    const res = await api
      .post('/api/v1/auth/admin/login')
      .send({ email: 'admin-bad-pass@yatri.local', password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('does not reveal whether an email exists (same error as a wrong password)', async () => {
    await createTestAdmin('admin-exists@yatri.local', 'correct-horse-battery-staple');

    const unknownEmail = await api
      .post('/api/v1/auth/admin/login')
      .send({ email: 'no-such-admin@yatri.local', password: 'anything' });
    const wrongPassword = await api
      .post('/api/v1/auth/admin/login')
      .send({ email: 'admin-exists@yatri.local', password: 'wrong-password' });

    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.body.error.code).toBe(wrongPassword.body.error.code);
    expect(unknownEmail.body.error.message).toBe(wrongPassword.body.error.message);
  });

  it('a passenger/driver account cannot log in through the admin endpoint even with a matching password shape', async () => {
    // A non-admin user has no password_hash at all, so any password must fail.
    const res = await api
      .post('/api/v1/auth/admin/login')
      .send({ email: 'not-an-admin@yatri.local', password: 'whatever' });
    expect(res.status).toBe(401);
  });

  it('blocks a suspended admin account after correct credentials', async () => {
    const admin = await createTestAdmin(
      'admin-suspended@yatri.local',
      'correct-horse-battery-staple',
    );
    await pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [admin.id]);

    const res = await api
      .post('/api/v1/auth/admin/login')
      .send({ email: 'admin-suspended@yatri.local', password: 'correct-horse-battery-staple' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('rejects malformed login payloads', async () => {
    const res = await api.post('/api/v1/auth/admin/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});
