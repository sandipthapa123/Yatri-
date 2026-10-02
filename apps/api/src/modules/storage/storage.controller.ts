import type { Request, Response } from 'express';

import { StorageObjectNotFoundError } from '../../lib/storage/storage-provider';
import { getStorageProvider } from '../../lib/storage';
import { verifySignedParams } from '../../lib/storage/signed-url';

/**
 * Serves object bytes for a signed URL produced by
 * StorageProvider.createTemporaryAccessUrl. This route is intentionally
 * NOT behind the `authenticate` bearer-token middleware — the signature
 * and expiry embedded in the query string ARE the credential, exactly like
 * an S3 presigned URL. Nothing here trusts anything about the requester
 * beyond "possesses a currently-valid signature for this exact key."
 */
export async function getSignedContentHandler(req: Request, res: Response) {
  const verification = verifySignedParams({
    key: typeof req.query.key === 'string' ? req.query.key : undefined,
    expires: typeof req.query.expires === 'string' ? req.query.expires : undefined,
    sig: typeof req.query.sig === 'string' ? req.query.sig : undefined,
    contentType: typeof req.query.contentType === 'string' ? req.query.contentType : undefined,
    filename: typeof req.query.filename === 'string' ? req.query.filename : undefined,
  });

  if (!verification.valid) {
    res.status(403).json({
      success: false,
      error: { code: 'INVALID_SIGNED_URL', message: 'This link is invalid or has expired.' },
    });
    return;
  }

  try {
    const buffer = await getStorageProvider().download(verification.key);
    res.setHeader('Content-Type', verification.contentType ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    if (verification.filename) {
      // The filename ultimately traces back to a client-supplied upload name;
      // strip anything that could break out of the quoted header value.
      const safeFilename = verification.filename.replace(/[\r\n"]/g, '');
      res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
    }
    res.send(buffer);
  } catch (err) {
    if (err instanceof StorageObjectNotFoundError) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'The requested file no longer exists.' },
      });
      return;
    }
    throw err;
  }
}
