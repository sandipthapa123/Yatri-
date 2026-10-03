/**
 * A failed call to the Yatri API, as every client sees it: the HTTP status, the stable error code, the human message from the
 * server, and any details (field errors, a retry delay). The ONE error type the admin site and both apps throw and catch.
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
