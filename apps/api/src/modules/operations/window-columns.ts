import { isoOrNull } from '../../lib/dates';
import { windowProblem, type TimeWindow } from '@yatri/types';
import { z } from 'zod';

/**
 * How a rule's time window is stored (columns) and validated (one zod schema), for every rule that has a
 * window: pricing rules and incentive rules share this, as they share `windowActive` in @yatri/types.
 */
export interface WindowRow {
  days_of_week: number[] | null;
  start_minute: number | null;
  end_minute: number | null;
  starts_at: Date | null;
  ends_at: Date | null;
}

export const windowFromRow = (r: WindowRow): TimeWindow => ({
  daysOfWeek: r.days_of_week && r.days_of_week.length > 0 ? r.days_of_week : null,
  startMinute: r.start_minute,
  endMinute: r.end_minute,
  startsAt: isoOrNull(r.starts_at),
  endsAt: isoOrNull(r.ends_at),
});

export const windowSchema = z
  .object({
    daysOfWeek: z.array(z.number().int()).max(7).nullable(),
    startMinute: z.number().int().nullable(),
    endMinute: z.number().int().nullable(),
    startsAt: z.string().datetime().nullable(),
    endsAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((w, ctx) => {
    const problem = windowProblem(w);
    if (problem) ctx.addIssue({ code: 'custom', message: problem });
  });
