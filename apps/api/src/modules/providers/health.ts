import { isoOrNull } from '../../lib/dates';
import {
  PROVIDER_CAPABILITIES,
  PROVIDER_CAPABILITY_LABELS,
  PROVIDER_HEALTH_LABELS,
  PROVIDER_REQUIRED_ENV,
  SIMULATED_PROVIDERS,
  environmentProfileOf,
  healthFromCalls,
  providerProblems,
  type ProviderCapability,
  type ProviderErrorKind,
  type ProviderHealthState,
  type ProviderSelection,
  type ProviderStatusInfo,
  type ProvidersOverview,
} from '@yatri/types';

import { env } from '../../config/env';
import { getRedisClient } from '../../config/redis';
import { query } from '../../lib/db';
import { getEmailProvider } from '../../lib/email';
import { getErrorReporter } from '../../lib/monitoring';
import { getProvider as getPushProvider } from '../../lib/notifications';
import { getStorageProvider } from '../../lib/storage';
import { getSmsProvider } from '../auth/sms';
import { activeCallProvider } from '../calls/call-provider';
import { getPaymentGateway } from '../payments/gateway';
import { ProviderError } from './errors';
import { usageToday } from './usage';

/**
 * Which vendor fills each need (from configuration: the one place a selection is read), how to prove it works, and what an
 * administrator may see about it. A check is a call that sends nothing and costs nothing; a vendor without one is shown as
 * "set up, but there is no live check", never as working. What is stored and shown is the vendor's name, a state, a time, a
 * latency and the KIND of the last failure: no key, address, account, message or vendor error text.
 */
export function selectedProviders(): ProviderSelection {
  return {
    OTP: env.SMS_PROVIDER,
    PUSH: env.PUSH_PROVIDER,
    MAPS_GEOCODING: env.LOCATION_PROVIDER,
    MAPS_ROUTING: env.LOCATION_ROUTING_PROVIDER,
    PAYMENTS: env.PAYMENT_PROVIDER,
    STORAGE: env.STORAGE_PROVIDER,
    CALLS: env.CALL_PROVIDER,
    REALTIME: env.REALTIME_PROVIDER,
    EMAIL: env.EMAIL_PROVIDER,
    MONITORING: env.MONITORING_PROVIDER,
  };
}

/** The capability a selection key belongs to (maps has two keys and one entry on the screen). */
const CAPABILITY_OF: Record<keyof ProviderSelection, ProviderCapability> = {
  OTP: 'OTP',
  PUSH: 'PUSH',
  MAPS_GEOCODING: 'MAPS',
  MAPS_ROUTING: 'MAPS',
  PAYMENTS: 'PAYMENTS',
  STORAGE: 'STORAGE',
  CALLS: 'CALLS',
  REALTIME: 'REALTIME',
  EMAIL: 'EMAIL',
  MONITORING: 'MONITORING',
};

const isConfigured = (key: string): boolean => {
  const v = (env as Record<string, unknown>)[key];
  return typeof v === 'string' ? v.length > 0 : v !== undefined && v !== null;
};

/** The vendors the platform actually uses for a need, by name (maps can be two: search and routes). */
function vendorsFor(capability: ProviderCapability): string[] {
  const sel = selectedProviders();
  const keys = (Object.keys(CAPABILITY_OF) as Array<keyof ProviderSelection>).filter((k) => CAPABILITY_OF[k] === capability);
  return [...new Set(keys.map((k) => sel[k]))];
}

/** A function that proves the active vendor for a need works, or null when the vendor has none. */
export function checkerFor(capability: ProviderCapability): (() => Promise<void>) | null {
  switch (capability) {
    case 'OTP': {
      const p = getSmsProvider();
      return p.check ? () => p.check!() : null;
    }
    case 'PUSH': {
      const p = getPushProvider();
      return p.check ? () => p.check!() : null;
    }
    case 'PAYMENTS': {
      const g = getPaymentGateway();
      return g?.check ? () => g.check!() : null;
    }
    case 'STORAGE': {
      const p = getStorageProvider() as { check?: () => Promise<void> };
      return p.check ? () => p.check!() : null;
    }
    case 'CALLS': {
      const p = activeCallProvider();
      return p.check ? () => p.check!() : null;
    }
    case 'EMAIL': {
      const p = getEmailProvider();
      return p.check ? () => p.check!() : null;
    }
    case 'MONITORING': {
      const r = getErrorReporter();
      return r.check ? () => r.check!() : null;
    }
    case 'REALTIME':
      return async () => {
        const answer = await getRedisClient().ping();
        if (answer !== 'PONG') throw new ProviderError('REALTIME', 'redis', 'BAD_RESPONSE');
      };
    case 'MAPS':
      return null; // live use is the evidence: every map call is counted (usage), and a failing vendor shows there
  }
}

function isSimulated(capability: ProviderCapability): boolean {
  const sel = selectedProviders();
  return (Object.keys(CAPABILITY_OF) as Array<keyof ProviderSelection>).some(
    (k) => CAPABILITY_OF[k] === capability && SIMULATED_PROVIDERS[k]?.includes(sel[k]),
  );
}

const kindOf = (err: unknown): ProviderErrorKind => (err instanceof ProviderError ? err.kind : 'UNAVAILABLE');

/** The `provider-health` job: run every check that exists and keep the answer. Never throws for a vendor that is down. */
export async function runProviderChecks(): Promise<{ checked: number; failing: number }> {
  let checked = 0;
  let failing = 0;
  for (const capability of PROVIDER_CAPABILITIES) {
    const check = checkerFor(capability);
    const vendor = vendorsFor(capability)[0];
    if (!check || !vendor) continue;
    if (isSimulated(capability)) continue; // a stand-in has nothing to check
    const started = Date.now();
    let ok = true;
    let kind: ProviderErrorKind | null = null;
    try {
      await check();
    } catch (err) {
      ok = false;
      kind = kindOf(err);
      failing += 1;
    }
    checked += 1;
    await query(
      `INSERT INTO provider_health (capability, provider, ok, latency_ms, failure_kind, checked_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (capability, provider)
       DO UPDATE SET ok = EXCLUDED.ok, latency_ms = EXCLUDED.latency_ms, failure_kind = EXCLUDED.failure_kind, checked_at = now()`,
      [capability, vendor, ok, Date.now() - started, kind],
    );
  }
  return { checked, failing };
}

interface HealthRow {
  capability: string;
  provider: string;
  ok: boolean;
  latency_ms: number | null;
  failure_kind: ProviderErrorKind | null;
  checked_at: Date;
}

/** How long a live check is believed. After this a vendor with only an old check is "unverified" again. */
export const HEALTH_CHECK_FRESH_MS = 20 * 60 * 1000;

/** Pure: the state to show, from what is known. (Exported and tested.) */
export function stateOf(input: {
  simulated: boolean;
  missingEnv: boolean;
  check: { ok: boolean; ageMs: number } | null;
  calls: number;
  failures: number;
  hasCheck: boolean;
}): ProviderHealthState {
  if (input.simulated) return 'SIMULATED';
  if (input.missingEnv) return 'NOT_CONFIGURED';
  const fresh = input.check && input.check.ageMs <= HEALTH_CHECK_FRESH_MS ? input.check : null;
  if (fresh && !fresh.ok) return 'DOWN';
  const fromCalls = healthFromCalls(input.calls, input.failures);
  if (fromCalls === 'DOWN' || fromCalls === 'DEGRADED') return fromCalls;
  if (fresh?.ok) return 'UP';
  return fromCalls ?? 'UNVERIFIED';
}

/** What an administrator sees: status only. */
export async function providersOverview(): Promise<ProvidersOverview> {
  const profile = environmentProfileOf(env.NODE_ENV);
  const usage = await usageToday().catch(() => new Map());
  const health = await query<HealthRow>('SELECT capability, provider, ok, latency_ms, failure_kind, checked_at FROM provider_health').catch(
    () => ({ rows: [] as HealthRow[] }),
  );
  const sel = selectedProviders();
  const items: ProviderStatusInfo[] = PROVIDER_CAPABILITIES.map((capability) => {
    const vendors = vendorsFor(capability);
    const vendor = vendors.join(' + ');
    const keys = (Object.keys(CAPABILITY_OF) as Array<keyof ProviderSelection>).filter((k) => CAPABILITY_OF[k] === capability);
    const simulated = isSimulated(capability);
    const missingEnv = keys.some((k) => (PROVIDER_REQUIRED_ENV[`${k}:${sel[k]}`] ?? []).some((e) => !isConfigured(e)));
    let calls = 0;
    let failures = 0;
    let lastFailureKind: ProviderErrorKind | null = null;
    for (const v of vendors) {
      const u = usage.get(`${capability}:${v}`);
      if (u) {
        calls += u.calls;
        failures += u.failures;
        lastFailureKind = (u.lastFailureKind as ProviderErrorKind | null) ?? lastFailureKind;
      }
    }
    const row = health.rows.find((h) => h.capability === capability && vendors.includes(h.provider));
    const state = stateOf({
      simulated,
      missingEnv,
      check: row ? { ok: row.ok, ageMs: Date.now() - row.checked_at.getTime() } : null,
      calls,
      failures,
      hasCheck: checkerFor(capability) !== null,
    });
    return {
      capability,
      label: PROVIDER_CAPABILITY_LABELS[capability].label,
      help: PROVIDER_CAPABILITY_LABELS[capability].help,
      provider: vendor,
      state,
      // A vendor that HAS a live check but has not been checked yet is not the same as one that has none.
      stateText: state === 'UNVERIFIED' && checkerFor(capability) !== null ? 'Set up, not checked yet (the provider check runs every 10 minutes)' : PROVIDER_HEALTH_LABELS[state],
      checkedAt: isoOrNull(row?.checked_at),
      latencyMs: row?.latency_ms ?? null,
      callsToday: calls,
      failuresToday: failures,
      lastFailureKind: row && !row.ok ? row.failure_kind : lastFailureKind,
      simulated,
    };
  });
  return { environment: profile, problems: providerProblems(profile, sel, isConfigured), items };
}

