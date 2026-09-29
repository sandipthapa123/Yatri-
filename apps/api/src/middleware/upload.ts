import type { NextFunction, Request, Response } from 'express';
import multer, { MulterError } from 'multer';

import { env } from '../config/env';
import { HttpError } from './errorHandler';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_UPLOAD_FILE_SIZE_BYTES,
    files: 1,
  },
});

/**
 * Buffers a single "file" field into memory (documents are small — a few
 * MB at most — so this is simpler and safer than streaming straight to
 * disk before the content has been validated). The buffer is never trusted
 * as-is: see lib/file-signature.ts, which is applied after this runs.
 */
export function uploadSingleFile(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();

    if (err instanceof MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(
        new HttpError(
          413,
          'FILE_TOO_LARGE',
          `File exceeds the maximum allowed size of ${Math.floor(env.MAX_UPLOAD_FILE_SIZE_BYTES / (1024 * 1024))}MB.`,
        ),
      );
    }
    if (err instanceof MulterError) {
      return next(new HttpError(400, 'UPLOAD_ERROR', 'The file could not be uploaded.'));
    }
    next(err);
  });
}
