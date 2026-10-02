import path from 'node:path';

import { env } from '../../config/env';
import { LocalDiskStorageProvider } from './local-disk-provider';
import { S3StorageProvider } from './s3-provider';
import type { StorageProvider } from './storage-provider';

let provider: StorageProvider | undefined;

/**
 * THE storage provider, chosen by STORAGE_PROVIDER. Everything that keeps a file (documents, support attachments, exports,
 * profile pictures) calls this and the StorageProvider interface; none of it knows whether the bytes sit on a disk or in an
 * S3-compatible bucket. Staging and production must use a real store (providerProblems).
 */
export function getStorageProvider(): StorageProvider {
  if (!provider) {
    provider =
      env.STORAGE_PROVIDER === 's3'
        ? new S3StorageProvider({
            bucket: env.S3_BUCKET ?? '',
            region: env.S3_REGION,
            ...(env.S3_ENDPOINT ? { endpoint: env.S3_ENDPOINT } : {}),
            forcePathStyle: env.S3_FORCE_PATH_STYLE,
            credentials: { accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '', region: env.S3_REGION },
            timeoutMs: env.PROVIDER_TIMEOUT_MS * 3, // files are larger than a text message
          })
        : new LocalDiskStorageProvider(path.resolve(env.STORAGE_LOCAL_ROOT));
  }
  return provider;
}

/** Test seam. */
export function setStorageProviderForTests(p: StorageProvider | undefined): void {
  provider = p;
}

export type { StorageProvider } from './storage-provider';
export { StorageObjectNotFoundError } from './storage-provider';
