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
- Groups of states (active, assigned, terminal) are constants in `@yatri/types`. An app never re-lists
  statuses with `||`; it imports the group. A fare is only ever produced by `pricing/` (estimate and
  final use the same function); an app displays it and never sends one.
- "Is this person on this ride?" is `trips/access.ts`. A feature about someone's ride calls
  `requireParticipant` / `requirePassenger`; it never compares `passenger_id` / `driver_id` itself.
  Notifications go through `lib/notifications`; nothing sends its own.
- A legal move of a state machine (SOS, incident, trip, availability) is a constant table in
  `@yatri/types` applied by ONE guarded update. Routes, admin forms and apps derive from the table
  (`...LeadingTo`, `INCIDENT_TRANSITIONS[status]`); they never re-list allowed states.
- Every sensitive admin read and every safety/admin action is written with `lib/audit.ts`
  `recordAudit` into the ONE `audit_log` (never the reporter-visible tables, never a per-feature log,
  never a phone number or message body in `detail`). A new admin capability is a new
  `ADMIN_PERMISSIONS` entry, not a role check.
- A safety event that could involve the other participant (SOS) is NOT a trip event: trip events go
  to both people. It uses its own per-person message (`sos_state`) and the safety team's notification.
- A value operations may change without a deploy is a `PLATFORM_SETTINGS` entry (@yatri/types) whose
  default is the env var of the same name, read only through `getSetting`; never `env.X` in a
  rule, never a copy in an app. Every admin route names ONE permission (`requirePermission`) and
  audits its action (`auditAdminAction`). Periods come from `resolveRange`; screens never build
  their own date maths, and shared words (roles, statuses, payment states) come from @yatri/types.
- A problem with a ride is a support ticket (category kind `DISPUTE`, a `trip_id` reference); never a
  second "dispute" or "complaint" record. A refund refers to `trip_payments`, is worked out by
  `pricing/refunds.ts` and never edits the payment. Categories, priorities, escalation hours, policy
  versions and retention periods are rows an admin edits (with a reason, audited), never a list in an
  app or an env value. Policy words are never stored: only the version and the address. Retention is
  `retention_policies`; only `runRetention` deletes by age. Files in support use the ONE upload path
  (sniffed type, random key, signed link).
- Do not put a backslash inside a SQL string written from a shell command: use `ESCAPE '!'` with
  `likeContains` for searches.
- If you discover a duplicate, consolidate it or add it to "Known duplication" in the doc.
