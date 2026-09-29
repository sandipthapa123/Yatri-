import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../../config/env';

export interface SignedUrlOptions {
  /** Sets the response Content-Type when the URL is fetched, if provided. */
  contentType?: string;
  /** Sets Content-Disposition's filename when the URL is fetched, if provided. */
  filename?: string;
}

function canonicalPayload(key: string, expiresAt: number, options: SignedUrlOptions): string {
  return [key, expiresAt, options.contentType ?? '', options.filename ?? ''].join(':');
}

function sign(key: string, expiresAt: number, options: SignedUrlOptions): string {
  return createHmac('sha256', env.STORAGE_SIGNING_SECRET)
    .update(canonicalPayload(key, expiresAt, options))
    .digest('base64url');
}

export function buildSignedPath(
  key: string,
  expiresInSeconds: number,
  options: SignedUrlOptions = {},
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const signature = sign(key, expiresAt, options);
  const params = new URLSearchParams({ key, expires: String(expiresAt), sig: signature });
  if (options.contentType) params.set('contentType', options.contentType);
  if (options.filename) params.set('filename', options.filename);
  return `/api/v1/storage/content?${params.toString()}`;
}

export type SignedUrlVerification =
  | { valid: true; key: string; contentType?: string; filename?: string }
  | { valid: false; reason: 'expired' | 'invalid_signature' | 'missing_params' };

export function verifySignedParams(params: {
  key?: string;
  expires?: string;
  sig?: string;
  contentType?: string;
  filename?: string;
}): SignedUrlVerification {
  const { key, expires, sig, contentType, filename } = params;
  if (!key || !expires || !sig) return { valid: false, reason: 'missing_params' };

  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) {
    return { valid: false, reason: 'expired' };
  }

  const expected = sign(key, expiresAt, { contentType, filename });
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(sig);
  const matches =
    expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);

  if (!matches) return { valid: false, reason: 'invalid_signature' };
  return { valid: true, key, contentType, filename };
}
