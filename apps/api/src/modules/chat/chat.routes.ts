import { Router, type Request, type Response, type Router as RouterType } from 'express';
import {
  CHAT_MAX_LENGTH,
  type ApiResponse,
  type ChatHistory,
  type ChatMessage,
} from '@yatri/types';
import { z } from 'zod';

import { HttpError } from '../../middleware/errorHandler';
import { validateBody } from '../../middleware/validate';
import { getHistory, markRead, sendMessage } from './chat.service';

/** Mounted at /trips/:id/chat (authenticated, participant-scoped by the service). REST mirror of the socket. */
export const chatRouter: RouterType = Router({ mergeParams: true });

const uid = (req: Request): string => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};
const tripId = (req: Request) => {
  const v = req.params.id;
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

const sendSchema = z
  .object({
    clientMessageId: z.string().min(8).max(64),
    body: z
      .string()
      .min(1)
      .max(CHAT_MAX_LENGTH * 2),
  })
  .strict();
const readSchema = z.object({ upToSeq: z.number().int().min(1) }).strict();

chatRouter.get('/', async (req: Request, res: Response<ApiResponse<ChatHistory>>) => {
  res.json({ success: true, data: await getHistory(tripId(req), uid(req)) });
});

/** Fallback for when the socket is down; idempotent on clientMessageId, so a retry never duplicates. */
chatRouter.post(
  '/',
  validateBody(sendSchema),
  async (req: Request, res: Response<ApiResponse<ChatMessage>>) => {
    const b = req.body as { clientMessageId: string; body: string };
    res.status(201).json({
      success: true,
      data: await sendMessage(tripId(req), uid(req), b.clientMessageId, b.body),
    });
  },
);

chatRouter.post(
  '/read',
  validateBody(readSchema),
  async (req: Request, res: Response<ApiResponse<{ upToSeq: number }>>) => {
    res.json({
      success: true,
      data: await markRead(tripId(req), uid(req), (req.body as { upToSeq: number }).upToSeq),
    });
  },
);
