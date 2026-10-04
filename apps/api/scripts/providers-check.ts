/**
 * Live check of the service providers an environment is configured with: `pnpm --filter @yatri/api providers:check`.
 *
 * Run it against STAGING with the real test credentials before relying on a vendor. It does what Yatri would do (look up a place,
 * plan a route, store and fetch a private file, ask the payment provider about a payment) and prints one line per step with
 * the vendor's name, whether it worked, how long it took and, on failure, the KIND of failure. It never prints a key, an
 * address of the vendor, a token or a message from the vendor.
 *
 * Steps that would send something to a person or open a real payment only run when asked for explicitly:
 *   --sms-to=+9779812345678     send one text to that number (use your own)
 *   --email-to=you@example.org  send one email to that address (use your own)
 *   --initiate-payment          open one NPR 10 test payment and ask the provider about it (use the provider's TEST key)
 *   --sentry-event              send one test error to error reporting
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { environmentProfileOf, providerProblems } from '@yatri/types';

import { env } from '../src/config/env';
import { sendEmail } from '../src/lib/email';
import { getErrorReporter } from '../src/lib/monitoring';
import { scrubbedEvent } from '../src/lib/monitoring/reporter';
import { getStorageProvider } from '../src/lib/storage';
import { getSmsProvider } from '../src/modules/auth/sms';
import { getLocationProvider, getRouteProvider } from '../src/modules/location/providers';
import { getPaymentGateway } from '../src/modules/payments/gateway';
import { ProviderError } from '../src/modules/providers/errors';
import { checkerFor, selectedProviders } from '../src/modules/providers/health';

interface Line {
  need: string;
  vendor: string;
  step: string;
  ok: boolean;
  ms: number;
  note: string;
}
const lines: Line[] = [];
const arg = (name: string) =>
  process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const argValue = (name: string) => arg(name)?.split('=')[1];

async function step(
  need: string,
  vendor: string,
  name: string,
  run: () => Promise<string | void>,
): Promise<void> {
  const started = performance.now();
  try {
    const note = (await run()) ?? '';
    lines.push({
      need,
      vendor,
      step: name,
      ok: true,
      ms: Math.round(performance.now() - started),
      note,
    });
  } catch (err) {
    // Only a kind or one of this script's own codes is ever printed: never the vendor's words, an address or a key.
    const own = err instanceof Error && /^[A-Z][A-Za-z]+$/.test(err.message) ? err.message : null;
    const kind =
      err instanceof ProviderError
        ? err.kind
        : (own ?? (err instanceof Error ? err.name : 'ERROR'));
    lines.push({
      need,
      vendor,
      step: name,
      ok: false,
      ms: Math.round(performance.now() - started),
      note: `failed (${kind})`,
    });
  }
}
const skipped = (need: string, vendor: string, name: string, why: string) =>
  lines.push({ need, vendor, step: name, ok: true, ms: 0, note: `skipped: ${why}` });

const THAMEL = { latitude: 27.7154, longitude: 85.3123 };
const PATAN = { latitude: 27.6727, longitude: 85.325 };

async function main() {
  const sel = selectedProviders();
  const profile = environmentProfileOf(env.NODE_ENV);
  console.log(`Environment: ${profile.toLowerCase()} (NODE_ENV=${env.NODE_ENV})`);
  const problems = providerProblems(profile, sel, (k) => {
    const v = (env as Record<string, unknown>)[k];
    return typeof v === 'string' ? v.length > 0 : v !== undefined && v !== null;
  });
  console.log(
    problems.length === 0
      ? 'Configuration: no problems.'
      : `Configuration problems:\n  - ${problems.join('\n  - ')}`,
  );

  // 1. Every provider's own live check (a call that sends nothing and costs nothing).
  for (const capability of [
    'OTP',
    'PUSH',
    'PAYMENTS',
    'STORAGE',
    'CALLS',
    'EMAIL',
    'MONITORING',
    'REALTIME',
  ] as const) {
    const check = checkerFor(capability);
    const vendor =
      capability === 'OTP'
        ? sel.OTP
        : capability === 'PUSH'
          ? sel.PUSH
          : capability === 'PAYMENTS'
            ? sel.PAYMENTS
            : capability === 'STORAGE'
              ? sel.STORAGE
              : capability === 'CALLS'
                ? sel.CALLS
                : capability === 'EMAIL'
                  ? sel.EMAIL
                  : capability === 'MONITORING'
                    ? sel.MONITORING
                    : sel.REALTIME;
    if (!check)
      skipped(
        capability,
        vendor,
        'live check',
        'this vendor has no check that is free and sends nothing',
      );
    else await step(capability, vendor, 'live check', async () => void (await check()));
  }

  // 2. Maps: what a rider would do.
  const geocoder = getLocationProvider();
  if (!geocoder) skipped('MAPS', sel.MAPS_GEOCODING, 'search', 'search is switched off');
  else {
    await step('MAPS', sel.MAPS_GEOCODING, 'find a place', async () => {
      const p = await geocoder.geocode('Thamel, Kathmandu');
      if (!p) throw new Error('NoResult');
      const near =
        Math.abs(p.latitude - THAMEL.latitude) < 0.1 &&
        Math.abs(p.longitude - THAMEL.longitude) < 0.1;
      return near
        ? 'found Thamel'
        : 'found a place, but not near Thamel (check the country filter)';
    });
    await step('MAPS', sel.MAPS_GEOCODING, 'name a spot', async () => {
      const r = await geocoder.reverseGeocode(THAMEL);
      return r ? 'named the spot' : 'nothing known there';
    });
  }
  await step('MAPS', sel.MAPS_ROUTING, 'plan a route with steps', async () => {
    const r = await getRouteProvider().calculateRoute(THAMEL, PATAN, {
      steps: true,
      geometry: true,
    });
    if (r.method !== 'route') return 'straight-line estimate only (no road routing configured)';
    const km = r.distanceMeters / 1000;
    if (km < 1 || km > 20) throw new Error('ImplausibleRoute');
    return `${km.toFixed(1)} km, ${Math.round((r.durationSeconds ?? 0) / 60)} min, ${r.steps?.length ?? 0} steps, live traffic ${r.trafficAware ? 'yes' : 'no'}`;
  });

  // 3. Storage: a private file round trip.
  await step('STORAGE', sel.STORAGE, 'store, link, fetch and delete a private file', async () => {
    const storage = getStorageProvider();
    const key = `providers-check/${randomUUID()}.txt`;
    const body = Buffer.from(`yatri provider check ${new Date().toISOString()}`);
    await storage.upload({ key, buffer: body, contentType: 'text/plain' });
    try {
      const back = await storage.download(key);
      if (!back.equals(body)) throw new Error('ContentMismatch');
      const url = await storage.createTemporaryAccessUrl(key, 60);
      // A link into the store itself (S3) is fetched here. A local link is served by the running API, so it is only made.
      if (!url.startsWith('http'))
        return 'stored and linked (a local link is served by the running API, so it was not fetched); the file was removed';
      const res = await fetch(url);
      const fetched = Buffer.from(await res.arrayBuffer());
      if (!res.ok || !fetched.equals(body)) throw new Error('LinkDidNotServeTheFile');
    } finally {
      await storage.delete(key);
    }
    return 'round trip worked; the file was removed';
  });

  // 4. Things that reach a person or open a payment, only when asked.
  const smsTo = argValue('sms-to');
  if (!smsTo) skipped('OTP', sel.OTP, 'send one text', 'pass --sms-to=<your number>');
  else
    await step('OTP', sel.OTP, 'send one text', async () => {
      await getSmsProvider().send({
        toPhoneNumber: smsTo,
        body: 'Yatri provider check: this text confirms sign-in codes can be sent.',
      });
      return 'sent';
    });

  const emailTo = argValue('email-to');
  if (!emailTo) skipped('EMAIL', sel.EMAIL, 'send one email', 'pass --email-to=<your address>');
  else
    await step('EMAIL', sel.EMAIL, 'send one email', async () => {
      await sendEmail({
        to: emailTo,
        subject: 'Yatri provider check',
        text: 'This email confirms Yatri can send email.',
      });
      return 'sent';
    });

  const gateway = getPaymentGateway();
  if (!arg('initiate-payment'))
    skipped(
      'PAYMENTS',
      sel.PAYMENTS,
      'open a test payment',
      "pass --initiate-payment (use the provider's TEST key)",
    );
  else if (!gateway)
    skipped('PAYMENTS', sel.PAYMENTS, 'open a test payment', 'online payment is switched off');
  else {
    await step('PAYMENTS', sel.PAYMENTS, 'open a payment and ask about it', async () => {
      const opened = await gateway.initiate({
        attemptId: randomUUID(),
        tripId: randomUUID(),
        amountNpr: 10,
        description: 'Yatri provider check',
      });
      const looked = await gateway.lookup(opened.providerRef);
      if (looked.state === 'COMPLETED') throw new Error('UnexpectedlyCompleted');
      return `opened (${new URL(opened.paymentUrl).hostname}), provider says: ${looked.state.toLowerCase()}; refund through the API: ${gateway.supportsRefund ? 'yes' : "no (staff refund in the provider's dashboard)"}`;
    });
  }

  if (!arg('sentry-event'))
    skipped('MONITORING', sel.MONITORING, 'send one test error', 'pass --sentry-event');
  else
    await step('MONITORING', sel.MONITORING, 'send one test error', async () => {
      await getErrorReporter().capture(
        scrubbedEvent(new Error('Yatri provider check (not a real error)'), {
          where: 'script:providers-check',
        }),
      );
      return 'sent; look for it in the error reporting project';
    });

  // The report.
  const width = (f: (l: Line) => string) => Math.max(...lines.map((l) => f(l).length));
  const wn = width((l) => l.need);
  const wv = width((l) => l.vendor);
  const ws = width((l) => l.step);
  console.log('');
  for (const l of lines)
    console.log(
      `${l.ok ? 'OK  ' : 'FAIL'}  ${l.need.padEnd(wn)}  ${l.vendor.padEnd(wv)}  ${l.step.padEnd(ws)}  ${String(l.ms).padStart(5)} ms  ${l.note}`,
    );
  const failed = lines.filter((l) => !l.ok).length;
  console.log(
    `\n${failed === 0 ? 'Every step that ran worked.' : `${failed} step${failed === 1 ? '' : 's'} failed.`} Nothing above contains a key, a token or the vendor's own words.`,
  );
  process.exit(failed === 0 && problems.length === 0 ? 0 : 1);
}

main().catch(() => {
  console.error('The check itself could not run. Check DATABASE_URL and the provider settings.');
  process.exit(2);
});
