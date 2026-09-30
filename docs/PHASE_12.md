# Phase 12: hardening for production

Phase 12 audited the whole system (API, database, realtime, maps, payments, notifications, safety,
authentication, storage, background jobs, both apps, the admin console), fixed what it found, and added what
was missing to run it for real. This page is the record; the controls are in [`SECURITY.md`](SECURITY.md), the
procedures in [`OPERATIONS.md`](OPERATIONS.md), the accessibility checks in
[`ACCESSIBILITY_TESTING.md`](ACCESSIBILITY_TESTING.md). Nothing here repeats them.

## Two real defects the new tests exposed

Both were latent (nothing had failed yet); both are fixed and each has a regression test.

1. **Time and sequence could disagree.** A chat message or ride event gets its sequence number under a row
   lock, but its timestamp was the transaction's _start_ time. Two simultaneous sends could therefore be stored
   with times in the opposite order to their sequence, and the chat history (which merges by time) could show
   message 3 before message 2. The timestamp is now taken under the same lock (`clock_timestamp()`), and the
   merge breaks ties by sequence. (`reliability.test.ts`: "never lets a message's time disagree with its
   sequence number", and the same for ride events.)
2. **A lost Redis silently froze rides.** The location path read the ride's cached facts from Redis only, so
   after a Redis restart every driver position was ignored ("not active") and "I have arrived" could never be
   accepted. `loadMeta` now rebuilds the cache from the database (one place; the realtime gateway's private
   copy of that fallback was removed). Completing a ride still needs a live driver position and answers a
   clear 409 until the app sends its next one, which is the safe behaviour. (`reliability.test.ts`: "carries a
   ride through a complete loss of Redis".)

## What changed

| Area           | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security       | Token algorithm and issuer pinned (API and admin console, one shared definition); atomic rate-limit counters; an API-wide ceiling and a per-user mutation limit on every authenticated router; uploads and deactivation limited; driver location limits moved from per-address to per-user (shared mobile addresses); one redacting logger, no `console.*`; malformed body is a 400; staging obeys production's configuration rules; admin console response headers |
| Reliability    | Readiness check (database and Redis, with a deadline) beside liveness; graceful shutdown with a deadline; escaped errors logged and the instance restarted; Redis command timeout and capped reconnect backoff; database statement timeout and bounded pool; the two defects above                                                                                                                                                                                  |
| Performance    | Four redundant indexes removed (one was the driver location index, written every few seconds), four range indexes added for reports, the user list's completed-ride count made index-friendly; a test that fails on any duplicate index                                                                                                                                                                                                                             |
| Accessibility  | Focus moves to the confirmation or form that replaces what was on screen (SOS confirmation, safety report, rating, problem report); a static check of every mobile screen and of the console runs on every push                                                                                                                                                                                                                                                     |
| Mobile         | A release build refuses an API address that is not https or is local (it used to fall back to `http://localhost`); no map (and no request to a third-party tile server) in a release build unless a tile provider is configured; the map library's CDN files are integrity-checked                                                                                                                                                                                  |
| Infrastructure | Container images (API runtime, migration job, admin console), a full local stack, backup and restore scripts, a CI pipeline (format, lint, types, tests against real Postgres and Redis, admin build, both Android exports, images, dependency audit) and a release workflow that publishes versioned images                                                                                                                                                        |
| Repository     | Two unused dependencies removed; consolidation listed below; three audit scripts in `scripts/`                                                                                                                                                                                                                                                                                                                                                                      |

## Duplication removed

- `useTheme` and the crash boundary were byte-identical in both apps: now one copy, in the new `@yatri/mobile-ui`.
- The vehicle create/update request bodies were defined in the driver app **and** the API: now
  `VehicleCreateBody` / `VehicleUpdateBody` in `@yatri/types`, used by both.
- The gateway's private "rebuild the ride cache from the database" was removed in favour of `loadMeta`.
- The mobile call controller's `CallState` collided with the server's `CallState` (different things, one name):
  renamed `CallUiState`. A second `listDisputesHandler` in the API was renamed `myDisputesHandler`.
- Earlier in this phase (Phase 11, same audit): role, account-status, payment-status and SOS-status wording that
  had eight local copies, and the trip-status lists hand-written in SQL.
- Recorded rather than removed, with the reason and the next step, in `ARCHITECTURE.md` "Known duplication":
  the near-identical sign-in screens of the two apps, the two `ApiError` classes, and the API-only call state table.

## Verified in this session

| Check                                                                 | Result                                                                                                                                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API tests (real Postgres and Redis)                                   | **493 passed, 36 files** (includes the new `hardening` 34, `reliability` 12, `performance` 4)                                                                              |
| Mobile package tests                                                  | mobile-auth 4, mobile-location 102, mobile-ride 67 passed (including the static accessibility scan)                                                                        |
| Lint, formatting, typecheck (all packages)                            | clean                                                                                                                                                                      |
| Admin console production build (standalone output)                    | built; the server file is at the path the container image starts                                                                                                           |
| Passenger and driver Android bundles                                  | both export                                                                                                                                                                |
| Dependency audit                                                      | nothing high or critical in runtime dependencies; one moderate advisory (`uuid` 7 inside Expo's build-time plugin tooling, not part of what ships)                         |
| Migration up, down, up                                                | run on the development database; applied to the test database                                                                                                              |
| Response times at 30,000 rides (test machine, shared with the runner) | slowest call 293 ms (dashboard, 30 days); analytics 53-98 ms; every list and report 14-156 ms; a rider's history and the nearby-driver lookup walk their indexes (EXPLAIN) |
| Map integrity attributes                                              | checked in a real browser: the correct hashes load Leaflet's CSS and script; a wrong hash is refused                                                                       |
| Secrets                                                               | a test scans every tracked file (keys, tokens, signed JWTs, credentialed URLs, real `.env` files): none                                                                    |

## Not verified, and what that means

- **Nothing was run on a phone, with a screen reader, or on a real network.** The accessibility work is structural
  (tests, the browser's accessibility tree, scripted focus) and the focus moves in the mobile apps are only
  type-checked (nothing exercises them without a device); TalkBack, VoiceOver and NVDA still need a person. `ACCESSIBILITY_TESTING.md` sections F-L
  are the script.
- **The container images, the compose stack, the CI and release workflows, and the backup and restore scripts were
  written and reviewed but not executed here** (no Docker and no `pg_dump` on the development machine). The scripts
  pass a syntax check; the admin standalone path was confirmed; CI builds every image on the first push and will
  show any error. **Do a restore drill before launch** (`OPERATIONS.md` section 4).
- **The mobile release-build rules** (https-only address, no tiles without a provider) are unit-tested as functions;
  a release build itself was not run.
- **Load beyond the seeded dataset, real network partitions, a third-party penetration test** were not done.

## Production blockers (open, in order of importance)

1. **No push provider.** A closed app is not woken, which matters for ride offers and SOS follow-up. Choose a
   provider and add it as a `NotificationProvider`; nothing else changes.
2. **No SMS gateway is configured or tested**; production refuses to start with the console provider, so one must be
   set (`SMS_PROVIDER=http`) and proven with a real number.
3. **No production map provider.** The public OpenStreetMap servers (geocoding and tiles) are for light use only:
   production refuses the public geocoder; set your own geocoder and tile provider.
4. **Backups and restore are untested** (see above), and there is **no hosted error tracker or alert routing** yet;
   the log lines and alert table in `OPERATIONS.md` say exactly what to connect.
5. **External penetration test and a device accessibility pass** before real riders use it.

## Deployment readiness

Ready to deploy to a **staging** environment: it builds, passes its tests, validates its configuration, exposes
health and readiness, shuts down cleanly and has a documented release and rollback. **Not ready for public
launch** until the five blockers above are closed.
