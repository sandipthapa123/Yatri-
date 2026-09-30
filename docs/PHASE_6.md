# Phase 6 — the complete ride, end to end

Phase 6 was a feature-gap audit followed by implementation. The baseline was Phases 1–5. This
document records what was audited, what existed, what was built, how it works, how it was
verified, and — plainly — what is **not** verified or **not** done.

## 1. Feature matrix (audit result, before coding)

| Area                       | Before Phase 6                                                                             | Status found             |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| Passenger requests a ride  | Nothing. Trips were created by an **admin** (`POST /admin/trips`), a testing shortcut      | **missing**              |
| Fare / pricing             | None                                                                                       | **missing**              |
| Matching / dispatch        | None (driver was assigned by the admin call)                                               | **missing**              |
| Driver accepts / declines  | None                                                                                       | **missing**              |
| Ride state machine         | 5 statuses, transitions in one service, no search/timeout/no-drivers/rematch               | **incomplete**           |
| Arrival check              | Driver could tap "arrived" anywhere                                                        | **incomplete**           |
| Waiting time               | One number (`waitingSeconds`) on the arrived snapshot; no rules, no fare effect, no events | **incomplete**           |
| Passenger waiting          | Not modelled                                                                               | **missing**              |
| Domain events              | Ephemeral `event` message (`TripEventName`), not persisted, no per-trip order, no catch-up | **incomplete**           |
| Notifications              | `notify()` existed for verification only                                                   | **incomplete**           |
| Live location + ETA        | Working (Phase 4/5): one presence path, snapshots, distance in meters, ETA, place, heading | **existed, complete**    |
| Passenger location sharing | Working, opt-in, EN_ROUTE only                                                             | **existed, complete**    |
| Driver location, 2 paths   | Presence **and** trip-scoped `driver_location` both carried driver GPS                     | **duplicated**           |
| Chat                       | None                                                                                       | **missing**              |
| Calls                      | None                                                                                       | **missing**              |
| Payment                    | None                                                                                       | **missing**              |
| Ratings / reviews          | None                                                                                       | **missing**              |
| Disputes                   | None                                                                                       | **missing**              |
| Ride history               | None                                                                                       | **missing**              |
| Admin visibility           | Driver verification + driver availability pages only; **no ride views**                    | **missing**              |
| Admin audit                | Location views audited in `driver_availability_events`, per-feature                        | **incomplete**           |
| Mobile ride UI             | Tracking screens for an existing trip only; no request, offer, chat, call, payment, rating | **incomplete**           |
| Text encoding              | Local Postgres was WIN1252; Nepali text failed (HTTP 500)                                  | **broken** (now guarded) |

## 2. What was built

### Ride lifecycle (server-authoritative)

`trips/trip-machine.ts` is the one transition table. Every change goes through a guarded
compare-and-swap (`casTripStatus`) inside a single `transition()` helper that then updates
tracking, the driver's active-trip pointer, ends a live call, and records the event.

| Your name for it             | Server state / mechanism                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| searching / requested        | `SEARCHING` (trip created by the **passenger**, priced by the server)                                                |
| matching                     | dispatcher offers to the nearest online, fresh driver (`dispatch/`)                                                  |
| assigned + approaching       | `DRIVER_EN_ROUTE`; passenger waiting timer runs                                                                      |
| arrived                      | `DRIVER_ARRIVED` — accepted only if the server has seen the driver within `TRIP_ARRIVAL_RADIUS_METERS` of the pickup |
| driver waiting               | `DRIVER_ARRIVED` timer; charged after the free period                                                                |
| passenger waiting            | `DRIVER_EN_ROUTE` timer; never charged                                                                               |
| started / in progress        | `IN_PROGRESS` (waiting charge is fixed at start)                                                                     |
| completed                    | `COMPLETED`; payment row created `PENDING`                                                                           |
| payment                      | separate axis: `trip_payments` (`CASH`, driver confirms → `PAID`)                                                    |
| rating / review              | opens only after `PAID`; one per person, 1–5 + optional comment                                                      |
| cancellation                 | `CANCELLED` by passenger, by driver (**rematch**, back to `SEARCHING`), by admin (`SYSTEM`), or passenger no-show    |
| timeout / rejection          | offer TTL → next driver; search deadline or max offers → `NO_DRIVERS`                                                |
| driver/passenger unavailable | driver stale/offline mid-ride → `DRIVER_LOCATION_LOST` event, then rematch after `TRIP_DRIVER_LOST_SECONDS`          |
| connection interruption      | clients reconnect, re-read snapshot, fetch missed events by `seq`                                                    |

Races are settled by guarded `UPDATE`s: two drivers accepting the same offer, an offer expiring
while accepted, cancel vs. arrive — exactly one wins, the loser gets a plain 409.

### One event pipeline

`recordTripEvent` writes a persisted, per-trip, **gap-free** `seq` (under a trip row lock) with an
optional `dedupeKey` (so a waiting milestone can fire at most once). It publishes to both people
over the socket and, for important ones, raises a notification. **Everything that words an event
uses `describeTripEvent(event, viewer)`** in `@yatri/types` — system chat lines, announcements,
notifications and the admin timeline. Examples (asserted in tests): "Your driver has arrived.",
"Your driver has been waiting for 2 minutes.", "You have been waiting for 3 minutes.", "Your ride
has started." Events are part of the participant-visible sequence, so it has no gaps; internal
history (offers, disputes) lives in its own tables and the admin view merges it.

### Waiting

`trips/waiting.ts` `computeWaiting()` is the one calculation, from server timestamps. Snapshots carry
`waiting { driver?, passenger?, rule, affectsFare, chargeableSeconds, chargeNpr }`. Devices only
add local elapsed time for on-screen display. Milestones (`WAITING_NOTIFY_SECONDS`) are raised by
`sweepTrips`. After `NO_SHOW_AFTER_SECONDS` the driver may cancel as a passenger no-show (the
button appears from the server's rule; the server re-checks).

### Chat

Trip-scoped, only the two people, opens on assignment, writable during the ride and for
`CHAT_OPEN_AFTER_TRIP_MINUTES` after, read-only history afterwards. Per-trip `seq`, idempotent
`clientMessageId` (retries never duplicate), delivered/read receipts, unread counts, rate limit.
System messages are the ride's own events, merged on read (never stored as chat).

### Calls (signalling on the server, media peer-to-peer)

A server-owned state machine (`RINGING → CONNECTING → CONNECTED → ENDED` with a reason:
completed, declined, missed, cancelled, failed, trip ended). One live call per trip; the call ends
with the ride; unanswered rings become missed calls. Participants are addressed by **role**, never
phone number. The server relays opaque SDP/ICE and hands out STUN (and time-limited TURN
credentials when configured). **The server never sees or records media.**

Client (`@yatri/mobile-ride`): `CallController` follows the server state, runs the WebRTC
negotiation through an injected `RtcFactory`, reports "connected" only when media really is,
gives a media drop a grace period (ICE restart) before ending the call, pauses video (not audio)
on weak connections or when backgrounded, and says every change in words.

**Quality is measured, never claimed** (`callQuality.ts`). "HD audio" requires Opus at a
measured ≥ 32 kbps, ≤ 2 % loss, good level, for 3 consecutive readings; "HD video" requires
measured ≥ 720p at ≥ 24 fps and low loss, also sustained. Anything less reads "standard"; HD is
dropped immediately when the evidence stops.

### Location during the ride

Unchanged and reused (one path): presence `location` → availability → `forwardToActiveTrip` →
`applyLocationUpdate` → snapshot with distance (meters), ETA, place name, heading, freshness.
The duplicate trip-scoped `driver_location` message was **removed**; the driver app no longer
broadcasts from the trip screen. Passenger sharing stays opt-in and EN_ROUTE only.

### Admin

`/admin/trips` (filter, search, paginate, live rides first), `/admin/trips/:id` (full detail),
`/admin/trips/:id/chat` (needs `TRIP_CHAT_VIEW`), `/admin/trips/:id/cancel`, `/admin/disputes`,
`/admin/disputes/:id/resolve`. Dashboard pages: **Rides**, **Ride detail** (summary, waiting and
location freshness, fare and payment, matching history, calls and chat counts, timeline, ratings,
disputes, operator cancel), **Ride conversation**, **Reported problems**. Exact driver coordinates
need `DRIVER_LOCATION_VIEW`, chat text needs `TRIP_CHAT_VIEW`; **both reads are written to the one
`admin_access_log`** (`admin/permissions.ts`; renamed `audit_log` in Phase 10, which also records actions). The earlier per-feature location audit was folded
into it. Live pages refresh on a **switchable** timer (WCAG 2.2.2); the refresh never moves focus
or announces.

### Mobile

New package **`@yatri/mobile-ride`**: `rideApi` (the only trips/chat/call REST client),
`ChatController`, `CallController`, `OfferController`, `callQuality`, `rideActions` (which buttons
a person sees), the native WebRTC adapter, hooks and components (`RideRoom`, `OfferCard`,
`HistoryList`, …). Both apps render the **same** `RideRoom`: live status and waiting timer, Trip /
Chat / Call tabs (unread count and incoming call announced from above the tabs so they are heard
from any tab), role-appropriate actions, payment, rating and "report a problem". The passenger
also gets fare estimate + request and ride history; the driver gets offers (on the existing
presence socket — no second connection) and history.

### Ride request, matching and cancellation (refinement)

**Vehicle category.** The passenger chooses a category (reference data in `vehicle_categories`; the
picker shows what the server returns). One estimate call prices _every_ active category for the two
places and marks each available-or-not near the pickup — a yes/no; no driver, id, position or count
is ever returned. The request must name a category; the ride stores it; only drivers with an
**approved vehicle of that category** are matched. A request with nobody available still searches
(drivers come online) and ends in "no driver available" on the search deadline.

**Fares by category.** `estimateFare` is the one pure function; a category stores only _overrides_
of the platform defaults (`base_fare_npr`, `per_km_npr`, `per_minute_npr`, `minimum_fare_npr`, NULL =
default from `FARE_*` env), merged by `pricing/categories.ts` `pricingFor`. Waiting rules stay
global. The estimated fare (`fare_estimate_npr`) is stored separately from the final fare
(`fare_final_npr`, set only at completion). The seeded overrides are placeholders for operations.

**State names.** The authoritative machine (`trips/trip-machine.ts`) keeps these states; the states in
the original brief map onto them (the per-driver steps live in `trip_offers`, so the trip row never
flips between "matching" and "driver asked" states):

| Brief                                           | Here                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| REQUESTED, MATCHING                             | `SEARCHING` (trip) + an open `trip_offers` row (`OFFERED`)        |
| DRIVER_DECLINED                                 | offer `DECLINED` (trip stays `SEARCHING`, next driver is offered) |
| EXPIRED (a driver's request)                    | offer `EXPIRED`; the trip moves on to the next driver             |
| EXPIRED (nobody found)                          | `NO_DRIVERS`                                                      |
| DRIVER_ASSIGNED / DRIVER_ACCEPTED               | `DRIVER_EN_ROUTE` (accept and assignment are one atomic step)     |
| DRIVER_ARRIVING / WAITING / STARTED / COMPLETED | `DRIVER_EN_ROUTE`, `DRIVER_ARRIVED`, `IN_PROGRESS`, `COMPLETED`   |
| CANCELLED                                       | `CANCELLED`                                                       |

**Events the passenger hears** (persisted, numbered, one wording function `describeTripEvent`):
`TRIP_REQUESTED` "Ride requested. Looking for a nearby driver." (and, on opening the screen,
"Searching for a driver.") → `DRIVER_REQUESTED` "Driver found, 450 meters away. Waiting for the driver
to accept." → `DRIVER_DECLINED` "That driver could not take your ride. Searching for another driver."
(decline _or_ expiry; the payload says which, for admins) → `DRIVER_ASSIGNED` "Driver has accepted your
ride." → or `NO_DRIVERS_FOUND` "No drivers are available right now…". The passenger learns a distance,
never who the driver is. Delivered over the existing socket; nothing polls.

**Matching architecture** (`dispatch/matching.ts`, no controller or app holds a matching rule):

1. _Eligibility_ `findEligibleDrivers` — the one definition, also behind "is the category available":
   verified profile · ACTIVE account · ONLINE with a FRESH location (`isMatchable`) · approved vehicle of
   the category · not on another ride · not holding an open offer · never offered this ride · inside
   `DISPATCH_RADIUS_METERS`. A bounding-box query on indexed last-locations, then exact distance and
   freshness from the live fix.
2. _Ranking_ `MatchingStrategy.rank` — a pure ordering, chosen by `MATCHING_STRATEGY`. Only
   `proximity` exists; ETA / rating / acceptance history are new strategies registered in that file.
3. _Scheduling_ `dispatch.service` — one open offer at a time, TTL, next driver on decline/expiry,
   deadline, max offers. Who wins a contested ride is decided by two guarded `UPDATE`s (offer, then trip),
   never by a client.

**Cancellation** (`trips/cancellation.ts`, one pure decision + one service path). Passenger: free while
searching and within `CANCEL_FREE_SECONDS` of a driver being assigned; later a fee of `CANCEL_FEE_NPR`
is **recorded** on the ride (not charged — payments are a later phase); never once the ride is in
progress. The confirmation shows the server-reported `cancelFeeNpr`; apps never restate the rule. A
driver cancelling sends the ride back to matching (it is not a cancellation of the passenger's ride).
Every cancellation records **who** (`cancelled_by` + the event actor), **why** (`cancel_reason`),
**when** (`ended_at` and the event time), **from which state** (`cancelled_from_status`, written in the
same UPDATE as the transition so it cannot disagree) and the **fee**; the `TRIP_CANCELLED` event carries
`fromStatus` and `feeNpr`, and the admin ride detail shows them.

**Indexes added for this:** `trips(vehicle_category_id, status)`, `trips(requested_at desc)`,
`driver_last_locations(latitude, longitude)`, and a partial `vehicles(category_id, driver_user_id)` for
approved vehicles (existing: status/creation, passenger and driver history).

### The live lifecycle after assignment (refinement)

**State names.** The brief's names map onto the one machine (`trips/trip-machine.ts`); nothing was
renamed because the states, events, SQL and both apps all derive from that single list:

| Brief                            | Here                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| DRIVER_ASSIGNED, DRIVER_ACCEPTED | `DRIVER_EN_ROUTE` (accepting _is_ being assigned: one atomic step)                |
| DRIVER_ARRIVING                  | `DRIVER_EN_ROUTE` + live distance/ETA in the snapshot, `DRIVER_NEARBY` milestones |
| DRIVER_WAITING                   | `DRIVER_ARRIVED` + the server waiting timer (`waiting.driver`)                    |
| RIDE_STARTED / RIDE_COMPLETED    | `IN_PROGRESS` / `COMPLETED`                                                       |
| CANCELLED                        | `CANCELLED`                                                                       |

**Events** (one model, `TRIP_EVENT_TYPES` in `@yatri/types`): DRIVER_LOCATION_UPDATED and
RIDE_LOCATION_UPDATED are the _snapshot_ stream (a location update is state, not a numbered event, so
it cannot flood the log or the screen reader); DRIVER_APPROACHING = `DRIVER_NEARBY`; DRIVER_ARRIVED,
DRIVER_WAITING, WAITING_TIME_UPDATED (= the `DRIVER_WAITING` milestones plus the ticking `waiting`
in every snapshot), `TRIP_STARTED`, `TRIP_COMPLETED`, `TRIP_CANCELLED`.

**What a ride actually measured.** On the one ride record: where it started (`started_latitude/longitude`)
and ended (`ended_*`), the distance driven (`actual_distance_meters`), the time taken
(`actual_duration_seconds`), and the waiting charge fixed at the start. Start and completion read the
driver's position from what the **server** last accepted (never from the request) and refuse with
`LOCATION_UNAVAILABLE` when there is none. The distance is an odometer over the driver's _accepted_
location updates while the ride runs (movement under `ODOMETER_MIN_STEP_METERS` is jitter and is ignored), and is never less than
the straight line from start to end (`trips/ride-actuals.ts`).

**Final fare.** `finalFare` in `pricing/pricing.ts` applies the **same** fare rules as the estimate
(`estimateFare`, with the category's rates) to the measured distance and time, then adds the waiting
charge. The estimate (`fare_estimate_npr`) is never overwritten; the passenger and driver see
"Estimated fare" and "Final fare" side by side, with "Distance travelled" and "Ride time". The cash payment
is created for the final fare. Payment settlement beyond that record and ratings are unchanged.

**Who is who.** The passenger's ride screen shows the driver's name, photo (described in text; a failed
photo is simply omitted), vehicle, registration and a rating line ("No ratings yet" until the rating
system feeds it); the driver sees the passenger's name only. The driver can hand the pickup or the
destination (the server's coordinates) to their own maps app for turn-by-turn directions — Yatri's own
distance, ETA and place names keep updating from the one presence feed. Profile picture links are signed and expire, so the server
re-issues a fresh link every time a picture is shown (`users/profile-picture.ts`, used by the profile and
the ride), and the apps turn the server's host-relative path into a loadable URL in one place
(`resolveMediaUrl` in `mobile-auth`).

## 3. Accessibility

- Every state is text with a role; no meaning by colour alone (cash/paid/waiting/quality are words).
- Two announcement sources, each for its own kind of information, so nothing is read twice:
  **server events** (arrived, started, waiting milestones, cancelled, signal lost/restored, payment)
  are spoken by `LiveTripController` in the shared wording; **snapshots** speak only distance / ETA /
  place changes (`announcementPolicy`). `DRIVER_NEARBY` is deliberately not spoken from the event,
  because the distance sentence already is.
- Waiting timers tick on screen but are **not** live regions; they are announced only at the
  server's milestones. The call timer and quality read-out are likewise silent until asked.
- Incoming call: assertive announcement, call tab brought forward, Answer/Decline first in focus
  order. Incoming chat text is announced once, politely, whichever tab is showing.
- History on open is silent (state, not news); reconnect catch-up is announced once, batched.
- 44 pt minimum targets; forms label every field; switches are `switch` role with state.

## 4. Environment variables added

`FARE_BASE_NPR`, `FARE_PER_KM_NPR`, `FARE_PER_MINUTE_NPR`, `FARE_MINIMUM_NPR`,
`WAITING_FREE_SECONDS`, `WAITING_PER_MINUTE_NPR`, `NO_SHOW_AFTER_SECONDS`,
`WAITING_NOTIFY_SECONDS`, `NEARBY_NOTIFY_METERS`, `TRIP_ARRIVAL_RADIUS_METERS`,
`DISPATCH_RADIUS_METERS`, `DISPATCH_OFFER_TTL_SECONDS`, `DISPATCH_SEARCH_TIMEOUT_SECONDS`,
`DISPATCH_MAX_OFFERS`, `TRIP_DRIVER_LOST_SECONDS`, `CHAT_OPEN_AFTER_TRIP_MINUTES`,
`CHAT_RATE_LIMIT_PER_MINUTE`, `CHAT_RETENTION_DAYS`, `MATCHING_STRATEGY`, `CANCEL_FREE_SECONDS`,
`CANCEL_FEE_NPR`, `CALL_RING_TIMEOUT_SECONDS`, `CALL_STUN_URLS`, `CALL_TURN_URLS`,
`CALL_TURN_SHARED_SECRET`, `CALL_TURN_CREDENTIAL_TTL_SECONDS`. See `apps/api/.env.example`.

## 5. Database

Migrations `1738500010000_trip-lifecycle` (trips columns; `trip_events`, `trip_offers`,
`trip_messages`, `trip_calls`, `trip_payments`, `trip_ratings`, `trip_disputes`) and
`1738500020000_admin-access-log`, and `1738600010000_ride-request-categories` (category fare overrides,
`trips.vehicle_category_id`, `cancelled_from_status`, `cancellation_fee_npr`, indexes). **The database must be UTF-8** (Nepali text): the API refuses to
start otherwise (`assertUtf8Database`).

## 6. Privacy and retention

- Chat text is deleted `CHAT_RETENTION_DAYS` (default 90; 0 = keep forever) days after the ride ends, by an
  hourly job, except while a dispute on the ride is open (it is evidence). Events, call metadata,
  payments and ratings are kept. Until then it is readable by admins only with `TRIP_CHAT_VIEW`, every
  read logged. The 90-day default is a placeholder for the business to confirm.
- Call media is never stored; only call metadata (who, when, how it ended) is kept.
- No phone numbers are exposed between passenger and driver; calls and chat are by role.
- Driver coordinates for a ride are shown to admins only with `DRIVER_LOCATION_VIEW`, logged.

## 7. How it was verified

- **API** (Vitest against real Postgres + Redis): `trip-lifecycle` 37, `trip-realtime` 12, `chat`
  10, `calls` 15, `admin-trips` 6, `trip-event-wording` 4, availability suites, and
  **`journey.e2e`** — one test drives request → offer → accept → live location with distance/ETA →
  chat with receipts → call signalling → arrival (proximity-checked) → driver waiting (server
  clock, charged) → start → live trip ETA → complete → cash payment → both ratings → history for
  both people → the admin's view of the same ride including the audited chat read. Full suite:
  346 passed, 0 failed.
- **Mobile packages**: `mobile-location` 99 tests, `mobile-ride` 52 (chat, call state machine with a
  fake WebRTC, quality evaluation, offers, action rules).
- **Admin**: `next build` succeeds; with the API running in test mode against the journey ride,
  the Rides list, Ride detail, audited chat page, Reported problems and dashboard were fetched with a
  real admin session and rendered the ride correctly. (That check caught one wording bug in the admin
  timeline, now fixed and tested.)
- **Apps**: `expo export --platform android` bundles both apps; `tsc` and `eslint --max-warnings 0`
  are clean across the workspace.

## 8. NOT verified / not done (blockers and limits)

These are real. Do not treat the feature as finished for them.

1. **No device testing.** Nothing here has run on a phone, TalkBack, VoiceOver or NVDA. Announcement
   _decisions_ are unit-tested; how a screen reader _speaks_ them is not. Run
   `docs/ACCESSIBILITY_TESTING.md` sections G–I before release.
2. **Calls need a development build.** `react-native-webrtc` and `react-native-incall-manager` are now
   dependencies with the Expo config plugin, but they are native modules (not in Expo Go) and their
   compatibility with React Native 0.86 / the new architecture is **untested**. Without them the app
   says plainly that it cannot carry call audio. The signalling, state machine and quality logic are
   tested; **real audio/video over a real network has never been exercised**, including HD claims.
3. **TURN is required for production.** Without `CALL_TURN_*`, calls across mobile carrier NAT will
   often fail to connect. STUN alone is only for development.
4. **Background calls.** Audio may stop when the app is backgrounded; a foreground service /
   background-audio entitlement is not implemented.
5. **Payments are cash only.** The driver confirms cash; there is no payment gateway and none is faked.
6. **Push notifications** (Expo push) are not implemented; `notify()` records/logs. A closed app is not
   woken for an offer.
7. **Fare distance** is straight-line unless a routing provider is configured (the estimate says so).
8. **Chat retention** is implemented (see section 6) but the 90-day default is unconfirmed.
9. **Admin cannot yet see a live map**, only freshness and (permissioned) coordinates.
10. **Dispatch is one-at-a-time nearest-driver.** No surge, batching or driver-quality ranking.
11. **Foreground-only location** (as in Phases 4–5).
12. Windows firewall / system security changes are yours to make; nothing here changes them.

## 9. Single-source-of-truth notes

- Statuses, event types and their wording, waiting/fare shapes, chat/call limits and states, the
  realtime protocol and the admin permission list are each defined once in `@yatri/types`
  (`trip.ts`, `trip-events.ts`, `trip-comms.ts`, `trip-commerce.ts`, `realtime.ts`, `admin.ts`,
  `format.ts`). `formatDistance/formatDuration/formatElapsed/formatNpr` moved there; the mobile copy
  and the API's copies were removed.
- Pricing rules in `pricing/pricing.ts` only; waiting in `trips/waiting.ts` only; "what buttons"
  in `mobile-ride/rideActions.ts` only; the admin permission check and audit in
  `admin/permissions.ts` only.
- Recorded remaining duplication: the realtime protocol is still both a TypeScript union
  (`realtime.ts`) and zod schemas (`realtime/gateway.ts`) — exercised together by the tests; the goal
  is to derive the types from the schemas.
