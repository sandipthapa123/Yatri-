import {
  MAX_RANGE_DAYS,
  RANGE_PRESET_LABELS,
  RANGE_PRESETS,
  type RangePreset,
  type ResolvedRange,
} from '@yatri/types';
import { z } from 'zod';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';

/**
 * THE date range every dashboard, report and list uses. A range is a preset ("today", "last 7 days")
 * or two calendar dates (both inclusive); it is turned into [from, to) instants in the platform time
 * zone here and nowhere else, so "today" means the same thing on every screen and in every figure.
 *
 * Rides are always attributed to the day they were REQUESTED (`trips.requested_at`); payments and
 * everything about a ride follow the ride. One rule, so a day's figures add up across screens.
 */
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-09-30.');

export const rangeFields = {
  range: z.enum(RANGE_PRESETS).optional(),
  from: date.optional(),
  to: date.optional(),
};
export const rangeQuerySchema = z.object(rangeFields);
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

const PRESET_DAYS: Record<RangePreset, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

interface Bounds {
  from_ts: Date;
  to_ts: Date;
  from_day: string;
  to_day: string;
}

export async function resolveRange(
  q: RangeQuery,
  defaultPreset: RangePreset = 'today',
): Promise<ResolvedRange> {
  const tz = env.PLATFORM_TIME_ZONE;
  if (q.from || q.to) {
    if (!q.from || !q.to) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Give both a start date and an end date.');
    }
    const r = await query<Bounds>(
      `SELECT ($1::date::timestamp AT TIME ZONE $3) AS from_ts,
              (($2::date + 1)::timestamp AT TIME ZONE $3) AS to_ts,
              $1::date::text AS from_day, $2::date::text AS to_day,
              ($2::date - $1::date + 1) AS days`,
      [q.from, q.to, tz],
    );
    const row = r.rows[0] as Bounds & { days: number };
    if (row.days < 1) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'The end date must not be before the start date.',
      );
    }
    if (row.days > MAX_RANGE_DAYS) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        `A report can cover at most ${MAX_RANGE_DAYS} days at a time.`,
      );
    }
    return {
      from: row.from_ts.toISOString(),
      to: row.to_ts.toISOString(),
      label: row.from_day === row.to_day ? row.from_day : `${row.from_day} to ${row.to_day}`,
      timeZone: tz,
    };
  }
  const preset = q.range ?? defaultPreset;
  const r = await query<Bounds>(
    `SELECT ((date_trunc('day', now() AT TIME ZONE $1) - ($2::int - 1) * interval '1 day') AT TIME ZONE $1) AS from_ts,
            ((date_trunc('day', now() AT TIME ZONE $1) + interval '1 day') AT TIME ZONE $1) AS to_ts`,
    [tz, PRESET_DAYS[preset]],
  );
  const row = r.rows[0] as Bounds;
  return {
    from: row.from_ts.toISOString(),
    to: row.to_ts.toISOString(),
    label: RANGE_PRESET_LABELS[preset],
    timeZone: tz,
  };
}

/** Escape a person's search text (with `!`, the ESCAPE character of every ILIKE here) so `%` and `_` are searched for, not treated as wildcards. */
export const likeContains = (text: string) => `%${text.replace(/[!%_]/g, '!$&')}%`;
