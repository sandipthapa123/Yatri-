import { LocationProviderError } from './location-provider';

/**
 * One place that turns "HTTP call to a map vendor" into either parsed JSON
 * or a classified LocationProviderError. Every adapter uses it, so timeout,
 * rate-limit, quota and outage handling is identical across vendors and no
 * upstream text or URL (which can contain an API key) ever escapes.
 */
export async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const isTimeout =
      err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new LocationProviderError(
      isTimeout ? 'TIMEOUT' : 'UNAVAILABLE',
      `${label} request failed`,
    );
  }
  if (res.status === 429) throw new LocationProviderError('RATE_LIMITED', `${label} 429`);
  if (res.status === 401 || res.status === 403) {
    throw new LocationProviderError('QUOTA', `${label} ${res.status}`);
  }
  if (!res.ok) throw new LocationProviderError('UNAVAILABLE', `${label} ${res.status}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new LocationProviderError('BAD_RESPONSE', `${label} returned non-JSON`);
  }
}
