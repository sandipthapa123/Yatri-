import { createHash } from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { query } from '../lib/db';
import { log } from '../lib/logger';
import { HttpError } from './errorHandler';

/**
 * THE idempotency rule for actions that must not happen twice (requesting a ride, accepting an offer, starting,
 * completing, cancelling, confirming a payment, ...). An app that cannot tell whether its request arrived (the network
 * dropped, the app was killed) sends the same request again with the SAME `Idempotency-Key` header and gets the first
 * answer back, instead of a second ride or a confusing "already done" error:
 *  - same user, same URL, same key, same body, finished  -> the stored answer is replayed (`Idempotent-Replay: true`);
 *  - still running (the first attempt has not finished)    -> 409 IDEMPOTENCY_IN_PROGRESS, try again in a moment;
 *  - same key with a different body or another URL        -> 422 IDEMPOTENCY_KEY_REUSED (a client bug, never guessed at);
 *  - the first attempt failed (4xx/5xx or crashed)         -> the key is released so a retry runs again for real.
 * The header is optional so older apps keep working; only a successful answer is stored. Keys are scoped to the user,
 * so one person's key can never replay another's answer, and they are removed by the IDEMPOTENCY_KEYS retention rule.
 * The rule that decides is still the endpoint's own (state checks under row locks); this only stops a repeat.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,100}$/;
/** An attempt that never finished (the process died) can be taken over after this long. */
const STALE_SECONDS = 60;

const fingerprint = (req: Request) =>
  createHash('sha256')
    .update(`${req.method} ${req.originalUrl.split('?')[0]}\n${JSON.stringify(req.body ?? null)}`)
    .digest('hex');

export function idempotent() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const raw = req.header(IDEMPOTENCY_HEADER);
      if (req.method !== 'POST' || raw === undefined || raw === '') return next();
      if (!req.auth) return next();
      if (!KEY_PATTERN.test(raw)) {
        throw new HttpError(
          400,
          'IDEMPOTENCY_KEY_INVALID',
          'The Idempotency-Key must be 8 to 100 letters, digits, dots, dashes, colons or underscores.',
        );
      }
      const userId = req.auth.userId;
      const endpoint = req.originalUrl.split('?')[0] ?? '';
      const hash = fingerprint(req);

      const claimed = await query(
        `INSERT INTO idempotency_keys (user_id, endpoint, key, request_hash)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [userId, endpoint, raw, hash],
      );
      if (claimed.rowCount === 0) {
        const found = await query<{
          request_hash: string;
          status_code: number | null;
          response: unknown;
          stale: boolean;
        }>(
          `SELECT request_hash, status_code, response,
                  (completed_at IS NULL AND created_at < now() - ($4::int * interval '1 second')) AS stale
           FROM idempotency_keys WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
          [userId, endpoint, raw, STALE_SECONDS],
        );
        const row = found.rows[0];
        if (!row) return next(); // removed between the two statements; treat as a fresh request
        if (row.request_hash !== hash) {
          throw new HttpError(
            422,
            'IDEMPOTENCY_KEY_REUSED',
            'This Idempotency-Key was already used for a different request.',
          );
        }
        if (row.status_code !== null) {
          res.setHeader('Idempotent-Replay', 'true');
          res.status(row.status_code).json(row.response);
          return;
        }
        if (!row.stale) {
          res.setHeader('Retry-After', '1');
          throw new HttpError(
            409,
            'IDEMPOTENCY_IN_PROGRESS',
            'The first attempt of this request is still being processed. Try again in a moment.',
          );
        }
        // A crashed first attempt: take it over (one winner).
        const taken = await query(
          `UPDATE idempotency_keys SET created_at = now()
           WHERE user_id = $1 AND endpoint = $2 AND key = $3 AND completed_at IS NULL
             AND created_at < now() - ($4::int * interval '1 second')`,
          [userId, endpoint, raw, STALE_SECONDS],
        );
        if (taken.rowCount === 0) {
          res.setHeader('Retry-After', '1');
          throw new HttpError(
            409,
            'IDEMPOTENCY_IN_PROGRESS',
            'The first attempt of this request is still being processed. Try again in a moment.',
          );
        }
      }

      // We own the key: remember a successful answer, release the key on anything else.
      const json = res.json.bind(res);
      let settled = false;
      res.json = ((body: unknown) => {
        if (!settled) {
          settled = true;
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          const done = ok
            ? query(
                `UPDATE idempotency_keys SET status_code = $4, response = $5::jsonb, completed_at = now()
                 WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
                [userId, endpoint, raw, res.statusCode, JSON.stringify(body ?? null)],
              )
            : query(
                `DELETE FROM idempotency_keys WHERE user_id = $1 AND endpoint = $2 AND key = $3`,
                [userId, endpoint, raw],
              );
          // The answer is sent after it is stored, so a client that retries instantly finds it.
          void done
            .catch((err) => log.error('Idempotency store failed', err))
            .finally(() => json(body));
          return res;
        }
        return json(body);
      }) as Response['json'];
      // If the client hangs up first, the handler still finishes and its answer is stored below, so a retry replays it.
      next();
    } catch (err) {
      next(err);
    }
  };
}
