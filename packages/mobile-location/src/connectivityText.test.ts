import type { ConnectivityState } from '@yatri/mobile-auth';
import { describe, expect, it } from 'vitest';

import { RECOVERED_NOTICE_MS, connectivityNotice } from './connectivityText';

const state = (over: Partial<ConnectivityState>): ConnectivityState => ({
  status: 'online',
  since: 0,
  lastOkAt: null,
  recoveredAt: null,
  failures: 0,
  ...over,
});

describe('connectivity wording', () => {
  it('says nothing while all is well', () => {
    expect(connectivityNotice(state({ lastOkAt: 1000 }), 5000).kind).toBe('none');
  });

  it('says in words that the screen may be out of date, with its age', () => {
    const n = connectivityNotice(state({ status: 'offline', lastOkAt: 0 }), 120_000);
    expect(n.kind).toBe('offline');
    expect(n.title).toBe('You are offline.');
    expect(n.detail).toContain('may be out of date');
    expect(n.detail).toContain('Last updated 2 minutes ago');
  });

  it('does not invent a last-updated time it does not have, nor claim anything about the ride', () => {
    const n = connectivityNotice(state({ status: 'offline' }), 1000);
    expect(n.detail).not.toContain('Last updated');
    expect(n.detail).not.toMatch(/cancel|lost your ride|ended/i);
  });

  it('says "back online" briefly, then goes quiet', () => {
    const back = state({ recoveredAt: 10_000, lastOkAt: 10_000 });
    expect(connectivityNotice(back, 10_000 + 1000).kind).toBe('recovered');
    expect(connectivityNotice(back, 10_000 + RECOVERED_NOTICE_MS + 1).kind).toBe('none');
  });
});
