# Yatri

Yatri (यात्री — "traveller" in Nepali) is a ride-sharing platform built for Nepal.

This repository is a TypeScript monorepo containing the passenger app, driver app, admin
dashboard, and backend API that make up the Yatri platform.

> **Status: Phase 1 — foundation.** The project structure, tooling, and the passenger app's
> entry point/navigation/branding are in place. Ride booking and the driver/admin
> feature sets land in later phases.

## Tech stack

| Layer                   | Technology                                        |
| ----------------------- | ------------------------------------------------- |
| Passenger & Driver apps | React Native + Expo, TypeScript                   |
| Admin dashboard         | Next.js (App Router), TypeScript                  |
| Backend API             | Node.js + Express, TypeScript                     |
| Database                | PostgreSQL                                        |
| Realtime (future)       | Redis-ready architecture (no live dependency yet) |
| Tooling                 | pnpm workspaces, ESLint, Prettier                 |

The backend is a **modular monolith**: each domain (health today; users, trips, and payments
later) is its own module under `apps/api/src/modules`, mounted on a single Express app. No
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
│   └── config/      # Shared TypeScript & ESLint base configuration
├── docs/            # Architecture notes and phase plans
└── .github/         # CI workflow, PR template
```

## Prerequisites

- Node.js 20+ (see `.nvmrc`)
- [pnpm](https://pnpm.io) 9+ — `corepack enable` will pick up the pinned version automatically
- PostgreSQL 15+ (for `apps/api`)
- For mobile apps: the [Expo Go](https://expo.dev/go) app, or Xcode/Android Studio for a
  simulator

## Getting started

```bash
# 1. Install all workspace dependencies
pnpm install

# 2. Configure the API
cp apps/api/.env.example apps/api/.env
# edit apps/api/.env with your local Postgres connection string

# 3. Run an app
pnpm dev:passenger   # starts Expo for the passenger app
pnpm dev:driver      # starts Expo for the driver app
pnpm dev:admin       # starts the Next.js admin dashboard
pnpm dev:api         # starts the backend API with hot reload
```

## Scripts

Run from the repository root; each fans out to every workspace package via pnpm.

| Command          | Description                         |
| ---------------- | ----------------------------------- |
| `pnpm build`     | Build every app/package             |
| `pnpm lint`      | Lint the whole repository           |
| `pnpm typecheck` | Type-check every app/package        |
| `pnpm format`    | Format the repository with Prettier |

## Architecture notes

- **`packages/types`** is the single source of truth for shapes shared between the backend
  and any client (the API response envelope, user roles, geo primitives). Add a new domain
  type there before duplicating it in an app.
- **`packages/shared`** holds brand tokens (`colors`, `spacing`, `typography`) so the
  passenger and driver apps render a consistent, accessible Yatri look without copy-pasting
  a palette. Colors are chosen to meet WCAG 2.1 AA contrast — see the comments in
  `packages/shared/src/theme.ts` before changing one.
- **Accessibility is part of the foundation, not an add-on.** The passenger app's loading and
  error states use proper `accessibilityRole`s, announce state changes to screen readers, and
  keep every tappable control at a 44pt minimum hit target.
- See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/PHASE_1.md`](docs/PHASE_1.md)
  for more detail.

## License

[MIT](LICENSE)
