import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { env } from '../../config/env';
import { buildSignedPath } from './signed-url';
import {
  StorageObjectNotFoundError,
  type StorageProvider,
  type TemporaryAccessUrlOptions,
  type UploadInput,
} from './storage-provider';

/**
 * Development-only provider: writes files to a directory on local disk,
 * deliberately outside `apps/api/public` or any other path Express serves
 * statically (there is no static file serving of this directory at all —
 * the only way to read a file back is through the signed `/storage/content`
 * route, which checks the signature itself). Not suitable for a
 * multi-instance production deployment (each instance would have its own
 * disk); swap in an S3/GCS-backed StorageProvider for that, which is the
 * entire point of the interface.
 */
export class LocalDiskStorageProvider implements StorageProvider {
  constructor(private readonly root: string) {}

  private resolvePath(key: string): string {
    // Reject any key that could escape the storage root (defense in depth —
    // callers always generate keys themselves, never from user input).
    const resolved = path.resolve(this.root, key);
    if (!resolved.startsWith(path.resolve(this.root) + path.sep)) {
      throw new Error(`Refusing to resolve storage key outside root: ${key}`);
    }
    return resolved;
  }

  async upload(input: UploadInput): Promise<void> {
    const filePath = this.resolvePath(input.key);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, input.buffer, { mode: 0o600 });
  }

  async download(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolvePath(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new StorageObjectNotFoundError(key);
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolvePath(key), { force: true });
  }

  async createTemporaryAccessUrl(
    key: string,
    expiresInSeconds: number,
    options?: TemporaryAccessUrlOptions,
  ): Promise<string> {
    return buildSignedPath(key, expiresInSeconds, options);
  }
}

let provider: StorageProvider | undefined;

export function getStorageProvider(): StorageProvider {
  if (!provider) {
    provider = new LocalDiskStorageProvider(path.resolve(env.STORAGE_LOCAL_ROOT));
  }
  return provider;
}

export type { StorageProvider } from './storage-provider';
export { StorageObjectNotFoundError } from './storage-provider';
