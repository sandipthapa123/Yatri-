import { ProviderError } from '../../providers/errors';
import { providerRequest } from '../../providers/http';
import { LocationProviderError, type ProviderFailureKind } from './location-provider';

/**
 * One place that turns "HTTP call to a map vendor" into either parsed JSON or a classified LocationProviderError. Every
 * adapter uses it, and it goes through the platform's single vendor-call function (providers/http.ts), so the deadline,
 * the retry of a read that failed in passing, the circuit breaker and the usage counters are the same for maps as for every
 * other vendor, and no upstream text or URL (which can contain an API key) ever escapes.
 */
const KIND: Record<ProviderError['kind'], ProviderFailureKind> = {
  TIMEOUT: 'TIMEOUT',
  UNAVAILABLE: 'UNAVAILABLE',
  CIRCUIT_OPEN: 'UNAVAILABLE',
  NOT_CONFIGURED: 'UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH: 'QUOTA',
  BAD_REQUEST: 'UNAVAILABLE',
  BAD_RESPONSE: 'BAD_RESPONSE',
};

export async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<T> {
  try {
    const res = await providerRequest<T>({
      capability: 'MAPS',
      provider: label,
      operation: 'request',
      url,
      init,
      timeoutMs,
      idempotent: true, // every map call is a read
      retries: 1,
      expect: 'json',
      fetchImpl,
    });
    return res.data;
  } catch (err) {
    if (err instanceof ProviderError) throw new LocationProviderError(KIND[err.kind], `${label} ${err.kind}`);
    throw new LocationProviderError('UNAVAILABLE', `${label} request failed`);
  }
}
