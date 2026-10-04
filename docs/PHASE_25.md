# Phase 25: production service providers

One interface per outside need, one vendor-call function, one rule for what each environment may run on. Business logic
never names a vendor; which vendor is used is server configuration.

## What is a "need" and who fills it

| Need             | Interface (the only thing business code sees)     | Vendors                                                    | Stand-ins (development only) |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------- | ---------------------------- |
| Sign-in codes    | `SmsProvider` (`modules/auth/sms`)                | `twilio`, `http` (a local gateway)                         | `console`                    |
| Push             | `NotificationProvider` (`lib/notifications`)      | `expo`                                                     | `console`                    |
| Maps: search     | `LocationProvider` (`modules/location/providers`) | `mapbox`, `nominatim`                                      | `static`, `none`             |
| Maps: routes     | `RouteProvider` (same folder)                     | `mapbox` (live traffic), `osrm`, `graphhopper`, `valhalla` | `haversine`                  |
| Digital payments | `PaymentGateway` (`modules/payments`)             | `khalti`                                                   | `sandbox`, `none`            |
| Files            | `StorageProvider` (`lib/storage`)                 | `s3` (Amazon S3, MinIO, R2, Spaces)                        | `local`                      |
| Calls            | `CallProvider` (`modules/calls`)                  | `twilio` (managed relay)                                   | `webrtc` (our own relay)     |
| Live updates     | the Redis bus (`modules/realtime`)                | `redis`                                                    | none                         |
| Email            | `EmailProvider` (`lib/email`)                     | `resend`                                                   | `console`                    |
| Error reporting  | `ErrorReporter` (`lib/monitoring`)                | `sentry`                                                   | `none`                       |

The vendor lists, the variable that picks each one, what each needs configured, which are stand-ins, and what a person is told
when one fails are all in `packages/types/src/providers.ts`. The API configuration (`config/env.ts`) builds its enums from
that file. Nothing else lists vendors.

## Environments

`NODE_ENV` is the switch: `development` and `test` are DEVELOPMENT, `staging` is STAGING, `production` is PRODUCTION.
`providerProblems(environment, selection, configured)` is the one rule, applied when the API starts (it refuses to start
otherwise) and shown on the admin screen:

- STAGING and PRODUCTION may not run on a stand-in (`SMS_PROVIDER=console`, `STORAGE_PROVIDER=local`, `PAYMENT_PROVIDER=sandbox`, …).
- A chosen vendor must have what it needs (`TWILIO_AUTH_TOKEN`, `S3_SECRET_ACCESS_KEY`, `KHALTI_SECRET_KEY`, …).
- PRODUCTION must report errors (`MONITORING_PROVIDER=sentry`).

`apps/api/.env.example` documents every variable with the recommended value per environment. Secrets come only from the
environment or a secret manager; `SECRET_ENV_KEYS` lists them, and a test checks that `.env.example` holds no vendor credential.

## One way to call a vendor (`modules/providers/http.ts`)

`providerRequest` is the only function that makes an outbound vendor HTTP call (a test fails on a raw `fetch` anywhere
else). It gives every adapter the same behaviour:

- **Timeout**: a call has a deadline; a silent vendor becomes `TIMEOUT`.
- **Error normalisation**: `ProviderError` with a kind (`TIMEOUT`, `UNAVAILABLE`, `RATE_LIMITED`, `AUTH`, `BAD_REQUEST`,
  `BAD_RESPONSE`, `CIRCUIT_OPEN`, `NOT_CONFIGURED`). The vendor's words, status text and address never travel on.
- **Retry**: only for a call that is safe to repeat (a read, a delete, an upload to a named key), a couple of times with a
  growing, jittered pause, and only for a kind that may pass. Sending a text, creating a payment or sending an email is never
  retried by this layer.
- **Circuit breaker**: after five failures in a row a vendor is skipped for 30 seconds instead of being hammered.
- **Usage logging** (`provider_usage`): a daily counter per need, vendor and outcome plus milliseconds. No address, key,
  message, person or place.
- **Fallback**: `SMS_FALLBACK_PROVIDER` puts a second vendor behind sign-in codes. It is used only for a failure that may
  pass (never for wrong credentials, which a fallback would hide).

An unexpected vendor failure that reaches a request is answered `503 SERVICE_UNAVAILABLE` with a fixed sentence per need
(`PROVIDER_PUBLIC_MESSAGES`), never the vendor's text.

## Digital payments

- The ride's payment record and the amount are Yatri's (the server created them when the ride completed, after offers and points).
  The client sends no amount.
- `POST /trips/:id/payment/digital` (rider only) opens one payment attempt (`payment_attempts`) and returns the vendor's page.
  `POST /trips/:id/payment/digital/verify` asks the vendor, server to server, what became of it. A rider returning from the
  vendor's page proves nothing.
- Idempotency is in the database: one open attempt per ride (asking again returns it, concurrent requests included), one vendor
  reference per attempt, one completed attempt per ride, and `markPaidByProvider` takes the payment's row lock so a repeated
  verify, a callback and the sweep end in one PAID payment and one "payment received" event.
- A completed report is believed only for **exactly** the amount asked for. A mismatch closes the attempt, audits
  `PAYMENT_AMOUNT_MISMATCH` and marks nothing paid.
- The `payment-attempts` job completes payments whose rider never came back and closes expired ones.
- Cash and organization billing are unchanged. With `PAYMENT_PROVIDER=none` the apps do not offer online payment (the server
  decides: `TripSummary.onlinePaymentAvailable`).

## Admin

`GET /admin/providers` (permission `SETTINGS_VIEW`) and the page **Service providers**: the vendor's name, a state in words
(Working, Working with problems, Not working, Set up but there is no live check, A development stand-in, Not set up), the
time and latency of the last check, today's calls and failures, and the **kind** of the last failure. Status only: no key,
account, address or vendor message exists in the answer (a test checks the response for every secret variable name and any
address). The `provider-health` job runs each live check (a free call that sends nothing).

## Push tokens

`POST/DELETE /users/me/push-token`: a phone's address, held only to deliver that person's own notifications, owned by one
person at a time, removed when the push service reports the phone gone. What is pushed is the title, the body and the type
and ride id: never an accessibility detail, note, location or document.

## What was verified, and what was not

Verified by tests (`apps/api/src/test/providers.test.ts`, 44 tests): the environment rule, API start-up refusal, secrets and
`.env.example`, the vendor-call function (timeout, retry, no retry for acting calls, breaker, kind naming without leaks, usage
counters), health rules, every adapter against a pretend vendor, **S3 signing against AWS's published example signatures**,
the digital-payment flow (idempotency, concurrency, amount check, authorization, vendor failure, sweep), the admin screen's
authorization and content, the 503 mapping and error scrubbing, and SSOT checks (no vendor names or addresses in business code,
no raw `fetch`).

**Not verified: no call was made to a real vendor.** The adapters follow each vendor's documented API but have only been
exercised against pretend vendors, so credentials, account approval (for example sender registration for Nepali SMS) and
the vendors' exact live behaviour need a staging run with real test keys. The passenger and driver apps do not yet register
their push tokens (that needs the `expo-notifications` dependency and a device build); the server side is ready.
