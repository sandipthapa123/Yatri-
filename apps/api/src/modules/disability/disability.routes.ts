import {
  DISABILITY_AUTHORITY_MAX,
  DISABILITY_AUTHORITY_MIN,
  DISABILITY_CARD_NUMBER_MAX,
  DISABILITY_METHODS,
  isIsoDate,
  type ApiResponse,
  type DisabilityVerificationView,
} from '@yatri/types';
import { Router, type Request, type Response, type Router as RouterType } from 'express';
import { z } from 'zod';

import { authenticate } from '../../middleware/authenticate';
import { HttpError } from '../../middleware/errorHandler';
import { userMutationRateLimit, userRateLimit } from '../../middleware/rateLimit';
import { requireRole } from '../../middleware/requireRole';
import { uploadSingleFile } from '../../middleware/upload';
import { validateBody } from '../../middleware/validate';
import { optIn, saveDetails, saveDocument, submit, viewFor, withdraw } from './verification.service';

/**
 * The rider's side of disability benefit verification, at /api/v1/me/disability-verification. Passengers only: it is a
 * rider's choice and a rider's record. Nothing here sets a status: the rider opts in, gives details, adds a document, asks
 * to send, or steps away; the server decides every move (and only the server can mark anyone VERIFIED).
 */
type Res = Response<ApiResponse<DisabilityVerificationView>>;

const date = z.string().refine(isIsoDate, 'Use the date as YYYY-MM-DD.');
const details = z
  .object({
    cardNumber: z.string().trim().min(1).max(DISABILITY_CARD_NUMBER_MAX * 2).optional(),
    issuingAuthority: z.string().trim().min(DISABILITY_AUTHORITY_MIN).max(DISABILITY_AUTHORITY_MAX).optional(),
    issueDate: date.optional(),
    expiryDate: date.optional(),
    method: z.enum(DISABILITY_METHODS).optional(),
  })
  .strict();

const optInSchema = z.object({ consentVersion: z.string().trim().min(1).max(40), method: z.enum(DISABILITY_METHODS).optional() }).strict();
const patchSchema = z
  .object({ details: details.optional(), withdrawConsent: z.literal(true).optional() })
  .strict()
  .refine((b) => b.details !== undefined || b.withdrawConsent === true, 'Nothing to change.');
const submitSchema = z.object({ cardNumber: z.string().trim().min(1).max(DISABILITY_CARD_NUMBER_MAX * 2).optional() }).strict();

const uid = (req: Request): string => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};

export const disabilityRouter: RouterType = Router();
disabilityRouter.use(authenticate, requireRole('PASSENGER'), userMutationRateLimit());

disabilityRouter.get('/', async (req: Request, res: Res) => {
  res.json({ success: true, data: await viewFor(uid(req)) });
});

disabilityRouter.post('/', userRateLimit('disability-opt-in', 20, 3600), validateBody(optInSchema), async (req: Request, res: Res) => {
  res.status(201).json({ success: true, data: await optIn(uid(req), req.body as z.infer<typeof optInSchema>) });
});

disabilityRouter.patch('/', userRateLimit('disability-update', 60, 3600), validateBody(patchSchema), async (req: Request, res: Res) => {
  const body = req.body as z.infer<typeof patchSchema>;
  const id = uid(req);
  res.json({ success: true, data: body.withdrawConsent ? await withdraw(id) : await saveDetails(id, body.details ?? {}) });
});

disabilityRouter.post('/documents', userRateLimit('disability-document', 20, 3600), uploadSingleFile, async (req: Request, res: Res) => {
  if (!req.file) throw new HttpError(400, 'VALIDATION_ERROR', 'Choose a photo or PDF of your card.');
  res.status(201).json({ success: true, data: await saveDocument(uid(req), req.file) });
});

disabilityRouter.post('/submit', userRateLimit('disability-submit', 20, 3600), validateBody(submitSchema), async (req: Request, res: Res) => {
  res.json({ success: true, data: await submit(uid(req), req.body as z.infer<typeof submitSchema>) });
});
