# Live Trip Tracking & the Non-Visual Trip Layer

## Scope

Realtime driver/passenger location during an **active trip**, distance / ETA / place
names that update without any refresh, and an interface a blind user can complete
without the map. Ride requests, matching, fares, payments, ratings, SOS, trip sharing
and ride history are still **not** implemented.

**A note on trips.** Live tracking needs something to attach access control to, and
ride requests do not exist yet. This phase adds a minimal `trips` table (participants,
status, pickup/destination `locations`). Until matching exists, trips are created by an
**admin-only** endpoint (`POST /api/v1/admin/trips`); the driver moves a trip through
`DRIVER_EN_ROUTE → DRIVER_ARRIVED → IN_PROGRESS → COMPLETED` (either side may cancel).
Matching will replace only the creation step.

## Architecture

```
Driver GPS (expo-location, foreground)
  → useLocationBroadcast → TripRealtimeClient ──ws──► gateway ─► tracking.service
                                                                  │  (rules, ETA, place names)
                                                          Redis: trk:{trip}:*  ◄┘
                                                                  │ publish "trip changed" (no coordinates)
Passenger app ◄── snapshot / event ◄── gateway (per-role snapshot) ◄┘
```

Concerns are separate, each behind its own interface:

| Concern                    | Where                                                                   |
| -------------------------- | ----------------------------------------------------------------------- |
| GPS (device)               | `expo-location` in `useLocationBroadcast` / `useCurrentLocation`        |
| Map rendering              | `YatriMap` (replaceable; screen-reader-hidden)                          |
| Geocode / reverse / search | `LocationProvider` (`providers/`)                                       |
| Routing, distance, ETA     | `RouteProvider` + `tracking/eta.ts` (falls back to a labelled estimate) |
| Acceptance of GPS fixes    | `tracking.rules.ts` (pure)                                              |
| Realtime transport         | `realtime/gateway.ts` + `bus.ts` (Redis pub/sub)                        |
| When to speak              | `announcementPolicy.ts` (pure)                                          |
| What to say                | `tripText.ts` (pure)                                                    |

Providers are chosen by configuration only (`createLocationProvider` /
`createRouteProvider`). `provider-switching.test.ts` runs the same ETA function against
OSRM, GraphHopper, Valhalla and the offline fallback.

## Realtime protocol (`/ws/v1/realtime`)

JSON messages; types in `packages/types/src/realtime.ts` (this document covers the tracking part of the
protocol; chat, calls, offers and events are in [PHASE_6](PHASE_6.md)).

- The **first** message must be `{type:'auth', token}` (never in the URL). No auth within
  5 s → close `4401`. A client re-sends `auth` with a fresh token every 10 minutes; the
  server closes a socket whose token has been expired for more than 30 s, and re-checks
  the session every 60 s (revoked/suspended accounts are dropped).
- `subscribe {tripId}` → `subscribed` + a full `snapshot`. Non-participants, missing and
  ended trips all get the identical `NOT_FOUND` error (no way to probe other trips).
- `passenger_location {tripId, latitude, longitude, accuracyMeters, deviceTimeMs}`;
  `stop_sharing`; `ping`. The driver's position arrives **only** through driver presence
  (`location`, Phase 5), which the server forwards into the driver's active trip. There is no
  trip-scoped driver message.
- Server → client: `snapshot` (role-specific, with a per-trip monotonic `version`),
  `trip_event {event, important}` (persisted domain events with a gap-free per-trip `seq`; see
  PHASE_6), `rejected {reason}`, `error`.
- Limits: 4 KB messages, 8 msgs/s per socket, slow consumers skip snapshots.
- Reconnect = resubscribe = full current state; no replay log needed. Clients drop
  snapshots with an older `version` (duplicates / out-of-order) and fetch events they missed
  with `GET /trips/:id/events?after=<seq>`.
- REST fallback: `GET /api/v1/trips/:id/live` (participants, active trips only) for first
  paint.

## GPS acceptance rules (`tracking.rules.ts`)

A fix is rejected as: `invalid` (NaN/range/0,0), `clock_skew` (device clock > 60 s ahead),
`stale` (> 30 s old on arrival), `low_accuracy` (> 200 m, or ≥ 3× worse than a fresh good
fix), `duplicate`, `out_of_order`, `too_frequent`, or `impossible_jump` (faster than
55 m/s plus accuracy radii). A rejected jump is remembered as a candidate: if the device
keeps reporting from the new place (3 consistent fixes) the earlier fix was the bad one
and the new position is accepted; scattered wild fixes never take over. Freshness of the
feed is judged by the **server** clock using the shared config (`DRIVER_LOCATION_FRESH_SECONDS`, default 30 s; `DRIVER_LOCATION_LOST_SECONDS`, default 60 s): `live`, then `stale`, else `lost`
(a sweeper broadcasts the change, so GPS loss is noticed even when nothing arrives).

## Distance, ETA, waiting time — never conflated

`LiveTripSnapshot` carries three distinct, mutually exclusive values:
`driverArrival` (only `DRIVER_EN_ROUTE`: driver→pickup), `trip` (only `IN_PROGRESS`:
driver→destination), and `waiting` (a server-computed structure: the passenger waiting while the
driver approaches, the driver waiting after arrival; see PHASE_6). ETA comes from the
`RouteProvider` when it can give a duration (`basis: 'route'`, re-queried at most every
30 s or 150 m of movement, otherwise scaled by remaining distance); otherwise a
speed-based estimate with `basis: 'estimate'`, shown as "(estimate)". Distance is
always the server's calculation.

## Place names

The driver's road/place is reverse-geocoded only after moving ≥ 75 m and ≥ 15 s since
the last lookup (`TRACKING_PLACE_REFRESH_MS`), cached by ~11 m cell. If geocoding fails
the previous name is kept and flagged `placeStale`; the UI says "Place name temporarily
unavailable" once. Roads read "on New Road", places "near Thamel Chowk".

## Privacy & retention

- Live positions exist **only in Redis**, only while the trip is active, and are deleted
  when it ends (`onTripStatusChanged`). There is no location-history table; after a
  trip the passenger gets `409` from REST and `NOT_FOUND` from the socket.
- The driver's position is visible to the trip's passenger only while active. The
  passenger's position is visible to the driver only while `DRIVER_EN_ROUTE` and only if
  the passenger switched sharing on (off by default; can be withdrawn). It stops the
  moment the driver arrives.
- Only the trip's driver can report the driver position; only its passenger the
  passenger's. Snapshots are built per viewer in one function (`buildSnapshot`).
- Fan-out messages carry no coordinates.
- Reverse geocoding sends the (exact) position to the configured geocoder — use a
  self-hosted one if that matters.
- **Transport:** run the API behind TLS in production so clients use `wss://`
  (`EXPO_PUBLIC_WS_URL` overrides the derived URL; `https://` API base → `wss://`).

## Accessibility design

- `LiveTripView` = a **"Live trip status"** header, an assertive region (arrived, started,
  completed, cancelled, signal lost only), a polite region (everything else), a connection
  notice region, and a structured list (Driver's current location · Driver distance ·
  Driver arrival ETA / Trip ETA / Waiting time · Trip status · Pickup · Destination ·
  Location accuracy · Last location update). Each row is one focusable item
  ("Driver distance: 180 meters"). The map is an optional, hidden extra with native
  labelled zoom/re-centre buttons.
- Speech is driven by snapshot changes through `announcementPolicy`: distance is
  re-announced only after a 50 m (close) / 100 m (mid) / 500 m (far) change, ETA after
  ≥ 1 min or 40 %, place only when the name changes, polite messages at most every 10 s,
  GPS jitter never. Realtime `event` messages are not spoken separately (no double
  announcements). The age of the last update is refreshed visually every 5 s but is not
  inside a live region.
- No colour-only state; 44 pt targets; errors are `alert`s with a next step.

## Environment variables added

API: `TRACKING_MIN_INTERVAL_MS` (800), `TRACKING_PLACE_REFRESH_MS` (15000),
`LOCATION_PROVIDER` now also accepts `static`, `LOCATION_ROUTING_PROVIDER` also accepts
`graphhopper` / `valhalla`, `LOCATION_ROUTING_API_KEY` (server-side only). See
`docs/PHASE_4.md` for the rest. Mobile: `EXPO_PUBLIC_WS_URL` (optional).

## Database

`trips` (migration `1738300010000`): participants, `status` CHECK, pickup/destination
`locations`, timestamps, `cancelled_by`; partial unique indexes allow one active trip per
passenger and per driver.

## Limitations (honest list)

- **Foreground only.** Fixes stop when the app is backgrounded (no background-location
  task/permission yet); the server marks the feed stale then lost and the driver is told
  to keep Yatri open. Background tracking is a later, explicit-permission feature.
- Fan-out needs Redis pub/sub; a single Redis is a single point of failure.
- Without OSRM/GraphHopper/Valhalla the ETA is an estimate, not a route.
- Not verified on a real device or with NVDA/TalkBack/VoiceOver in this phase — see
  `docs/ACCESSIBILITY_TESTING.md` for the manual protocol. There are no React Native
  component tests; the announcement policy, text builders, realtime client and controller
  are unit tested instead, and the gateway/tracking flow is integration tested.
- Reverse geocoding uses the public OSM server in development only (see PHASE_4).
- Matching, fares, payments and history arrived in Phase 6 (see PHASE_6 for its own limits).
