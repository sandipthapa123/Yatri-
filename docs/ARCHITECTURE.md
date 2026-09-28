# Architecture

## Overview

Yatri is a pnpm-workspaces monorepo split into `apps/` (deployable applications) and
`packages/` (shared code with no runtime of its own).

```
apps/passenger  ─┐
apps/driver     ─┼─► packages/shared, packages/types
apps/admin      ─┘
apps/api        ───► packages/types
```

Only `packages/types` and `packages/shared` are shared across the client apps and the API —
this keeps the dependency graph a strict DAG with no app depending on another app.

## Backend: modular monolith

`apps/api` is a single Express process. Each domain lives in its own module under
`src/modules/<domain>/`, exposing a router and a controller:

```
src/modules/health/
├── health.controller.ts
└── health.routes.ts
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
- **Redis** is wired for future realtime features (driver presence, live location fanout,
  pub/sub) via `src/config/redis.ts`, but nothing holds an open connection today. Phase 1 has
  no realtime feature, so nothing should pay for one.

## Client apps

- **Passenger & driver** are Expo-managed React Native apps sharing `packages/shared`'s brand
  tokens and `packages/types`'s contracts. Metro is configured for the pnpm workspace
  (`metro.config.js` watches the repo root and enables symlink resolution) so workspace
  packages resolve without hoisting hacks.
- **Admin** is a Next.js App Router project. It shares the same `packages/types` contracts as
  the mobile apps so a future admin API client and the mobile apps agree on shapes by
  construction, not by convention.

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
