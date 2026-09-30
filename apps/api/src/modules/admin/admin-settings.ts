import {
  type AdminVehicleCategory,
  type ApiResponse,
  type PlatformSettingInfo,
  type PlatformSettingsResponse,
  type UpdateSettingBody,
  type VehicleCategoryBody,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { pool } from '../../config/database';
import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { requireParam } from '../../lib/params';
import { HttpError } from '../../middleware/errorHandler';
import { listSettings, updateSetting } from '../settings/settings.service';
import { hasPermission } from './permissions';

export const updateSettingSchema = z
  .object({
    value: z.unknown().refine((v) => v !== undefined, 'A value is required.'),
    expectedVersion: z.number().int().min(0),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

export async function listSettingsHandler(
  req: Request,
  res: Response<ApiResponse<PlatformSettingsResponse>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  res.json({
    success: true,
    data: {
      settings: await listSettings(),
      canManage: await hasPermission(req.auth.userId, 'SETTINGS_MANAGE'),
    },
  });
}

export async function updateSettingHandler(
  req: Request,
  res: Response<ApiResponse<PlatformSettingInfo>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const body = req.body as UpdateSettingBody;
  res.json({
    success: true,
    data: await updateSetting(requireParam(req, 'key'), body, req.auth.userId),
  });
}

// ---------------------------------------------------------------- vehicle categories

const fare = z.number().int().min(0).max(100000).nullable();
const perUnit = z.number().min(0).max(10000).nullable();
export const vehicleCategorySchema = z
  .object({
    label: z.string().trim().min(2).max(40).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    baseFareNpr: fare.optional(),
    perKmNpr: perUnit.optional(),
    perMinuteNpr: perUnit.optional(),
    minimumFareNpr: fare.optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();

interface CategoryRow {
  id: string;
  code: string;
  label: string;
  is_active: boolean;
  sort_order: number;
  base_fare_npr: number | null;
  per_km_npr: string | null;
  per_minute_npr: string | null;
  minimum_fare_npr: number | null;
  using: number;
}

const COLUMNS = `c.id, c.code, c.label, c.is_active, c.sort_order, c.base_fare_npr, c.per_km_npr,
  c.per_minute_npr, c.minimum_fare_npr,
  (SELECT count(*)::int FROM vehicles v WHERE v.category_id = c.id) AS using`;

const toCategory = (r: CategoryRow): AdminVehicleCategory => ({
  id: r.id,
  code: r.code,
  label: r.label,
  isActive: r.is_active,
  sortOrder: r.sort_order,
  baseFareNpr: r.base_fare_npr,
  perKmNpr: r.per_km_npr === null ? null : Number(r.per_km_npr),
  perMinuteNpr: r.per_minute_npr === null ? null : Number(r.per_minute_npr),
  minimumFareNpr: r.minimum_fare_npr,
  driversUsing: r.using,
});

export async function listCategoriesHandler(
  _req: Request,
  res: Response<ApiResponse<AdminVehicleCategory[]>>,
) {
  const r = await query<CategoryRow>(
    `SELECT ${COLUMNS} FROM vehicle_categories c ORDER BY c.sort_order, c.code`,
  );
  res.json({ success: true, data: r.rows.map(toCategory) });
}

/**
 * Edit a vehicle category: its label, whether it can be requested, its order, and how its fare
 * differs from the platform default (null = use the default). Rides already requested keep the
 * rates they were priced with. The last active category cannot be switched off (nobody could
 * request a ride), and every change is audited with what it was before.
 */
export async function updateCategoryHandler(
  req: Request,
  res: Response<ApiResponse<AdminVehicleCategory>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const id = requireParam(req, 'id');
  const { reason, ...changes } = req.body as VehicleCategoryBody;
  const client = await pool.connect();
  let before: CategoryRow;
  try {
    await client.query('BEGIN');
    const cur = await client.query<CategoryRow>(
      `SELECT ${COLUMNS} FROM vehicle_categories c WHERE c.id = $1 FOR UPDATE OF c`,
      [id],
    );
    if (!cur.rows[0]) {
      await client.query('ROLLBACK');
      throw new HttpError(404, 'NOT_FOUND', 'Vehicle category not found.');
    }
    before = cur.rows[0];
    if (changes.isActive === false && before.is_active) {
      const others = await client.query(
        'SELECT 1 FROM vehicle_categories WHERE is_active AND id <> $1 LIMIT 1',
        [id],
      );
      if (!others.rowCount) {
        await client.query('ROLLBACK');
        throw new HttpError(
          409,
          'LAST_ACTIVE_CATEGORY',
          'At least one vehicle category must stay active so rides can be requested.',
        );
      }
    }
    const has = (k: keyof typeof changes) => k in changes;
    await client.query(
      `UPDATE vehicle_categories SET
         label = COALESCE($2, label),
         is_active = COALESCE($3, is_active),
         sort_order = COALESCE($4, sort_order),
         base_fare_npr = CASE WHEN $5::boolean THEN $6::int ELSE base_fare_npr END,
         per_km_npr = CASE WHEN $7::boolean THEN $8::numeric ELSE per_km_npr END,
         per_minute_npr = CASE WHEN $9::boolean THEN $10::numeric ELSE per_minute_npr END,
         minimum_fare_npr = CASE WHEN $11::boolean THEN $12::int ELSE minimum_fare_npr END
       WHERE id = $1`,
      [
        id,
        changes.label ?? null,
        changes.isActive ?? null,
        changes.sortOrder ?? null,
        has('baseFareNpr'),
        changes.baseFareNpr ?? null,
        has('perKmNpr'),
        changes.perKmNpr ?? null,
        has('perMinuteNpr'),
        changes.perMinuteNpr ?? null,
        has('minimumFareNpr'),
        changes.minimumFareNpr ?? null,
      ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  const after = await query<CategoryRow>(
    `SELECT ${COLUMNS} FROM vehicle_categories c WHERE c.id = $1`,
    [id],
  );
  const row = after.rows[0] as CategoryRow;
  await recordAudit({
    actorId: req.auth.userId,
    actorRole: 'ADMIN',
    action: 'VEHICLE_CATEGORY_CHANGED',
    subjectType: 'vehicle_category',
    subjectIds: [id],
    detail: { before: toCategory(before), after: toCategory(row), reason },
  });
  res.json({ success: true, data: toCategory(row) });
}
