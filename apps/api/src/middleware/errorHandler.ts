import type { NextFunction, Request, Response } from 'express';
import type { ApiResponse } from '@yatri/types';
import { log } from '../lib/logger';
import { reportError } from '../lib/monitoring';
import { ProviderError } from '../modules/providers/errors';

export class HttpError extends Error {
  public details?: Record<string, unknown>;

  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }

  withDetails(details: Record<string, unknown>): this {
    this.details = details;
    return this;
  }
}

export function notFoundHandler(req: Request, res: Response<ApiResponse<never>>) {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}

/** Errors thrown by the body parser: the caller's fault, and never a 500. */
function bodyParserError(err: unknown): HttpError | null {
  const type = (err as { type?: unknown } | null)?.type;
  if (type === 'entity.parse.failed') {
    return new HttpError(400, 'INVALID_JSON', 'The request body is not valid JSON.');
  }
  if (type === 'entity.too.large') {
    return new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.');
  }
  return null;
}

// Express 5 forwards rejected promises from async handlers here automatically.
export function errorHandler(
  original: unknown,
  req: Request,
  res: Response<ApiResponse<never>>,
  _next: NextFunction,
) {
  const err = bodyParserError(original) ?? original;
  const isHttpError = err instanceof HttpError;
  // A vendor that failed is "service unavailable" with a fixed sentence: never the vendor's words, status or address.
  const isProviderError = err instanceof ProviderError;
  const status = isHttpError ? err.status : isProviderError ? 503 : 500;
  const code = isHttpError ? err.code : isProviderError ? 'SERVICE_UNAVAILABLE' : 'INTERNAL_ERROR';
  // Never leak internal error messages (which can include driver/library
  // detail) for unexpected 500s — only HttpErrors we raised ourselves have
  // messages meant for API consumers.
  const message = isHttpError
    ? err.message
    : isProviderError
      ? err.publicMessage
      : 'Something went wrong. Please try again.';

  if (isProviderError) {
    log.warn('Provider failure answered with 503', { requestId: req.id, route: req.route?.path, kind: err.kind });
  } else if (!isHttpError) {
    // The correlation id lets support match the caller's "something went wrong" to this line.
    log.error('Unhandled error', { requestId: req.id, route: req.route?.path }, err);
    reportError(err, {
      where: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}`,
      status,
      ...(req.id ? { requestId: String(req.id) } : {}),
    });
  }

  res.status(status).json({
    success: false,
    error: {
      code,
      message,
      ...(isHttpError && err.details ? { details: err.details } : {}),
      ...(status >= 500 && req.id ? { requestId: req.id } : {}),
    },
  });
}
