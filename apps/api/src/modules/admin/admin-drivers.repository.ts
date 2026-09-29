import { query } from '../../lib/db';
import type { AccountStatus, DriverStatus } from '@yatri/types';

export interface AdminDriverListRow {
  id: string;
  full_name: string | null;
  phone_number: string | null;
  account_status: AccountStatus;
  profile_picture_url: string | null;
  created_at: Date;
  driver_status: DriverStatus;
  submitted_at: Date | null;
  verified_at: Date | null;
}

export interface ListDriversFilters {
  search?: string;
  status?: DriverStatus;
  page: number;
  pageSize: number;
}

export async function listDrivers(
  filters: ListDriversFilters,
): Promise<{ rows: AdminDriverListRow[]; total: number }> {
  const search = filters.search?.trim() || null;
  const offset = (filters.page - 1) * filters.pageSize;

  const whereClause = `
    FROM users u
    JOIN driver_profiles dp ON dp.user_id = u.id
    WHERE u.role = 'DRIVER'
      AND ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.phone_number ILIKE '%' || $1 || '%')
      AND ($2::driver_verification_status IS NULL OR dp.status = $2)
  `;

  const [rowsResult, countResult] = await Promise.all([
    query<AdminDriverListRow>(
      `SELECT u.id, u.full_name, u.phone_number, u.status AS account_status,
              u.profile_picture_url, u.created_at,
              dp.status AS driver_status, dp.submitted_at, dp.verified_at
       ${whereClause}
       ORDER BY dp.submitted_at DESC NULLS LAST, u.created_at DESC
       LIMIT $3 OFFSET $4`,
      [search, filters.status ?? null, filters.pageSize, offset],
    ),
    query<{ count: string }>(`SELECT count(*) ${whereClause}`, [search, filters.status ?? null]),
  ]);

  return { rows: rowsResult.rows, total: Number(countResult.rows[0]?.count ?? 0) };
}
