/**
 * Sending an action again safely. One key per user intent (this tap of "Request ride"), sent as `Idempotency-Key`; if
 * the network drops before an answer arrives the SAME key is sent again, and the server answers with the first result
 * instead of doing it twice (see the API's middleware/idempotency.ts). Only failures where we do not know whether the
 * server acted are retried: no connection, or "the first attempt is still being processed". Anything the server
 * actually answered is returned as it is.
 */
/** The header the API reads (middleware/idempotency.ts). */
export const IDEMPOTENCY_HEADER_NAME = 'Idempotency-Key';
export const IDEMPOTENCY_RETRY_DELAYS_MS = [800, 2000, 5000] as const;

let counter = 0;
/** A key that is unique per device and per intent. (Not a secret: its only job is to not repeat.) */
export function newIdempotencyKey(
  now: () => number = Date.now,
  random: () => number = Math.random,
): string {
  counter += 1;
  const part = () => Math.floor(random() * 0xffffffff).toString(36);
  return `${now().toString(36)}-${counter.toString(36)}-${part()}${part()}`;
}

export interface RetryableError {
  status: number;
  code: string;
}

/** True when it is safe and useful to send the same request again with the same key. */
export function shouldRetryIdempotent(err: RetryableError): boolean {
  return err.code === 'NETWORK_ERROR' || err.code === 'IDEMPOTENCY_IN_PROGRESS';
}

export async function withIdempotentRetry<T>(
  send: (key: string) => Promise<T>,
  opts: {
    key?: string;
    delaysMs?: readonly number[];
    wait?: (ms: number) => Promise<void>;
    isRetryable?: (err: unknown) => boolean;
  } = {},
): Promise<T> {
  const key = opts.key ?? newIdempotencyKey();
  const delays = opts.delaysMs ?? IDEMPOTENCY_RETRY_DELAYS_MS;
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retryable =
    opts.isRetryable ??
    ((e: unknown) =>
      typeof e === 'object' &&
      e !== null &&
      'code' in e &&
      shouldRetryIdempotent(e as RetryableError));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send(key);
    } catch (err) {
      const delay = delays[attempt];
      if (delay === undefined || !retryable(err)) throw err;
      await wait(delay);
    }
  }
}
