import type { VehicleCategoryInfo } from '@yatri/types';

import { query } from '../../lib/db';
import { pricingConfig, type PricingConfig } from './pricing.config';

/**
 * Vehicle categories are reference data in the database (operations can add or retire one without
 * a deploy). A category may override the platform fare defaults; a NULL override means "use the
 * default from configuration", so the default is stated once (FARE_* env) and a category only
 * records how it differs.
 */
export interface CategoryRow extends VehicleCategoryInfo {
  id: string;
  baseFareNpr: number | null;
  perKmNpr: number | null;
  perMinuteNpr: number | null;
  minimumFareNpr: number | null;
}

interface Raw {
  id: string;
  code: string;
  label: string;
  base_fare_npr: number | null;
  per_km_npr: number | null;
  per_minute_npr: number | null;
  minimum_fare_npr: number | null;
}

const COLS = 'id, code, label, base_fare_npr, per_km_npr, per_minute_npr, minimum_fare_npr';
const map = (r: Raw): CategoryRow => ({
  id: r.id,
  code: r.code,
  label: r.label,
  baseFareNpr: r.base_fare_npr,
  perKmNpr: r.per_km_npr,
  perMinuteNpr: r.per_minute_npr,
  minimumFareNpr: r.minimum_fare_npr,
});

export async function listActiveCategories(): Promise<CategoryRow[]> {
  const r = await query<Raw>(
    `SELECT ${COLS} FROM vehicle_categories WHERE is_active ORDER BY sort_order, code`,
  );
  return r.rows.map(map);
}

export async function getActiveCategoryByCode(code: string): Promise<CategoryRow | null> {
  const r = await query<Raw>(
    `SELECT ${COLS} FROM vehicle_categories WHERE is_active AND code = $1`,
    [code],
  );
  return r.rows[0] ? map(r.rows[0]) : null;
}

/** The fare rules for a category: the platform defaults with the category's overrides applied. */
export function pricingFor(category: CategoryRow | null, base: PricingConfig = pricingConfig()) {
  if (!category) return base;
  return {
    ...base,
    baseNpr: category.baseFareNpr ?? base.baseNpr,
    perKmNpr: category.perKmNpr ?? base.perKmNpr,
    perMinuteNpr: category.perMinuteNpr ?? base.perMinuteNpr,
    minimumNpr: category.minimumFareNpr ?? base.minimumNpr,
  };
}
