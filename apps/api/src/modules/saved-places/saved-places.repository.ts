import type { SavedPlace, SavedPlaceKind } from '@yatri/types';
import type { PoolClient } from 'pg';

import { pool } from '../../config/database';
import { query } from '../../lib/db';

interface Row {
  id: string;
  kind: SavedPlaceKind;
  name: string;
  label: string | null;
  address: string;
  latitude: string;
  longitude: string;
  city: string | null;
  province: string | null;
  country: string | null;
  created_at: Date;
  updated_at: Date;
}

// Every read is scoped by user_id in SQL: another user's row is
// indistinguishable from a missing one.
const SELECT = `
  SELECT sp.id, sp.kind, sp.name, sp.label, l.address, l.latitude, l.longitude,
         l.city, l.province, l.country, sp.created_at, sp.updated_at
  FROM saved_places sp
  JOIN locations l ON l.id = sp.location_id`;

function toSavedPlace(r: Row): SavedPlace {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    label: r.label,
    address: r.address,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    city: r.city,
    province: r.province,
    country: r.country,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface PlaceFields {
  address: string;
  latitude: number;
  longitude: number;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  postalCode?: string | null;
}

export async function listSavedPlaces(userId: string): Promise<SavedPlace[]> {
  const res = await query<Row>(
    `${SELECT} WHERE sp.user_id = $1
     ORDER BY CASE sp.kind WHEN 'HOME' THEN 0 WHEN 'WORK' THEN 1 ELSE 2 END, sp.created_at`,
    [userId],
  );
  return res.rows.map(toSavedPlace);
}

export async function getSavedPlace(userId: string, id: string): Promise<SavedPlace | null> {
  const res = await query<Row>(`${SELECT} WHERE sp.user_id = $1 AND sp.id = $2`, [userId, id]);
  return res.rows[0] ? toSavedPlace(res.rows[0]) : null;
}

export async function countSavedPlaces(userId: string): Promise<number> {
  const res = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM saved_places WHERE user_id = $1',
    [userId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function inTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function createSavedPlace(
  userId: string,
  input: {
    kind: SavedPlaceKind;
    name: string;
    label: string | null;
    provider: string;
  } & PlaceFields,
): Promise<SavedPlace> {
  return inTransaction(async (c) => {
    const loc = await c.query<{ id: string }>(
      `INSERT INTO locations
         (latitude, longitude, address, place_name, city, province, country, postal_code, provider_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
       RETURNING id`,
      [
        input.latitude,
        input.longitude,
        input.address,
        input.name,
        input.city ?? null,
        input.province ?? null,
        input.country ?? null,
        input.postalCode ?? null,
        JSON.stringify({ provider: input.provider }),
      ],
    );
    const sp = await c.query<{ id: string }>(
      `INSERT INTO saved_places (user_id, location_id, kind, name, label)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, loc.rows[0]?.id, input.kind, input.name, input.label],
    );
    const row = await c.query<Row>(`${SELECT} WHERE sp.id = $1`, [sp.rows[0]?.id]);
    return toSavedPlace(row.rows[0] as Row);
  });
}

export async function updateSavedPlace(
  userId: string,
  id: string,
  patch: {
    kind?: SavedPlaceKind;
    name?: string;
    label?: string | null;
    place?: PlaceFields;
  },
): Promise<SavedPlace | null> {
  return inTransaction(async (c) => {
    const existing = await c.query<{ location_id: string }>(
      'SELECT location_id FROM saved_places WHERE id = $1 AND user_id = $2 FOR UPDATE',
      [id, userId],
    );
    const locationId = existing.rows[0]?.location_id;
    if (!locationId) return null;

    if (patch.place) {
      const p = patch.place;
      await c.query(
        `UPDATE locations SET latitude = $2, longitude = $3, address = $4,
           city = $5, province = $6, country = $7, postal_code = $8, updated_at = now()
         WHERE id = $1`,
        [
          locationId,
          p.latitude,
          p.longitude,
          p.address,
          p.city ?? null,
          p.province ?? null,
          p.country ?? null,
          p.postalCode ?? null,
        ],
      );
    }
    await c.query(
      `UPDATE saved_places SET
         kind = COALESCE($3, kind),
         name = COALESCE($4, name),
         label = CASE WHEN $5::boolean THEN $6 ELSE label END,
         updated_at = now()
       WHERE id = $1 AND user_id = $2`,
      [
        id,
        userId,
        patch.kind ?? null,
        patch.name ?? null,
        patch.label !== undefined,
        patch.label ?? null,
      ],
    );
    const row = await c.query<Row>(`${SELECT} WHERE sp.id = $1 AND sp.user_id = $2`, [id, userId]);
    return row.rows[0] ? toSavedPlace(row.rows[0]) : null;
  });
}

export async function deleteSavedPlace(userId: string, id: string): Promise<boolean> {
  return inTransaction(async (c) => {
    const del = await c.query<{ location_id: string }>(
      'DELETE FROM saved_places WHERE id = $1 AND user_id = $2 RETURNING location_id',
      [id, userId],
    );
    const locationId = del.rows[0]?.location_id;
    if (!locationId) return false;
    // The location row was created for this saved place; remove it too (no orphaned coordinates).
    await c.query('DELETE FROM locations WHERE id = $1', [locationId]);
    return true;
  });
}
