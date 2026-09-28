import type { NextFunction, Request, Response } from 'express';
import type { ApiResponse } from '@yatri/types';

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

// Express 5 forwards rejected promises from async handlers here automatically.
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response<ApiResponse<never>>,
  _next: NextFunction,
) {
  const isHttpError = err instanceof HttpError;
  const status = isHttpError ? err.status : 500;
  const code = isHttpError ? err.code : 'INTERNAL_ERROR';
  // Never leak internal error messages (which can include driver/library
  // detail) for unexpected 500s — only HttpErrors we raised ourselves have
  // messages meant for API consumers.
  const message = isHttpError ? err.message : 'Something went wrong. Please try again.';

  if (!isHttpError) {
    console.error('Unhandled error:', err);
  }

  res.status(status).json({
    success: false,
    error: { code, message, ...(isHttpError && err.details ? { details: err.details } : {}) },
  });
}
