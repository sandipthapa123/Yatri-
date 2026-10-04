import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4, for any S3-compatible store (Amazon S3, MinIO, Cloudflare R2, DigitalOcean Spaces…). Written
 * out here rather than pulled in from a vendor SDK, so the storage adapter has no vendor dependency; it is checked against
 * the signatures AWS publishes for its own examples (see the tests).
 */
export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service?: string;
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) =>
  createHmac('sha256', key).update(data).digest();

/** RFC 3986 percent-encoding as S3 wants it: everything but letters, digits and - _ . ~ ; "/" kept in a path. */
export function encodeRfc3986(value: string, keepSlash = false): string {
  return encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/%2F/g, keepSlash ? '/' : '%2F');
}

export const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, '');

function signingKey(c: SigV4Credentials, date: string): Buffer {
  return hmac(
    hmac(hmac(hmac(`AWS4${c.secretAccessKey}`, date), c.region), c.service ?? 's3'),
    'aws4_request',
  );
}

const canonicalQuery = (params: Array<[string, string]>) =>
  params
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

/** Headers (including Authorization) to send for a signed request. */
export function signRequest(input: {
  method: string;
  url: URL;
  credentials: SigV4Credentials;
  /** Extra headers to sign and send (lower-case names). */
  headers?: Record<string, string>;
  payload: Buffer | string | 'UNSIGNED-PAYLOAD';
  now?: Date;
}): Record<string, string> {
  const now = input.now ?? new Date();
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);
  const payloadHash = input.payload === 'UNSIGNED-PAYLOAD' ? input.payload : sha256(input.payload);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...input.headers,
    host: input.url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  })) {
    headers[k.toLowerCase()] = v.trim();
  }
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const query = canonicalQuery([...input.url.searchParams.entries()]);
  const canonical = [
    input.method,
    encodeRfc3986(decodeURIComponent(input.url.pathname), true),
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const scope = `${date}/${input.credentials.region}/${input.credentials.service ?? 's3'}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(input.credentials, date))
    .update(toSign)
    .digest('hex');
  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/** A URL that grants one request for a limited time without any other credential (a "presigned" URL). */
export function presignUrl(input: {
  method: string;
  url: URL;
  credentials: SigV4Credentials;
  expiresInSeconds: number;
  /** Query parameters to add before signing (for example response-content-type). */
  query?: Record<string, string>;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);
  const scope = `${date}/${input.credentials.region}/${input.credentials.service ?? 's3'}/aws4_request`;
  const params: Array<[string, string]> = [
    ...input.url.searchParams.entries(),
    ...Object.entries(input.query ?? {}),
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${input.credentials.accessKeyId}/${scope}`],
    ['X-Amz-Date', stamp],
    ['X-Amz-Expires', String(input.expiresInSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const query = canonicalQuery(params);
  const canonical = [
    input.method,
    encodeRfc3986(decodeURIComponent(input.url.pathname), true),
    query,
    `host:${input.url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(input.credentials, date))
    .update(toSign)
    .digest('hex');
  return `${input.url.origin}${input.url.pathname}?${query}&X-Amz-Signature=${signature}`;
}
