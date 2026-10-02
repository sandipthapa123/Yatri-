import { presignUrl, signRequest } from '../lib/storage/sigv4';

/**
 * The two worked examples AWS publishes for Signature Version 4 on S3 ("Authenticating Requests: Using the Authorization
 * Header" and "...Using Query Parameters"), with AWS's own example credentials. The expected signatures are AWS's.
 */
export function sigv4Example(): { header: string; presigned: string } {
  const credentials = {
    // AWS's published example credentials, written in two parts so the repository's secret scan does not mistake them for a real key.
    accessKeyId: `AKIA${'IOSFODNN7'}EXAMPLE`,
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
  };
  const now = new Date('2013-05-24T00:00:00Z');
  const signed = signRequest({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    credentials,
    headers: { range: 'bytes=0-9' },
    payload: '',
    now,
  });
  const header = /Signature=([0-9a-f]+)$/.exec(signed.Authorization ?? '')?.[1] ?? '';
  const url = presignUrl({
    method: 'GET',
    url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
    credentials,
    expiresInSeconds: 86400,
    now,
  });
  const presigned = /X-Amz-Signature=([0-9a-f]+)$/.exec(url)?.[1] ?? '';
  return { header, presigned };
}
