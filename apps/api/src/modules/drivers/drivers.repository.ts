import { query } from '../../lib/db';
import type { DriverProfileRow } from './drivers.types';

export async function createDriverProfile(userId: string): Promise<DriverProfileRow> {
  const result = await query<DriverProfileRow>(
    `INSERT INTO driver_profiles (user_id, status)
     VALUES ($1, 'PENDING_VERIFICATION')
     RETURNING user_id, status, created_at, updated_at`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create driver profile');
  return row;
}

export async function findDriverProfileByUserId(userId: string): Promise<DriverProfileRow | null> {
  const result = await query<DriverProfileRow>(
    `SELECT user_id, status, created_at, updated_at FROM driver_profiles WHERE user_id = $1`,
    [userId],
  );
  return result.rows[0] ?? null;
}
