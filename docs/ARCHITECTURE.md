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
src/modules/users/           # GET/PATCH /users/me (any authenticated role)
src/modules/drivers/         # GET/PATCH /drivers/me (DRIVER only)
src/modules/admin/           # GET /admin/me (ADMIN only)
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
  dashboard page still makes one authoritative API call server-side before rendering.

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
