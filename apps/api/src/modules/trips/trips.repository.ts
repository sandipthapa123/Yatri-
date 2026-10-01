import { ACTIVE_TRIP_STATUSES, type TripPlace, type TripStatus } from '@yatri/types';

import type { PoolClient } from 'pg';

import { pool } from '../../config/database';
import { query } from '../../lib/db';
import { sqlIn } from '../../lib/sql';
import { insertLocation, type LocationFields } from '../location/locations.repository';

export interface TripRow {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  status: TripStatus;
  requested_at: Date;
  matched_at: Date | null;
  arrived_at: Date | null;
  started_at: Date | null;
  ended_at: Date | null;
  search_deadline_at: Date | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  fare_estimate_npr: number | null;
  waiting_charge_npr: number;
  fare_final_npr: number | null;
  passenger_notified_at: Date | null;
  vehicle_category_id: string | null;
  vehicle_category_code: string | null;
  vehicle_category_label: string | null;
  cancelled_from_status: TripStatus | null;
  cancellation_fee_npr: number;
  started_latitude: string | null;
  started_longitude: string | null;
  ended_latitude: string | null;
  ended_longitude: string | null;
  actual_distance_meters: number | null;
  actual_duration_seconds: number | null;
  surge_multiplier: string;
  surge_label: string | null;
  pickup_zone_id: string | null;
  city_id: string | null;
  organization_id: string | null;
  booked_by: string | null;
  cost_center_id: string | null;
  purpose: string | null;
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
  SELECT t.id, t.passenger_id, t.driver_id, t.status, t.requested_at, t.matched_at, t.arrived_at,
         t.started_at, t.ended_at, t.search_deadline_at, t.cancel_reason, t.cancelled_by,
         t.distance_meters, t.duration_seconds, t.fare_estimate_npr, t.waiting_charge_npr,
         t.fare_final_npr, t.passenger_notified_at, t.created_at,
         t.vehicle_category_id, vc.code AS vehicle_category_code, vc.label AS vehicle_category_label,
         t.cancelled_from_status, t.cancellation_fee_npr,
         t.started_latitude, t.started_longitude, t.ended_latitude, t.ended_longitude,
         t.actual_distance_meters, t.actual_duration_seconds,
         t.surge_multiplier, t.surge_label, t.pickup_zone_id,
         t.city_id, t.organization_id, t.booked_by, t.cost_center_id, t.purpose,
         pl.place_name AS pickup_name, pl.address AS pickup_address,
         pl.latitude AS pickup_lat, pl.longitude AS pickup_lng,
         dl.place_name AS dest_name, dl.address AS dest_address,
         dl.latitude AS dest_lat, dl.longitude AS dest_lng
  FROM trips t
  JOIN locations pl ON pl.id = t.pickup_location_id
  JOIN locations dl ON dl.id = t.destination_location_id
  LEFT JOIN vehicle_categories vc ON vc.id = t.vehicle_category_id`;

/** SQL `IN` list derived from the shared constant — the statuses are defined once, in @yatri/types. */
export const ACTIVE_SQL = sqlIn(ACTIVE_TRIP_STATUSES);

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

/**
 * What a ride booked for an organization adds to the ordinary request: who it is for, who booked it, the cost
 * centre and purpose. `guard` runs inside the same transaction as the insert (after the organization row is
 * locked by the guard itself), so a spending limit is checked and the ride created as one step.
 */
export interface BusinessRequest {
  organizationId: string;
  bookedBy: string;
  costCenterId: string | null;
  purpose: string | null;
  guard: (client: PoolClient) => Promise<void>;
}

export async function createTripRequest(input: {
  business?: BusinessRequest | undefined;
  /** The city the ride was requested in (its fare, waiting and cancellation rules follow the ride). */
  cityId?: string | null;
  passengerId: string;
  vehicleCategoryId: string;
  pickup: LocationFields;
  destination: LocationFields;
  distanceMeters: number;
  durationSeconds: number | null;
  fareEstimateNpr: number;
  /** The multiplier the rider was quoted; the final fare uses it, whatever the rules say later. */
  surgeMultiplier: number;
  surgeLabel: string | null;
  pickupZoneId: string | null;
  searchTimeoutSeconds: number;
}): Promise<TripRow> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pickupId = await insertLocation(client, input.pickup);
    const destId = await insertLocation(client, input.destination);
    if (input.business) await input.business.guard(client);
    const ins = await client.query<{ id: string }>(
      `INSERT INTO trips
         (passenger_id, pickup_location_id, destination_location_id, status,
          distance_meters, duration_seconds, fare_estimate_npr, search_deadline_at, vehicle_category_id,
          surge_multiplier, surge_label, pickup_zone_id, organization_id, booked_by, cost_center_id, purpose, city_id)
       VALUES ($1, $2, $3, 'SEARCHING', $4, $5, $6, now() + ($7::int * interval '1 second'), $8, $9, $10, $11,
               $12, $13, $14, $15, $16)
       RETURNING id`,
      [
        input.passengerId,
        pickupId,
        destId,
        Math.round(input.distanceMeters),
        input.durationSeconds === null ? null : Math.round(input.durationSeconds),
        input.fareEstimateNpr,
        input.searchTimeoutSeconds,
        input.vehicleCategoryId,
        input.surgeMultiplier,
        input.surgeLabel,
        input.pickupZoneId,
        input.business?.organizationId ?? null,
        input.business?.bookedBy ?? null,
        input.business?.costCenterId ?? null,
        input.business?.purpose ?? null,
        input.cityId ?? null,
      ],
    );
    await client.query('COMMIT');
    return (await getTrip(ins.rows[0]?.id as string)) as TripRow;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Columns a transition may set. A whitelist: the SQL below is assembled from these names only. */
export interface TripPatch {
  driverId?: string | null;
  matchedAt?: 'now' | null;
  arrivedAt?: 'now' | null;
  startedAt?: 'now';
  endedAt?: 'now';
  passengerNotifiedAt?: 'now';
  cancelReason?: string | null;
  cancelledBy?: 'PASSENGER' | 'DRIVER' | 'SYSTEM';
  waitingChargeNpr?: number;
  cancellationFeeNpr?: number;
  startedLatitude?: number;
  startedLongitude?: number;
  endedLatitude?: number;
  endedLongitude?: number;
  actualDistanceMeters?: number;
  actualDurationSeconds?: number;
  fareFinalNpr?: number;
  searchDeadlineSeconds?: number;
}

const COLUMN_FOR: Record<keyof TripPatch, string> = {
  driverId: 'driver_id',
  matchedAt: 'matched_at',
  arrivedAt: 'arrived_at',
  startedAt: 'started_at',
  endedAt: 'ended_at',
  passengerNotifiedAt: 'passenger_notified_at',
  cancelReason: 'cancel_reason',
  cancelledBy: 'cancelled_by',
  waitingChargeNpr: 'waiting_charge_npr',
  cancellationFeeNpr: 'cancellation_fee_npr',
  startedLatitude: 'started_latitude',
  startedLongitude: 'started_longitude',
  endedLatitude: 'ended_latitude',
  endedLongitude: 'ended_longitude',
  actualDistanceMeters: 'actual_distance_meters',
  actualDurationSeconds: 'actual_duration_seconds',
  fareFinalNpr: 'fare_final_npr',
  searchDeadlineSeconds: 'search_deadline_at',
};

/**
 * Compare-and-swap: only applies when the trip is currently in one of `from`, so two racing
 * requests can never both win a transition. Returns the fresh row, or null when it lost.
 * `expectDriverId` additionally pins the assigned driver (so a stale driver cannot act).
 */
export async function casTripStatus(
  id: string,
  from: readonly TripStatus[],
  to: TripStatus,
  patch: TripPatch = {},
  expectDriverId?: string,
): Promise<TripRow | null> {
  const sets: string[] = ['status = $3', 'updated_at = now()'];
  // Atomic with the transition: the state a ride is cancelled FROM is read from the row itself
  // (the pre-update value), so it can never disagree with what actually happened.
  if (to === 'CANCELLED') sets.push('cancelled_from_status = status');
  const params: unknown[] = [id, from as string[], to];
  for (const key of Object.keys(patch) as Array<keyof TripPatch>) {
    const value = patch[key];
    if (value === undefined) continue;
    const column = COLUMN_FOR[key];
    if (value === 'now') sets.push(`${column} = now()`);
    else if (key === 'searchDeadlineSeconds') {
      params.push(value);
      sets.push(`${column} = now() + ($${params.length}::int * interval '1 second')`);
    } else {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
  }
  let where = 'id = $1 AND status = ANY($2::text[])';
  if (expectDriverId) {
    params.push(expectDriverId);
    where += ` AND driver_id = $${params.length}`;
  }
  const r = await query<{ id: string }>(
    `UPDATE trips SET ${sets.join(', ')} WHERE ${where} RETURNING id`,
    params,
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
