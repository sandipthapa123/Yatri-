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

| Where | What was wrong | Effect | Fix |
|---|---|---|---|
| Sessions (Phase 1) | Refresh-token rotation was an unconditional update | Two refreshes with the same token both "succeeded"; the second silently overwrote the first's new token, so a device was later logged out at random (a screen with several polled cards triggers this) | Rotation is a compare-and-swap (`rotateSession`); the app refreshes single-flight; a test fires four simultaneous refreshes and exactly one wins |
| One-time codes (Phase 1) | A guess was counted after it was compared; a correct code was marked used without checking it was unused | A burst of parallel guesses was all evaluated before any was counted, so the attempt limit could be exceeded; one correct code could sign in twice | `reserveOtpAttempt` counts before comparing (atomically); `markOtpConsumed` only succeeds once; tests for both |
| One-time codes + providers (Phase 25) | A failed text left the code armed and the resend wait running | A vendor outage punished the person ("please wait") for a text that never left | The unsent code is withdrawn and the wait lifted; the person gets the fixed 503 sentence and can ask again at once |
| Mobile client (Phase 1) | `fetch` had no deadline | On a stalled connection a screen waited for ever | A 20 s deadline (60 s for uploads), reported in plain words with the same code as a dropped connection so safe retries still apply |
| Admin client (Phase 3) | Calls to the API had no deadline and a failure to reach it was a raw error | A stuck API made admin pages hang | A 15 s deadline; failures become `ApiError` (503 or 504) |
| Payments wording (Phase 25) | Dashboard, finance and analytics said "Awaiting cash", "Paid in cash", "Cash confirmed" for all payments | Online payments were described as cash | Method-neutral labels where the method is unknown; method-specific where it is known |
| Admin Providers page (Phase 25) | "Every service is set up and none is reporting a problem" with nothing checked; "no live check" for a vendor that has one that had not run yet; a garbled sentence | Misleading reassurance | Honest counts of stand-ins and unchecked services; "not checked yet" distinguished from "no check exists" |
| Configuration (Phase 25) | I had added `RELEASE_VERSION` beside the existing `APP_VERSION` | Two settings for one fact | Removed; error reporting uses `APP_VERSION` |
| Scripts | Running a script outside the test runner uses the built `@yatri/types`, which was stale | `providers:check` crashed on first run | `preproviders:check` builds the types first |
| README | Still said "Phase 3" and listed four packages | Stale | Updated |

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

| Where | What was wrong | Effect | Fix |
|---|---|---|---|
| Dispatch (Phase 6) | "One open offer per ride" was only checked in code (`openOfferForTrip`, then insert) | Two dispatch runs at the same moment (a decline and the sweep, or two servers) could offer one ride to two drivers, burning offers and showing a driver an offer that vanished | A unique partial index `trip_offers_one_open_per_trip`; the loser of the race reports the existing offer; a test fires six dispatch runs at once and gets exactly one open offer |
| Promotions (Phase 24) | If releasing an offer failed once when a ride was cancelled, nothing ever gave it back | The rider's use limit stayed held for a ride that never happened | The hourly `growth-expiry` job voids reservations of cancelled or driverless rides (`voidStaleReservations`); tested |
| Calls (Phase 8) | Only unanswered rings were swept; an answered call whose media never connected stayed `CONNECTING` | The one-live-call-per-ride rule then refused every new call for the rest of the ride | The sweep ends calls stuck connecting past `CALL_CONNECT_TIMEOUT_SECONDS` as `FAILED`; tested |
| Calls (Phase 8) | Hang-up chose its end reason from a stale read | An answer arriving a moment before the hang-up was recorded as cancelled and raised a false missed-call event | The reason is decided inside the update from the call's state at that instant |
| Chat (Phase 9) | A retry of an already-saved message was counted against the send rate limit; the history query took the oldest 500 messages | A flaky connection could trip the limit; a very long chat would drop its newest messages | The duplicate check runs before the limit; history takes the newest 500, shown oldest first |
| SOS (Phase 10) | The safety team was told after each contact's text was sent in turn; a failed team notice on "I am safe" turned the cancel into an error | A slow text vendor delayed the people who can act; a cancelled alert showed as a failure | The team is told first, texts go out together, and the cancel notice is best effort |
| Support (Phase 11) | In the escalation and auto-close sweeps one failed note or notice stopped the follow-up for every later ticket | Some tickets escalated or closed with no note and nobody told | Each ticket's follow-up is isolated |
| Retention (Phase 12) | The disability-card and support-evidence purges deleted the database record even when the file store refused to delete the file | An identity document or a support file stayed in storage past its retention period with nothing left pointing at it | A record is dropped only once its file is gone, so the next run retries; tested with a store that refuses |
| Account deletion (Phase 12) | A file the store refused to delete was ignored silently | Leftover files with no record to retry from | Logged as an error with a count (never keys) so an operator removes them. Not retried automatically: that would need a deletion queue, which is not built |
| Fleet (Phase 14) | The expiry report asked for a category's required papers once per vehicle | One query per approved vehicle on every report | Asked once per category per report |
| Organizations (Phase 18) | If anything failed after an approved ride was created, the approval went back to waiting | A second approval booked a second ride for one approval | The approval is put back only when no ride was created; later steps are best effort |
| Organizations (Phase 18) | One organization's statement failure aborted the monthly run | Every later organization went unbilled until it was fixed | Each organization is its own transaction; the run still fails at the end so the problem is seen |
| Devices (Phase 17) | A push token belonged to the person, not the sign-in | Signing a lost phone out from another device left it receiving notifications | Tokens are tied to their session (migration `1740700010000`); logout, device sign-out and sign-out-others remove them; tested |
| Accessibility (Phase 15) | The profile save locked a row that does not exist on a first save | Two devices saving for the first time both passed the version check and the later silently overwrote the earlier | The person's row is locked first; a concurrent first-save test gets one 200 and the rest 409 |
| Payments (Phase 7) | The reconcile job created a full-fare payment when settling the ride's offers and points failed | The rider lost their offer or points for good, since settling never revisits a ride that has a payment | The ride is left for the next run until it settles; the completion comment, which claimed otherwise, is corrected. Not covered by a test: forcing the settlement to fail needs a fault-injection hook that does not exist |
| Trip sweeps (Phase 7) | One ride's failure stopped the waiting notices for every later ride | Drivers and riders missed waiting notices | Each ride is isolated |
| Tracking (Phase 6) | A location update checked the ride was live before taking its lock, then wrote its position | If the ride ended (or its driver dropped out) in between, the position came back after the ride ended, kept for 6 hours, or the old driver's position was handed to the next driver | After writing, an update looks again and takes back what it wrote if the ride no longer shows live positions. Covered by the existing tracking tests; the race itself needs a fault-injection hook and is not tested |
| Documents (Phase 3) | Replacing a document checked it was not approved, then deleted its file and record separately; the file went first | A reviewer approving it in between meant the driver's replace deleted an approved document (or left an approved record with no file) | The record is deleted in one statement that refuses an approved document, then the file |
| Documents (Phase 3) | Nothing stopped two documents in one slot | Two uploads at once (a double tap, a retry) left two documents for one slot; a failed insert also left its uploaded file behind | Unique indexes per driver and vehicle slot (migration `1740800010000`, which first keeps one of any existing duplicates: an approved one, else the newest); a refused insert removes its file and answers 409 `UPLOAD_IN_PROGRESS`; tested with four simultaneous uploads |
