import { query } from '../../lib/db';

export type OfferStatus = 'OFFERED' | 'ACCEPTED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';

export interface OfferRow {
  id: string;
  trip_id: string;
  driver_id: string;
  status: OfferStatus;
  pickup_distance_meters: number;
  offered_at: Date;
  expires_at: Date;
  responded_at: Date | null;
}

const COLS =
  'id, trip_id, driver_id, status, pickup_distance_meters, offered_at, expires_at, responded_at';

/** Returns null when this driver was already offered this trip (a driver is never offered a trip twice). */
export async function insertOffer(input: {
  tripId: string;
  driverId: string;
  pickupDistanceMeters: number;
  ttlSeconds: number;
}): Promise<OfferRow | null> {
  try {
    const r = await query<OfferRow>(
      `INSERT INTO trip_offers (trip_id, driver_id, pickup_distance_meters, expires_at)
       VALUES ($1, $2, $3, now() + ($4::int * interval '1 second'))
       RETURNING ${COLS}`,
      [input.tripId, input.driverId, Math.round(input.pickupDistanceMeters), input.ttlSeconds],
    );
    return r.rows[0] ?? null;
  } catch (err) {
    // trip_offers_trip_driver_unique, or trip_offers_one_open_per_driver: someone else got there first.
    if ((err as { code?: string }).code === '23505') return null;
    throw err;
  }
}

export async function getOffer(id: string): Promise<OfferRow | null> {
  const r = await query<OfferRow>(`SELECT ${COLS} FROM trip_offers WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

export async function openOfferForTrip(tripId: string): Promise<OfferRow | null> {
  const r = await query<OfferRow>(
    `SELECT ${COLS} FROM trip_offers WHERE trip_id = $1 AND status = 'OFFERED'`,
    [tripId],
  );
  return r.rows[0] ?? null;
}

export async function countOffers(tripId: string): Promise<number> {
  const r = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM trip_offers WHERE trip_id = $1',
    [tripId],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Only succeeds while the offer is still open AND unexpired: the accept/decline race is decided in SQL. */
export async function respondToOffer(
  id: string,
  driverId: string,
  to: 'ACCEPTED' | 'DECLINED',
): Promise<OfferRow | null> {
  const r = await query<OfferRow>(
    `UPDATE trip_offers SET status = $3, responded_at = now()
     WHERE id = $1 AND driver_id = $2 AND status = 'OFFERED' AND expires_at > now()
     RETURNING ${COLS}`,
    [id, driverId, to],
  );
  return r.rows[0] ?? null;
}

export async function closeOffer(
  id: string,
  to: 'EXPIRED' | 'CANCELLED',
): Promise<OfferRow | null> {
  const r = await query<OfferRow>(
    `UPDATE trip_offers SET status = $2, responded_at = now()
     WHERE id = $1 AND status IN ('OFFERED', 'ACCEPTED') RETURNING ${COLS}`,
    [id, to],
  );
  return r.rows[0] ?? null;
}

export async function expireDueOffers(): Promise<OfferRow[]> {
  const r = await query<OfferRow>(
    `UPDATE trip_offers SET status = 'EXPIRED', responded_at = now()
     WHERE status = 'OFFERED' AND expires_at <= now() RETURNING ${COLS}`,
  );
  return r.rows;
}

export async function cancelOpenOffersForTrip(tripId: string): Promise<OfferRow[]> {
  const r = await query<OfferRow>(
    `UPDATE trip_offers SET status = 'CANCELLED', responded_at = now()
     WHERE trip_id = $1 AND status = 'OFFERED' RETURNING ${COLS}`,
    [tripId],
  );
  return r.rows;
}

/** The accepted offer of a trip's current driver (marked CANCELLED when that driver drops out). */
export async function cancelAcceptedOffer(tripId: string, driverId: string): Promise<void> {
  await query(
    `UPDATE trip_offers SET status = 'CANCELLED', responded_at = now()
     WHERE trip_id = $1 AND driver_id = $2 AND status = 'ACCEPTED'`,
    [tripId, driverId],
  );
}
