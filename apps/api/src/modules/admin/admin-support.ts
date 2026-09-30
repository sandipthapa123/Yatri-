import {
  REFUND_METHODS,
  REFUND_REASONS,
  REFUND_STATES,
  TICKET_BODY_MAX,
  TICKET_NOTE_MAX,
  TICKET_OUTCOMES,
  TICKET_STATUSES,
  SUPPORT_RESOLUTION_MAX,
  type AdminTicketDetail,
  type AdminTicketRow,
  type ApiResponse,
  type RefundInfo,
  type SupportCategory,
  type SupportPriority,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { requireParam } from '../../lib/params';
import { actOnRefund, createRefundAsAdmin } from '../support/refunds.service';
import {
  categoryPatchSchema,
  listCategories,
  listPriorities,
  priorityPatchSchema,
  updateCategory,
  updatePriority,
} from '../support/support.config';
import {
  adminAssign,
  adminAttachment,
  adminNote,
  adminReply,
  adminSetPriority,
  adminSetStatus,
  adminTicketDetail,
  listAdminTickets,
} from '../support/tickets.service';

/**
 * The support workspace's handlers. Each is a thin call into the ticket and refund services (the same
 * ones the apps' routes use); permissions are named on the routes, audit of actions happens in the
 * services or at the route.
 */
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};
const idParam = (req: Request) => requireParam(req, 'id');

export const adminTicketsQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  group: z.enum(['open', 'awaiting', 'finished']).optional(),
  priority: z.string().trim().max(40).optional(),
  category: z.string().trim().max(40).optional(),
  kind: z.enum(['dispute', 'general']).optional(),
  assigned: z.string().trim().max(40).optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  tripId: z.string().uuid().optional(),
  requesterId: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const adminReplySchema = z
  .object({
    body: z.string().trim().min(1).max(TICKET_BODY_MAX),
    status: z.enum(TICKET_STATUSES).optional(),
  })
  .strict();
export const adminNoteSchema = z
  .object({ body: z.string().trim().min(1).max(TICKET_NOTE_MAX) })
  .strict();
export const adminStatusSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
    resolution: z.string().trim().max(SUPPORT_RESOLUTION_MAX).optional(),
    outcome: z.enum(TICKET_OUTCOMES).optional(),
  })
  .strict();
export const adminAssignSchema = z.object({ adminId: z.string().uuid().nullable() }).strict();
export const adminPrioritySchema = z
  .object({
    priorityCode: z.string().trim().min(1).max(40),
    reason: z.string().trim().min(3).max(300),
  })
  .strict();
export const adminRefundCreateSchema = z
  .object({
    reason: z.enum(REFUND_REASONS),
    amountNpr: z.number().int().min(1).max(1_000_000).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export const adminRefundActionSchema = z
  .object({
    to: z.enum(REFUND_STATES),
    note: z.string().trim().max(500).optional(),
    method: z.enum(REFUND_METHODS).optional(),
    reference: z.string().trim().max(120).optional(),
    failedReason: z.string().trim().max(300).optional(),
  })
  .strict();
export { categoryPatchSchema, priorityPatchSchema };

type Res<T> = Response<ApiResponse<T>>;

export async function listTicketsHandler(
  req: Request,
  res: Res<{ items: AdminTicketRow[]; total: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof adminTicketsQuerySchema>;
  res.json({ success: true, data: await listAdminTickets(adminId(req), q) });
}
export async function ticketDetailHandler(req: Request, res: Res<AdminTicketDetail>) {
  res.json({ success: true, data: await adminTicketDetail(adminId(req), idParam(req)) });
}
export async function ticketReplyHandler(req: Request, res: Res<AdminTicketDetail>) {
  res.json({
    success: true,
    data: await adminReply(
      adminId(req),
      idParam(req),
      req.body as z.infer<typeof adminReplySchema>,
    ),
  });
}
/** A file from support, with an optional note in the multipart field `body`. */
export async function ticketAttachmentHandler(req: Request, res: Res<AdminTicketDetail>) {
  if (!req.file) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'A file is required.').withDetails({
      file: ['A file is required'],
    });
  }
  const note = z
    .string()
    .trim()
    .max(TICKET_BODY_MAX)
    .optional()
    .safeParse((req.body as { body?: unknown } | undefined)?.body);
  if (!note.success) throw new HttpError(400, 'VALIDATION_ERROR', 'The message is too long.');
  res.status(201).json({
    success: true,
    data: await adminReply(adminId(req), idParam(req), { body: note.data ?? '' }, req.file),
  });
}
export async function ticketNoteHandler(req: Request, res: Res<AdminTicketDetail>) {
  res.json({
    success: true,
    data: await adminNote(adminId(req), idParam(req), req.body as z.infer<typeof adminNoteSchema>),
  });
}
export async function ticketStatusHandler(req: Request, res: Res<AdminTicketDetail>) {
  res.json({
    success: true,
    data: await adminSetStatus(
      adminId(req),
      idParam(req),
      req.body as z.infer<typeof adminStatusSchema>,
    ),
  });
}
export async function ticketAssignHandler(req: Request, res: Res<AdminTicketDetail>) {
  const b = req.body as z.infer<typeof adminAssignSchema>;
  res.json({ success: true, data: await adminAssign(adminId(req), idParam(req), b.adminId) });
}
export async function ticketPriorityHandler(req: Request, res: Res<AdminTicketDetail>) {
  const b = req.body as z.infer<typeof adminPrioritySchema>;
  res.json({
    success: true,
    data: await adminSetPriority(adminId(req), idParam(req), b.priorityCode),
  });
}
export async function refundCreateHandler(req: Request, res: Res<RefundInfo>) {
  res.status(201).json({
    success: true,
    data: await createRefundAsAdmin(
      adminId(req),
      idParam(req),
      req.body as z.infer<typeof adminRefundCreateSchema>,
    ),
  });
}
export async function refundActionHandler(req: Request, res: Res<RefundInfo>) {
  res.json({
    success: true,
    data: await actOnRefund(
      adminId(req),
      idParam(req),
      req.body as z.infer<typeof adminRefundActionSchema>,
    ),
  });
}
export async function attachmentUrlHandler(
  req: Request,
  res: Res<{ url: string; expiresInSeconds: number }>,
) {
  res.json({ success: true, data: await adminAttachment(adminId(req), idParam(req)) });
}
/** The administrators a ticket can be given to (those who may handle tickets). */
export async function assigneesHandler(
  _req: Request,
  res: Res<Array<{ id: string; name: string | null; canHandleGeneral: boolean }>>,
) {
  const r = await query<{ id: string; full_name: string | null; general: boolean }>(
    `SELECT id, full_name, ('SUPPORT_MANAGE' = ANY(admin_permissions)) AS general FROM users
     WHERE role = 'ADMIN' AND status = 'ACTIVE'
       AND ('SUPPORT_MANAGE' = ANY(admin_permissions) OR 'DISPUTES_MANAGE' = ANY(admin_permissions))
     ORDER BY full_name NULLS LAST, id`,
  );
  res.json({
    success: true,
    data: r.rows.map((a) => ({ id: a.id, name: a.full_name, canHandleGeneral: a.general })),
  });
}

export async function listSupportConfigHandler(
  _req: Request,
  res: Res<{ categories: SupportCategory[]; priorities: SupportPriority[] }>,
) {
  res.json({
    success: true,
    data: {
      categories: await listCategories({ includeInactive: true }),
      priorities: await listPriorities(),
    },
  });
}
export async function updateSupportCategoryHandler(req: Request, res: Res<SupportCategory>) {
  res.json({
    success: true,
    data: await updateCategory(
      requireParam(req, 'code'),
      req.body as z.infer<typeof categoryPatchSchema>,
      adminId(req),
    ),
  });
}
export async function updatePriorityHandler(req: Request, res: Res<SupportPriority>) {
  res.json({
    success: true,
    data: await updatePriority(
      requireParam(req, 'code'),
      req.body as z.infer<typeof priorityPatchSchema>,
      adminId(req),
    ),
  });
}
