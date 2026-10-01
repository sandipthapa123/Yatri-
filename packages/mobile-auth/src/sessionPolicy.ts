/**
 * When a failed token refresh or profile fetch means "this session is over" and when it only means "we could not ask".
 * Signing a person out because their train went into a tunnel would drop them out of an active ride, so only an
 * answer from the server that rejects the credentials ends the session; no connection and server trouble do not.
 */
export function shouldEndSession(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || !('status' in err)) return false;
  const status = (err as { status: unknown }).status;
  return status === 401 || status === 403;
}
