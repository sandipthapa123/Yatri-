import { RATING_COMMENT_MAX, RATING_MAX, RATING_MIN, type RatingInput } from '@yatri/types';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { getPayment } from './payments.service';
import { getTrip } from './trips.repository';

/** Average rating a user has received (1–5, one decimal), or null with no ratings yet. */
export async function averageRating(userId: string): Promise<number | null> {
  const r = await query<{ avg: string | null }>(
    'SELECT round(avg(stars)::numeric, 1)::text AS avg FROM trip_ratings WHERE ratee_id = $1',
    [userId],
  );
  const v = r.rows[0]?.avg;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * Rate the other party of a finished trip. Sequence follows the product flow: the ride is
 * completed and paid before ratings open. One rating per person per trip.
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
  if ((await getPayment(tripId))?.status !== 'PAID') {
    throw new HttpError(409, 'PAYMENT_NOT_SETTLED', 'Ratings open once the payment is settled.');
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
    if ((err as { code?: string }).code === '23505') {
      throw new HttpError(409, 'ALREADY_RATED', 'You have already rated this ride.');
    }
    throw err;
  }
}
