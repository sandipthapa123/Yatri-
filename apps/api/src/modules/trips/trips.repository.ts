import type { TripPlace, TripStatus, TripSummary } from '@yatri/types';

import { pool } from '../../config/database';
import { query } from '../../lib/db';
import { insertLocation, type LocationFields } from '../location/locations.repository';

export interface TripRow {
  id: string;
  passenger_id: string;
  driver_id: string;
  status: TripStatus;
  arrived_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  created_at: Date;
  pickup_name: string | null;
  pickup_address: string;
  pickup_lat: string;
  pickup_lng: string;
  dest_name: string | null;
  dest_address: string;
  dest_lat: string;
  dest_lng: string;
}

const SELECT = `
  SELECT t.id, t.passenger_id, t.driver_id, t.status, t.arrived_at, t.started_at, t.ended_at,
         t.created_at,
         pl.place_name AS pickup_name, pl.address AS pickup_address,
         pl.latitude AS pickup_lat, pl.longitude AS pickup_lng,
         dl.place_name AS dest_name, dl.address AS dest_address,
         dl.latitude AS dest_lat, dl.longitude AS dest_lng
  FROM trips t
  JOIN locations pl ON pl.id = t.pickup_location_id
  JOIN locations dl ON dl.id = t.destination_location_id`;

export const ACTIVE_SQL = "('DRIVER_EN_ROUTE', 'DRIVER_ARRIVED', 'IN_PROGRESS')";

export async function getTrip(id: string): Promise<TripRow | null> {
  const r = await query<TripRow>(`${SELECT} WHERE t.id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function getActiveTripFor(userId: string): Promise<TripRow | null> {
  const r = await query<TripRow>(
    `${SELECT} WHERE (t.passenger_id = $1 OR t.driver_id = $1) AND t.status IN ${ACTIVE_SQL}
     LIMIT 1`,
    [userId],
  );
  return r.rows[0] ?? null;
}

export async function createTrip(input: {
  passengerId: string;
  driverId: string;
  pickup: LocationFields;
  destination: LocationFields;
}): Promise<TripRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pickupId = await insertLocation(client, input.pickup);
    const destId = await insertLocation(client, input.destination);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO trips (passenger_id, driver_id, pickup_location_id, destination_location_id)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.passengerId, input.driverId, pickupId, destId],
    );
    await client.query('COMMIT');
    const row = await getTrip(ins.rows[0]?.id as string);
    return row as TripRow;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Guarded transition: only applies when the trip is currently in one of `from`. */
export async function transitionTrip(
  id: string,
  from: TripStatus[],
  to: TripStatus,
  extra: { cancelledBy?: string } = {},
): Promise<TripRow | null> {
  const r = await query<{ id: string }>(
    `UPDATE trips SET status = $3, updated_at = now(),
       arrived_at = CASE WHEN $3 = 'DRIVER_ARRIVED' THEN now() ELSE arrived_at END,
       started_at = CASE WHEN $3 = 'IN_PROGRESS' THEN now() ELSE started_at END,
       ended_at = CASE WHEN $3 IN ('COMPLETED', 'CANCELLED') THEN now() ELSE ended_at END,
       cancelled_by = CASE WHEN $3 = 'CANCELLED' THEN $4 ELSE cancelled_by END
     WHERE id = $1 AND status = ANY($2::text[])
     RETURNING id`,
    [id, from, to, extra.cancelledBy ?? null],
  );
  if (!r.rows[0]) return null;
  return getTrip(id);
}

function place(name: string | null, address: string, lat: string, lng: string): TripPlace {
  return {
    name: name ?? address.split(',')[0]?.trim() ?? address,
    address,
    latitude: Number(lat),
    longitude: Number(lng),
  };
}

export function pickupOf(t: TripRow): TripPlace {
  return place(t.pickup_name, t.pickup_address, t.pickup_lat, t.pickup_lng);
}
export function destinationOf(t: TripRow): TripPlace {
  return place(t.dest_name, t.dest_address, t.dest_lat, t.dest_lng);
}

export function toTripSummary(t: TripRow, viewerId: string): TripSummary {
  return {
    id: t.id,
    status: t.status,
    pickup: pickupOf(t),
    destination: destinationOf(t),
    createdAt: t.created_at.toISOString(),
    arrivedAt: t.arrived_at?.toISOString() ?? null,
    startedAt: t.started_at?.toISOString() ?? null,
    endedAt: t.ended_at?.toISOString() ?? null,
    viewerRole: t.passenger_id === viewerId ? 'PASSENGER' : 'DRIVER',
  };
}
