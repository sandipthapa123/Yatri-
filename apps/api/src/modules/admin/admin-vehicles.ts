import { pageParam, pageSizeParam } from '../../lib/pagination';
import type { AdminListResponse, AdminVehicleRow, ApiResponse } from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { query } from '../../lib/db';
import { likeContains } from './admin-range';

/** Every vehicle with its owner and verification state; approval itself is the driver-review flow. */
export const adminVehiclesQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED']).optional(),
  category: z.string().trim().max(40).optional(),
  expiring: z.enum(['true']).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.enum(['newest', 'oldest', 'registration']).default('newest'),
  page: pageParam,
  pageSize: pageSizeParam(50, 20),
});

const ORDER = {
  newest: 'v.created_at DESC',
  oldest: 'v.created_at ASC',
  registration: 'v.registration_number ASC',
} as const;

export async function listVehiclesHandler(
  req: Request,
  res: Response<ApiResponse<AdminListResponse<AdminVehicleRow>>>,
) {
  const q = req.validatedQuery as z.infer<typeof adminVehiclesQuerySchema>;
  const params = [
    q.status ?? null,
    q.category ?? null,
    q.search ? likeContains(q.search) : null,
    q.expiring === 'true',
  ];
  const from = `
    FROM vehicles v
    LEFT JOIN users u ON u.id = v.driver_user_id
    LEFT JOIN vehicle_categories c ON c.id = v.category_id
    WHERE ($1::text IS NULL OR v.verification_status::text = $1)
      AND ($2::text IS NULL OR c.code = $2)
      AND ($3::text IS NULL OR v.registration_number ILIKE $3 ESCAPE '!' OR v.make ILIKE $3 ESCAPE '!'
           OR v.model ILIKE $3 ESCAPE '!' OR u.full_name ILIKE $3 ESCAPE '!')
      AND (NOT $4::boolean OR v.registration_expiry_date < current_date + 30
           OR v.insurance_expiry_date < current_date + 30)`;
  const [rows, count] = await Promise.all([
    query<{
      id: string;
      driver_user_id: string;
      driver: string | null;
      code: string | null;
      label: string | null;
      make: string;
      model: string;
      year: number | null;
      registration_number: string;
      verification_status: string;
      registration_expiry_date: Date | string | null;
      insurance_expiry_date: Date | string | null;
      created_at: Date;
    }>(
      `SELECT v.id, v.driver_user_id, u.full_name AS driver, c.code, c.label, v.make, v.model, v.year,
              v.registration_number, v.verification_status::text, v.registration_expiry_date,
              v.insurance_expiry_date, v.created_at
       ${from} ORDER BY ${ORDER[q.sort]}, v.id LIMIT $5 OFFSET $6`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: number }>(`SELECT count(*)::int AS n ${from}`, params),
  ]);
  // A DATE column may arrive as a Date or as text depending on the driver; either way it is a calendar day.
  const day = (d: Date | string | null) =>
    d === null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  res.json({
    success: true,
    data: {
      items: rows.rows.map((r) => ({
        id: r.id,
        driverId: r.driver_user_id,
        driverName: r.driver,
        categoryCode: r.code,
        categoryLabel: r.label,
        make: r.make,
        model: r.model,
        year: r.year,
        registrationNumber: r.registration_number,
        verificationStatus: r.verification_status,
        registrationExpiryDate: day(r.registration_expiry_date),
        insuranceExpiryDate: day(r.insurance_expiry_date),
        createdAt: r.created_at.toISOString(),
      })),
      total: count.rows[0]?.n ?? 0,
      page: q.page,
      pageSize: q.pageSize,
    },
  });
}
