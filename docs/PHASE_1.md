# Phase 1 — Foundation

## Goal

Stand up the Yatri monorepo, its tooling, and the passenger app's foundation — without
building ride booking yet.

## In scope

- [x] Monorepo structure (`apps/*`, `packages/*`) with pnpm workspaces
- [x] Shared TypeScript config, ESLint config, and brand/type packages
- [x] Passenger app: entry point, navigation structure, branding, home screen, loading
      state, error state, accessible UI foundation
- [x] Driver app: entry point and branding placeholder
- [x] Admin dashboard: Next.js foundation with loading/error routes
- [x] Backend API: Express app skeleton, health endpoint, Postgres-ready connection pool,
      Redis-ready (unconnected) client, modular-monolith module layout

## Explicitly out of scope (future phases)

- Ride booking flow (request, match, fare, track) — passenger app
- Driver online/offline state, trip acceptance, navigation — driver app
- Auth (passenger, driver, admin) and session management
- Fleet, trip, and payout views — admin dashboard
- Any domain module beyond `health` — backend API (users, trips, payments, …)
- Realtime features that would actually connect to Redis (live driver location, presence)
- Database schema/migrations — `apps/api/prisma` or equivalent lands with the first real
  domain module that needs persisted data

## Notes for the next phase

- `packages/types` currently only has identity/geo/API-envelope primitives. Ride and trip
  domain types belong there once booking starts, not duplicated per app.
- The passenger app's `RootNavigator` has one route (`Home`) on purpose — it exists so adding
  a booking flow is "add a screen to the stack," not "introduce navigation."
