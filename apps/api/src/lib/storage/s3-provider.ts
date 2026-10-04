import { providerRequest } from '../../modules/providers/http';
import { ProviderError } from '../../modules/providers/errors';
import { encodeRfc3986, presignUrl, signRequest, type SigV4Credentials } from './sigv4';
import {
  StorageObjectNotFoundError,
  type StorageProvider,
  type TemporaryAccessUrlOptions,
  type UploadInput,
} from './storage-provider';

export interface S3Config {
  bucket: string;
  region: string;
  /** For a store that is not Amazon S3 (MinIO, R2, Spaces). Empty: Amazon S3 for the region. */
  endpoint?: string;
  forcePathStyle: boolean;
  credentials: SigV4Credentials;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/**
 * An S3-compatible object store behind the one StorageProvider interface. Documents are private: they are never public,
 * and the only way to read one without a credential is a short-lived presigned URL made here. Uploads, reads and deletes
 * of a named key are safe to repeat, so they are retried on a passing failure (providerRequest). Nothing about the keys or
 * the bytes is logged.
 */
export class S3StorageProvider implements StorageProvider {
  readonly name = 's3';
  constructor(private readonly c: S3Config) {}

  private url(key: string): URL {
    const path = key
      .split('/')
      .map((s) => encodeRfc3986(s))
      .join('/');
    if (this.c.endpoint) {
      const base = this.c.endpoint.replace(/\/$/, '');
      return this.c.forcePathStyle
        ? new URL(`${base}/${this.c.bucket}/${path}`)
        : new URL(`${base.replace('://', `://${this.c.bucket}.`)}/${path}`);
    }
    return this.c.forcePathStyle
      ? new URL(`https://s3.${this.c.region}.amazonaws.com/${this.c.bucket}/${path}`)
      : new URL(`https://${this.c.bucket}.s3.${this.c.region}.amazonaws.com/${path}`);
  }

  private call<T>(
    operation: string,
    method: string,
    url: URL,
    opts: { body?: Buffer; headers?: Record<string, string>; expect: 'none' | 'buffer' },
  ) {
    const headers = signRequest({
      method,
      url,
      credentials: this.c.credentials,
      payload: opts.body ?? '',
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(this.c.now ? { now: this.c.now() } : {}),
    });
    return providerRequest<T>({
      capability: 'STORAGE',
      provider: this.name,
      operation,
      url: url.toString(),
      init: { method, headers, ...(opts.body ? { body: new Uint8Array(opts.body) } : {}) },
      timeoutMs: this.c.timeoutMs,
      idempotent: true,
      expect: opts.expect,
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
  }

  async upload(input: UploadInput): Promise<void> {
    await this.call('put', 'PUT', this.url(input.key), {
      body: input.buffer,
      headers: { 'content-type': input.contentType },
      expect: 'none',
    });
  }

  async download(key: string): Promise<Buffer> {
    try {
      return (await this.call<Buffer>('get', 'GET', this.url(key), { expect: 'buffer' })).data;
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404)
        throw new StorageObjectNotFoundError(key);
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.call('delete', 'DELETE', this.url(key), { expect: 'none' });
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) return; // already gone
      throw err;
    }
  }

  async createTemporaryAccessUrl(
    key: string,
    expiresInSeconds: number,
    options: TemporaryAccessUrlOptions = {},
  ): Promise<string> {
    const query: Record<string, string> = {};
    if (options.contentType) query['response-content-type'] = options.contentType;
    if (options.filename) {
      query['response-content-disposition'] =
        `attachment; filename="${options.filename.replace(/[^\w.\- ]/g, '_')}"`;
    }
    return presignUrl({
      method: 'GET',
      url: this.url(key),
      credentials: this.c.credentials,
      expiresInSeconds,
      query,
      ...(this.c.now ? { now: this.c.now() } : {}),
    });
  }

  /** A cheap check that the bucket answers and the credentials work: a signed HEAD of the bucket. */
  async check(): Promise<void> {
    const url = this.url('');
    await this.call('head', 'HEAD', new URL(url.toString().replace(/\/$/, '') + '/'), {
      expect: 'none',
    });
  }
}
