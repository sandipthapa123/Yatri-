export interface UploadInput {
  /** Opaque key within the provider's namespace, e.g. "documents/2026/uuid.pdf". */
  key: string;
  buffer: Buffer;
  contentType: string;
}

/**
 * Everything above this interface (document upload/review) only ever talks
 * to a StorageProvider — swapping local disk for S3/GCS later means
 * writing one new class here, not touching upload/document logic. Every
 * document's bytes live only behind this interface; nothing else in the
 * codebase reads or writes document content directly.
 */
export interface TemporaryAccessUrlOptions {
  /** Response Content-Type to serve the object with, if the caller knows it. */
  contentType?: string;
  /** Filename to suggest via Content-Disposition, if the caller knows it. */
  filename?: string;
}

export interface StorageProvider {
  upload(input: UploadInput): Promise<void>;
  download(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** A time-limited URL that grants access to `key` without any other credential. */
  createTemporaryAccessUrl(
    key: string,
    expiresInSeconds: number,
    options?: TemporaryAccessUrlOptions,
  ): Promise<string>;
}

export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Storage object not found: ${key}`);
    this.name = 'StorageObjectNotFoundError';
  }
}
