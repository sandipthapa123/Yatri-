import { query } from '../../lib/db';
import type { DriverProfileRow, DriverStatus } from './drivers.types';

const SELECT_COLUMNS = `user_id, status, rejection_reason, submitted_at, verified_at, reviewed_by, created_at, updated_at`;

export async function createDriverProfile(userId: string): Promise<DriverProfileRow> {
  const result = await query<DriverProfileRow>(
    `INSERT INTO driver_profiles (user_id, status)
     VALUES ($1, 'NOT_STARTED')
     RETURNING ${SELECT_COLUMNS}`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create driver profile');
  return row;
}

export async function findDriverProfileByUserId(userId: string): Promise<DriverProfileRow | null> {
  const result = await query<DriverProfileRow>(
    `SELECT ${SELECT_COLUMNS} FROM driver_profiles WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

/** Transitions status only if the driver is currently in one of `fromStatuses`. Returns null otherwise. */
export async function transitionDriverStatus(
  userId: string,
  fromStatuses: DriverStatus[],
  toStatus: DriverStatus,
  extra: {
    rejectionReason?: string | null;
    reviewedBy?: string;
    setSubmittedAt?: boolean;
    setVerifiedAt?: boolean;
  } = {},
): Promise<DriverProfileRow | null> {
  const result = await query<DriverProfileRow>(
    `UPDATE driver_profiles
     SET status = $2,
         rejection_reason = $3,
         reviewed_by = COALESCE($4, reviewed_by),
         submitted_at = CASE WHEN $5::boolean THEN now() ELSE submitted_at END,
         verified_at = CASE WHEN $6::boolean THEN now() ELSE verified_at END
     WHERE user_id = $1 AND status = ANY($7::driver_verification_status[])
     RETURNING ${SELECT_COLUMNS}`,
    [
      userId,
      toStatus,
      extra.rejectionReason ?? null,
      extra.reviewedBy ?? null,
      extra.setSubmittedAt ?? false,
      extra.setVerifiedAt ?? false,
      fromStatuses,
    ],
  );
  return result.rows[0] ?? null;
}
