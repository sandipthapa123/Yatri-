import {
  PROVIDER_ERROR_RETRYABLE,
  PROVIDER_PUBLIC_MESSAGES,
  type ProviderCapability,
  type ProviderErrorKind,
} from '@yatri/types';

/**
 * THE failure of a provider, named the same way whatever vendor produced it. `message` carries the need, the vendor's name
 * and the kind, and nothing the vendor said; `publicMessage` is the fixed sentence a person may be shown. Business code
 * decides by `kind` and `retryable`, never by a vendor's status code or text.
 */
export class ProviderError extends Error {
  constructor(
    readonly capability: ProviderCapability,
    readonly provider: string,
    readonly kind: ProviderErrorKind,
    /** The vendor's HTTP status, for the adapter that must tell "not found" from "bad request". Never logged or shown. */
    readonly status?: number,
  ) {
    super(`${capability}/${provider}: ${kind}`);
    this.name = 'ProviderError';
  }
  get retryable(): boolean {
    return PROVIDER_ERROR_RETRYABLE[this.kind];
  }
  get publicMessage(): string {
    return PROVIDER_PUBLIC_MESSAGES[this.capability];
  }
}

/** The kind a HTTP answer from a vendor stands for. */
export function kindOfStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'UNAVAILABLE';
  return 'BAD_REQUEST';
}

/** Whatever was thrown, as a ProviderError. A network failure or a timeout is a kind; a bug is not hidden, it is wrapped as UNAVAILABLE and logged by the caller. */
export function toProviderError(
  capability: ProviderCapability,
  provider: string,
  err: unknown,
): ProviderError {
  if (err instanceof ProviderError) return err;
  const name = err instanceof Error ? err.name : '';
  if (name === 'TimeoutError' || name === 'AbortError')
    return new ProviderError(capability, provider, 'TIMEOUT');
  return new ProviderError(capability, provider, 'UNAVAILABLE');
}
