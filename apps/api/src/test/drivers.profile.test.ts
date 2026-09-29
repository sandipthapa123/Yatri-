import { describe, expect, it } from 'vitest';

import { api, onboardUser } from './helpers';

describe('Driver profile — GET/PATCH /drivers/me', () => {
  it('retrieves the driver profile with NOT_STARTED status by default', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await api.get('/api/v1/drivers/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('DRIVER');
    expect(res.body.data.driverStatus).toBe('NOT_STARTED');
  });

  it('updates the driver profile', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await api
      .patch('/api/v1/drivers/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: 'Driver Person' });

    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Driver Person');
    expect(res.body.data.driverStatus).toBe('NOT_STARTED');
  });

  it('rejects an empty update body', async () => {
    const { accessToken } = await onboardUser('DRIVER');
    const res = await api
      .patch('/api/v1/drivers/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated access', async () => {
    const res = await api.get('/api/v1/drivers/me');
    expect(res.status).toBe(401);
  });
});
