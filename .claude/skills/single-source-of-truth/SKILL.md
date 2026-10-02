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
- Where a ride may start or end is `checkZoneAccess` over the one `pointInPolygon` (`@yatri/types`); a
  price multiplier is decided ONLY by `operations/surge.ts` and applied by `pricing/pricing.ts`, locked on
  the ride, and shown by `FareBreakdown` + `describeSurge` (an app never computes it). Who is offered a ride
  is `dispatch/matching.ts` (eligibility, strategy, `searchRadius`), driver limits are
  `availability/driver-limits.ts`, demand is `operations/demand.ts`, a rule time window is `windowActive`,
  and a bonus is calculated only in `evaluateIncentives` and recorded as an award, never as a fare change.
- Who drives which vehicle is `vehicles.driver_user_id` and nothing else; a vehicle lifecycle move is
  `setLifecycle` (table in `@yatri/types`); a driver operational status is its own model, apart from account,
  verification, availability and ride; "may this be used for rides" is `fleet/eligibility.ts` (never a stored flag);
  what expires is `expiryItems` over the existing document tables with `expiryState`; "today" is `todayKey()` and
  the database session time zone. Maintenance records point only at a vehicle.
- What is suspicious and how much is `RISK_RULES` (types) with one query per rule in `risk/detectors.ts`; a
  risk level is `deriveRiskLevel` over the events, the restriction and `users.status` and is never stored; "is
  restricted" is `RISK_RESTRICTED_SQL`; a restriction is written only by `risk/restriction.service.ts`; suspend and
  restore stay in `admin-users`. A risk event holds counts and ids only (no phone, address or coordinates).
- What an organization member may do is `ORG_ROLE_PERMISSIONS` (organization roles are NOT platform roles); a booking
  is checked only by `evaluateBooking`; a business ride is an ordinary `trips` row (`booked_by` is the booker, `passenger_id`
  the rider) created only through `requestAndOffer`; what it costs an organization is `ORG_TRIP_COST_SQL`; how it is paid is
  `ORG_PAYMENT_MODE_METHOD`; a statement only groups `trip_payments` (`statement_id`) and never stores an amount.
- A personal setting is a row of `PREFERENCE_DEFS` (types) stored by `preferences.service.ts`; the apps read it through
  `useUiPreferences` and never keep their own copy; whether a notification is pushed is `shouldDeliver` over
  `notificationCategoryOf`; a preference is never a business rule and a platform-controlled default is a platform setting.
- Where Yatri operates is `service_zones` (one geofence); a place's city is `cityAtPoint` (zone `city_id`); whether service
  is on is `cityServiceState` via `assertRideService`; a city's fare, waiting and cancellation values are the platform setting
  overlaid by `city_settings` in `city-rules.ts` (`pricingConfigFor`, `cancellationRulesFor`). No code or app names a city.
- Time-based work is a line in `modules/jobs/registry.ts` run by `modules/jobs/jobs.ts`; never add a `setInterval` for platform
  work. An action that must not happen twice goes through `middleware/idempotency.ts` (client: `withIdempotentRetry`). A
  network failure is `ApiError` code `NETWORK_ERROR` from the one `request()`; only a 401/403 ends a session (`shouldEndSession`).
- Accessibility needs, communication choices and pickup instructions are defined in `@yatri/types` `accessibility.ts` and stored
  only by `modules/accessibility/accessibility.service.ts`; vehicle features hang off `vehicles` (`vehicle_accessibility`) and
  are matched by `attributesSatisfiedSql` in the one matching engine. Never infer a need, never copy the details into a
  notification, chat, event or shared link, and never let a driver mark a feature approved.
- A route between two points is asked of the `RouteProvider` only (`computeEta`); the route and guidance of an active ride are
  `navigation/navigation.service.ts` fed by the one accepted-fix path in `tracking.service.ts`; distance to a line, progress
  along it and simplifying it are in `@yatri/types` `geo.ts`; the phase of an approach is `approachPhase`. Navigation never touches
  the fare, never stores a track, and a deviation is a count, not a penalty.
- Offers, discounts, eligibility and limits are `@yatri/types` `growth.ts` rules applied only by `modules/growth/engine.ts` (quote at
  the estimate, reserve in the request transaction, settle on the final fare); reward points are `reward_ledger`, written only by
  `growth/loyalty.ts`. A promotion never alters a fare: record the platform-paid amount on the ride and charge what is owed. Apps never
  hold a campaign rule or compute an amount.
- Do not put a backslash inside a SQL string written from a shell command: use `ESCAPE '!'` with
  `likeContains` for searches.
- If you discover a duplicate, consolidate it or add it to "Known duplication" in the doc.

## Service providers (Phase 25)

- The vendors for each need, the variable that picks each, what each requires, which are development stand-ins and what a person is
  told on failure are `@yatri/types` `providers.ts`; `config/env.ts` builds its enums from it. Never list vendors elsewhere.
- Every outbound vendor HTTP call goes through `modules/providers/http.ts` (`providerRequest`): no raw `fetch`, no per-adapter
  timeout, retry, error mapping or usage logging. Business code imports an interface (`getSmsProvider`, `getStorageProvider`,
  `getPaymentGateway`, `sendEmail`, `reportError`, …), never a vendor class, SDK or address.
- Which environment may use which vendor is `providerProblems` only. A new vendor is one adapter, one entry in `providers.ts`,
  one case in that need's factory: no other file changes.
- An online payment is marked paid only by `markPaidByProvider`, after a server-to-server lookup for the exact amount.

## Disability benefit verification (Phase 26)

- The verification states, who may enter each, the card rules and every word of the flow are `@yatri/types` `disability.ts`;
  only `modules/disability/verification.service.ts` moves a verification (`applyMove`, under the row lock).
- "Is this rider's benefit active" is `benefitActiveFor` / `benefitActiveSql` and nothing else. The benefit is a growth campaign
  (`requiresDisabilityVerified`); never a second discount engine, points ledger or eligibility list.
- Consent is `compliance_policies`/`compliance_records` (`withdrawConsent`); the driver-sharing choice is the preference
  `shareDisabilityStatusWithDriver`. Card documents use the storage provider and the shared file checks.
