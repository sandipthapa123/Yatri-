import type { PoolClient } from 'pg';

export interface LocationFields {
  latitude: number;
  longitude: number;
  address: string;
  placeName?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  postalCode?: string | null;
  provider?: string;
}

/**
 * The single insert path for the `locations` table (saved places and trips
 * both use it). Runs on the caller's client so it joins their transaction.
 */
export async function insertLocation(client: PoolClient, f: LocationFields): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO locations
       (latitude, longitude, address, place_name, city, province, country, postal_code, provider_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      f.latitude,
      f.longitude,
      f.address,
      f.placeName ?? null,
      f.city ?? null,
      f.province ?? null,
      f.country ?? null,
      f.postalCode ?? null,
      JSON.stringify({ provider: f.provider ?? 'none' }),
    ],
  );
  const id = res.rows[0]?.id;
  if (!id) throw new Error('Failed to insert location');
  return id;
}
