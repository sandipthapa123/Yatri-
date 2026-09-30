import { randomUUID } from 'node:crypto';

import { REQUEST_ID_HEADER } from '@yatri/types';
import type { NextFunction, Request, Response } from 'express';

import { log } from '../lib/logger';

const WELL_FORMED_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Every request gets a correlation id (a caller's is kept only if it is a plain token, so a log
 * line cannot be forged or flooded with junk), API responses are marked `no-store` (they carry
 * personal data: nothing may cache them), and one access-log line is written when the response
 * finishes.
 *
 * The line names the ROUTE TEMPLATE ("/api/v1/trips/:id"), never the URL: a share link's token and a
 * signed storage URL's signature live in the address and must not reach a log. No query string, no
 * body, no headers are logged.
 */
export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = req.header(REQUEST_ID_HEADER);
  const requestId = incoming && WELL_FORMED_ID.test(incoming) ? incoming : randomUUID();
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : '(unmatched)';
    const fields = {
      requestId,
      method: req.method,
      route,
      status: res.statusCode,
      ms,
      userId: req.auth?.userId,
    };
    if (res.statusCode >= 500) log.error('request failed', fields);
    else if (ms > 1500) log.warn('slow request', fields);
    else log.info('request', fields);
  });
  next();
}
