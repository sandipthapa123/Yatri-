# Phase 5 — Driver Availability & Realtime Location

## Scope

A verified driver can go **ONLINE**, share their current location securely, stay visible
to Yatri's (future) dispatch system, and go **OFFLINE**. The server always knows whether
a driver is available and where they are, and never exposes that publicly.

Not in this phase: ride requests, matching, dispatch, fares, payments, ratings, SOS,
trip sharing, ride history, navigation. `isMatchable()` is the single hook matching will
use next phase; no matching query exists yet.

> **Relation to `LIVE_TRIP_TRACKING.md`.** Before this phase, an earlier change added
> _trip-scoped_ tracking (a passenger watching their driver during an admin-created
> trip). That work is documented in `docs/LIVE_TRIP_TRACKING.md` and is separate from
> availability: it shares the WebSocket gateway and the tracking rules but is driven by a
> `trips` row. This phase adds driver **presence** (no trip) on the same gateway. Note
> that this phase's brief says passenger-facing driver tracking should wait for matching;
> the earlier trip tracking is therefore ahead of this brief and can be disabled by
> removing the `/trips` router mount if you want it out until matching lands.

## Availability state machine

```
        ┌──────────── (failure / cancel) ───────────┐
        ▼                                            │
    OFFLINE ──► GOING_ONLINE ──► ONLINE ──► GOING_OFFLINE ──► OFFLINE
        ▲                          │
        │                          └─ location silent > DRIVER_STALE_TIMEOUT ─► UNAVAILABLE
        └────────── UNAVAILABLE (system pause: driver must tap Go Online again)
    SUSPENDED: set immediately when an admin suspends (or the driver deactivates);
               leaves only via Go Online once the account is reinstated AND eligible.
```

- Persisted in `driver_availability.state` (Postgres is the source of truth) and changed
  **only** through a compare-and-swap (`casTransition`: `UPDATE … WHERE state = ANY(from)`
  plus a `state_version` bump). Two racing requests can never both win a transition.
- **Ride status is a different axis.** `ONLINE` never means "on a trip". Future states
  (`ONLINE_AVAILABLE`, `ONLINE_ASSIGNED`, `ON_TRIP`) are sub-states of `ONLINE` and will be
  a separate column, leaving this machine and every "is this driver reachable?" query
  unchanged. Rules live in `availability.machine.ts` (pure, unit-tested).
- `isMatchable(state, freshness)` = `ONLINE` **and** `fresh`. Nothing else.

## Going online (server-authoritative)

Client: check auth → check permission → obtain a fix within 100 m → `POST …/online` →
start updates. Server:

1. Validates the opening fix (finite, in range, not 0,0, recent, accuracy ≤
   `DRIVER_ONLINE_MAX_ACCURACY_METERS`) — else the driver stays offline (`422`).
2. Already `ONLINE` → idempotent (refreshes the location). `GOING_*` → `409`.
3. `evaluateDriverEligibility` from the database, every time: account `ACTIVE`; driver
   `VERIFIED` and not `SUSPENDED`; the phase-3 strict gate (licence valid, an `APPROVED`
   unexpired vehicle, every required document `APPROVED` and unexpired); no active trip.
   Failure → `403 NOT_ELIGIBLE` with the reasons; nothing changes.
4. CAS `OFFLINE|UNAVAILABLE|SUSPENDED → GOING_ONLINE`, store the fix, CAS `→ ONLINE`.
   If anything else changed the state meanwhile (offline request, suspension) the online
   attempt aborts and cleans up. A `GOING_*` that never completes is rolled back by the
   sweeper after `DRIVER_TRANSITION_TIMEOUT_SECONDS`.

The request body is `.strict()`: nothing the client adds (`eligible`, `state`,
`driverId`) has any effect — it is rejected.

## Going offline

Client stops broadcasting **first**, then `POST …/offline`. Server: `→ GOING_OFFLINE →
OFFLINE`, deletes the live fix and the stored location (nothing kept off shift), audits.
Idempotent. If the phone cannot reach the server the app is offline locally, says the
server could not confirm it, and the stale timeout takes the driver offline anyway.

## Realtime (WebSocket `/ws/v1/realtime`, the existing gateway)

The endpoint is the one already established by the project (`/ws/v1/realtime`); it was not
duplicated at `/api/v1/realtime`.

Client → server (driver presence; **no `driverId` field exists** — the authenticated
connection is the identity, and unknown keys are a protocol error):

| Message                                                                                                            | Meaning                         |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| `{type:'auth', token}`                                                                                             | first message; never in the URL |
| `{type:'location', latitude, longitude, accuracyMeters?, headingDegrees?, speedMps?, deviceTimeMs, mockLocation?}` | one GPS reading                 |
| `{type:'availability', action:'online', location}` / `{action:'offline'}`                                          | change availability             |
| `{type:'ping'}`                                                                                                    | heartbeat (updates last-seen)   |

Server → client: `connection {status:'connected'|'superseded', updateIntervalMs}`,
`availability {status}` (full status incl. eligibility, freshness, configured intervals;
pushed on every change), `availability_error {code,message}`, `location_ack
{receivedAt, freshness}`, `rejected {reason}`, `pong`, `error`.

Connection management: authentication with the same session rules as REST (revoked or
suspended accounts are dropped; tokens are refreshed over the socket); 4 KB messages, 8
msgs/s per socket; ws ping/pong + client silence detection; a **newer connection for the
same driver supersedes the older** (`4409`), so two devices never fight over a shift; a
dropped socket does **not** flip the driver offline — staleness does, on a timeout, so a
tunnel or a blip doesn't cost a shift; clients reconnect with jittered exponential
backoff, re-authenticate, and receive the current availability.

## Location update strategy & battery

- The server tells the client the cadence (`updateIntervalsMs` in every status): idle
  10 s, en route 3 s, on trip 3 s (`DRIVER_UPDATE_INTERVAL_*`). Only idle is used now.
- One **high-accuracy** reading opens the shift; afterwards **balanced** accuracy, one
  reading per interval **and** only after ≥ 20 m of movement — never continuous max GPS.
- Reverse geocoding on the phone only after ≥ 150 m and ≥ 60 s.
- Only latitude, longitude, accuracy, heading, speed, device time (+ mock flag) are sent.
- The client keeps only the latest unsent reading while offline and drops it if it is
  older than 25 s.
- **Foreground only.** Background location (an OS foreground service / background task
  plus store-review justification) is designed for but **not built**; when the app is
  backgrounded fixes stop, the driver is told, and the server marks the driver stale then
  `UNAVAILABLE` on its own.

## Freshness & stale handling (all configurable)

| Age of last accepted location          | Meaning                                                |
| -------------------------------------- | ------------------------------------------------------ |
| ≤ `DRIVER_LOCATION_FRESH_SECONDS` (30) | **fresh** — matchable                                  |
| older                                  | **stale** — not matchable; driver told once            |
| > `DRIVER_STALE_TIMEOUT_SECONDS` (180) | driver → `UNAVAILABLE` (`STALE_LOCATION`), fix deleted |

A sweeper (`sweepDrivers`, every 15 s, safe on every instance) applies these. The server
records its **own** receive time; the device clock is used only for ordering/staleness of
the reading (`evaluateFix`: duplicate, out-of-order, stale, clock-skew, accuracy, jump).

## Spoofing / anomaly foundation

`detectFlags` records `MOCK_LOCATION` (platform indicator), `IMPLAUSIBLE_SPEED`,
`LOCATION_JUMP`, `ACCURACY_TOO_PERFECT` into `driver_location_flags`, at most one per kind
per driver per minute. **Flags only** — nothing changes a driver's state.

## Privacy model

- Exact driver location is readable by: the driver (their own), backend components, and
  admins holding **`DRIVER_LOCATION_VIEW`** (each disclosure is written to
  `driver_availability_events` as `ADMIN_LOCATION_VIEW`). No passenger or other-driver
  endpoint exists.
- Other admins see availability, verification, freshness and last-update time only;
  coordinates come back `null`.
- Live position: Redis (24 h TTL, deleted on offline/stale/suspension). Postgres keeps
  **one overwritten row per driver** (`driver_last_locations`), written at most every
  `DRIVER_LOCATION_PERSIST_SECONDS`; deleted when the driver leaves the shift. No history.
- Suspension/deactivation removes the driver from availability immediately.

## Redis (used, and only for ephemeral state)

`drv:{id}:fix` latest fix · `drv:{id}:state` state mirror (so a location update costs no DB
read; rebuilt from Postgres if missing) · `drv:{id}:seen` heartbeat · small throttles
(`persisted`, `notified`, `flag:*`). Pub/sub channel `yatri:driver-changes` carries only a
driver id (no coordinates) so every API instance can push status to its own sockets.

## Database (migration `1738400010000`)

`driver_availability` (state, version, timestamps, reason; partial index on `ONLINE`),
`driver_last_locations` + `heading_degrees`, `speed_mps`, and a `(latitude, longitude)`
index for future bounding-box "online drivers near X" queries (no PostGIS required; add a
`geography` column + GiST index when matching needs radius queries),
`driver_availability_events` (audit), `driver_location_flags`, `users.admin_permissions`.

## API

| Endpoint                                       | Notes                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/v1/drivers/me/availability`          | own state, freshness, eligibility + reasons, intervals                           |
| `POST /api/v1/drivers/me/availability/online`  | body = one location sample; strict; rate limited                                 |
| `POST /api/v1/drivers/me/availability/offline` | idempotent; rate limited                                                         |
| `GET /api/v1/drivers/me/location`              | (phase 4) own last-known position                                                |
| `GET /api/v1/admin/availability/drivers`       | filters: `state`, `freshness`, `verification`, `search`; `page`, `pageSize ≤ 50` |

Errors: `NOT_ELIGIBLE` (403 + reasons), `WEAK_GPS_ACCURACY` / `STALE_LOCATION` /
`INVALID_LOCATION` (422), `AVAILABILITY_CHANGE_IN_PROGRESS` / `AVAILABILITY_CHANGED` (409).

## Environment variables

Freshness is defined once (`modules/tracking/tracking.config.ts`, from env) and shared by availability, trip tracking and the admin list; clients receive thresholds from the API. See the Single Source of Truth section in `docs/ARCHITECTURE.md`.

`DRIVER_LOCATION_FRESH_SECONDS` (30), `DRIVER_LOCATION_LOST_SECONDS` (60), `DRIVER_STALE_TIMEOUT_SECONDS` (180),
`DRIVER_UPDATE_INTERVAL_IDLE_MS` (10000), `DRIVER_UPDATE_INTERVAL_EN_ROUTE_MS` (3000),
`DRIVER_UPDATE_INTERVAL_ON_TRIP_MS` (3000), `DRIVER_ONLINE_MAX_ACCURACY_METERS` (100),
`DRIVER_LOCATION_PERSIST_SECONDS` (20), `DRIVER_TRANSITION_TIMEOUT_SECONDS` (30),
`TRACKING_MIN_INTERVAL_MS` (800), dev-only `ADMIN_SEED_PERMISSIONS`
(e.g. `DRIVER_LOCATION_VIEW`). See `apps/api/.env.example`.

## Mobile permissions

Driver app: foreground location only (`expo-location` plugin, "when in use" text updated
to say it is shared only while online and the app is open). Android
`ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION`; iOS `NSLocationWhenInUseUsageDescription`.
Denied / blocked (Settings only, with an Open settings button) / location services off /
no fix / weak accuracy each keep the driver offline with a plain explanation.

## Driver app & accessibility

`DriverHomeScreen`: a large `ONLINE`/`OFFLINE` heading (words + glyph, never colour alone),
one primary **GO ONLINE / GO OFFLINE** button, and text rows — status, permission, location
status (Location permission required · Location unavailable · Weak GPS accuracy · Location
updating · Location update delayed · Connection lost), current place, accuracy, last
update, connection. Changes are announced through an assertive/polite live-region pair
("You are now online. Your location is being shared with Yatri." / "You are now offline.
Location sharing has stopped." / "Connection lost. Your location is not being shared.").
"Sharing" is claimed only while the server keeps acknowledging (`location_ack`); if the
socket drops the screen says so and says nothing is being shared. The last-update age is
refreshed visually every 5 s but is not inside a live region. There is no map on this screen.

## Admin dashboard

`/availability`: server-side filtered, paginated table (driver, verification,
availability, last location time, freshness, position). Position is "Restricted" without
`DRIVER_LOCATION_VIEW`. A map-based operational view is **not** built (table only).

## Testing

`availability.test.ts` (26: state machine, eligibility variants, idempotence, races,
freshness/stale, flags, privacy, admin RBAC, Redis-loss recovery),
`availability.realtime.test.ts` (13: WebSocket auth, online/offline, ack, impersonation,
passenger misuse, superseding, reconnect, heartbeat, disconnect→stale, pushes), plus
`packages/mobile-location` unit tests for the presence controller (permission, weak GPS,
double taps, honest sharing status, server-driven offline, battery throttles).
`docker`-free: needs Postgres + Redis (`pnpm --filter @yatri/api migrate:test:up`).

## Known limitations

- Foreground-only location (above). Battery use has not been measured on a device.
- Not run on a physical phone/emulator or with TalkBack/VoiceOver/NVDA; see
  `docs/ACCESSIBILITY_TESTING.md` (the driver-home protocol is at the end).
- The sweeper iterates `ONLINE` drivers each run — fine to thousands; shard by id range
  or move freshness to a Redis sorted set when the fleet grows.
- Admin freshness/filtering is "as of the last persisted sample" (±`PERSIST_SECONDS`).
- `en route` / `on trip` cadences are configured and delivered but only idle is used.
