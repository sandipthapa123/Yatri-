import type { ProviderCapability } from '@yatri/types';

import { query } from '../../lib/db';

/**
 * What the platform records about its use of a vendor: a daily counter per need, vendor and outcome (OK, or the kind of
 * failure), and the milliseconds the calls took. No address, key, message, person or place is in it, so it can be shown to
 * an administrator and kept. A failure to write it never fails the call it describes.
 */
export async function recordUsage(
  capability: ProviderCapability,
  provider: string,
  outcome: string,
  ms: number,
): Promise<void> {
  try {
    await query(
      `INSERT INTO provider_usage (day, capability, provider, outcome, calls, total_ms)
       VALUES (current_date, $1, $2, $3, 1, $4)
       ON CONFLICT (day, capability, provider, outcome)
       DO UPDATE SET calls = provider_usage.calls + 1, total_ms = provider_usage.total_ms + EXCLUDED.total_ms`,
      [capability, provider, outcome, Math.max(0, Math.round(ms))],
    );
  } catch {
    /* counters are best effort */
  }
}

export interface UsageToday {
  calls: number;
  failures: number;
  lastFailureKind: string | null;
}

export async function usageToday(): Promise<Map<string, UsageToday>> {
  const r = await query<{ capability: string; provider: string; outcome: string; calls: string }>(
    `SELECT capability, provider, outcome, calls::text FROM provider_usage WHERE day = current_date`,
  );
  const out = new Map<string, UsageToday>();
  for (const row of r.rows) {
    const k = `${row.capability}:${row.provider}`;
    const u = out.get(k) ?? { calls: 0, failures: 0, lastFailureKind: null };
    u.calls += Number(row.calls);
    if (row.outcome !== 'OK') {
      u.failures += Number(row.calls);
      u.lastFailureKind = row.outcome;
    }
    out.set(k, u);
  }
  return out;
}
