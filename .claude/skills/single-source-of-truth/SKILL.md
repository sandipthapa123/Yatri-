---
name: single-source-of-truth
description: Yatri's Single Source of Truth rule — before adding any type, constant, status list, validator, threshold or rule, find its one owner and reuse it; derive everything else from it. Use when adding or reviewing shared concepts in this repo.
---

Follow the generic `single-source-of-truth` skill (global) and the **owner table and known
exceptions in `docs/ARCHITECTURE.md` → "Single Source of Truth"**, which is the one place that
lists where each Yatri concept lives (this file deliberately does not repeat it).

Yatri-specific reminders:

- New status/state? Add it to the constant array in `packages/types`; the type, zod enum,
  SQL (`sqlIn`) and UI maps all derive from it.
- New threshold? Add it to `apps/api/src/config/env.ts` + `.env.example`, expose it to clients
  through an API response, never hardcode it in an app.
- New coordinate/geo rule? Extend `coordinates.ts` / `packages/types/src/geo.ts`.
- New spoken text? `tripText.ts` / `driverPresenceText.ts`.
- A decision about WHO or WHICH or HOW MUCH (eligibility, ranking, cancellation policy, fares) is
  one function in one service module (`dispatch/matching.ts`, `trips/cancellation.ts`,
  `pricing/`). Controllers call it, apps display what the server returns, and a new rule is a new
  strategy or config value there — never a branch in a controller or a screen.
- If you discover a duplicate, consolidate it or add it to "Known duplication" in the doc.
