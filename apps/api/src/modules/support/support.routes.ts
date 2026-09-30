import {
  TICKET_BODY_MAX,
  TICKET_BODY_MIN,
  TICKET_SUBJECT_MAX,
  REFUND_REASONS,
  type ApiResponse,
  type RefundInfo,
  type RefundQuote,
  type SupportCategory,
  type TicketDetail,
  type TicketInfo,
  type TripRole,
} from '@yatri/types';
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/authenticate';
import { userMutationRateLimit, userRateLimit } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/requireRole';
import { HttpError } from '../../middleware/errorHandler';
import { uploadSingleFile } from '../../middleware/upload';
import { validateBody } from '../../middleware/validate';
import { validateQuery } from '../../middleware/validateQuery';
import { validateUuidParam } from '../../middleware/validateUuidParam';
import { requireParam } from '../../lib/params';
import { listCategories } from './support.config';
import { refundQuoteForRequester, requestRefundAsRequester } from './refunds.service';
import {
  closeAsRequester,
  createTicket,
  getMyTicket,
  listMyTickets,
  replyAsRequester,
  requesterAttachment,
} from './tickets.service';

/**
 * The person's side of support: passengers and drivers (only), each seeing only their own tickets. Every
 * route runs the same service the admin side uses; nothing here decides a status.
 */
export const supportRouter: RouterType = Router();
supportRouter.use(authenticate, requireRole('PASSENGER', 'DRIVER'));
supportRouter.use(userMutationRateLimit());

const createSchema = z
  .object({
    categoryCode: z.string().trim().min(1).max(40),
    subject: z.string().trim().min(3).max(TICKET_SUBJECT_MAX),
    body: z.string().trim().min(TICKET_BODY_MIN).max(TICKET_BODY_MAX),
    tripId: z.string().uuid().optional(),
  })
  .strict();
const replySchema = z.object({ body: z.string().trim().min(1).max(TICKET_BODY_MAX) }).strict();
const listQuerySchema = z.object({ tripId: z.string().uuid().optional() });
const refundSchema = z
  .object({
    reason: z.enum(REFUND_REASONS),
    amountNpr: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
/** The optional text that travels with an uploaded file (multipart form field). */
const fileNoteSchema = z.string().trim().max(TICKET_BODY_MAX).optional();

const who = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return { userId: req.auth.userId, role: req.auth.role as TripRole };
};

supportRouter.get('/categories', async (req, res: Response<ApiResponse<SupportCategory[]>>) => {
  res.json({ success: true, data: await listCategories({ role: who(req).role }) });
});

supportRouter.get(
  '/tickets',
  validateQuery(listQuerySchema),
  async (req, res: Response<ApiResponse<TicketInfo[]>>) => {
    const q = req.validatedQuery as z.infer<typeof listQuerySchema>;
    res.json({ success: true, data: await listMyTickets(who(req).userId, q) });
  },
);

supportRouter.post(
  '/tickets',
  userRateLimit('support:create', 10, 3600),
  validateBody(createSchema),
  async (req, res: Response<ApiResponse<TicketInfo>>) => {
    const { userId, role } = who(req);
    res.status(201).json({
      success: true,
      data: await createTicket(userId, role, req.body as z.infer<typeof createSchema>),
    });
  },
);

supportRouter.get(
  '/tickets/:id',
  validateUuidParam('id'),
  async (req, res: Response<ApiResponse<TicketDetail>>) => {
    res.json({ success: true, data: await getMyTicket(who(req).userId, requireParam(req, 'id')) });
  },
);

supportRouter.post(
  '/tickets/:id/replies',
  userRateLimit('support:reply', 30, 3600),
  validateUuidParam('id'),
  validateBody(replySchema),
  async (req, res: Response<ApiResponse<TicketDetail>>) => {
    const { body } = req.body as z.infer<typeof replySchema>;
    res.json({
      success: true,
      data: await replyAsRequester(who(req).userId, requireParam(req, 'id'), body),
    });
  },
);

supportRouter.post(
  '/tickets/:id/attachments',
  userRateLimit('support:upload', 20, 3600),
  validateUuidParam('id'),
  uploadSingleFile,
  async (req, res: Response<ApiResponse<TicketDetail>>) => {
    if (!req.file) {
      throw new HttpError(400, 'VALIDATION_ERROR', 'A file is required.').withDetails({
        file: ['A file is required'],
      });
    }
    const note = fileNoteSchema.safeParse((req.body as { body?: unknown } | undefined)?.body);
    if (!note.success) throw new HttpError(400, 'VALIDATION_ERROR', 'The message is too long.');
    res.status(201).json({
      success: true,
      data: await replyAsRequester(
        who(req).userId,
        requireParam(req, 'id'),
        note.data || null,
        req.file,
      ),
    });
  },
);

supportRouter.post(
  '/tickets/:id/close',
  validateUuidParam('id'),
  async (req, res: Response<ApiResponse<TicketDetail>>) => {
    res.json({
      success: true,
      data: await closeAsRequester(who(req).userId, requireParam(req, 'id')),
    });
  },
);

supportRouter.get(
  '/tickets/:id/refund-quote',
  validateUuidParam('id'),
  async (req, res: Response<ApiResponse<RefundQuote>>) => {
    res.json({
      success: true,
      data: await refundQuoteForRequester(who(req).userId, requireParam(req, 'id')),
    });
  },
);

supportRouter.post(
  '/tickets/:id/refund',
  userRateLimit('support:refund', 5, 3600),
  validateUuidParam('id'),
  validateBody(refundSchema),
  async (req, res: Response<ApiResponse<RefundInfo>>) => {
    res.status(201).json({
      success: true,
      data: await requestRefundAsRequester(
        who(req).userId,
        requireParam(req, 'id'),
        req.body as z.infer<typeof refundSchema>,
      ),
    });
  },
);

supportRouter.get(
  '/attachments/:id/download-url',
  validateUuidParam('id'),
  userRateLimit('support:download', 60, 60),
  async (req, res: Response<ApiResponse<{ url: string; expiresInSeconds: number }>>) => {
    res.json({
      success: true,
      data: await requesterAttachment(who(req).userId, requireParam(req, 'id')),
    });
  },
);
