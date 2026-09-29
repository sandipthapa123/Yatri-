# Architecture

## Overview

Yatri is a pnpm-workspaces monorepo split into `apps/` (deployable applications) and
`packages/` (shared code with no runtime of its own).

```
apps/passenger  ─┐
apps/driver     ─┼─► packages/mobile-auth ─► packages/shared, packages/types
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
src/modules/admin/           # Driver review, document/vehicle approval, verification history
                              # (ADMIN only) — see docs/PHASE_3.md
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
