# Operations

How Yatri runs in production: what runs where, how a release goes out and comes back, how to back up and
restore, what to watch, and what to do when something breaks. Configuration values are **not** listed here
(a second list would drift): `apps/api/.env.example` documents every API variable with its meaning and
default, `apps/admin/.env.example` the admin console's, `deploy/compose.env.example` the container stack's,
and `apps/api/src/config/env.ts` is the code that enforces them.

> **What has and has not been exercised.** Everything below that is code (health checks, shutdown, rate
> limits, environment validation, scripts' syntax) has tests or was run. The container images, the compose
> stack, the CI and release workflows and the backup/restore scripts were written and reviewed but **could not
> be executed on the development machine** (no Docker, no `pg_dump`). CI builds the images on every push, so
> the first run will confirm or break them; do a restore drill (below) before you rely on backups.

## 1. Production architecture

```
 passenger app ─┐                                   ┌── PostgreSQL (the record of everything)
 driver app  ───┼─► load balancer (TLS) ─► API × N ─┤
 admin console ─┘        │                   │      └── Redis (live positions, presence, rate limits,
 contact's browser ──────┘                   │              realtime fan-out: rebuildable, not a record)
                                             └── SMS gateway · map/route provider (HTTP)
```

- **API** (`apps/api`): stateless Express + WebSocket server. Any number of identical instances behind a
  load balancer; every instance runs the same background sweeps, and each sweep is safe to run concurrently
  because every change is a guarded database transition. Point the load balancer's health check at
  `/api/v1/health/ready`; use `/api/v1/health/live` for the container's liveness probe.
- **PostgreSQL** is the only record. Rides, payments, ratings, safety and audit live here and nowhere else.
- **Redis** holds nothing that cannot be rebuilt: losing it drops live positions (drivers resend within
  seconds), rate-limit counters and cached ride state (rebuilt from the database). It needs no persistence.
- **Admin console** (`apps/admin`): a Next.js server that calls the API; it holds no data of its own.
- **Mobile apps** talk only to the API. They keep no rule of their own and re-synchronise from server state on
  every reconnect.
- **Not built:** a push-notification provider (notifications are stored and readable, never pushed to a closed
  app), and wallets/payouts (payment is cash to the driver). Both are known gaps, not oversights.

## 2. Environments

|                  | development                  | staging                               | production                                      |
| ---------------- | ---------------------------- | ------------------------------------- | ----------------------------------------------- |
| `NODE_ENV`       | `development`                | `staging`                             | `production`                                    |
| Purpose          | your machine                 | a rehearsal of production, real infra | real riders and drivers                         |
| Database / Redis | local containers or services | its own instances, never shared       | managed, backed up, TLS (`DATABASE_SSL=true`)   |
| OTP / SMS        | `OTP_DEV_MODE`, console SMS  | **real** SMS gateway                  | real SMS gateway                                |
| Secrets          | throwaway                    | its own, generated                    | its own, generated, in a secret store           |
| Maps             | public OSM allowed           | own or commercial provider            | own or commercial provider (public OSM refused) |

Staging obeys **production's** validation rules on purpose (it is reachable from the internet with realistic
data): the API refuses to start there with the OTP bypass on, console SMS, a localhost or non-https CORS
origin or public address, or one secret reused for two purposes. The complete list of refusals is
`superRefine` in `config/env.ts` and is tested in `hardening.test.ts`.

## 3. Setting up

### Database

```sql
CREATE DATABASE yatri ENCODING 'UTF8' TEMPLATE template0;   -- the API refuses any other encoding (Nepali text)
CREATE ROLE yatri_app LOGIN PASSWORD '<generated>';          -- what the API connects as
CREATE ROLE yatri_migrate LOGIN PASSWORD '<generated>';      -- what the migration job connects as
GRANT CONNECT ON DATABASE yatri TO yatri_app, yatri_migrate;
-- the migration role owns the schema; the app role may read and write data but not change the schema:
GRANT USAGE ON SCHEMA public TO yatri_app;
ALTER DEFAULT PRIVILEGES FOR ROLE yatri_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO yatri_app;
ALTER DEFAULT PRIVILEGES FOR ROLE yatri_migrate IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO yatri_app;
```

Use `DATABASE_URL` with the app role for the API and with the migration role for the migration job. Turn TLS on
(`DATABASE_SSL=true`) for any database that is not on a private network you fully control. Every query the API
makes is parameterised; the only SQL assembled from text uses constant lists defined in code.

### Migrations

`apps/api/migrations` are forward migrations run by `node-pg-migrate`. In a release they run **once, before**
the new API starts (the `migrate` image; in compose it is the `migrate` service). Rules that keep a rollback safe:

1. A migration must work with the **previous** release still running (add before you use; remove only in a
   later release once nothing reads it): "expand, then contract".
2. Never edit a migration that has run anywhere; add a new one.
3. Every migration has a `down`, but treat rolling the **database** back as an incident action (it can lose
   data), not a routine one. To undo a release, roll the **application** back (section 5); the expand-only rule
   is what makes that possible.

## 4. Backups and restore

`deploy/scripts/backup-db.sh` writes a compressed, checksummed, verified dump and prunes old ones;
`deploy/scripts/restore-db.sh` restores one (it refuses to run without `CONFIRM_RESTORE=yes`, and checks the
checksum first).

- **Schedule:** at least daily, plus one immediately before every release that carries a migration. Keep 14
  days locally (`KEEP_DAYS`) **and copy every file off the machine** to storage in another location: a backup
  on the same disk is not a backup. Encrypt that copy; the dump contains personal data (phone numbers, names,
  ride history, locations).
- **Managed databases:** prefer the provider's point-in-time recovery as the primary backup and keep these
  dumps as an independent second copy.
- **Targets to set and then measure** (none are measured yet): how much data you can lose (RPO) and how long
  recovery may take (RTO). Daily dumps mean up to a day of loss; point-in-time recovery narrows it to minutes.
- **Restore drill (do this before launch, then quarterly):**
  1. Create an empty database `yatri_restore` (UTF8).
  2. `TARGET_DATABASE_URL=… CONFIRM_RESTORE=yes deploy/scripts/restore-db.sh <latest dump>`.
  3. Start an API instance against it with `DATABASE_URL` pointing there; `GET /api/v1/health/ready` must be 200.
  4. Sign in to the admin console against it; open the dashboard; open one completed ride. Compare its counts
     with production's for the dump's date.
  5. Record how long steps 1-4 took. That is your real RTO.
- **Object storage:** driver documents and profile pictures are files, not rows. Back up `STORAGE_LOCAL_ROOT`
  (or the bucket) with the same care and the same schedule; a database restore without the files leaves
  documents dangling.

## 5. Releasing and rolling back

**Release** (the whole procedure):

1. `main` is green in CI (lint, format, types, tests, admin build, mobile bundles, images, dependency audit).
2. Take a backup (section 4).
3. Actions tab → **Release** → enter the tag (for example `v1.4.0`). It publishes
   `yatri-api`, `yatri-api-migrate` and `yatri-admin` images to the registry tagged with the version. It does
   **not** deploy.
4. Run the migration image against the target environment. If it fails, nothing else has changed: stop.
5. Roll the API out one instance at a time. Each new instance must pass `/api/v1/health/ready` before it takes
   traffic; on `SIGTERM` an old instance stops accepting connections, closes realtime sockets and exits within
   `SHUTDOWN_TIMEOUT_MS`. Connected apps reconnect and resynchronise from server state on their own.
6. Roll out the admin console.
7. Watch section 6 for 15 minutes: error rate, readiness, and one real ride end to end on staging first.
8. `APP_VERSION` is set from the release tag inside the API image, so logs and `/health` say which release each instance is. Set it in the environment only to override that.
9. Mobile apps release separately through their stores; an API release must stay compatible with the
   previous app version for as long as that version is in use (add fields, do not remove or rename).

**Roll back:** redeploy the previous tag's images (steps 5-6 with the old tag). Do not run `down` migrations
unless the migration itself is the problem and you have a backup. Because migrations are expand-only, the old
release runs against the new schema. If a bad release wrote bad data, fix the data with a forward migration or a
reviewed script and record it in the audit log; do not restore over live data unless the loss is worse.

**Secrets rotation** (also the response to a suspected leak): generate new values with `openssl rand -base64 48`
and roll them out like a release. Rotating `JWT_ACCESS_SECRET` signs everyone out (they sign in again);
it must match on the API and the admin console. Rotating `STORAGE_SIGNING_SECRET` invalidates outstanding
document links only. Rotate the database and SMS credentials at their providers, then update the environment.

## 6. Monitoring and alerts

What the system gives you today:

- **Health:** `GET /api/v1/health/live` (process up) and `/health/ready` (database and Redis answer; 503 names
  the failing one). Both carry `version`.
- **Logs:** one JSON line per event on stdout/stderr (`time`, `level`, `msg`, `service`, `version`), one access
  line per request with `requestId`, `method`, `route` (a template, never the address), `status`, `ms`,
  `userId`. Secrets, personal data and addresses are stripped before writing (`lib/logger.ts`, tested). A
  server error returns the caller a `requestId` that matches its log line.
- **Audit log:** every sensitive administrative action and safety event is in the `audit_log` table and in the
  admin console's Audit log page.

What you must connect (not built in): a log collector and a place to alert from. Suggested alerts, by log field:

| Alert                         | Condition                                                                    | Why                                          |
| ----------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Instance not ready            | `/health/ready` non-200 for 2 minutes                                        | load balancer has removed it; find out why   |
| Server errors                 | `level=error` and `msg="request failed"` rate > 1% of requests for 5 minutes | a release or a dependency is failing         |
| Slow API                      | `msg="slow request"` (over 1.5 s) more than a few per minute                 | database or provider degradation             |
| Repeated unhandled rejections | `msg="Unhandled promise rejection"` any                                      | a bug; the instance restarts itself          |
| Database pool pressure        | `pg_stat_activity` connections near `DB_POOL_MAX` × instances                | raise the pool or scale the database         |
| OTP or login abuse            | 429 `RATE_LIMITED` spike on `/auth/*`                                        | someone is guessing or pumping SMS           |
| Active SOS unanswered         | admin dashboard "Active SOS alerts" > 0 for 5 minutes                        | a person may need help: page the safety team |
| Backup missing                | no new file in the backup location for 26 hours                              | you have no recent backup                    |

Also monitor from outside (uptime check on the public API address and the admin login page), disk on the
database host, and certificate expiry.

**Error monitoring:** there is no hosted error tracker wired in. The structured `level=error` lines with a
`requestId` are the source; forward them to whichever service you choose. Adding one (for example Sentry) is a
change to `lib/logger.ts` only, so every error site benefits; do that before launch if you want stack-level
grouping. Keep its scrubbing at least as strict as `redact` in the logger.

## 7. Incident recovery

Start every incident the same way: what is failing (health, logs by `requestId`), since when (the release
time), and can you roll back (section 5)? Roll back first if a release is the likely cause.

- **API instances not ready.** `/health/ready` says which dependency. Database: check the host, connections
  (`pg_stat_activity`), disk. Redis: restart it; nothing is lost that cannot be rebuilt, and instances recover
  without a restart (the client reconnects with backoff; commands fail fast in the meantime).
- **Database down or corrupted.** Stop the API (it cannot help), restore (section 4) into a new database, verify,
  point `DATABASE_URL` at it. State what data window was lost to affected people.
- **Redis lost.** No action needed beyond restarting it. Drivers reappear as their apps send positions; a ride
  under way continues from the database's state.
- **A bad release.** Roll back the application (section 5). Keep the failing build's logs.
- **Suspected token or secret leak.** Rotate (section 5). For a single stolen session, an administrator
  suspends the account (this ends every session and refuses new ones), or the person logs out of all devices.
- **OTP / SMS pumping.** The limits already cap requests per phone and per address; if the SMS bill or the 429
  rate spikes, tighten `OTP_*` limits and block the range at the load balancer. Look at `auth_events`.
- **A rider or driver reports harm.** This is a safety matter, not an outage: the Safety page in the admin
  console (SOS alerts and incident reports), then the runbook your safety team keeps. Nothing in the software
  replaces calling the person or the emergency services.
- **Service must stop taking rides** (an outage elsewhere, an incident): Settings → Service availability →
  turn off "Accept new ride requests" and write the message riders will see. Rides under way are not affected.
  Turn it back on the same way; both changes are audited.
- **After any incident:** write down the timeline and the fix, and add the test that would have caught it.

## 8. Security practices for operators

The controls and their evidence are in `docs/SECURITY.md`. What operators must do:

- Keep secrets out of git and out of images: environment variables from a secret store only. CI checks that no
  tracked file contains a key, token or credentialed URL.
- Give the API and the migration job separate database roles (section 3); give the API no schema rights.
- Terminate TLS at the load balancer and set `TRUST_PROXY_HOPS` to the real number of proxies; keep
  `CORS_ORIGINS` to the exact admin origin.
- Create the first administrator out of band (`ADMIN_SEED_*` is refused in production): insert the row and its
  permissions directly, then manage everyone else in the console. Grant the fewest permissions that do the job.
- Review the Audit log weekly; remove administrators who have left the same day.
- Apply dependency updates monthly; CI fails the build on a high-severity vulnerability in a runtime dependency.
- Keep backups encrypted and test restores (section 4).

## 9. Support, privacy requests and retention

- **Who handles what.** Give `DISPUTES_MANAGE` to people who answer ride problems, `SUPPORT_MANAGE` to those who
  also answer general requests and raise refunds, `REFUNDS_MANAGE` to the (different) people who approve and
  record refunds, and `COMPLIANCE_MANAGE` to whoever answers privacy requests and publishes policies.
- **Service levels are data.** Hours to a first answer, and what an unanswered ticket is raised to, are edited in
  Settings under "Support priorities and escalation". The sweep runs every `SUPPORT_SWEEP_SECONDS` inside the
  API process; with several instances it is safe (each move is one guarded statement).
- **Privacy requests have a due date** (Settings: days to answer). Work the queue under Privacy and compliance;
  overdue requests are listed first. Completing a deletion is irreversible and is refused while a ride is under
  way, a payment is unsettled or a refund is being handled; tell the person why if you must reject.
- **Retention.** Review the rules under Privacy and compliance before launch and with counsel each year. The
  hourly job deletes only kinds marked DELETE (one-time codes, notifications, sign-in events, ride chat, support
  files of long-closed tickets) and records how many it removed. Rides, payments, refunds, tickets, safety
  records, the audit log, policy acceptances and privacy requests are KEEP and no job touches them. Backups keep
  deleted data until they expire (section 4): count that when you answer a deletion request.
- **Policy text** lives at the address you publish (a web page you control); Yatri stores only the version and
  the address. Publishing a new version asks every person to accept it again.

## 10. Dispatch, pricing, zones and incentives

- **Start without zones.** With no service area in use, rides are allowed everywhere. Add a service area (and
  any restricted, airport or venue zones) before relying on geofencing; once one is in use, a ride whose
  pickup or drop-off is outside it is refused and a driver outside it is not offered rides. A zone is switched
  off, not deleted.
- **Pricing rules.** Create a rule per situation (an airport rush, Friday evenings, a festival weekend, high
  demand). The highest matching multiplier applies and never exceeds the platform limit in Settings
  ("Highest price multiplier"). Riders see the resulting fare before they confirm; a request made at an old
  price is refused with the new fare. Check your local rules on demand pricing before turning any rule on.
- **Watch demand and supply.** Admin > Demand, zones and pricing shows requests against available drivers per
  zone and the multiplier in force. The map hides small counts on purpose. The figures are refreshed every
  few seconds and cached per instance for up to ten.
- **Dispatch tuning** (Settings > Dispatch): how far each unanswered offer widens the search, the largest
  radius, how much a recent ride counts against a driver when ranking, and the workload window.
  `MATCHING_STRATEGY` chooses `eta_workload` (default) or `proximity`.
- **Driver limits** (Settings > Dispatch): most rides per day and longest continuous time online (0 = no
  limit). A driver at a limit is told why and is not offered rides.
- **Incentives** are recorded, not paid, by the platform: Admin > Driver incentives lists every award; pay
  from that list and keep your own payment record. Changing a rule never undoes bonuses already earned.

## 11. Fleets, vehicles and driver operations

- **Who does what.** `FLEET_VIEW` reads fleets, vehicles, drivers, expiring documents, maintenance and the
  operational history; `FLEET_MANAGE` changes them. Vehicle and document approval stays with driver review.
- **Fleets.** A fleet is a contact, a status and the vehicles and drivers that point at it. A fleet that is not
  active stops its vehicles and drivers taking rides and takes its online drivers offline. A fleet vehicle is
  registered by an administrator, then assigned to a driver of that fleet; the driver uploads its papers and
  a reviewer approves it. Independent drivers keep their own vehicles.
- **The check.** Every hour (`FLEET_MONITOR_MINUTES`) documents, licences, registration, insurance and service
  dates are checked: drivers get reminders at the days in Settings (`EXPIRY_REMINDER_DAYS`), once each, and a
  driver who can no longer take rides is taken offline. Use "Check documents and dates now" after a big
  change. An expired required paper stops rides immediately, before the check runs.
- **Vehicle status.** Put a vehicle in maintenance, inactive, suspended or retired from its page; retired
  is final. A failed inspection puts it in maintenance and opens the repair; completing maintenance returns it.
- **Driver operational status.** Restrict a driver (a lower daily ride cap, Settings) or suspend them (no
  rides, offline now) with a reason and, if you like, an end date after which the system reinstates them. This is
  separate from account suspension and from driver verification; reinstating needs no re-verification.
- **The database time zone.** The API sets every connection to `PLATFORM_TIME_ZONE`, so date rules agree
  between SQL and code; keep the setting correct for your country.

## 12. Fraud and risk

- **Who does what.** `RISK_VIEW` reads signals, people, rides, rules and history; `RISK_MANAGE` reviews signals,
  adds notes, restricts and lifts, and edits rules. Suspending or restoring needs `USERS_MANAGE` as well.
- **What the system does by itself.** Every `RISK_SWEEP_MINUTES` it runs the detectors and raises signals (the
  same signal is never raised twice in a window). It tells the risk team once a week per person that a review is
  due. Automatic restriction is **off** (`RISK_AUTO_RESTRICT_SCORE=0`); if you switch it on in Settings it needs
  several different kinds of signal, lasts `RISK_AUTO_RESTRICT_HOURS`, and never suspends. "Check now" on the
  overview runs the sweep immediately.
- **Investigating.** Open a person from the overview or from a signal. Read the signals and the context (rides,
  cancellations, disputes, refund requests: a few signals on a long history usually mean nothing), add a note,
  then choose: dismiss a false alarm, confirm, restrict for a few days, or suspend. Everything is in the audit trail.
- **Restricting.** A restricted passenger cannot request rides and a restricted driver is not offered rides (and
  is taken offline). Support still works. It ends by itself; lift it sooner from the person page. The person is
  told their account is limited, with no reason.
- **Tuning.** If a rule fires too often, raise its threshold or lower its points on the Rules page (with a
  reason) rather than ignoring the signals; putting the defaults back removes the override.
- **Retention.** Signals are deleted after the `RISK_EVENTS` retention period (Compliance > Retention; default
  365 days). The audit log of what was done is kept.

## 13. Business accounts

- **Who does what.** An organization's owners and administrators run it themselves in the passenger app (Business rides):
  members, rules, cost centres, approvals, statements and usage. Platform staff with `ORGANIZATIONS_VIEW` read
  organizations and statements (Business accounts); `ORGANIZATIONS_MANAGE` suspends or reactivates an organization, issues
  statements and records payment. Staff cannot change an organization's members, rules or rides.
- **Statements.** The sweep (`ORG_SWEEP_MINUTES`) issues last month's statements in the first five days of each month and
  expires approvals nobody decided (`ORG_APPROVAL_TTL_MINUTES`). Use Statements > Issue statements to issue one now or to
  catch up a month; running it twice issues nothing twice. Payment terms are `ORG_PAYMENT_TERMS_DAYS`.
- **Recording payment.** When the transfer arrives, open the statement and record the exact total with the bank reference.
  Every ride on it becomes paid together. A mistake before payment: cancel the statement; its rides go onto the next one.
- **The driver is not paid by the organization.** Rides billed to an organization have no cash for the driver; the platform
  owes the driver and settles it outside Yatri (as with incentives). Keep your own record.
- **Suspending.** Use it when statements are overdue or for misuse. New bookings and approvals stop and waiting approvals are
  withdrawn; rides under way and money owed are untouched. The owners and administrators are told.
- **Refunds.** A rider cannot ask for a refund on a ride billed to an organization; settle any dispute with the organization.

## 14. Passenger experience settings

- **What an administrator can change.** Settings > Passenger experience: the default app language (only a language the apps are
  translated into can be chosen) and how many recent destinations are offered. Both are versioned, audited edits like every
  other setting, and take effect for everyone who has not chosen for themselves.
- **What an administrator cannot see.** Personal preferences (theme, notification choices, how a name is shown) are the
  person's own: no screen shows them, and support cannot change them for someone.
- **Notifications.** A person can switch off ride updates, messages and calls, payments, support, business and bonus
  notifications. Safety alerts and account notices are always sent. A switched-off notification is still recorded in their
  history (marked not pushed). There is no push provider yet, so nothing is pushed in a real deployment until one is added.
- **When someone cannot sign in on a new phone or sees a device they do not know.** They sign it out themselves in
  Settings > Devices; sessions are the existing ones.

## 15. Cities and service areas

- **Adding a city.** Cities and service areas > Add a city (name, code, province, map centre, time zone). It starts as
  coming soon. In Service zones, draw its service area (kind "Service area" or "City boundary"), then on the city page tick
  the area under Boundary, review hours, vehicle types, fares and driver requirements, and Open it. A city with no active
  service area cannot be opened.
- **Opening and pausing.** Pausing stops new rides and new drivers going online at once; rides under way finish. Riders and
  drivers are told in words ("Yatri is paused in Pokhara for now").
- **Hours.** No window means open all day. A closing time earlier than the opening time runs past midnight. Hours are read
  in the city's time zone.
- **Fares, waiting and cancellation.** Leave a box empty to use the platform value (Settings). Changing a city's value
  affects new estimates and rides in that city only; changing the platform value reaches every city that has not set its own.
- **Driver requirements.** Ticking a document means a driver must hold an approved, unexpired copy to go online in that city;
  the refusal names it. Yatri-wide required documents stay in driver verification.
- **Two administrators at once.** The second save is refused with "changed by someone else": reload and make the change again.
- **Existing deployments** have no cities until one is added: the platform-wide rules and service areas apply as before.

## 16. Background jobs and recovery

- **Where to look.** Background jobs lists every timed job with its state in words: OK, Late (it has not run for three
  intervals), Failed (the last run failed), or Has not run yet. "Run now" runs it immediately (needs the settings
  permission) and is audited. A run that finds the job already running says so and does nothing.
- **More than one API server** is fine: each job takes a lock for its run, so it runs once. A server that dies mid-job frees
  the job when the lock expires (the job's timeout plus ten seconds).
- **Restarting the API** loses nothing: jobs find their work in the database, rides live in the database (the Redis cache
  is rebuilt from it), and apps reconnect and fetch a full snapshot.
- **Notifications that failed** are retried by the `notification-retry` job at 30 s, 2 min, 10 min and 1 h, then marked
  dead. A growing number of dead notifications means the push provider is down or misconfigured.
- **Payment reconciliation** creates a missing payment for a finished ride. When it reports anomalies (audit action
  `PAYMENT_ANOMALIES_FOUND`: statement paid with an unpaid payment, cancelled statement holding payments, empty issued
  statement, refund stuck processing) a person must look; it never changes those itself.
- **History** (`job_runs`) is kept 14 days and idempotency keys 2 days, set in Privacy and compliance > Retention.
- A person telling you "I tapped twice" or "my connection dropped while requesting" should not end up with two rides: the
  app sends the same idempotency key again. If they did, look at the trip events and the audit log.

## 17. Accessible rides

- **Where.** Accessible rides in the console: counts for the last 30 days (rides that needed an accessible vehicle, matched or
  not, vehicles approved and online now), the approval queue, and the list of vehicle features.
- **Approving a driver's claim.** Features such as wheelchair accessible need a check. Look at the vehicle (as your process
  requires), then approve or reject with a reason; the driver is told. Until approved, the vehicle is not offered rides that
  need the feature. Rejecting an already approved claim takes it away at once.
- **Adding a feature.** Give it a name and a plain description; choose whether claims need approval. Switching approval on
  puts approved claims back in the queue. Core features cannot be switched off.
- **If accessible rides are not being matched.** Look at "approved vehicles" and "with a driver online now". Zero online
  means rides that need that feature will end with no driver found; the request screen already tells the person. Recruiting and
  approving more accessible vehicles is the fix, not a setting.
- **A support case about an accessible ride.** Open the ride's accessibility details (needs the support permission; the read
  is recorded). Do not copy them into tickets or messages.
- **Retention.** A ride's accessibility details are deleted 30 days after it ends (Privacy and compliance > Retention).

## 18. Navigation and routing

- **Where to look.** Routes and arrival times: which routing engine is in use and what it supports, how many routes were
  planned, how many fell back to a straight-line guide, new routes after deviations, arrivals detected, and how close the first
  arrival estimate was to the real ride time.
- **A high share of fallbacks** means the routing engine is down, slow or out of quota (see the engine's own logs). Drivers then
  get a straight-line guide in words and an estimate; rides still work and fares are unaffected.
- **Estimates that are consistently off** (average difference well above 20%) mean the engine's speeds do not match the
  roads. A traffic-aware engine would help; none is configured by default.
- **Thresholds** (Settings > Navigation and route guidance): how close is approaching, near and at; how far from the route is
  "off it"; how many readings in a row confirm it; how often a new route may be planned. Too sensitive a deviation distance
  causes needless new routes (more routing requests and data); too lax hides real wrong turns.
- **A driver says "it keeps rerouting me".** Check whether the planned route uses a closed or one-way street the map has wrong;
  a deviation is only a count on that ride, and the pattern rule needs three deviations on each of three rides in a week.
- **The routing engine** is configured only through the existing settings (`LOCATION_ROUTING_PROVIDER`, base URL, key); changing
  vendor needs no code in the apps.

## 19. Campaigns, offers and reward points

- **Where.** Campaigns and rewards in the console: figures, the list (filter by kind and state), create, start/pause/end, who used
  each, and a rider's points.
- **Running a campaign.** Create it (it starts as a draft), check its offer, who it is for, its dates and limits, then Start it.
  To change a running campaign, Pause it first. Ending is final. Every move asks for a reason and is audited.
- **Who pays.** A discount is money Yatri pays: the rider pays less in cash, the driver earns the full fare. Finance shows
  "Yatri paid towards fares" so the difference does not look unpaid. Set limits (per rider, in total) to cap the cost: there is no
  rupee budget cap.
- **Reward points.** Earning, what a point is worth, the minimum to use, the largest share of a fare and expiry are in Settings >
  Rewards and referrals. A rider's history is under Campaigns > a rider's reward points; correct a mistake there with a reason.
  Points that expire are written off hourly and riders are warned two weeks ahead.
- **Invites.** Open by having an active referral campaign. One code brings in at most the 30-day limit of new riders. If invites
  look abused, check the risk signals (many invites, same network address, repeated own-code attempts); they are reasons to look.
- **Messages.** A message campaign goes out once at its time to riders who opted in to "Offers and news"; others are recorded, not
  pushed. No push provider means "sent" is "handed to the notification service".
- **If a ride's payment is refunded**, an applied discount is not reversed automatically: use the refund flow and correct points if needed.

## Service providers (Phase 25)

- Set `NODE_ENV`, then the provider variables for that environment (`apps/api/.env.example` lists the recommended set for
  development, staging and production). The API will not start on a stand-in in staging or production, or without a chosen
  vendor's credentials. Production must set `MONITORING_PROVIDER=sentry`.
- Admin > **Service providers** shows each service's state; the `provider-health` job (every 10 minutes) runs the live checks
  that exist. A service with no live check shows as "set up, but there is no live check", never as working.
- `payment-attempts` (every 2 minutes) completes online payments whose rider never came back and closes expired ones.
- A vendor outage: sign-in codes use `SMS_FALLBACK_PROVIDER` if set; online payment says it is unavailable and cash still works;
  push is retried by the notification retry job; maps return the straight-line estimate where the app already falls back.
- Before relying on a vendor, run a staging pass with its real test keys: Phase 25's tests use pretend vendors only.

## Refunds, payouts, push and the live check (Phase 28)

- **Before relying on a vendor**, run `pnpm --filter @yatri/api providers:check` against staging with the real test credentials.
  Add `--sms-to=`, `--email-to=`, `--initiate-payment` and `--sentry-event` for the steps that reach a person or open a payment.
- **Payouts**: Admin > Driver payouts. Prepare (rides older than the hold, no refund under way, driver has an account and at least the
  smallest amount), send the money from your bank or wallet using "Show the account to pay", then a different person records it as
  paid with the reference. A failed payout can be tried again or cancelled (its rides return to the driver's balance).
- **Online refunds**: a provider without a refund API (Khalti) needs the refund made in its dashboard and the reference recorded.
  The `refund-settle` job finishes provider refunds that were cut short.
- **Settings**: `PAYOUT_HOLD_HOURS`, `PAYOUT_MIN_NPR`, `ONLINE_REFUND_DRIVER_SHARE_PERCENT` (Settings > Online payments, refunds and payouts).
- **Push needs an EAS project, once per app, before the first build.** Neither app has one yet (`expo.extra.eas.projectId` is unset
  in both `app.json` files), and without it a phone gets no push address, so registration is skipped and no notification is ever
  pushed. Nothing fails loudly: people still see everything in the in-app notification list. Each app already has its package
  name (`app.yatri.passenger`, `app.yatri.driver`) and build profiles (`eas.json`: `preview` for testers, `production` for the
  stores). Once, signed in to the Expo account that will own the apps:
  1. `npx eas-cli login`
  2. In `apps/passenger`, then in `apps/driver`: `npx eas-cli init` (creates the project and writes its id into `app.json`;
     commit that change).
  3. In each app: `npx eas-cli credentials`, choose Android, then _push notifications (FCM V1)_ and upload the Google service
     account key from the Firebase project; for iOS, let EAS create the APNs key with the Apple Developer account.
  4. In each app: `npx eas-cli build --profile preview --platform android`, install the APK on a phone, sign in, and check that
     a row appears in `push_tokens` for that sign-in and that a ride notification arrives with the app closed.
