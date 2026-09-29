import { describe, expect, it } from 'vitest';

import {
  api,
  bringDriverToSubmittable,
  createTestVehicle,
  loginTestAdmin,
  onboardUser,
  uploadDocument,
  FIXTURES,
} from './helpers';

describe('Phase 3 authorization', () => {
  it('driver A cannot access, update, or delete driver B’s vehicle', async () => {
    const driverA = await onboardUser('DRIVER');
    const driverB = await onboardUser('DRIVER');
    const vehicleA = await createTestVehicle(driverA.accessToken);

    const res = await api
      .patch(`/api/v1/vehicles/${vehicleA.id}`)
      .set('Authorization', `Bearer ${driverB.accessToken}`)
      .send({ color: 'Black' });
    expect(res.status).toBe(404);
  });

  it('driver A cannot access driver B’s documents by id', async () => {
    const driverA = await onboardUser('DRIVER');
    const driverB = await onboardUser('DRIVER');
    const doc = await uploadDocument(
      driverA.accessToken,
      'DRIVING_LICENSE',
      FIXTURES.jpeg,
      'a.jpg',
    );

    const res = await api
      .get(`/api/v1/documents/${doc.body.data.id}/download-url`)
      .set('Authorization', `Bearer ${driverB.accessToken}`);
    expect(res.status).toBe(404);
  });

  it('a passenger cannot access any driver-only onboarding/vehicle endpoint', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const auth = (req: import('supertest').Test) =>
      req.set('Authorization', `Bearer ${accessToken}`);

    const results = await Promise.all([
      auth(api.get('/api/v1/drivers/me/onboarding')),
      auth(api.patch('/api/v1/drivers/me/onboarding')),
      auth(api.get('/api/v1/drivers/me/verification-status')),
      auth(api.post('/api/v1/drivers/me/submit-verification')),
      auth(api.get('/api/v1/vehicles')),
      auth(api.post('/api/v1/vehicles')),
    ]);
    for (const res of results) {
      expect(res.status).toBe(403);
    }
  });

  it('a driver cannot access any admin verification endpoint', async () => {
    const driver = await bringDriverToSubmittable();

    const listRes = await api
      .get('/api/v1/admin/drivers')
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(listRes.status).toBe(403);

    const detailRes = await api
      .get(`/api/v1/admin/drivers/${driver.user.id}`)
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(detailRes.status).toBe(403);

    const verifyRes = await api
      .post(`/api/v1/admin/drivers/${driver.user.id}/verify`)
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(verifyRes.status).toBe(403);

    const approveDocRes = await api
      .post(`/api/v1/admin/documents/${driver.documentIds.DRIVING_LICENSE}/approve`)
      .set('Authorization', `Bearer ${driver.accessToken}`);
    expect(approveDocRes.status).toBe(403);
  });

  it('an admin can access admin verification endpoints', async () => {
    const admin = await loginTestAdmin(
      `authz3-admin-${Date.now()}@yatri.local`,
      'a-strong-test-password-1',
    );
    const res = await api.get('/api/v1/admin/drivers').set('Authorization', `Bearer ${admin}`);
    expect(res.status).toBe(200);
  });

  it('unauthenticated requests cannot reach any driver, vehicle, or document endpoint', async () => {
    const paths = [
      '/api/v1/drivers/me/onboarding',
      '/api/v1/vehicles',
      '/api/v1/documents',
      '/api/v1/admin/drivers',
    ];
    for (const path of paths) {
      const res = await api.get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('an unauthenticated request cannot fetch a document’s signed content without a valid signature', async () => {
    const res = await api.get(
      '/api/v1/storage/content?key=documents/does/not/exist.jpg&expires=9999999999&sig=x',
    );
    expect(res.status).toBe(403);
  });
});
