import { describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { api, onboardUser } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const URL = '/api/v1/drivers/me/location';

describe('driver location (explicit, last-known only)', () => {
  it('requires a driver session', async () => {
    expect((await api.put(URL).send({ latitude: 27.7, longitude: 85.3 })).status).toBe(401);
    const passenger = await onboardUser('PASSENGER');
    expect(
      (
        await api
          .put(URL)
          .set(auth(passenger.accessToken))
          .send({ latitude: 27.7, longitude: 85.3 })
      ).status,
    ).toBe(403);
    expect((await api.get(URL).set(auth(passenger.accessToken))).status).toBe(403);
  });

  it('404s before any location has been shared', async () => {
    const d = await onboardUser('DRIVER');
    expect((await api.get(URL).set(auth(d.accessToken))).status).toBe(404);
  });

  it('stores a single overwritten row, not a history, with a server-side timestamp', async () => {
    const d = await onboardUser('DRIVER');
    const first = await api.put(URL).set(auth(d.accessToken)).send({
      latitude: 27.7172,
      longitude: 85.324,
      accuracyMeters: 12.5,
      recordedAt: '1999-01-01',
    });
    // recordedAt is not part of the schema -> strict rejection
    expect(first.status).toBe(400);

    const ok = await api
      .put(URL)
      .set(auth(d.accessToken))
      .send({ latitude: 27.7172, longitude: 85.324, accuracyMeters: 12.5 });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({
      latitude: 27.7172,
      longitude: 85.324,
      accuracyMeters: 12.5,
    });
    expect(new Date(ok.body.data.recordedAt).getFullYear()).toBeGreaterThanOrEqual(2026);

    await api.put(URL).set(auth(d.accessToken)).send({ latitude: 28.2096, longitude: 83.9856 });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM driver_last_locations');
    expect(rows[0].n).toBe(1);
    const got = await api.get(URL).set(auth(d.accessToken));
    expect(got.body.data).toMatchObject({
      latitude: 28.2096,
      longitude: 83.9856,
      accuracyMeters: null,
    });
  });

  it('rejects invalid coordinates and accuracy', async () => {
    const d = await onboardUser('DRIVER');
    for (const b of [
      {},
      { latitude: 91, longitude: 85 },
      { latitude: 27, longitude: 181 },
      { latitude: 'x', longitude: 85 },
      { latitude: 27 },
      { latitude: 0, longitude: 0 },
      { latitude: 27.7, longitude: 85.3, accuracyMeters: -1 },
      { latitude: 27.7, longitude: 85.3, accuracyMeters: 'good' },
    ]) {
      expect((await api.put(URL).set(auth(d.accessToken)).send(b)).status, JSON.stringify(b)).toBe(
        400,
      );
    }
  });

  it('never exposes one driver’s location to another', async () => {
    const a = await onboardUser('DRIVER');
    const b = await onboardUser('DRIVER');
    await api.put(URL).set(auth(a.accessToken)).send({ latitude: 27.7, longitude: 85.3 });
    expect((await api.get(URL).set(auth(b.accessToken))).status).toBe(404);
  });

  it('lets the driver clear their stored location', async () => {
    const d = await onboardUser('DRIVER');
    await api.put(URL).set(auth(d.accessToken)).send({ latitude: 27.7, longitude: 85.3 });
    expect((await api.delete(URL).set(auth(d.accessToken))).status).toBe(200);
    expect((await api.get(URL).set(auth(d.accessToken))).status).toBe(404);
  });
});
