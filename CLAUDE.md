# Yatri — project rules

Monorepo: `apps/api` (Express + Postgres + Redis + WebSocket), `apps/passenger` and
`apps/driver` (Expo), `apps/admin` (Next.js), `packages/*` (shared; `mobile-ride` holds the ride,
chat, call and offer clients both apps render).

## Non-negotiables

1. **Single Source of Truth.** Define each type, constant, status list, validation rule,
   threshold, permission and business rule **once** and reuse it. Search before creating;
   derive enums, zod schemas, SQL lists and UI maps from one exported constant; keep
   thresholds in config and let clients read them from the API. If you change something,
   change its one owner. The owner table and the recorded exceptions are in
   `docs/ARCHITECTURE.md` ("Single Source of Truth"). Use the `single-source-of-truth` skill
   when adding or reviewing shared concepts. Report any duplicate you find or consolidate.
2. **The backend is authoritative** for eligibility, state transitions, distances, freshness,
   permissions and prices. Clients present results.
3. **Accessibility is a feature**: every state must be available as text with proper roles,
   announcements for changes, no colour-only meaning, 44 pt targets. See
   `docs/ACCESSIBILITY_TESTING.md`.
4. **Location is sensitive**: minimum retention, no history tables, RBAC-gated admin views.

## Commands

```bash
pnpm install
pnpm lint && pnpm typecheck
pnpm --filter @yatri/types build          # compiled shared package (needed to run the API from dist)
pnpm --filter @yatri/api migrate:test:up && pnpm --filter @yatri/api test   # needs Postgres + Redis
pnpm --filter @yatri/mobile-location test
pnpm --filter @yatri/mobile-ride test
```
