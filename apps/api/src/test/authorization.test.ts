import { describe, expect, it } from 'vitest';

import { api, createTestAdmin, onboardUser } from './helpers';

async function loginAdmin(email: string, password: string) {
  await createTestAdmin(email, password);
  const res = await api.post('/api/v1/auth/admin/login').send({ email, password });
  return res.body.data.accessToken as string;
}

describe('Authorization (role isolation)', () => {
  it('a passenger cannot access driver-only endpoints', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api.get('/api/v1/drivers/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a passenger cannot access admin-only endpoints', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api.get('/api/v1/admin/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a driver cannot access admin-only endpoints', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await api.get('/api/v1/admin/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('a driver cannot access another role-restricted resource by sending a different role in the body', async () => {
    // A client-supplied role must never influence authorization — the
    // server only trusts the role attached to the authenticated session.
    const { accessToken } = await onboardUser('DRIVER');
    const res = await api
      .patch('/api/v1/drivers/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: 'Still A Driver', role: 'ADMIN' });
    // The request succeeds (role field is simply ignored/not a valid field on
    // this schema) but the caller remains a driver, never becomes an admin.
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('DRIVER');
  });

  it('an admin can access admin-only endpoints', async () => {
    const accessToken = await loginAdmin('authz-admin@yatri.local', 'a-strong-test-password-1');
    const res = await api.get('/api/v1/admin/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('ADMIN');
  });

  it('an admin cannot access driver-only endpoints', async () => {
    const accessToken = await loginAdmin('authz-admin-2@yatri.local', 'a-strong-test-password-1');
    const res = await api.get('/api/v1/drivers/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('unauthenticated requests cannot access any protected endpoint', async () => {
    const [usersRes, driversRes, adminRes] = await Promise.all([
      api.get('/api/v1/users/me'),
      api.get('/api/v1/drivers/me'),
      api.get('/api/v1/admin/me'),
    ]);
    expect(usersRes.status).toBe(401);
    expect(driversRes.status).toBe(401);
    expect(adminRes.status).toBe(401);
  });
});
