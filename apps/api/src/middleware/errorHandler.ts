import type { NextFunction, Request, Response } from 'express';
import type { ApiResponse } from '@yatri/types';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
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
  const message = err instanceof Error ? err.message : 'Unexpected error';

  if (!isHttpError) {
    console.error('Unhandled error:', err);
  }

  res.status(status).json({ success: false, error: { code, message } });
}
