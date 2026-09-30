import type { TripRole } from '@yatri/types';

import { HttpError } from '../../middleware/errorHandler';
import { getTrip, type TripRow } from './trips.repository';

/**
 * THE ride permission check: who a person is on a ride. Every feature that acts on "this person's
 * ride" — trip reads, chat, calls, sharing, payment, disputes — asks here, so the rule (and the
 * anti-probing answer) exists exactly once.
 */
export function participantRole(trip: TripRow, userId: string): TripRole | null {
  if (trip.passenger_id === userId) return 'PASSENGER';
  if (trip.driver_id === userId) return 'DRIVER';
  return null;
}

/**
 * The ride and the caller's role on it. A person who is not on the ride gets the same 404 as a ride
 * that does not exist, so other people's rides cannot be probed.
 */
export async function requireParticipant(
  tripId: string,
  userId: string,
): Promise<{ trip: TripRow; role: TripRole }> {
  const trip = await getTrip(tripId);
  const role = trip ? participantRole(trip, userId) : null;
  if (!trip || !role) throw new HttpError(404, 'NOT_FOUND', 'Trip not found.');
  return { trip, role };
}

/** For actions only the ride's passenger may take: the driver is refused (403), strangers get the 404. */
export async function requirePassenger(tripId: string, userId: string): Promise<TripRow> {
  const { trip, role } = await requireParticipant(tripId, userId);
  if (role !== 'PASSENGER') {
    throw new HttpError(403, 'FORBIDDEN', 'Only the passenger can do this.');
  }
  return trip;
}
