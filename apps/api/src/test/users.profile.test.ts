import { describe, expect, it } from 'vitest';

import { api, onboardUser } from './helpers';

describe('Passenger/driver profile — GET/PATCH /users/me', () => {
  it('retrieves the authenticated user’s own profile', async () => {
    const { accessToken, phoneNumber } = await onboardUser('PASSENGER');
    const res = await api.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.phoneNumber).toBe(phoneNumber);
    expect(res.body.data.role).toBe('PASSENGER');
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.createdAt).toEqual(expect.any(String));
    // Never expose internal-only fields.
    expect(res.body.data.passwordHash).toBeUndefined();
  });

  it('updates the authenticated user’s own profile', async () => {
    const { accessToken } = await onboardUser('PASSENGER');

    const patchRes = await api
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: 'Sandip Thapa', profilePictureUrl: 'https://example.com/me.jpg' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.fullName).toBe('Sandip Thapa');
    expect(patchRes.body.data.profilePictureUrl).toBe('https://example.com/me.jpg');

    const getRes = await api.get('/api/v1/users/me').set('Authorization', `Bearer ${accessToken}`);
    expect(getRes.body.data.fullName).toBe('Sandip Thapa');
  });

  it('can clear the profile picture by setting it to null', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    await api
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ profilePictureUrl: 'https://example.com/me.jpg' });

    const res = await api
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ profilePictureUrl: null });

    expect(res.status).toBe(200);
    expect(res.body.data.profilePictureUrl).toBeNull();
  });

  it('rejects an empty update body', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid field values', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await api
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ fullName: '', profilePictureUrl: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toBeDefined();
  });

  it('rejects unauthenticated access', async () => {
    const getRes = await api.get('/api/v1/users/me');
    const patchRes = await api.patch('/api/v1/users/me').send({ fullName: 'Nope' });
    expect(getRes.status).toBe(401);
    expect(patchRes.status).toBe(401);
  });
});
