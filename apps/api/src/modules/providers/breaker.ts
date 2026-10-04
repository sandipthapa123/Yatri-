import type { ProviderCapability } from '@yatri/types';

/**
 * A small circuit breaker per vendor, in this process. After BREAKER_THRESHOLD failures in a row that may pass by
 * themselves, calls to that vendor are refused for BREAKER_OPEN_MS without being tried (so a vendor that is down is not
 * hammered and requests do not wait for its timeout one after another). After the pause one call is let through; if it
 * succeeds the breaker closes. It is per process on purpose: each server learns from its own calls, and a restart starts
 * fresh. Failures that are the caller's fault (a bad request, wrong credentials) do not count.
 */
export const BREAKER_THRESHOLD = 5;
export const BREAKER_OPEN_MS = 30_000;

interface State {
  failures: number;
  openedAt: number | null;
}
const states = new Map<string, State>();
const key = (c: ProviderCapability, p: string) => `${c}:${p}`;

export function breakerAllows(
  capability: ProviderCapability,
  provider: string,
  now = Date.now(),
): boolean {
  const s = states.get(key(capability, provider));
  if (!s || s.openedAt === null) return true;
  if (now - s.openedAt >= BREAKER_OPEN_MS) {
    // Half open: let one call through; the next failure re-opens it.
    s.openedAt = null;
    s.failures = BREAKER_THRESHOLD - 1;
    return true;
  }
  return false;
}

export function breakerRecord(
  capability: ProviderCapability,
  provider: string,
  ok: boolean,
  now = Date.now(),
): void {
  const k = key(capability, provider);
  const s = states.get(k) ?? { failures: 0, openedAt: null };
  if (ok) {
    s.failures = 0;
    s.openedAt = null;
  } else {
    s.failures += 1;
    if (s.failures >= BREAKER_THRESHOLD) s.openedAt = now;
  }
  states.set(k, s);
}

export function breakerOpen(capability: ProviderCapability, provider: string): boolean {
  return states.get(key(capability, provider))?.openedAt != null;
}

/** For tests. */
export function resetBreakers(): void {
  states.clear();
}
