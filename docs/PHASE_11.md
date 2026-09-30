# Phase 11: admin operations and analytics

## What existed, what was built

| Area                 | Before                                          | Now                                                                                                            |
| -------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Access control       | ADMIN role opened everything except three reads | 16 permissions; **every** admin route names one (`requirePermission`); read from the database on every request |
| Live dashboard       | none (a landing page)                           | `/admin/dashboard`: active rides, online / available / stale drivers, pending applications, payments, safety   |
| Analytics            | none                                            | `/admin/analytics`: volume, completion and cancellation rates, revenue, earnings, activity, safety, ratings    |
| Users                | none                                            | list (search, filter, sort, page), detail, suspend and reactivate with a reason                                |
| Drivers and vehicles | verification flow                               | same flow, now audited; vehicles list with filters and expiring papers                                         |
| Rides                | list by status and search                       | + live/finished groups, period, sort, fare                                                                     |
| Payments             | on a ride only                                  | payments list, summary and driver earnings (read-only, audited)                                                |
| Wallets and payouts  | (do not exist)                                  | **still do not exist**: Yatri takes cash and holds no money. Screens say so instead of showing empty tables    |
| Notifications        | stored and sent                                 | monitoring by type, period and read state (never the message text)                                             |
| Platform settings    | environment only                                | `platform_settings` store, admin editor with version check, reason, confirmation; apps read it from the API    |
| Vehicle categories   | table, no editor                                | editor: name, order, on/off, fare overrides; the last active category cannot be switched off                   |
| Audit                | reads and safety actions                        | every sensitive admin action, plus an audit viewer (reading it is audited)                                     |
| Administrators       | permissions set by hand in the database         | manage permissions in the console: cannot edit yourself, can only grant what you hold                          |

## How it is built (and where each thing lives, once)

- **Permissions**: `ADMIN_PERMISSIONS`, their words, and `holdsPermission` (a MANAGE implies its VIEW) are in
  `@yatri/types` (`admin.ts`). `requirePermission` in `admin/permissions.ts` is the only guard; the admin
  menu (`apps/admin/src/lib/nav.ts`) uses the same list. A test walks the router and fails if any route
  (other than `/me`) opens without a permission.
- **Audit**: `auditAdminAction` (route level) writes the entry _before_ the reply leaves, so a reply means the
  audit exists; failed actions are not recorded as if they happened. Reads of personal or money data are
  audited by their handlers. One table, `audit_log`; setting and administrator changes carry no subject row.
- **Date ranges**: `admin-range.ts` is the only place a period becomes instants, in `PLATFORM_TIME_ZONE`
  (default Asia/Kathmandu). A ride belongs to the day it was **requested**. Custom ranges are capped at 366 days.
- **Settings**: keys, words, kinds and limits are `PLATFORM_SETTINGS` in `@yatri/types` (`settings.ts`);
  `checkSettingValue` is the one validation rule (the API uses it; the form shows its messages). Values live in
  `platform_settings`; the deployment default is the environment variable of the same name. `getSetting`
  is what `pricingConfig()`, `cancellationRules()`, the waiting reminders, the nearby alerts and the request
  gate read; a test fails if any other file reads those `env.*` values. An edit quotes the version it saw:
  of two simultaneous edits exactly one applies.
- **Apps**: they keep no copy of a rule. Fares, fees and waiting figures reach them in the API's responses as
  before; `GET /api/v1/config/platform` publishes the values in force (public, no personal data) for screens
  that want to show them. A paused service answers a ride request with `503 SERVICE_PAUSED` and the admin's
  message, which the apps already display.
- **Dashboard "available drivers"**: `countAvailableDrivers` sits next to `findEligibleDrivers` in
  `dispatch/matching.ts` and states the same conditions; a test moves a driver between states and checks
  both the count and the stale figure.
- **Account status moves** (`ACCOUNT_ADMIN_MOVES`) are a table in `@yatri/types`, applied with a guarded
  `UPDATE`; suspension ends every session, takes a driver off the road, and is refused mid-ride.
- **Wording** shared by screens (`ROLE_LABELS`, `ACCOUNT_STATUS_LABELS`, `PAYMENT_STATUS_LABELS`,
  `SOS_STATUS_LABELS`) is defined once in `@yatri/types`; eight local copies were removed.

## Analytics definitions (also printed on the page)

Completion and cancellation rates are of rides that **ended** (completed, cancelled, no driver found). Revenue is
the sum of final fares of completed rides; Yatri models no commission, so it is also driver earnings. "Cash
confirmed" is what drivers confirmed receiving; the rest is "not yet confirmed". Nothing is stored twice:
every figure is computed from `trips`, `trip_payments`, users, driver and safety tables on request.

## Accessibility

One `main` landmark and a skip link in the console layout; the menu shows only permitted pages and marks the
current page with `aria-current` and an underline; every filter is a labelled GET form (works without
scripts); tables have captions, `scope="col"` headers and sort links; results are announced in `status`
regions; **no browser alert, confirm or prompt anywhere** (a test scans for them). Destructive and financial
actions (suspend, reactivate, settings, categories, permissions) use an in-page confirmation: focus moves in,
Escape goes back, focus returns to the button. Analytics are words and tables; there is no chart to depend on.
Existing pages were brought up to the same bar (captions added to the ride detail tables).

## Verification

- `admin-ops.test.ts` (48 tests): RBAC matrix over every route and every permission, administrator management
  and its races, user management (search, wildcards, suspend, races, sessions, driver off the road), driver and
  vehicle audit, dashboard counts against the tables, period edges (the second before and after midnight in
  Kathmandu), finance totals that add up across three views, analytics against a hand-counted day, settings
  (validation, versions, races, effect on estimates, cancellation fee, paused requests), categories, audit,
  notifications, SSOT guards, and static accessibility checks of the admin sources.
- The admin console was also run against the dev API and opened in the in-app browser: every page returned
  200 with its heading, and a settings change was driven end to end (focus moved into the field, then to the
  confirmation, the result was announced, focus returned, the change reached `/config/platform` and the audit
  page).

## Not done / limits

1. **No wallets, payouts or refunds exist** in the product, so none were built (they would be a new money
   feature). The console shows payments, collected cash and earnings, and says why there is nothing more.
2. **Settings are cached per process** for `SETTINGS_CACHE_SECONDS` (10 by default). A change is instant on the
   process that saved it and reaches others within that time.
3. **The mobile apps do not yet fetch `/config/platform`**; they keep receiving fares and fees in the API's
   responses, and show a paused message through their existing error display.
4. **Not run with a screen reader, on a device, or under load.** Accessibility is checked structurally (tests, the
   browser's accessibility tree, and scripted keyboard focus), not by listening to NVDA or TalkBack.
5. **Analytics query the live tables.** Indexes were added, and this is fine at today's size; at high volume they
   would need rolled-up tables, which were deliberately not built now.
6. **One time zone** (`PLATFORM_TIME_ZONE`) defines every day and "today".
7. **Bootstrapping the first administrator manager** is outside the console: set `ADMIN_SEED_PERMISSIONS=ALL` in
   development, or grant it in the database in a real deployment. Administrators that existed before this phase
   keep operations, driver review, ride cancelling and disputes; anything new must be granted.
8. Subscriptions, referrals, promotions and new product features were not touched.
