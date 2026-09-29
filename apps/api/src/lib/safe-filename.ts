import { randomUUID } from 'node:crypto';

/** A random, collision-free storage key — never derived from user input. */
export function generateStorageKey(ownerSegment: string, extension: string): string {
  const now = new Date();
  const datePrefix = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return `documents/${datePrefix}/${ownerSegment}/${randomUUID()}.${extension}`;
}

/**
 * The client-supplied original filename is stored only for display (e.g.
 * "driving_license.pdf" in an admin review list) — never used to build a
 * file path. Still worth trimming to something reasonable and stripping
 * path separators/control characters so it can't be used for a header or
 * UI injection trick further down the line.
 */
export function sanitizeDisplayFilename(name: string): string {
  const stripped = name.replace(/[/\\\r\n\t\0]/g, '_').trim();
  return stripped.slice(0, 150) || 'file';
}
