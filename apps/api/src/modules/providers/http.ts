import type { ProviderCapability } from '@yatri/types';

import { log } from '../../lib/logger';
import { ProviderError, kindOfStatus, toProviderError } from './errors';
import { breakerAllows, breakerRecord } from './breaker';
import { recordUsage } from './usage';

/**
 * THE way Yatri calls a vendor over HTTP. Every adapter (texts, push, maps, payments, storage, calls, email, error
 * reporting) goes through here, so timeouts, retries, the breaker, error naming and usage logging are written once:
 *  - a call has a deadline (`timeoutMs`); a vendor that does not answer is a TIMEOUT, not a hung request;
 *  - failures become ProviderError kinds (see errors.ts); nothing the vendor said travels on;
 *  - a call that is safe to repeat (`idempotent`: a read, a delete, an upload to a named key) is retried a couple of times
 *    with a growing, jittered pause when the failure may pass by itself; a call that is not (sending a text, creating a
 *    payment) is never repeated here, so a retry cannot send or charge twice;
 *  - after repeated failures the vendor is skipped for a short while (the breaker) instead of piling on;
 *  - what is recorded about a call is the need, the vendor, the outcome and how long it took: no address, key, body or person.
 */
export interface ProviderRequest {
  capability: ProviderCapability;
  provider: string;
  /** A short label for the log and the counters ("send", "geocode"); never a value from a person. */
  operation: string;
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  idempotent?: boolean;
  retries?: number;
  /** What to read from a good answer. */
  expect?: 'json' | 'text' | 'none' | 'buffer';
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ProviderResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

const BASE_DELAY_MS = 200;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function providerRequest<T = unknown>(r: ProviderRequest): Promise<ProviderResponse<T>> {
  const fetchImpl = r.fetchImpl ?? fetch;
  const sleep = r.sleep ?? wait;
  const maxRetries = r.idempotent ? (r.retries ?? 2) : 0;
  let attempt = 0;
  for (;;) {
    if (!breakerAllows(r.capability, r.provider)) {
      await recordUsage(r.capability, r.provider, 'CIRCUIT_OPEN', 0);
      throw new ProviderError(r.capability, r.provider, 'CIRCUIT_OPEN');
    }
    const started = Date.now();
    try {
      const out = await once<T>(r, fetchImpl);
      breakerRecord(r.capability, r.provider, true);
      await recordUsage(r.capability, r.provider, 'OK', Date.now() - started);
      return out;
    } catch (err) {
      const e = toProviderError(r.capability, r.provider, err);
      if (!(err instanceof ProviderError)) log.warn(`Provider call failed (${r.capability}/${r.provider}/${r.operation})`);
      if (e.retryable) breakerRecord(r.capability, r.provider, false);
      await recordUsage(r.capability, r.provider, e.kind, Date.now() - started);
      if (e.retryable && attempt < maxRetries) {
        attempt += 1;
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
        continue;
      }
      throw e;
    }
  }
}

async function once<T>(r: ProviderRequest, fetchImpl: typeof fetch): Promise<ProviderResponse<T>> {
  let res: Response;
  try {
    res = await fetchImpl(r.url, { ...r.init, signal: AbortSignal.timeout(r.timeoutMs) });
  } catch (err) {
    throw toProviderError(r.capability, r.provider, err);
  }
  if (!res.ok) throw new ProviderError(r.capability, r.provider, kindOfStatus(res.status), res.status);
  const expect = r.expect ?? 'json';
  try {
    const data =
      expect === 'json'
        ? await res.json()
        : expect === 'text'
          ? await res.text()
          : expect === 'buffer'
            ? Buffer.from(await res.arrayBuffer())
            : undefined;
    return { status: res.status, data: data as T, headers: res.headers };
  } catch {
    throw new ProviderError(r.capability, r.provider, 'BAD_RESPONSE');
  }
}
