import type { ApiResponse, PushTokenBody } from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';

/**
 * A phone's address for push notifications. It is held only to deliver this person's own notifications, belongs to one
 * person at a time (a phone passed to someone else moves with the next sign-in), and is removed on sign-out or when the push
 * service reports the phone gone. It is never shown to anyone.
 */
export const pushTokenSchema = z.object({
  token: z.string().trim().regex(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{8,64}\]$/, 'That is not a push token.'),
  platform: z.enum(['ios', 'android']),
});

export async function registerPushTokenHandler(req: Request, res: Response<ApiResponse<{ registered: true }>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const body = req.body as PushTokenBody;
  await query(
    `INSERT INTO push_tokens (token, user_id, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, last_seen_at = now()`,
    [body.token, req.auth.userId, body.platform],
  );
  res.json({ success: true, data: { registered: true } });
}

export async function removePushTokenHandler(req: Request, res: Response<ApiResponse<{ removed: true }>>) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const body = pushTokenSchema.pick({ token: true }).parse(req.body);
  await query('DELETE FROM push_tokens WHERE token = $1 AND user_id = $2', [body.token, req.auth.userId]);
  res.json({ success: true, data: { removed: true } });
}
