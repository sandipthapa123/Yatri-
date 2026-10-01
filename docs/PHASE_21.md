# Phase 21: reliability and offline recovery

Phase 21 makes Yatri behave sensibly when the real world fails: no internet, a dropped socket, no GPS, the app in the
background or killed, the server restarted, the same request sent twice, events arriving late or out of order, a payment
retried, a notification delayed. The rule throughout: **the server's state is the truth.** After any interruption the apps
ask the server and show what it says; they never guess, replay or repair a ride locally.

It reuses what already existed (the realtime client with reconnect, backoff, resubscribe and snapshot versioning; the trip
snapshot and `/trips/active`; the notification service; the audit log; retention policies; admin RBAC). It adds one job
architecture, one idempotency rule, one connection monitor and one server clock.

## What was built

| Brief                                               | Where it is                                                                                                                                                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One centralized job architecture                    | `modules/jobs/jobs.ts` (runner: Redis lock per job, timeout, never throws, `job_runs` history, scheduler with jitter) and `modules/jobs/registry.ts` (the one list). The old per-feature `setInterval`s in the gateway are gone; a test keeps it so |
| Expired rides, stale drivers, calls, shares, offers | `trip-sweep`, `driver-sweep`, `call-sweep`, `share-expiry`, `dispatch-sweep` (the same functions as before, now run by the runner)                                                                                                                  |
| Scheduled and document-expiry notices               | `fleet-monitor` (documents, licences, service dates), `support-sweep`, `organization-sweep`, `risk-sweep`, `retention`                                                                                                                              |
| Failed notification retries                         | `notification-retry`: a failed push is kept (`delivery_status` FAILED, `attempts`, `next_attempt_at`, `last_error`), retried after 30 s, 2 min, 10 min, 1 h, then DEAD. Claimed with `FOR UPDATE SKIP LOCKED`, so no double push                    |
| Notification deduplication                          | `dedupe_key` (unique per user): the same key is recorded and pushed once however often the raising code runs                                                                                                                                        |
| Payment reconciliation                              | `payment-reconcile` (`trips/payment-reconcile.ts`): creates the missing payment of a finished ride with the existing idempotent insert; reports (never silently changes) statement and refund anomalies and audits them                             |
| Idempotency                                         | `middleware/idempotency.ts`, on the trips router (request, accept/decline, arrived, start, complete, no-show, cancel, payment confirm, rating) and the admin router (refunds and every other admin action)                                          |
| Authoritative time and ordering                     | every API answer carries `Date`; live snapshots carry `serverTime`, `version`, `lastEventSeq` (already). The apps keep a server-clock offset (`ServerClock`) and the realtime client drops duplicate and older snapshots (already)                  |
| Reconnect and resync                                | the realtime client resubscribes with a full snapshot (already); `useResyncOnReturn` re-fetches the active trip when the app returns to the foreground or the connection returns                                                                    |
| Offline UI                                          | `ConnectivityBanner` (both apps): "You are offline. What you see may be out of date. Last updated 2 minutes ago", then "Back online." One polite announcement per change, not a ticking live region                                                 |
| Restart and offline start                           | a token refresh failure signs the person out **only** when the server rejects it (401/403); no connection or a server error never does. The last profile is cached in secure storage so the app can open offline and show/recover the ride          |
| Admin                                               | Background jobs (`/jobs`): each job, what it does, interval, state in words (OK, Needs attention, Late, Failed), last result, run now (needs `SETTINGS_MANAGE`, audited)                                                                            |

## The idempotency rule

An app sends `Idempotency-Key` (8 to 100 characters, one per user intent) on an action that must not happen twice.

- same user, URL, key and body, finished: the stored answer is replayed (`Idempotent-Replay: true`);
- first attempt still running: `409 IDEMPOTENCY_IN_PROGRESS` (the app waits and sends again with the same key);
- same key with a different body or URL: `422 IDEMPOTENCY_KEY_REUSED`;
- the first attempt failed: the key is released and a retry runs for real; only a successful answer is stored;
- a first attempt that crashed can be taken over after 60 s; one winner.

The header is optional, so older apps still work, and keys are per user. This only stops a repeat: whether the action is
allowed is still the endpoint's own rule under its row lock (a second `complete` of a finished ride is refused by the trip
state machine whether or not a key is used). Keys are deleted by the `IDEMPOTENCY_KEYS` retention rule (2 days).

The mobile client sends a key for the actions above and, if the connection drops before an answer, sends the same key
again (0.8 s, 2 s, 5 s). Only "no connection" and "still processing" are retried; an answer the server gave is returned as is.

## Rules worth knowing

- **A job must be safe to run twice and to be interrupted.** It finds work by looking at the data, never by remembering
  what it did. The lock only prevents overlap and duplicate work across instances; correctness never depends on it.
- **A failing job cannot take the server down**, and the next interval runs as usual. A job running past its timeout is
  abandoned and its lock lapses.
- **Reconciliation fixes only what is safe.** A completed ride without a payment gets its pending payment. Anything that
  involves a decision about money (a statement marked paid with an unpaid payment, a cancelled statement still holding
  payments, an issued statement with none, a refund processing for over a day) is reported in the audit log and left to a person.
- **Offline is a measurement.** "Offline" means two requests in a row could not reach the server. It says the screen may be
  out of date and how old it is; it makes no claim about the ride.
- **No local guessing.** Nothing in the apps advances a ride, a payment or an offer while offline.

## Not done, honestly

- **Nothing was run on a device**, on a flaky mobile network, or with TalkBack, VoiceOver or NVDA. The behaviours are tested
  at the API (real database and Redis), the client logic is unit tested (fake fetch, fake clock), and the screen-reader
  checks are listed in section T of `ACCESSIBILITY_TESTING.md`.
- **No push provider is connected**, so "delivery" is the console provider; the retry machinery is proven with a provider
  that fails, not with real push.
- **No real payments**: reconciliation covers the cash-based ledger that exists.
- **Offline actions are not queued.** A request sent offline is retried for a few seconds with its key, then reported as
  failed in words; the person decides to try again. A queue that replays hours-old actions would risk acting on stale state.
- **An offline first launch with no cached profile** shows the sign-in screen (the tokens are kept, so signing in again works).
- The client server clock uses the HTTP `Date` header (one-second resolution); it is used for "how long ago" wording, never
  for any decision.
- A second API instance was not run in tests; the lock is a Redis `SET NX` with a compare-and-delete release, tested by
  two simultaneous runs in one process.
