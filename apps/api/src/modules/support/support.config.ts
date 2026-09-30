import type { SupportCategory, SupportPriority, TripRole } from '@yatri/types';
import { z } from 'zod';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';

/**
 * Support categories and priorities are DATA: labels, who may pick a category, whether it needs a ride,
 * its default priority, and how long an unanswered ticket of a priority may wait (and what it is raised
 * to then). Administrators edit them here; the apps only render what they are given.
 */
interface CategoryRow {
  code: string;
  label: string;
  help: string;
  kind: 'GENERAL' | 'DISPUTE';
  for_roles: TripRole[];
  requires_ride: boolean;
  default_priority: string;
  is_active: boolean;
  sort_order: number;
}
const toCategory = (r: CategoryRow): SupportCategory => ({
  code: r.code,
  label: r.label,
  help: r.help,
  kind: r.kind,
  forRoles: r.for_roles,
  requiresRide: r.requires_ride,
  defaultPriority: r.default_priority,
  isActive: r.is_active,
  sortOrder: r.sort_order,
});
const CATEGORY_COLS =
  'code, label, help, kind, for_roles, requires_ride, default_priority, is_active, sort_order';

/** The categories a person of this role may pick (active only), or all of them when no role is given. */
export async function listCategories(
  opts: { role?: TripRole; includeInactive?: boolean } = {},
): Promise<SupportCategory[]> {
  const r = await query<CategoryRow>(
    `SELECT ${CATEGORY_COLS} FROM support_categories
     WHERE ($1::boolean OR is_active) AND ($2::text IS NULL OR $2 = ANY(for_roles))
     ORDER BY sort_order, code`,
    [opts.includeInactive ?? false, opts.role ?? null],
  );
  return r.rows.map(toCategory);
}

export async function getCategory(code: string): Promise<SupportCategory | null> {
  const r = await query<CategoryRow>(
    `SELECT ${CATEGORY_COLS} FROM support_categories WHERE code = $1`,
    [code],
  );
  return r.rows[0] ? toCategory(r.rows[0]) : null;
}

export async function listPriorities(): Promise<SupportPriority[]> {
  const r = await query<{
    code: string;
    label: string;
    rank: number;
    first_response_hours: number;
    escalates_to: string | null;
  }>(
    `SELECT code, label, rank, first_response_hours, escalates_to
     FROM support_priorities ORDER BY rank DESC`,
  );
  return r.rows.map((p) => ({
    code: p.code,
    label: p.label,
    rank: p.rank,
    firstResponseHours: p.first_response_hours,
    escalatesTo: p.escalates_to,
  }));
}

export const categoryPatchSchema = z
  .object({
    label: z.string().trim().min(2).max(80).optional(),
    help: z.string().trim().min(5).max(300).optional(),
    forRoles: z
      .array(z.enum(['PASSENGER', 'DRIVER']))
      .min(1)
      .optional(),
    requiresRide: z.boolean().optional(),
    defaultPriority: z.string().trim().min(1).max(40).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(1000).optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export type CategoryPatch = z.infer<typeof categoryPatchSchema>;

export const priorityPatchSchema = z
  .object({
    label: z.string().trim().min(2).max(40).optional(),
    firstResponseHours: z.number().int().min(1).max(720).optional(),
    escalatesTo: z.string().trim().min(1).max(40).nullable().optional(),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export type PriorityPatch = z.infer<typeof priorityPatchSchema>;

async function assertPriority(code: string): Promise<void> {
  const r = await query('SELECT 1 FROM support_priorities WHERE code = $1', [code]);
  if (!r.rowCount) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown priority.').withDetails({
      priority: ['Unknown priority'],
    });
  }
}

export async function updateCategory(
  code: string,
  patch: CategoryPatch,
  adminId: string,
): Promise<SupportCategory> {
  const current = await getCategory(code);
  if (!current) throw new HttpError(404, 'NOT_FOUND', 'Category not found.');
  if (patch.defaultPriority) await assertPriority(patch.defaultPriority);
  // A dispute category always names a ride: disputes reference the ride, never copy it.
  if (current.kind === 'DISPUTE' && patch.requiresRide === false) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'A ride problem category must name the ride.');
  }
  const r = await query<CategoryRow>(
    `UPDATE support_categories SET
       label = COALESCE($2, label), help = COALESCE($3, help), for_roles = COALESCE($4::text[], for_roles),
       requires_ride = COALESCE($5, requires_ride), default_priority = COALESCE($6, default_priority),
       is_active = COALESCE($7, is_active), sort_order = COALESCE($8, sort_order), updated_at = now()
     WHERE code = $1 RETURNING ${CATEGORY_COLS}`,
    [
      code,
      patch.label ?? null,
      patch.help ?? null,
      patch.forRoles ?? null,
      patch.requiresRide ?? null,
      patch.defaultPriority ?? null,
      patch.isActive ?? null,
      patch.sortOrder ?? null,
    ],
  );
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'SUPPORT_CATEGORY_UPDATED',
    subjectType: 'support_category',
    subjectIds: null,
    detail: { code, reason: patch.reason },
  });
  return toCategory(r.rows[0] as CategoryRow);
}

export async function updatePriority(
  code: string,
  patch: PriorityPatch,
  adminId: string,
): Promise<SupportPriority> {
  const all = await listPriorities();
  const current = all.find((p) => p.code === code);
  if (!current) throw new HttpError(404, 'NOT_FOUND', 'Priority not found.');
  if (patch.escalatesTo) {
    const target = all.find((p) => p.code === patch.escalatesTo);
    if (!target) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown priority to escalate to.');
    }
    // Escalation only ever raises a ticket, so it can never loop.
    if (target.rank <= current.rank) {
      throw new HttpError(
        400,
        'VALIDATION_ERROR',
        'A ticket can only be escalated to a more urgent priority.',
      );
    }
  }
  await query(
    `UPDATE support_priorities SET
       label = COALESCE($2, label), first_response_hours = COALESCE($3, first_response_hours),
       escalates_to = CASE WHEN $4::boolean THEN $5 ELSE escalates_to END, updated_at = now()
     WHERE code = $1`,
    [
      code,
      patch.label ?? null,
      patch.firstResponseHours ?? null,
      patch.escalatesTo !== undefined,
      patch.escalatesTo ?? null,
    ],
  );
  await recordAudit({
    actorId: adminId,
    actorRole: 'ADMIN',
    action: 'SUPPORT_PRIORITY_UPDATED',
    subjectType: 'support_priority',
    subjectIds: null,
    detail: { code, reason: patch.reason },
  });
  return (await listPriorities()).find((p) => p.code === code) as SupportPriority;
}
