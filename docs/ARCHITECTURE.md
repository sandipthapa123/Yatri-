# Architecture

## Overview

Yatri is a pnpm-workspaces monorepo split into `apps/` (deployable applications) and
`packages/` (shared code with no runtime of its own).

```
apps/passenger  ─┐
apps/driver     ─┼─► packages/mobile-ride ─► packages/mobile-location ─► packages/mobile-auth
                 │                                                      └─► packages/shared, packages/types
apps/admin      ─────────────────────────► packages/shared, packages/types
apps/api        ─────────────────────────► packages/types
```

Only `packages/types` and `packages/shared` are shared across every app; `packages/mobile-auth`
is scoped to the two Expo apps only (it depends on `expo-secure-store`, which has no web
equivalent — mixing it into `packages/shared` would break the admin app's build). This keeps
the dependency graph a strict DAG with no app depending on another app.

## Backend: modular monolith

`apps/api` is a single Express process. Each domain lives in its own module under
`src/modules/<domain>/`, exposing a router and a controller:

```
src/modules/health/
├── health.controller.ts
└── health.routes.ts

src/modules/auth/            # OTP, sessions, admin login — see docs/AUTHENTICATION.md
src/modules/users/           # GET/PATCH /users/me, profile picture, deactivation (any role)
src/modules/drivers/         # Driver profile + onboarding progress/submission (DRIVER only)
src/modules/vehicles/        # Vehicle registration + categories (DRIVER only, own vehicles)
src/modules/documents/       # Document upload/list/delete + signed download URLs
src/modules/storage/         # Serves signed URLs issued by StorageProvider (public route,
                              # but every request is signature+expiry verified)
src/modules/admin/           # Driver review, document/vehicle approval, verification history,
                              # rides, disputes, RBAC + access log (ADMIN only) — PHASE_3 / PHASE_6
src/modules/trips/           # ride lifecycle, events, waiting, payments, ratings, disputes — PHASE_6
src/modules/dispatch/        # offers to nearby drivers, expiry, rematch — PHASE_6
src/modules/chat/            # trip chat — PHASE_6
src/modules/calls/           # call state machine + signalling relay + ICE servers — PHASE_6
src/modules/pricing/         # fare and waiting charge (server-only) — PHASE_6
src/modules/realtime/        # ONE socket: presence, snapshots, events, chat, calls, offers
```

`src/routes/index.ts` mounts every module's router under `/api/v1`. Adding a capability means
adding a module and one mount line — not a new service, and not a shared "everything"
controller. Split a module into its own deployable service only when there's a concrete
operational reason (independent scaling, a different runtime, a separate team boundary), not
by default.

## Data layer

- **PostgreSQL** is the system of record, accessed via a single pooled `pg.Pool`
  (`src/config/database.ts`). The pool connects lazily — no query, no connection — so the API
  can boot and pass health checks even before a schema exists.
- **Redis** (`src/config/redis.ts`, lazily connecting) now backs OTP resend cooldowns and
  request-rate limiting (`src/lib/rate-limit.ts`) — its first real job, ahead of the presence/
  location-fanout use cases it was originally reserved for. Still nothing holds an open
  connection until a rate-limit check or cooldown actually runs.
- **Postgres `DATE` columns come back as plain strings, not JS `Date` objects.** `pg`'s
  default parser + `JSON.stringify` would otherwise turn a date-only value into a full
  UTC timestamp — wrong for something with no time component. `src/config/database.ts`
  overrides the type parser for OID 1082 once, centrally, for every date column.

## File storage

- **`StorageProvider`** (`src/lib/storage/storage-provider.ts`) is the interface every
  uploaded document goes through: `upload`/`download`/`delete`/`createTemporaryAccessUrl`.
  `LocalDiskStorageProvider` is the only implementation so far (development), but nothing
  above the interface assumes a filesystem — swapping in an S3-compatible provider later
  is a new class, not a rewrite.
- Access is always via a short-lived, HMAC-signed URL (`src/lib/storage/signed-url.ts`),
  never a permanent or predictable path — this is what lets `src/modules/storage/` serve
  identity documents through one public route without exposing them publicly.
- See [`docs/PHASE_3.md`](PHASE_3.md) for the full driver-verification data model and
  upload-security details (file-type detection, size limits, replacement rules).

## Client apps

- **Passenger & driver** are Expo-managed React Native apps sharing `packages/shared`'s brand
  tokens, `packages/types`'s contracts, and `packages/mobile-auth`'s auth client (API calls,
  secure token storage, `AuthContext`, accessible phone/OTP inputs). Metro is configured for
  the pnpm workspace (`metro.config.js` watches the repo root and enables symlink resolution)
  so workspace packages resolve without hoisting hacks.
- **Admin** is a Next.js App Router project. It shares `packages/types`'s contracts with the
  mobile apps, and verifies its own access-token JWTs locally in `src/proxy.ts` (Next's
  middleware/proxy convention) using the same `JWT_ACCESS_SECRET` as the API — no network
  round trip on every navigation, with a silent-refresh fallback when the access token has
  expired but a valid refresh cookie remains. See `docs/AUTHENTICATION.md` for why the
  dashboard page still makes one authoritative API call server-side before rendering. The
  driver verification pages (`src/app/drivers/`) are Server Components for data fetching,
  with small Client Components for the interactive parts (accessible tabs, native
  `<dialog>`-based reject/suspend forms) driven by Server Actions — `ActionGuard.tsx`
  serializes those actions on a page so two in-flight submissions can't race each other's
  `revalidatePath` refresh.

## Why these choices

- **Modular monolith over microservices**: at Phase 1 scale, a single deployable backend is
  simpler to run, test, and reason about. Module boundaries inside it are what make splitting
  a service out later a refactor, not a rewrite.
- **pnpm workspaces**: fast, disk-efficient installs and strict (non-hoisted) dependency
  resolution — a package can only import what it actually declares, which catches "phantom
  dependency" bugs before they reach production.
- **Shared `packages/types`**: the backend and every client import the same request/response
  shapes, so an API change that breaks a client is a type error at build time, not a bug
  report from Nepal.

## Single Source of Truth (SSOT) — a non-negotiable rule

**One definition → one source → used everywhere.** Every piece of data, business rule,
configuration value, type, validation rule, permission, constant and system behaviour is
defined **once**. Everything else imports or derives from it. If it must change, the
authoritative source changes and every consumer follows. No duplicates, no conflicting
versions, no parallel sources of truth. The backend stays authoritative for business-critical
rules and data; clients present results and never re-derive them.

### Who owns what

| Concern                                                                      | The one source                                                                                                                                  | Everyone else                                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Shared types, status/state lists, pure shared rules (haversine, null-island) | `packages/types` (`TRIP_STATUSES`, `ACTIVE_TRIP_STATUSES`, `DRIVER_AVAILABILITY_STATES`, `DRIVER_STATUSES`, `haversineMeters`, `isNullIsland`)  | import it; derive zod enums / SQL lists / UI maps from the constants                                                 |
| Brand tokens, theme                                                          | `packages/shared`                                                                                                                               | apps read via their `useTheme`                                                                                       |
| Coordinate validation                                                        | `apps/api/src/modules/location/coordinates.ts` (`coordinateSchema`, `latitudeSchema`, `notNullIsland`)                                          | every validator composes these; clients never validate authoritatively                                               |
| Distance                                                                     | `haversineMeters` (`@yatri/types`); road distance/ETA via `RouteProvider`                                                                       | API and mobile import the same function                                                                              |
| GPS freshness & tracking thresholds                                          | `modules/tracking/tracking.config.ts` (from env)                                                                                                | availability, trip tracking and admin all call it; clients receive the values from the API                           |
| Availability state machine                                                   | `modules/availability/availability.machine.ts`                                                                                                  | service, SQL (`sqlIn(TRANSITIONAL_STATES)`), validators derive from it                                               |
| Go-online eligibility                                                        | `availability/eligibility.ts` (+ phase-3 `checkVerificationEligibility`)                                                                        | clients display the server's reasons                                                                                 |
| Trip status rules                                                            | `TRIP_STATUSES` + `trips/trip-machine.ts` (the one transition table)                                                                            | SQL uses `sqlIn(ACTIVE_TRIP_STATUSES)` (`ACTIVE_SQL`); all changes via `transition()`                                |
| Trip events and their wording                                                | `TRIP_EVENT_TYPES` + `describeTripEvent` (`@yatri/types`); persisted by `recordTripEvent`                                                       | announcements, system chat lines, notifications and the admin timeline render from it                                |
| Driver eligibility and ranking for a ride                                    | `dispatch/matching.ts` (`findEligibleDrivers`, `MatchingStrategy`)                                                                              | dispatch schedules offers; the estimate asks it "is a category available"; controllers and apps never restate a rule |
| Cancellation rules and the cancellation record                               | `trips/cancellation.ts` + `casTripStatus` (`cancelled_from_status`)                                                                             | the service applies it; apps show the fee the server reports                                                         |
| Vehicle categories and their fare overrides                                  | `vehicle_categories` table + `pricing/categories.ts` `pricingFor`                                                                               | the estimate, the request and the offer read it; defaults stay in `FARE_*` env                                       |
| The final fare and what a ride measured                                      | `pricing/pricing.ts` `finalFare` (the same `estimateFare` rules) + `trips/ride-actuals.ts` + the odometer in `tracking.service`                 | the completion path only chooses the inputs; apps display estimate and final side by side                            |
| Who a person is on a ride (participant / passenger checks)                   | `trips/access.ts` (`requireParticipant`, `requirePassenger`)                                                                                    | trips, chat, calls, sharing, payment and disputes all ask it; nobody re-checks ids by hand                           |
| Trip sharing links, their expiry and what the holder sees                    | `sharing/sharing.service.ts` + `ShareView` / `describeShareView` (`@yatri/types`)                                                               | the public page and JSON render the shared lines; the view is built from the passenger's live snapshot               |
| Which call provider carries media                                            | `calls/call-provider.ts` (`CALL_PROVIDER`)                                                                                                      | the call state machine and signalling never know the provider                                                        |
| Notifications (what triggers one, and its words)                             | `lib/notifications` (`notify`, `notifyThrottled`) + `TRIP_EVENT_META.notify` + `describeNewMessage` / `describeIncomingCall`                    | events, chat and calls all go through it; no module sends its own                                                    |
| "Your driver" / "the passenger" wording                                      | `counterpartLabel` (`@yatri/types`)                                                                                                             | notifications, announcements and the call/chat controllers                                                           |
| Waiting time and its fare effect                                             | `trips/waiting.ts` `computeWaiting` / `secondsSince` + `pricing/`                                                                               | apps display the server `waiting`; they add only elapsed display time                                                |
| Which ride buttons a person sees                                             | `mobile-ride/rideActions.ts` (presentation only; the server re-checks)                                                                          | both apps render `RideRoom`                                                                                          |
| Who may do what in the admin console | `ADMIN_PERMISSIONS`, `holdsPermission`, `PERMISSION_IMPLIES` (`@yatri/types`) + `requirePermission` (`admin/permissions.ts`), one per route | the admin menu (`apps/admin/src/lib/nav.ts`) and the permission editor use the same list; a test fails if a route has none |
| Auditing an admin action | `auditAdminAction` at the route (writes before the reply) or `recordAudit` in a handler; detail pages read `auditTrail` | handlers hold no audit code for plain actions; the audit viewer is `admin-audit.ts` and reading it is audited |
| Platform settings (fares, cancellation, waiting, availability, notification thresholds) | `PLATFORM_SETTINGS` + `checkSettingValue` (`@yatri/types`); value in `platform_settings`, default = the env var of the same name; read only through `settings/settings.service.ts` `getSetting` | `pricingConfig()`, `cancellationRules()`, the reminder sweeps and the request gate; apps get values from API responses and `GET /config/platform`; a test forbids other `env.*` reads of these |
| A reporting period and what "a day" means | `admin/admin-range.ts` `resolveRange` (`PLATFORM_TIME_ZONE`); rides belong to the day they were requested | dashboard, analytics, payments, notifications, audit and the rides list all call it |
| Operational and analytics figures | computed on request by `admin-dashboard.ts` / `admin-analytics.ts` from `trips`, `trip_payments`, users, driver and safety tables; no analytics store | definitions are printed on the analytics page; `countAvailableDrivers` sits beside `findEligibleDrivers` |
| Account suspension and who may suspend whom | `ACCOUNT_ADMIN_MOVES` (`@yatri/types`) applied by a guarded update in `admin-users.ts` | the user page shows only the moves the API says are possible |
| Role, account-status, payment-status and SOS-status wording for admins | `ROLE_LABELS`, `ACCOUNT_STATUS_LABELS`, `PAYMENT_STATUS_LABELS`, `SOS_STATUS_LABELS` (`@yatri/types`) | every admin page and the passenger profile import them |
| SOS states and their legal moves | `SOS_STATES` / `SOS_TRANSITIONS` / `sosStatesLeadingTo` (`@yatri/types`) applied by one guarded `UPDATE` in `safety/sos.service.ts` `transitionSos` | the API, the admin actions and the apps never list the states or moves again; the words are `describeSosStatus` |
| Incident states, categories and moves | `INCIDENT_*` constants and `INCIDENT_TRANSITIONS` (`@yatri/types`) applied in `safety/incidents.service.ts` `changeIncidentStatus` (row lock) | validators, the admin status form and the reporter wording (`describeIncidentStatus`) all derive from them |
| Who is told about an SOS or a report | `safety/safety-team.ts` `notifySafetyTeam` (permission `SAFETY_REVIEW`) through `lib/notifications`; the SOS follow-up link is a quiet `sharing` share (purpose `SOS`) | nothing else notifies the safety team; the other person on the ride is never told of an SOS |
| Ratings and their aggregate | `trips/ratings.service.ts` (`ratingSummary`, one row per rater per ride) + `describeRatingSummary` (`@yatri/types`) | the ride counterpart card, `/users/me/rating` and the admin low-rating view all read it; nobody averages ratings elsewhere |
| Emergency contacts | `safety/emergency-contacts.service.ts` (limit from `EMERGENCY_CONTACTS_MAX`) | owner-only routes; SOS reads them, nothing else does |
| Distance/duration/money formatting                                           | `format.ts` in `@yatri/types`                                                                                                                   | API messages and every app use it                                                                                    |
| Map/geocoder/router choice                                                   | `modules/location/providers/index.ts` (config only)                                                                                             | business code uses the interfaces                                                                                    |
| Configuration                                                                | `apps/api/src/config/env.ts` + `.env.example`                                                                                                   | thresholds reach clients through API responses (e.g. `updateIntervalsMs`, `onlineMaxAccuracyMeters`), not copies     |
| Spoken/UI wording                                                            | `describeTripEvent` (events); `mobile-location` `tripText.ts` / `driverPresenceText.ts` (snapshot text); `mobile-ride` (chat, call, offer text) | screens render, never restate                                                                                        |
| API calls from apps                                                          | `mobile-location/locationApi.ts`, `mobile-ride/rideApi.ts`, `mobile-auth/apiClient.ts`                                                          | screens never `fetch` directly                                                                                       |
| SQL literals for enums                                                       | generated with `lib/sql.ts` `sqlIn(...)` from the constants above                                                                               | migrations are historical snapshots and may keep literals                                                            |

### Known duplication (recorded, not silently left)

- The realtime protocol exists twice: TypeScript unions in `packages/types/src/realtime.ts`
  and zod schemas in `modules/realtime/gateway.ts`. Both are exercised by the realtime tests;
  the goal is to generate the TS types from shared zod schemas.
- Status wording exists in two registers by design: `TRIP_STATUS_LABELS` (`@yatri/types`, neutral labels for lists/admin) and `STATUS_TEXT` in `mobile-location/tripText.ts` (first-person sentences for the live view). Admin call/payment/freshness text maps are short labels for staff, distinct from the apps' role-worded sentences.
- Admin `STATE_TEXT` labels vs the driver app's presence wording (different audiences).
- `MAX_PLAUSIBLE_SPEED_MPS` (flag, 70) vs `trackingConfig.maxSpeedMps` (reject, 55): distinct
  by design, both named and documented.
- Migration literals (historical by nature).

### Shared runtime code

`@yatri/types` now contains runtime values (constants, tiny pure functions). It is compiled to
`dist/` (`pnpm --filter @yatri/types build`) for Node — the API's `predev`/`prestart` run it —
while Metro and TypeScript use `src/` (see its `exports`). Tests alias the source.
