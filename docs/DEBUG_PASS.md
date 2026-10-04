# Debug pass, from Phase 1 forward (after Phase 28)

A deliberate second look at what earlier phases built, with the habit of running things for real instead of only reading them. What was
checked, what was found, what was fixed, and what was not checked.

## How it was checked

- **From scratch**: all 42 migrations applied to an empty database; the last five reversed and applied again.
- **For real**: the API was built (`pnpm build`), refused to start as `NODE_ENV=production` on a development configuration (the right
  answer), and started and answered (`/health`, `request-otp`, an admin route without a token) when built and run as development.
- **Bundled**: both Expo apps exported for Android (Metro bundles every import, including the new `expo-notifications`).
- **Admin**: `next build` compiled; the new pages were loaded in a browser against the running API and scanned with axe-core
  (WCAG 2.2 A/AA and best practices) with **no violations** on the payouts, disability, disability benefits, providers and
  campaign-creation pages.
- **Whole suite**: every API test, every package test, lint, type-check, and the repository audits (dead files, duplicate definitions,
  unused dependencies).
- **By reading** the places where money, sign-in and the network meet: sessions, one-time codes, the mobile and admin API clients,
  the realtime gateway, and every interpolated value in SQL (all constants or fragments, none user input).

## Found and fixed

| Where                                 | What was wrong                                                                                                                                                     | Effect                                                                                                                                                                                                 | Fix                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sessions (Phase 1)                    | Refresh-token rotation was an unconditional update                                                                                                                 | Two refreshes with the same token both "succeeded"; the second silently overwrote the first's new token, so a device was later logged out at random (a screen with several polled cards triggers this) | Rotation is a compare-and-swap (`rotateSession`); the app refreshes single-flight; a test fires four simultaneous refreshes and exactly one wins |
| One-time codes (Phase 1)              | A guess was counted after it was compared; a correct code was marked used without checking it was unused                                                           | A burst of parallel guesses was all evaluated before any was counted, so the attempt limit could be exceeded; one correct code could sign in twice                                                     | `reserveOtpAttempt` counts before comparing (atomically); `markOtpConsumed` only succeeds once; tests for both                                   |
| One-time codes + providers (Phase 25) | A failed text left the code armed and the resend wait running                                                                                                      | A vendor outage punished the person ("please wait") for a text that never left                                                                                                                         | The unsent code is withdrawn and the wait lifted; the person gets the fixed 503 sentence and can ask again at once                               |
| Mobile client (Phase 1)               | `fetch` had no deadline                                                                                                                                            | On a stalled connection a screen waited for ever                                                                                                                                                       | A 20 s deadline (60 s for uploads), reported in plain words with the same code as a dropped connection so safe retries still apply               |
| Admin client (Phase 3)                | Calls to the API had no deadline and a failure to reach it was a raw error                                                                                         | A stuck API made admin pages hang                                                                                                                                                                      | A 15 s deadline; failures become `ApiError` (503 or 504)                                                                                         |
| Payments wording (Phase 25)           | Dashboard, finance and analytics said "Awaiting cash", "Paid in cash", "Cash confirmed" for all payments                                                           | Online payments were described as cash                                                                                                                                                                 | Method-neutral labels where the method is unknown; method-specific where it is known                                                             |
| Admin Providers page (Phase 25)       | "Every service is set up and none is reporting a problem" with nothing checked; "no live check" for a vendor that has one that had not run yet; a garbled sentence | Misleading reassurance                                                                                                                                                                                 | Honest counts of stand-ins and unchecked services; "not checked yet" distinguished from "no check exists"                                        |
| Configuration (Phase 25)              | I had added `RELEASE_VERSION` beside the existing `APP_VERSION`                                                                                                    | Two settings for one fact                                                                                                                                                                              | Removed; error reporting uses `APP_VERSION`                                                                                                      |
| Scripts                               | Running a script outside the test runner uses the built `@yatri/types`, which was stale                                                                            | `providers:check` crashed on first run                                                                                                                                                                 | `preproviders:check` builds the types first                                                                                                      |
| README                                | Still said "Phase 3" and listed four packages                                                                                                                      | Stale                                                                                                                                                                                                  | Updated                                                                                                                                          |

## Checked and found sound

Security headers, CORS and proxy configuration; the realtime gateway (authentication within 5 s, per-connection rate limit,
violation cap, size limits, session re-check); every SQL interpolation; migration reversibility; production refusal of development
settings; bundle integrity of both apps.

## Not checked

- No device, screen reader (TalkBack, VoiceOver, NVDA) or real vendor was available. axe-core is automated and finds roughly a third of
  accessibility problems; it does not replace a person using the product.
- Push could not be received on a phone.
- Earlier phases' documents were not re-audited line by line against the code; the test suite is the guarantee for their behaviour.
- A load test was not run.

## Second round (dispatch and promotions)

| Where                       | What was wrong                                                                                                                           | Effect                                                                                                                                                                              | Fix                                                                                                                                                                                                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispatch (Phase 6)          | "One open offer per ride" was only checked in code (`openOfferForTrip`, then insert)                                                     | Two dispatch runs at the same moment (a decline and the sweep, or two servers) could offer one ride to two drivers, burning offers and showing a driver an offer that vanished      | A unique partial index `trip_offers_one_open_per_trip`; the loser of the race reports the existing offer; a test fires six dispatch runs at once and gets exactly one open offer                                                                                          |
| Promotions (Phase 24)       | If releasing an offer failed once when a ride was cancelled, nothing ever gave it back                                                   | The rider's use limit stayed held for a ride that never happened                                                                                                                    | The hourly `growth-expiry` job voids reservations of cancelled or driverless rides (`voidStaleReservations`); tested                                                                                                                                                      |
| Calls (Phase 8)             | Only unanswered rings were swept; an answered call whose media never connected stayed `CONNECTING`                                       | The one-live-call-per-ride rule then refused every new call for the rest of the ride                                                                                                | The sweep ends calls stuck connecting past `CALL_CONNECT_TIMEOUT_SECONDS` as `FAILED`; tested                                                                                                                                                                             |
| Calls (Phase 8)             | Hang-up chose its end reason from a stale read                                                                                           | An answer arriving a moment before the hang-up was recorded as cancelled and raised a false missed-call event                                                                       | The reason is decided inside the update from the call's state at that instant                                                                                                                                                                                             |
| Chat (Phase 9)              | A retry of an already-saved message was counted against the send rate limit; the history query took the oldest 500 messages              | A flaky connection could trip the limit; a very long chat would drop its newest messages                                                                                            | The duplicate check runs before the limit; history takes the newest 500, shown oldest first                                                                                                                                                                               |
| SOS (Phase 10)              | The safety team was told after each contact's text was sent in turn; a failed team notice on "I am safe" turned the cancel into an error | A slow text vendor delayed the people who can act; a cancelled alert showed as a failure                                                                                            | The team is told first, texts go out together, and the cancel notice is best effort                                                                                                                                                                                       |
| Support (Phase 11)          | In the escalation and auto-close sweeps one failed note or notice stopped the follow-up for every later ticket                           | Some tickets escalated or closed with no note and nobody told                                                                                                                       | Each ticket's follow-up is isolated                                                                                                                                                                                                                                       |
| Retention (Phase 12)        | The disability-card and support-evidence purges deleted the database record even when the file store refused to delete the file          | An identity document or a support file stayed in storage past its retention period with nothing left pointing at it                                                                 | A record is dropped only once its file is gone, so the next run retries; tested with a store that refuses                                                                                                                                                                 |
| Account deletion (Phase 12) | A file the store refused to delete was ignored silently                                                                                  | Leftover files with no record to retry from                                                                                                                                         | Logged as an error with a count (never keys) so an operator removes them. Not retried automatically: that would need a deletion queue, which is not built                                                                                                                 |
| Fleet (Phase 14)            | The expiry report asked for a category's required papers once per vehicle                                                                | One query per approved vehicle on every report                                                                                                                                      | Asked once per category per report                                                                                                                                                                                                                                        |
| Organizations (Phase 18)    | If anything failed after an approved ride was created, the approval went back to waiting                                                 | A second approval booked a second ride for one approval                                                                                                                             | The approval is put back only when no ride was created; later steps are best effort                                                                                                                                                                                       |
| Organizations (Phase 18)    | One organization's statement failure aborted the monthly run                                                                             | Every later organization went unbilled until it was fixed                                                                                                                           | Each organization is its own transaction; the run still fails at the end so the problem is seen                                                                                                                                                                           |
| Devices (Phase 17)          | A push token belonged to the person, not the sign-in                                                                                     | Signing a lost phone out from another device left it receiving notifications                                                                                                        | Tokens are tied to their session (migration `1740700010000`); logout, device sign-out and sign-out-others remove them; tested                                                                                                                                             |
| Accessibility (Phase 15)    | The profile save locked a row that does not exist on a first save                                                                        | Two devices saving for the first time both passed the version check and the later silently overwrote the earlier                                                                    | The person's row is locked first; a concurrent first-save test gets one 200 and the rest 409                                                                                                                                                                              |
| Payments (Phase 7)          | The reconcile job created a full-fare payment when settling the ride's offers and points failed                                          | The rider lost their offer or points for good, since settling never revisits a ride that has a payment                                                                              | The ride is left for the next run until it settles; the completion comment, which claimed otherwise, is corrected. Not covered by a test: forcing the settlement to fail needs a fault-injection hook that does not exist                                                 |
| Trip sweeps (Phase 7)       | One ride's failure stopped the waiting notices for every later ride                                                                      | Drivers and riders missed waiting notices                                                                                                                                           | Each ride is isolated                                                                                                                                                                                                                                                     |
| Tracking (Phase 6)          | A location update checked the ride was live before taking its lock, then wrote its position                                              | If the ride ended (or its driver dropped out) in between, the position came back after the ride ended, kept for 6 hours, or the old driver's position was handed to the next driver | After writing, an update looks again and takes back what it wrote if the ride no longer shows live positions. Covered by the existing tracking tests; the race itself needs a fault-injection hook and is not tested                                                      |
| Documents (Phase 3)         | Replacing a document checked it was not approved, then deleted its file and record separately; the file went first                       | A reviewer approving it in between meant the driver's replace deleted an approved document (or left an approved record with no file)                                                | The record is deleted in one statement that refuses an approved document, then the file                                                                                                                                                                                   |
| Documents (Phase 3)         | Nothing stopped two documents in one slot                                                                                                | Two uploads at once (a double tap, a retry) left two documents for one slot; a failed insert also left its uploaded file behind                                                     | Unique indexes per driver and vehicle slot (migration `1740800010000`, which first keeps one of any existing duplicates: an approved one, else the newest); a refused insert removes its file and answers 409 `UPLOAD_IN_PROGRESS`; tested with four simultaneous uploads |

## Result of the second pass

Every earlier phase was read once more, from authentication to payments, and the findings above were fixed. After the last change the whole API suite was run once, on its own: **56 files, 999 tests, all passing**. Four of the fixes (the tracking race, the reconcile-after-failed-settlement case, and the two first-write races in accessibility and approvals) are covered only by existing tests or by none, because forcing the failure needs a fault-injection hook that does not exist; they were found by reading, not by a failing test.

Still not checked: the admin and mobile front ends were not re-run this round, no real vendor, device or screen reader was used, and no load test was run.

## Third pass: one of everything

The whole repository was searched for things defined more than once (`scripts/duplicate-definitions.mjs`, plus searches for idioms the
script cannot see) and each was given one owner. Where each now lives is in the single-source-of-truth skill.

| What was repeated                                 | Copies                                                                       | Now                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- |
| Sign-in screens (welcome, phone, code)            | Copied in both apps                                                          | `createSignInScreens` in `@yatri/mobile-auth` |
| Wordmark, loading, start-up error, support screen | One per app                                                                  | `@yatri/mobile-ui` / `@yatri/mobile-support`  |
| Sign-in response shapes                           | API controller and app client separately                                     | `@yatri/types` `auth.ts`                      |
| Code length                                       | Hard-coded 6 in both apps while the server's is configurable (4 to 8)        | Sent by the server (`codeLength`); tested     |
| `ApiError` class                                  | Admin site and mobile client                                                 | `@yatri/shared`                               |
| Trip status lists                                 | Written out in 3 files                                                       | Named groups, plus `PRE_PICKUP_TRIP_STATUSES` |
| Postgres collision checks                         | 24                                                                           | `isUniqueViolation` / `isForeignKeyViolation` |
| Paging schemas                                    | 17                                                                           | `pageParam` / `pageSizeParam`                 |
| Date to ISO or null                               | 64                                                                           | `isoOrNull`                                   |
| Transactions written by hand                      | 10, plus a private copy of `withTransaction` and a private rollback sentinel | `withTransaction` + `Rollback`                |
| Date and time formatting                          | 49 in the admin site, 15 in the apps and packages, 3 helper functions        | `formatWhen`                                  |
| Dead constants                                    | `SUPPORT_EMAIL`, `DEFAULT_API_TIMEOUT_MS`                                    | Removed                                       |

Bugs that the consolidation exposed and fixed:

- **Times on admin pages** were formatted by the server, in the server's time zone; a server in UTC showed every time 5 h 45 min off
  without saying so. They are now always in Nepal time. The same applied to two sentences the API builds (a driver's restriction
  end, a pricing window).
- **Refund options** could read "NPR null" for an amount that does not apply; the option now shows no amount.
- **A missing date on the driver page** read "—" (a screen reader says "em dash"); it now says "not recorded".
- **`verifyOtp`'s `driverStatus`** was typed as any string on the server; it is now the driver status type.

Kept on purpose: each app's `SettingsScreen` (each links to different screens), `brand.ts` (each app's identity), client functions
named after the endpoint they call, and the public share page's own script, which runs in the viewer's browser and shows the viewer's
clock.

Testing note: on the day of this pass the test machine had become about 2.5 times slower than before. Clearing a test's data
(`TRUNCATE users CASCADE` on an empty database) took 2.3 seconds, the same on the previous commit, which caused timeouts under the
default 15-second limit. The suite was run with 60-second limits for that reason.

## Dependency audit (2026-10-04)

`pnpm audit --prod` reports three advisories, none in the API or the admin site (`pnpm --filter @yatri/api why <pkg> --prod` finds none):

| Package                                      | Severity | Reaches the code through                            | Fix available                         |
| -------------------------------------------- | -------- | --------------------------------------------------- | ------------------------------------- |
| node-forge (signature check)                 | High     | Expo's command-line tool (development certificates) | No                                    |
| braces (deeply nested patterns)              | High     | The bundler's file matching                         | No                                    |
| uuid (buffer bounds, v3/v5/v6 with a buffer) | Moderate | Expo config plugins (`xcode`)                       | Yes, but only through an Expo upgrade |

All three are build tools that run on a developer's machine and are not part of the app bundles, so the risk is to the build machine,
not to riders, drivers or the servers. Re-run the audit after the next Expo upgrade.

## Verification after the deduplication pass (2026-10-04)

- Whole API suite, `--maxWorkers=2`, nothing else running: **56 files, 999 tests, all passing** (24 minutes). Earlier runs with 4
  workers timed out on a machine with under 1 GB of free memory; the same tests pass with 2.
- Mobile package tests: 277 of 277. Type-check and lint clean across the repository. Admin production build: 45 pages.
- Both apps bundle for Android (`expo export`).
- Admin pages scanned with axe-core (WCAG 2.2 A/AA and best practice) after the change: 16 pages, no violations. Times on the
  audit page are in Nepal time (an event at 05:11 UTC shows 10:56).
- The two new migrations roll back and re-apply cleanly.
- Found while checking the app configurations: neither app has an EAS project id, so push cannot work on any build until one is
  set (now a step in OPERATIONS.md).

## Load and abuse checks (2026-10-04)

The first load test of the API (development server, one machine with under 1 GB free memory, database pool of 10). Bursts of
simultaneous requests, kept under the per-minute limits so they measure the server, not the limiter.

| Burst                                         | Requests at once                    | p95    | Result                               |
| --------------------------------------------- | ----------------------------------- | ------ | ------------------------------------ |
| Health check                                  | 300                                 | 263 ms | all 200                              |
| Profile                                       | 100                                 | 413 ms | all 200                              |
| Ride history                                  | 100                                 | 188 ms | all 200                              |
| Fare estimate (zones, demand pricing, offers) | 50                                  | 972 ms | all 200                              |
| Admin ride list                               | 60                                  | 156 ms | all 200                              |
| Admin analytics                               | 30                                  | 163 ms | all 200                              |
| Mixed                                         | 120                                 | 141 ms | all 200                              |
| Realtime: connect, sign in, ping              | 100 sockets (5 people x 20 devices) | 347 ms | all answered, API healthy afterwards |

No server errors and no dropped connections; the API log recorded no errors.

Limits under a simultaneous burst (both counters are atomic, so a burst never slips past them):

- **Fare estimates**: 45 at once from one rider, limit 30 a minute: exactly 30 answered, 15 refused with `429 RATE_LIMITED` and
  `Retry-After: 60`.
- **Sign-in codes** (each one a paid text): 30 at once to 30 different numbers from one address with 9 of the 20-per-15-minutes left:
  exactly 9 sent, 21 refused with `Retry-After: 900`.

Not measured: sustained load over minutes, many client addresses, a production-sized database, or a real SMS/route vendor's latency.
The scripts are not in the repository (they were one-off); the numbers above are the record.

## CI made to work again (2026-10-04)

The most important finding of this pass: **CI had failed on every push since 1 October**, while every local check passed. Because
the formatting step failed first and stopped its job, lint, types, tests, the admin build and the audit never ran on GitHub; the
container images could not be built at all, so the servers could not have been deployed from CI.

| Cause                                                      | Effect                                                         | Fix                                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 258 files not in the project's formatting                  | First step failed; every later step in the job skipped         | `pnpm format` once; `prettier --check .` before every commit                      |
| Neither Dockerfile copied `packages/config`                | Image builds failed: `TS5083 Cannot read file .../base.json`   | Copy it in both images                                                            |
| The admin image never compiled `@yatri/types`              | Admin image failed: "Can't resolve '@yatri/types'" (88 places) | Compile it before the admin build                                                 |
| Two high advisories with no fix, in build tools only       | The audit step would fail                                      | Acknowledged by id with reasons (`docs/SECURITY.md`); still listed in every audit |
| The configuration tests predated `FIELD_ENCRYPTION_SECRET` | Tests failed on GitHub                                         | Added it, with tests of its rules                                                 |
| One job did everything in sequence under a 30-minute limit | Slow pushes; a slow runner could time out                      | Five parallel jobs; a push now takes about 9 minutes                              |
| Failures were unreadable without admin rights              | "exit code 1" and nothing else                                 | Failing tests are annotated, and the failing lines go into the public job summary |
| The admin image kept a placeholder secret in an `ENV` line | Docker warning; the value stayed in the image                  | Given to the build command only                                                   |

**First green run: run 46, commit `fd2c966`.** Every job passed: checks, tests, admin build, container images and both app bundles.

Not settled: run 45 failed its tests with code identical to run 46, which then passed, so one test is probably flaky. It cannot
be named yet; if it fails again, the job summary will show which one.

Lesson recorded: after every push, read the CI result for that commit (the public run page works without signing in).

### The intermittent CI failures, named and fixed

Once failures were raised as public annotations, the two intermittent test failures named themselves:

| Run | Test                                                       | Cause                                                                                                                                                                           | Fix                                                                                                                                         |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 49  | `ride-communication`: notifies the person being called     | Test timing. A call starts over the realtime socket; the ring is sent first and the notification written just after (the right order for an open app). The test read too early. | The test waits for it (`eventually`, a shared helper)                                                                                       |
| 50  | `admin-ops`: of two simultaneous edits applies exactly one | **A real bug.** A setting never edited before has no row, so `FOR UPDATE` locked nothing; two first edits both passed and the second silently overwrote the first.              | A first edit inserts with `ON CONFLICT DO NOTHING`; the loser gets 409. A test repeats the race 15 times (the old code fails it in round 1) |

Every other test that reads the database right after a realtime message was checked: each one reads data written before the
message (or after an HTTP answer that waits for the write), so none can race. CI green on runs 46, 48 and 51.
