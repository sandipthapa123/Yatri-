import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError, NETWORK_ERROR_MESSAGE, REQUEST_TIMEOUT_MS, TIMEOUT_ERROR_MESSAGE, request } from './apiClient';
import { connectivity } from './connectivity';
import { serverClock } from './serverClock';

afterEach(() => vi.unstubAllGlobals());

const ok = (data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('request', () => {
  it('turns a dropped connection into a plain, spoken-friendly error and records it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network request failed')));
    const before = connectivity.getState().failures;
    const err = await request('/x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: NETWORK_ERROR_MESSAGE });
    expect(connectivity.getState().failures).toBe(before + 1);
  });

  it('ends a request that gets no answer, in plain words, and still lets the caller cancel', async () => {
    vi.useFakeTimers();
    try {
      // a connection that never answers, but honours the abort signal like a real fetch
      vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))))));
      const pending = request('/slow').catch((e) => e);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 10);
      const err = await pending;
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status: 0, code: 'NETWORK_ERROR', message: TIMEOUT_ERROR_MESSAGE });
      // the caller's own cancel is not reported as a timeout or a network problem
      const controller = new AbortController();
      const cancelled = request('/slow', { signal: controller.signal }).catch((e) => e);
      controller.abort();
      await expect(cancelled).resolves.toMatchObject({ name: 'AbortError' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call a cancelled request a network problem', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')));
    const before = connectivity.getState().failures;
    await expect(request('/x', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(connectivity.getState().failures).toBe(before);
  });

  it('sends one key and repeats it when the connection drops mid-action', async () => {
    vi.useFakeTimers();
    const keys: (string | null)[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      keys.push(new Headers(init.headers).get('Idempotency-Key'));
      if (keys.length === 1) throw new TypeError('Network request failed');
      return ok({ id: 'trip-1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const pending = request<{ id: string }>('/trips/request', {
      method: 'POST',
      body: {},
      idempotent: true,
    });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ id: 'trip-1' });
    vi.useRealTimers();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('sends no key for an ordinary request', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get('Idempotency-Key')).toBeNull();
      return ok(1);
    });
    vi.stubGlobal('fetch', fetchMock);
    await request('/y');
  });

  it('learns the server clock from the answer', async () => {
    const serverNow = Date.now() + 120_000;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(ok(1, { date: new Date(serverNow).toUTCString() })),
    );
    await request('/z');
    expect(serverClock.known).toBe(true);
    expect(Math.abs(serverClock.offset - 120_000)).toBeLessThan(3000); // the Date header has 1 s resolution
  });
});
