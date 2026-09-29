import { beforeEach, describe, expect, it } from 'vitest';

import { pool } from '../config/database';
import { setLocationProviderForTests } from '../modules/location/providers';
import { api, onboardUser } from './helpers';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const BASE = '/api/v1/users/me/saved-places';

const home = {
  kind: 'HOME',
  name: 'Home',
  address: 'Baneshwor, Kathmandu, Bagmati Province, Nepal',
  latitude: 27.6915,
  longitude: 85.342,
};

beforeEach(() => setLocationProviderForTests(null));

async function create(token: string, body: Record<string, unknown> = home) {
  return api.post(BASE).set(auth(token)).send(body);
}

describe('saved places — CRUD', () => {
  it('creates, reads, lists, updates and deletes a saved place', async () => {
    const { accessToken } = await onboardUser('PASSENGER');

    const created = await create(accessToken, { ...home, label: 'Mum’s house' });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({
      kind: 'HOME',
      name: 'Home',
      label: 'Mum’s house',
      latitude: 27.6915,
      longitude: 85.342,
      address: home.address,
    });
    const id = created.body.data.id as string;

    const got = await api.get(`${BASE}/${id}`).set(auth(accessToken));
    expect(got.status).toBe(200);
    expect(got.body.data.id).toBe(id);

    const list = await api.get(BASE).set(auth(accessToken));
    expect(list.body.data).toHaveLength(1);

    const patched = await api.patch(`${BASE}/${id}`).set(auth(accessToken)).send({
      name: 'Home sweet home',
      label: null,
      latitude: 27.7,
      longitude: 85.35,
      address: 'New spot',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data).toMatchObject({
      name: 'Home sweet home',
      label: null,
      latitude: 27.7,
      longitude: 85.35,
      address: 'New spot',
    });

    const del = await api.delete(`${BASE}/${id}`).set(auth(accessToken));
    expect(del.status).toBe(200);
    expect((await api.get(`${BASE}/${id}`).set(auth(accessToken))).status).toBe(404);
    // The location row is removed with it — no orphaned coordinates.
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM locations');
    expect(rows[0].n).toBe(0);
  });

  it('keeps unrelated fields when only the name changes', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const id = (await create(accessToken)).body.data.id;
    const res = await api.patch(`${BASE}/${id}`).set(auth(accessToken)).send({ name: 'Flat' });
    expect(res.body.data).toMatchObject({ name: 'Flat', latitude: 27.6915, address: home.address });
  });

  it('falls back to a coordinate label when no address is supplied and geocoding is unavailable', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const res = await create(accessToken, {
      kind: 'FAVOURITE',
      name: 'Cafe',
      latitude: 27.7,
      longitude: 85.3,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.address).toContain('27.70000');
  });

  it('stores coordinates as numeric, not strings', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    await create(accessToken);
    const { rows } = await pool.query(
      'SELECT pg_typeof(latitude)::text AS t FROM locations LIMIT 1',
    );
    expect(rows[0].t).toBe('numeric');
  });
});

describe('saved places — validation & duplicates', () => {
  it('rejects invalid coordinates and bad fields', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    const bad = [
      { ...home, latitude: 91 },
      { ...home, longitude: -181 },
      { ...home, latitude: 'abc' },
      { ...home, latitude: undefined },
      { ...home, longitude: null },
      { ...home, latitude: 0, longitude: 0 },
      { ...home, kind: 'OFFICE' },
      { ...home, name: '' },
      { ...home, name: 'x'.repeat(81) },
      { ...home, userId: 'someone-else' }, // strict: unknown keys rejected
    ];
    for (const b of bad) {
      const res = await create(accessToken, b);
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
    const patchBad = [{}, { latitude: 27.7 }, { latitude: 200, longitude: 85 }, { kind: 'X' }];
    const id = (await create(accessToken)).body.data.id;
    for (const b of patchBad) {
      expect((await api.patch(`${BASE}/${id}`).set(auth(accessToken)).send(b)).status).toBe(400);
    }
  });

  it('rejects a second Home or Work and duplicate names', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    expect((await create(accessToken)).status).toBe(201);

    const second = await create(accessToken, { ...home, name: 'Home 2' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SAVED_PLACE_EXISTS');

    const dupName = await create(accessToken, { ...home, kind: 'FAVOURITE', name: 'HOME' });
    expect(dupName.status).toBe(409);
    expect(dupName.body.error.code).toBe('SAVED_PLACE_DUPLICATE_NAME');

    const work = await create(accessToken, { ...home, kind: 'WORK', name: 'Office' });
    expect(work.status).toBe(201);
    // Multiple favourites are fine.
    expect((await create(accessToken, { ...home, kind: 'FAVOURITE', name: 'A' })).status).toBe(201);
    expect((await create(accessToken, { ...home, kind: 'FAVOURITE', name: 'B' })).status).toBe(201);

    // Renaming into an existing name and re-typing into an existing Home are also 409s.
    const list = (await api.get(BASE).set(auth(accessToken))).body.data as Array<{
      id: string;
      name: string;
    }>;
    const b = list.find((p) => p.name === 'B');
    expect(
      (await api.patch(`${BASE}/${b?.id}`).set(auth(accessToken)).send({ name: 'a' })).status,
    ).toBe(409);
    expect(
      (await api.patch(`${BASE}/${b?.id}`).set(auth(accessToken)).send({ kind: 'HOME' })).status,
    ).toBe(409);
  });

  it('lists Home first, then Work, then favourites', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    await create(accessToken, { ...home, kind: 'FAVOURITE', name: 'Fav' });
    await create(accessToken, { ...home, kind: 'WORK', name: 'Office' });
    await create(accessToken);
    const kinds = (await api.get(BASE).set(auth(accessToken))).body.data.map(
      (p: { kind: string }) => p.kind,
    );
    expect(kinds).toEqual(['HOME', 'WORK', 'FAVOURITE']);
  });

  it('caps the number of saved places per user', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    for (let i = 0; i < 50; i++) {
      await pool.query('SELECT 1'); // keep the pool warm; inserts go through the API
      const r = await create(accessToken, { ...home, kind: 'FAVOURITE', name: `Fav ${i}` });
      expect(r.status).toBe(201);
    }
    const over = await create(accessToken, { ...home, kind: 'FAVOURITE', name: 'One too many' });
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe('SAVED_PLACE_LIMIT');
  }, 60000);

  it('rejects malformed ids', async () => {
    const { accessToken } = await onboardUser('PASSENGER');
    expect((await api.get(`${BASE}/not-a-uuid`).set(auth(accessToken))).status).toBe(400);
    expect(
      (await api.get(`${BASE}/00000000-0000-0000-0000-000000000000`).set(auth(accessToken))).status,
    ).toBe(404);
  });
});

describe('saved places — authorization & privacy', () => {
  it('requires authentication', async () => {
    expect((await api.get(BASE)).status).toBe(401);
    expect((await api.post(BASE).send(home)).status).toBe(401);
  });

  it('is passenger-only', async () => {
    const driver = await onboardUser('DRIVER');
    expect((await api.get(BASE).set(auth(driver.accessToken))).status).toBe(403);
    expect((await create(driver.accessToken)).status).toBe(403);
  });

  it('User A cannot read, list, edit or delete User B’s saved places', async () => {
    const a = await onboardUser('PASSENGER');
    const b = await onboardUser('PASSENGER');
    const id = (await create(b.accessToken)).body.data.id as string;

    expect((await api.get(BASE).set(auth(a.accessToken))).body.data).toEqual([]);
    expect((await api.get(`${BASE}/${id}`).set(auth(a.accessToken))).status).toBe(404);
    expect(
      (await api.patch(`${BASE}/${id}`).set(auth(a.accessToken)).send({ name: 'Hijack' })).status,
    ).toBe(404);
    expect(
      (
        await api
          .patch(`${BASE}/${id}`)
          .set(auth(a.accessToken))
          .send({ latitude: 1.5, longitude: 2.5, address: 'Hijacked' })
      ).status,
    ).toBe(404);
    expect((await api.delete(`${BASE}/${id}`).set(auth(a.accessToken))).status).toBe(404);

    // B's data is untouched.
    const still = await api.get(`${BASE}/${id}`).set(auth(b.accessToken));
    expect(still.body.data).toMatchObject({ name: 'Home', latitude: 27.6915 });

    // Both users can each have their own Home.
    expect((await create(a.accessToken)).status).toBe(201);
  });

  it('deleting the user removes their saved places', async () => {
    const a = await onboardUser('PASSENGER');
    await create(a.accessToken);
    await pool.query('DELETE FROM saved_places WHERE user_id = $1', [a.user.id]);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM saved_places');
    expect(rows[0].n).toBe(0);
  });
});
