import { describe, expect, it } from 'vitest';

import { api, createTestVehicle, onboardUser } from './helpers';

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

describe('a registration number another vehicle already holds', () => {
  it('is answered in words when adding a vehicle, not as a server error', async () => {
    const a = await onboardUser('DRIVER');
    const b = await onboardUser('DRIVER');
    const first = await createTestVehicle(a.accessToken);
    const plate = (
      (await api.get('/api/v1/vehicles').set(auth(a.accessToken))).body.data as Array<{
        id: string;
        registrationNumber: string;
      }>
    ).find((v) => v.id === first.id)?.registrationNumber as string;
    const category = (
      (await api.get('/api/v1/vehicles/categories').set(auth(b.accessToken))).body.data as Array<{
        id: string;
        code: string;
      }>
    ).find((c) => c.code === 'CAR')!;
    const res = await api.post('/api/v1/vehicles').set(auth(b.accessToken)).send({
      categoryId: category.id,
      make: 'Toyota',
      model: 'Corolla',
      year: 2020,
      color: 'White',
      registrationNumber: plate,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('REGISTRATION_TAKEN');
  });

  it('is answered the same way when changing a vehicle to it', async () => {
    const a = await onboardUser('DRIVER');
    const b = await onboardUser('DRIVER');
    const va = await createTestVehicle(a.accessToken);
    const vb = await createTestVehicle(b.accessToken);
    const plate = (
      (await api.get('/api/v1/vehicles').set(auth(a.accessToken))).body.data as Array<{
        id: string;
        registrationNumber: string;
      }>
    ).find((v) => v.id === va.id)?.registrationNumber as string;
    const res = await api
      .patch(`/api/v1/vehicles/${vb.id}`)
      .set(auth(b.accessToken))
      .send({ registrationNumber: plate });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.error.code).toBe('REGISTRATION_TAKEN');
  });
});
