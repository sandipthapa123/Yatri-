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
