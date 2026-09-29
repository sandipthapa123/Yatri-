export interface DetectedFileType {
  mimeType: 'image/jpeg' | 'image/png' | 'application/pdf';
  extension: 'jpg' | 'png' | 'pdf';
}

/**
 * Detects a file's real type from its magic bytes. The client-supplied
 * `Content-Type`/filename extension are never trusted for anything
 * security-relevant (storage, validation, or the response headers used to
 * serve it back) — only what the bytes actually are.
 */
export function detectFileType(buffer: Buffer): DetectedFileType | null {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { mimeType: 'application/pdf', extension: 'pdf' };
  }
  return null;
}
