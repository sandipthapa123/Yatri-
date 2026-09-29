# Phase 3 — Driver Onboarding & Verification

## Goal

Build the complete foundation for passenger profiles, driver onboarding, vehicle
registration, document submission, and admin-driven driver verification — so that a
driver can only become eligible to accept rides (a later phase) once the platform has
actually verified them. No ride booking, matching, tracking, or payments yet.

## In scope

- [x] Database: `driver_details`, `vehicle_categories`, `vehicles`, `document_types`,
      `documents` (unified driver+vehicle table via an `owner_type` discriminator),
      `driver_verification_events` (append-only audit trail), `notifications` — all via
      `node-pg-migrate` migrations, with the `driver_profiles.status` enum expanded to
      `NOT_STARTED` / `IN_PROGRESS` / `SUBMITTED` / `UNDER_REVIEW` / `VERIFIED` /
      `REJECTED` / `SUSPENDED`
- [x] `StorageProvider` abstraction (`upload`/`download`/`delete`/
      `createTemporaryAccessUrl`) with a local-disk development implementation and
      HMAC-signed, time-limited access URLs — no document is ever served from a
      predictable or permanent public path
- [x] Upload pipeline: magic-byte file-type detection (never trusts client
      Content-Type/extension), size limits, generated (non-guessable) storage keys,
      replacement of rejected/expired documents, rejection of an already-approved
      document's replacement
- [x] Driver onboarding API: `GET`/`PATCH /drivers/me/onboarding` (returns live
      progress — which steps are complete, what's still missing, and the driver's own
      previously-saved answers, so a resumed session never re-asks for saved data),
      `POST /drivers/me/submit-verification`, `GET /drivers/me/verification-status`
- [x] Vehicles API: configurable categories (`GET /vehicles/categories`, seeded with
      Motorcycle/Scooter/Car/SUV but not hard-coded), `POST`/`GET /vehicles`,
      `PATCH /vehicles/:id` (edits reset verification to `PENDING`)
- [x] Documents API: configurable document types (`GET /documents/types`, each flagged
      required/optional and driver- or vehicle-scoped), `POST`/`GET`/`DELETE /documents`,
      signed download URLs
- [x] Two-tier eligibility logic: `computeOnboardingProgress` (lenient — "has the driver
      entered this yet") drives the onboarding wizard; `checkVerificationEligibility`
      (strict — every requirement `APPROVED` and unexpired) is the _only_ function
      allowed to decide a driver may become `VERIFIED`. The client can never set
      `VERIFIED` directly — every transition goes through a guarded, atomic
      `transitionDriverStatus(fromStatuses, toStatus)` call
- [x] Admin API: `GET /admin/drivers` (search/filter/paginate), `GET /admin/drivers/:id`
      (auto-transitions `SUBMITTED` → `UNDER_REVIEW` on first view),
      `GET /admin/drivers/:id/documents`, `GET /admin/drivers/:id/verification-history`,
      `POST /admin/drivers/:id/verify|reject|suspend`,
      `POST /admin/documents/:id/approve|reject`,
      `POST /admin/vehicles/:id/approve|reject` — every admin route is
      `authenticate` + `requireRole('ADMIN')`, and every mutating action is recorded in
      `driver_verification_events` (actor, previous/new status, reason, timestamp)
- [x] Notification foundation: a `NotificationProvider` interface (console
      implementation for now) plus a DB-backed `notifications` table, fired on
      submission, document approval/rejection, and driver approval/rejection/suspension
      — not tied to a specific push/SMS vendor
- [x] Passenger profile (mobile): view/edit name, change profile picture (validated,
      private-storage upload), view phone number and account status, sign out,
      self-service account deactivation
- [x] Driver onboarding wizard (mobile): Personal info → Driver info → Vehicle →
      Documents → Review/submit, each step server-validated, prefilled from the
      driver's own saved data on resume, with a visible "Step N of 5" progress
      indicator; a post-submission status screen shows the live status as explicit text
      (never color alone) and, if rejected, the reason plus a path back into the wizard
      to fix and resubmit
- [x] Admin verification dashboard (web): searchable/filterable driver list; a driver
      detail page with accessible tabs (driver info, vehicles, documents, history);
      approve/reject controls for documents, vehicles, and the driver as a whole,
      with a required reason on every rejection/suspension; full verification history
- [x] Accessibility: every onboarding/admin control has a proper role, label, and
      keyboard path; validation and status are always exposed as text, never
      color-only; admin's reject/suspend dialogs use the native `<dialog>` element
      (built-in focus trap and Escape-to-close) with per-instance unique IDs; the admin
      tab strip implements the WAI-ARIA APG tabs pattern (roving tabindex, arrow/Home/
      End key navigation)
- [x] Automated backend tests (93 passing) against a real local Postgres + Redis,
      covering onboarding save/resume/submit, document upload validation (valid/
      invalid/oversized/replacement), the full verification lifecycle including
      resubmission after rejection, cross-driver and cross-role authorization
      isolation, and security cases (malicious uploads, malformed IDs, expired
      documents, invalid state transitions)
- [x] Manual end-to-end verification of the complete flow (see "How this was tested"
      below), since the admin web UI's Server-Action-driven interactions aren't
      exercised by the backend test suite

## Explicitly out of scope (future phases)

- Ride requests, driver-passenger matching, live location tracking, maps
- Fare calculation, payments, payouts
- Ratings, SOS, trip sharing, promotions
- Real push/SMS delivery (the `NotificationProvider` interface is ready for one)
- Production object storage (the `StorageProvider` interface is ready for one; local
  disk is the only implementation so far)

## Architectural decisions worth knowing

- **One `documents` table, not `driver_documents` + `vehicle_documents`.** An
  `owner_type` discriminator plus a check constraint (`documents_owner_shape_check`)
  enforces that exactly one of `driver_user_id`/`vehicle_id` is set, matching
  `owner_type`. This avoids duplicating near-identical review/status/audit logic across
  two tables.
- **No separate `verification_applications` table.** `driver_profiles.status` is
  already the single source of truth for a driver's current state;
  `driver_verification_events` is purely an append-only audit trail, never a second
  place that state could disagree with the first.
- **Eligibility is computed twice on purpose, at different strictness.** The
  onboarding wizard needs to know "is this step _filled in_"; the admin approval path
  needs to know "is every requirement _approved and unexpired_, right now." Conflating
  these would either block a wizard on approval-only concerns (a document not yet
  reviewed shouldn't stop a driver from finishing the wizard) or let an incomplete
  application slip through review (a document merely uploaded is not a document
  approved).
- **Postgres `DATE` columns are read back as plain `YYYY-MM-DD` strings, not `Date`
  objects** (`apps/api/src/config/database.ts` sets a custom `pg` type parser for OID
  1082). `pg`'s default behavior parses `DATE` into a JS `Date`, which
  `JSON.stringify` then serializes as a full UTC timestamp
  (`"1995-01-01T00:00:00.000Z"`) — silently wrong for a value that has no time
  component, and exactly the kind of mismatch that broke the onboarding wizard's
  resume-prefill validation during testing. Fixed once, centrally, for every date
  column in the system.
- **Admin document/vehicle actions never get disabled once approved.** `setDocumentReview`
  and `setVehicleVerification` have no status guard — an admin can re-review anything,
  any time, and each action is still recorded in the audit trail. The one time this
  matters for the client: re-approving an already-approved item is a safe no-op, not
  an error.
- **Admin page actions are guarded against concurrent submission.** Several
  independent approve/reject forms share one page, each an independent
  `useActionState`. Firing more than one of their Server Actions at once races against
  Next's `revalidatePath` — the first one to resolve can interrupt a second still in
  flight, which testing surfaced as a document's approval silently not registering
  while its button stayed stuck showing "Working…" forever. `ActionGuard.tsx` fixes
  this with a page-level, `useRef`-backed lock (checked synchronously, so it can't be
  raced by React's own render lag): only one guarded action runs at a time; any others
  fired while it's in flight are safely dropped, not corrupted, and the button remains
  fully usable for another click.

## How this was tested

- `cd apps/api && pnpm test` — 93 tests against a real local Postgres 16 + Redis,
  covering every category above.
- `pnpm typecheck`, `pnpm lint`, `pnpm build` — clean across every workspace
  (`packages/types`, `packages/shared`, `packages/mobile-auth`, `apps/api`,
  `apps/admin`, `apps/passenger`, `apps/driver`).
- Full manual end-to-end run against the real API + a real Postgres/Redis:
  a driver was taken from account creation through onboarding, vehicle
  registration, document upload, and submission entirely through the same HTTP API the
  apps call; an admin then reviewed and approved every document, the vehicle, and the
  driver through the actual admin web UI (Playwright-driven, real Chromium, not a
  mocked DOM), confirming the driver reaches `VERIFIED` and the full audit history is
  recorded correctly.
- The passenger and driver Expo apps were each bundled end-to-end with Metro
  (`expo export`) to confirm every new screen, native module (`expo-image-picker`,
  `expo-document-picker`), and cross-package import resolves correctly at runtime, not
  just under `tsc`.
- The admin web app was built for production (`next build`) and run in dev mode
  against the live API to drive the flow above; this is also how the Server Action
  concurrency bug above was found and confirmed fixed (isolated single clicks and a
  synthetic rapid-click race were both retested after the fix).

## Notes for the next phase

- `driver_profiles.status === 'VERIFIED'` plus `checkVerificationEligibility` staying
  true is what ride matching should gate on — a `SUSPENDED` driver, or one with a
  document that's since expired, must not be treated as eligible even if their status
  column still briefly reads `VERIFIED` in a stale cache.
- The `notifications` table and `NotificationProvider` interface are ready for a real
  push/SMS backend; nothing about ride booking should hard-code a delivery mechanism
  either.
- `vehicle_categories` and `document_types` are DB-driven and admin-editable in
  principle (no admin UI for editing them yet) — ride booking's vehicle-category
  filtering (e.g., "only show Car/SUV drivers for a 4-seat request") should read from
  the same table, not a hard-coded list.
