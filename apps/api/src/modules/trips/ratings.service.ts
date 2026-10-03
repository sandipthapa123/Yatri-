import {
  RATING_COMMENT_MAX,
  RATING_MAX,
  RATING_MIN,
  type RatingInput,
  type RatingSummary,
} from '@yatri/types';

import { query, isUniqueViolation } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { getTrip } from './trips.repository';

/**
 * THE rating aggregation: what a person has been rated, computed from the ratings themselves on every
 * read (nothing is cached or stored beside them, so it cannot drift). One decimal, 1 to 5.
 */
export async function ratingSummary(userId: string): Promise<RatingSummary> {
  const r = await query<{ avg: string | null; n: string }>(
    'SELECT round(avg(stars)::numeric, 1)::text AS avg, count(*)::text AS n FROM trip_ratings WHERE ratee_id = $1',
    [userId],
  );
  const row = r.rows[0];
  return { average: row?.avg == null ? null : Number(row.avg), count: Number(row?.n ?? 0) };
}

/**
 * Rate the other party of a COMPLETED ride: the passenger rates the driver, the driver the passenger,
 * 1 to 5 stars with optional written feedback. One rating per person per ride (the database enforces
 * it, so two simultaneous submissions cannot both count).
 */
export async function rateTrip(tripId: string, raterId: string, input: RatingInput) {
  if (
    !Number.isInteger(input.stars) ||
    input.stars < RATING_MIN ||
    input.stars > RATING_MAX ||
    (input.comment ?? '').length > RATING_COMMENT_MAX
  ) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Invalid rating.');
  }
  const trip = await getTrip(tripId);
  const isPassenger = trip?.passenger_id === raterId;
  const isDriver = trip?.driver_id === raterId;
  if (!trip || (!isPassenger && !isDriver)) {
    throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
  }
  if (trip.status !== 'COMPLETED' || !trip.driver_id) {
    throw new HttpError(409, 'TRIP_NOT_COMPLETED', 'You can rate a ride once it has ended.');
  }
  const rateeId = isPassenger ? trip.driver_id : trip.passenger_id;
  try {
    const r = await query<{ id: string }>(
      `INSERT INTO trip_ratings (trip_id, rater_id, ratee_id, rater_role, stars, comment)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tripId,
        raterId,
        rateeId,
        isPassenger ? 'PASSENGER' : 'DRIVER',
        input.stars,
        input.comment?.trim() || null,
      ],
    );
    return { id: r.rows[0]?.id as string, tripId, stars: input.stars };
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, 'ALREADY_RATED', 'You have already rated this ride.');
    }
    throw err;
  }
}
