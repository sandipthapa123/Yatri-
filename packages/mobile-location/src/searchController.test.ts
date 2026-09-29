import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SearchController, type SearchState } from './searchController';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(fetcher: (q: string, s: AbortSignal) => Promise<string[]>) {
  const states: SearchState<string>[] = [];
  const c = new SearchController<string>({
    fetcher,
    onState: (s) => states.push(s),
    debounceMs: 300,
  });
  return { c, states, last: () => states[states.length - 1] };
}

describe('SearchController', () => {
  it('does not call the API for every keystroke (debounce)', async () => {
    const fetcher = vi.fn(async (q: string) => [q]);
    const { c, last } = setup(fetcher);
    for (const q of ['th', 'tha', 'tham', 'thame', 'thamel']) {
      c.setQuery(q);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(fetcher).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('thamel');
    expect(last()).toEqual({ status: 'success', query: 'thamel', results: ['thamel'] });
  });

  it('ignores empty / too-short input and never calls the API', async () => {
    const fetcher = vi.fn(async () => []);
    const { c, last } = setup(fetcher);
    c.setQuery('');
    expect(last()).toEqual({ status: 'idle' });
    c.setQuery(' a ');
    expect(last()).toEqual({ status: 'too-short', minChars: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('cancels the in-flight request and drops its stale response', async () => {
    const signals: AbortSignal[] = [];
    const resolvers: Array<(v: string[]) => void> = [];
    const fetcher = vi.fn(
      (q: string, s: AbortSignal) =>
        new Promise<string[]>((res) => {
          signals.push(s);
          resolvers.push(() => res([q]));
        }),
    );
    const { c, last } = setup(fetcher);
    c.setQuery('pokhara');
    await vi.advanceTimersByTimeAsync(300);
    c.setQuery('patan');
    expect(signals[0]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    resolvers[0]?.([]); // late answer for the old query
    resolvers[1]?.([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toEqual({ status: 'success', query: 'patan', results: ['patan'] });
  });

  it('caches results per normalised query', async () => {
    const fetcher = vi.fn(async (q: string) => [q]);
    const { c, last } = setup(fetcher);
    c.setQuery('Thamel');
    await vi.advanceTimersByTimeAsync(300);
    c.setQuery('  thamel ');
    expect(last()).toMatchObject({ status: 'success' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('surfaces errors but not cancellations, and can retry', async () => {
    let fail = true;
    const fetcher = vi.fn(async (q: string) => {
      if (fail) throw new Error('network');
      return [q];
    });
    const { c, last } = setup(fetcher);
    c.setQuery('thamel');
    await vi.advanceTimersByTimeAsync(300);
    expect(last()).toMatchObject({ status: 'error' });
    fail = false;
    c.searchNow('thamel');
    await vi.advanceTimersByTimeAsync(0);
    expect(last()).toMatchObject({ status: 'success', results: ['thamel'] });
  });

  it('dispose cancels pending work (no updates after unmount)', async () => {
    const fetcher = vi.fn(async (q: string) => [q]);
    const { c, states } = setup(fetcher);
    c.setQuery('thamel');
    const before = states.length;
    c.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).not.toHaveBeenCalled();
    expect(states.length).toBe(before);
  });

  it('handles Nepali text (counts characters, not bytes)', async () => {
    const fetcher = vi.fn(async (q: string) => [q]);
    const { c } = setup(fetcher);
    c.setQuery('थमेल');
    await vi.advanceTimersByTimeAsync(300);
    expect(fetcher).toHaveBeenCalledWith('थमेल', expect.anything());
  });
});
