# Yatri

Yatri (यात्री — "traveller" in Nepali) is a ride-sharing platform built for Nepal.

This repository is a TypeScript monorepo containing the passenger app, driver app, admin
dashboard, and backend API that make up the Yatri platform.

> **Status: Phase 28.** Sign-in, driver onboarding and verification, ride booking, matching, live
> tracking, calls and chat, safety, cash and online payments with refunds and driver payouts, support
> and compliance, fleets, business accounts, accessible rides, navigation, growth and loyalty,
> production service providers, and disability benefit verification are implemented and tested. What
> each phase added, and what it did **not** verify, is in `docs/PHASE_<n>.md` (start with
> [`docs/PHASE_1.md`](docs/PHASE_1.md), [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) and
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)). Nothing has been run against real payment, SMS, map,
> storage or error-reporting vendors yet: use `pnpm --filter @yatri/api providers:check` against staging.

## Tech stack

| Layer                    | Technology                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Passenger & Driver apps  | React Native + Expo, TypeScript                                                     |
| Admin dashboard          | Next.js (App Router), TypeScript                                                    |
| Backend API              | Node.js + Express, TypeScript                                                       |
| Database                 | PostgreSQL (`node-pg-migrate` migrations)                                           |
| Auth / sessions          | Phone+OTP (passenger/driver), email+password (admin), JWT + rotating refresh tokens |
| Realtime / rate limiting | Redis                                                                               |
| Tooling                  | pnpm workspaces, ESLint, Prettier, Vitest                                           |

The backend is a **modular monolith**: each domain (auth, users, trips, payments, dispatch, support,
growth, providers, and more) is its own module under `apps/api/src/modules`, mounted on a single Express app. No
microservices until there's a real operational reason for one.

## Project structure

```text
yatri/
├── apps/
│   ├── passenger/   # React Native (Expo) — rider-facing app
│   ├── driver/      # React Native (Expo) — driver-facing app
│   ├── admin/       # Next.js — internal operations dashboard
│   └── api/         # Node.js + Express — backend API (modular monolith)
├── packages/
│   ├── shared/      # Brand tokens (colors, spacing, typography) + small cross-platform utils
│   ├── types/       # Shared TypeScript contracts (API envelope, user, geo primitives)
│   ├── mobile-auth/ # Shared RN auth client: API client, secure token storage, AuthContext,
│   │                # accessible phone/OTP inputs (used by passenger + driver)
│   ├── mobile-ui/   # Theme hook and crash boundary shared by both apps
│   ├── mobile-ride/ # Ride room, offers, live trip view, navigation, accessibility screens
│   ├── mobile-location/, mobile-support/, mobile-business/, mobile-preferences/
│   │                # Place search; support, privacy and push; business accounts; settings,
│   │                # rewards, disability benefit and payouts screens
│   └── config/      # Shared TypeScript & ESLint base configuration
├── deploy/          # Container images, a full local stack, backup and restore scripts
├── scripts/         # Repository audits (unused dependencies, dead files, duplicate definitions)
├── docs/            # Architecture notes, operations, security and phase plans
└── .github/         # CI and release workflows, PR template
```

## Prerequisites

- Node.js 20+ (see `.nvmrc`)
- [pnpm](https://pnpm.io) 9+ — `corepack enable` will pick up the pinned version automatically
- PostgreSQL 15+ and Redis 6+ (for `apps/api` — Redis backs OTP rate limiting/cooldowns)
- For mobile apps: the [Expo Go](https://expo.dev/go) app, or Xcode/Android Studio for a
  simulator

## Getting started

```bash
# 1. Install all workspace dependencies
pnpm install

# 2. Configure and migrate the database
cp apps/api/.env.example apps/api/.env
# edit apps/api/.env — set DATABASE_URL/REDIS_URL for your local instances, and
# generate a JWT_ACCESS_SECRET:
#   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
pnpm --filter @yatri/api migrate:up

# 3. (Optional) seed a development admin account
#    edit ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD in apps/api/.env first
pnpm --filter @yatri/api seed:admin

# 4. Configure the admin app (must share the API's JWT_ACCESS_SECRET)
cp apps/admin/.env.example apps/admin/.env.local
# edit apps/admin/.env.local

# 5. Run an app
pnpm dev:passenger   # starts Expo for the passenger app
pnpm dev:driver      # starts Expo for the driver app
pnpm dev:admin       # starts the Next.js admin dashboard
pnpm dev:api         # starts the backend API with hot reload
```

With `OTP_DEV_MODE=true` (the `.env.example` default), `request-otp` returns the generated
code directly in its response — no real SMS provider needed for local development. See
[`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md#local-testing) for the full auth setup,
including running the automated test suite against a real database.

## Scripts

Run from the repository root; each fans out to every workspace package via pnpm.

| Command                               | Description                            |
| ------------------------------------- | -------------------------------------- |
| `pnpm build`                          | Build every app/package                |
| `pnpm lint`                           | Lint the whole repository              |
| `pnpm typecheck`                      | Type-check every app/package           |
| `pnpm format`                         | Format the repository with Prettier    |
| `pnpm --filter @yatri/api test`       | Run the backend's automated test suite |
| `pnpm --filter @yatri/api migrate:up` | Apply pending database migrations      |

## Architecture notes

- **`packages/types`** is the single source of truth for shapes shared between the backend
  and any client (the API response envelope, user roles, geo primitives). Add a new domain
  type there before duplicating it in an app.
- **`packages/shared`** holds brand tokens (`colors`, `spacing`, `typography`) so the
  passenger and driver apps render a consistent, accessible Yatri look without copy-pasting
  a palette. Colors are chosen to meet WCAG 2.1 AA contrast — see the comments in
  `packages/shared/src/theme.ts` before changing one.
- **Accessibility is part of the foundation, not an add-on.** Every auth screen uses proper
  `accessibilityRole`s/ARIA, announces state changes to screen readers, associates validation
  errors with their fields, and keeps every tappable control at a 44pt minimum hit target —
  including a single (not segmented) OTP field, since segmented "box per digit" widgets are a
  well-known screen-reader pain point.
- **`packages/mobile-auth`** is the shared auth client for the two Expo apps: API calls,
  secure on-device token storage, the `AuthContext`/`useAuth()` state machine, and the
  accessible phone/OTP input components. The passenger and driver apps compose it into their
  own screens/navigation rather than duplicating auth logic.
- **Driver verification is server-controlled, end to end.** A driver's `VERIFIED` status is
  set only by a guarded backend state transition after an admin approves every
  requirement — the mobile apps and admin dashboard both just display and act on that
  server state, never compute or assume it locally. See
  [`docs/PHASE_3.md`](docs/PHASE_3.md) for the full driver onboarding, document storage,
  and admin verification architecture.
- **Document storage is behind a `StorageProvider` abstraction** (local disk in
  development, swappable for a production object store) with signed, time-limited access
  URLs — no identity document is ever served from a predictable or permanent public path.
- **Support, disputes and privacy** (`docs/PHASE_14.md`): one ticket system for questions and ride problems, refunds
  that record what was paid back, accessible screens in both apps and a support workspace in the console, policy
  acceptance records, account-deletion and data-access requests, and retention rules kept as configuration.
  `packages/mobile-support` is the shared client. Rides, payments and the audit log are never deleted by it.
- **Advanced operations** (`docs/PHASE_15.md`): service zones and geofencing, configurable dynamic pricing
  with the fare always shown before confirming, ETA- and workload-aware dispatch with widening retries,
  driver limits and incentives, and a privacy-preserving demand and supply heatmap with a text equivalent.
  The fare arithmetic, geography and matching each still have exactly one implementation.
- **Fleets and driver operations** (`docs/PHASE_16.md`): fleets, driver-to-vehicle assignment, a vehicle
  lifecycle, expiry monitoring with automatic reminders, inspection and maintenance records, and an operational
  status for drivers kept apart from account, verification, availability and ride status. An ineligible vehicle
  or driver is never offered a ride; documents stay in the one document system.
- **Fraud, risk and trust** (`docs/PHASE_17.md`): one central rule table raises signals from the records other
  systems already own (sign-in events, rides, ratings, disputes, refunds, location flags, incentives), derives a
  risk level, and gives administrators investigation, notes, temporary restrictions and the existing suspend and
  restore, all audited. It never suspends on its own and never acts on a single signal.
- **Business and institutional transport** (`docs/PHASE_18.md`): organizations with their own roles (separate from platform
  roles), members, a booking policy, rides booked for employees, approvals, spending limits, cost-centre tags, monthly
  statements on the existing payment records, and usage reports. A business ride is an ordinary ride; the booker and the
  rider stay different people.
- **Passenger experience and settings** (`docs/PHASE_19.md`): one authoritative preferences model (appearance, language,
  accessibility, notifications, privacy, safety, ride defaults) consumed by both apps, the notification service and the API;
  recent destinations, device management, and administrator-managed platform defaults. A preference never overrides a
  server rule.
- **Multi-city service** (`docs/PHASE_20.md`): cities as data (status, hours, vehicle types, fares, cancellation and waiting
  values, payment options, driver requirements), bounded by the existing service zones. A driver and a passenger operate
  under the city their location is in; rides cannot be made where service is off, outside hours or across a city line.
- **Reliability and offline recovery** (`docs/PHASE_21.md`): one background job runner and registry (locked, timed out,
  recorded, shown in admin), idempotent actions with an `Idempotency-Key` the apps resend after a dropped connection,
  notification retry with back-off and deduplication, payment reconciliation, a connectivity banner that says in words when
  the screen may be out of date, and sessions that survive being offline.
- **Inclusive and accessible rides** (`docs/PHASE_22.md`): passengers state what they need (wheelchair accessible vehicle,
  help, blind or low vision, deaf or hard of hearing, service animal, pickup instructions, how to be reached); drivers declare
  vehicle features, approved by an administrator where checking is needed; the matching engine offers a ride only to vehicles
  with what it needs; a text version of the pickup; vibration and simpler-screen preferences; private by design.
- **Advanced navigation** (`docs/PHASE_23.md`): the route of an active ride through the one route provider abstraction (steps,
  geometry, traffic flag), turn-by-turn directions and deviation detection decided by the server, automatic rerouting, phases of
  the approach (approaching, near, at, leaving), arrival detection, text-only trip progress for passengers, route and ETA metrics
  for operations, and a low-weight risk signal only for a pattern across rides.
- **Growth and loyalty** (`docs/PHASE_24.md`): one promotion and reward engine on the server: promotions, coupons, first-ride offers,
  referrals, win-back offers, message campaigns, reward points (an append-only ledger with expiry), usage limits, fraud signals
  through the risk system, an admin campaign dashboard, and offers, rewards and invites in the rider app. A promotion never
  changes a fare; Yatri pays the discount.
- **Production service providers** (`docs/PHASE_25.md`): one interface per outside need (sign-in codes, push, maps and routes,
  digital payments, files, calls, live updates, email, error reporting), the vendor chosen by server configuration per
  environment (development, staging, production), one vendor-call function (deadline, named failures, safe retries, circuit
  breaker, usage counters), stand-ins refused outside development, online payment with database-enforced idempotency and an exact
  amount check, and a status-only admin screen. No vendor is called by business logic.
- **Disability benefit verification** (`docs/PHASE_26.md`): voluntary, consented and private verification of a disability identity
  card (manual review, with an official check only if one is ever connected), a server-owned state machine a client can never
  set, duplicate and expiry handling, an accessible reviewer workspace with every decision audited, and a benefit that is an
  ordinary promotion-engine campaign. Drivers never see card details.
- **Disability benefits and accessible ride services** (`docs/PHASE_27.md`): benefit policies as configurable campaigns (discount,
  loyalty points, vehicle types, cities, limits, validity, stacking, companion rules) that only a verified benefit can use, a fare
  shown as standard fare, disability benefit, loyalty benefit, other discount and amount payable, a companion flag, extra boarding
  time, a wider search for accessible requests, and an accessible admin view with abuse signals.
- **Online money out, push and a live provider check** (`docs/PHASE_28.md`): refunds of online payments through the provider (or staff
  in its dashboard) with idempotency, driver payouts for online rides (hold, once-only rides, encrypted accounts, four-eyes, audited),
  push registration in both apps, and `providers:check` to verify every vendor with real test credentials.
- Running it for real: [`docs/OPERATIONS.md`](docs/OPERATIONS.md) (architecture, deployment, backups,
  monitoring, incident recovery, release and rollback) and [`docs/SECURITY.md`](docs/SECURITY.md) (the controls,
  what was audited, what is still open). Container images and a full local stack are in [`deploy/`](deploy/).
- See [`docs/AUTHENTICATION.md`](docs/AUTHENTICATION.md) for the full authentication
  architecture, [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the system overview, and
  [`docs/PHASE_1.md`](docs/PHASE_1.md)/[`docs/PHASE_2.md`](docs/PHASE_2.md)/
  [`docs/PHASE_3.md`](docs/PHASE_3.md) for what shipped in each phase.

## License

[MIT](LICENSE)
