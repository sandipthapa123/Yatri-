import type { DisputeInfo, DisputeStatus } from '@yatri/types';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { requireParticipant } from './access';

interface Row {
  id: string;
  trip_id: string;
  status: DisputeStatus;
  reason: string;
  resolution: string | null;
  created_at: Date;
  resolved_at: Date | null;
}
const COLS = 'id, trip_id, status, reason, resolution, created_at, resolved_at';
const toInfo = (r: Row): DisputeInfo => ({
  id: r.id,
  tripId: r.trip_id,
  status: r.status,
  reason: r.reason,
  resolution: r.resolution,
  createdAt: r.created_at.toISOString(),
  resolvedAt: r.resolved_at?.toISOString() ?? null,
});

/** A participant flags a problem with a trip (fare, behaviour, no-show…). Admins resolve it. */
export async function openDispute(
  tripId: string,
  userId: string,
  reason: string,
): Promise<DisputeInfo> {
  const { trip } = await requireParticipant(tripId, userId);
  if (trip.status === 'SEARCHING' || trip.status === 'NO_DRIVERS') {
    throw new HttpError(409, 'NOTHING_TO_DISPUTE', 'There is no ride to dispute yet.');
  }
  const open = await query(
    `SELECT 1 FROM trip_disputes WHERE trip_id = $1 AND raised_by = $2 AND status = 'OPEN'`,
    [tripId, userId],
  );
  if (open.rowCount) {
    throw new HttpError(
      409,
      'DISPUTE_ALREADY_OPEN',
      'You already have an open dispute for this ride.',
    );
  }
  const r = await query<Row>(
    `INSERT INTO trip_disputes (trip_id, raised_by, reason) VALUES ($1, $2, $3) RETURNING ${COLS}`,
    [tripId, userId, reason],
  );
  return toInfo(r.rows[0] as Row);
}

export async function listMyDisputes(tripId: string, userId: string): Promise<DisputeInfo[]> {
  await requireParticipant(tripId, userId);
  const r = await query<Row>(
    `SELECT ${COLS} FROM trip_disputes WHERE trip_id = $1 AND raised_by = $2 ORDER BY created_at DESC`,
    [tripId, userId],
  );
  return r.rows.map(toInfo);
}

export async function resolveDispute(
  id: string,
  adminId: string,
  status: 'RESOLVED' | 'REJECTED',
  resolution: string,
): Promise<DisputeInfo> {
  const r = await query<Row>(
    `UPDATE trip_disputes SET status = $2, resolution = $3, resolved_by = $4, resolved_at = now()
     WHERE id = $1 AND status = 'OPEN' RETURNING ${COLS}`,
    [id, status, resolution, adminId],
  );
  if (!r.rows[0]) throw new HttpError(409, 'DISPUTE_NOT_OPEN', 'That dispute is not open.');
  return toInfo(r.rows[0]);
}
