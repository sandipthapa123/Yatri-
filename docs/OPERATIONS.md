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
8. Set `APP_VERSION` to the tag so logs and `/health` say which release each instance is.
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
