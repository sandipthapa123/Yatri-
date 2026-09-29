# Phase 4 — Maps & Location Infrastructure

## Goal

Give Yatri a provider-independent location layer: current location, place search,
reverse geocoding, distances, saved places, and an accessible pickup/destination
picker — without any ride, matching, fare, payment or live-tracking logic.

## Architecture

```
mobile screens ─► @yatri/mobile-location ─► /api/v1/location/*  ─► location.service
(passenger/driver)   (hooks, picker, map)    /users/me/saved-places   ├─ LocationProvider  (geocode / reverse / search)
                                             /drivers/me/location     └─ RouteProvider     (route / ETA)
```

- **Provider-specific code lives only in `apps/api/src/modules/location/providers/`.**
  Controllers, the service and the mobile apps use the `LocationProvider` and
  `RouteProvider` interfaces and Yatri's own normalized types (`PlaceSummary`,
  `ReverseGeocodeResult`, `DistanceResult` in `@yatri/types`). No vendor field names
  or errors cross that boundary.
- Shipped adapters: `NominatimProvider` (any Nominatim-compatible geocoder: OSM
  Nominatim, self-hosted, LocationIQ-style), `HaversineRouteProvider` (straight-line),
  `OsrmRouteProvider` (road distance + ETA). Adding GraphHopper/Valhalla/Mapbox/etc.
  means one new class plus one case in `providers/index.ts`.
- **GPS is separate from the map provider.** Device position comes from the phone
  (`expo-location`, one-shot). The map (Leaflet in a WebView, tile URL from config) is a
  supplementary visual only and can be replaced (e.g. MapLibre) behind the same
  `YatriMap` props.
- The backend is authoritative for distance. Clients never supply a distance; the
  `/location/distance` endpoint computes it from validated coordinates.

## Map provider

| Concern   | Default                        | Configure via                                      |
| --------- | ------------------------------ | -------------------------------------------------- |
| Geocoding | Nominatim (OpenStreetMap data) | `LOCATION_PROVIDER*`                               |
| Routing   | Haversine (straight-line)      | `LOCATION_ROUTING_PROVIDER` (`haversine` / `osrm`) |
| Map tiles | OSM raster tiles in Leaflet    | `EXPO_PUBLIC_MAP_TILE_URL` (mobile)                |

Nepal is the default focus (`LOCATION_COUNTRY_CODES=np`, `accept-language=en,ne`,
labels built from locality/city/province — no street-number assumption), but nothing
is hard-coded to Kathmandu: add country codes to expand.

## Environment variables

API (`apps/api/.env`, see `.env.example`; **never commit real values**):

| Variable                                | Default                               | Purpose                                                            |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `LOCATION_PROVIDER`                     | `nominatim`                           | `nominatim` or `none` (endpoints return 503)                       |
| `LOCATION_PROVIDER_BASE_URL`            | `https://nominatim.openstreetmap.org` | Geocoder base URL. **Public OSM server is refused in production.** |
| `LOCATION_PROVIDER_API_KEY`             | _(empty)_                             | Optional key for commercial providers; server-side only            |
| `LOCATION_PROVIDER_USER_AGENT`          | `Yatri-API/0.1 (dev)`                 | Identifying UA with a contact (required by Nominatim policy)       |
| `LOCATION_COUNTRY_CODES`                | `np`                                  | Comma-separated ISO codes results are limited to                   |
| `LOCATION_REQUEST_TIMEOUT_MS`           | `4000`                                | Per-request provider timeout                                       |
| `LOCATION_SEARCH_CACHE_TTL_SECONDS`     | `86400`                               | Redis cache for search (0 disables)                                |
| `LOCATION_REVERSE_CACHE_TTL_SECONDS`    | `86400`                               | Redis cache for reverse geocoding (0 disables)                     |
| `LOCATION_ROUTING_PROVIDER`             | `haversine`                           | `haversine` or `osrm`                                              |
| `LOCATION_ROUTING_BASE_URL`             | `https://router.project-osrm.org`     | OSRM base URL (use your own in production)                         |
| `LOCATION_SEARCH_RATE_LIMIT_PER_MINUTE` | `60`                                  | Per-user rate limit on location endpoints                          |

Mobile (Expo inlines `EXPO_PUBLIC_*` at build time; these are **public** — never put a
secret here):

| Variable                      | Default                                          | Purpose                      |
| ----------------------------- | ------------------------------------------------ | ---------------------------- |
| `EXPO_PUBLIC_MAP_TILE_URL`    | `https://tile.openstreetmap.org/{z}/{x}/{y}.png` | Tile server for the map      |
| `EXPO_PUBLIC_MAP_ATTRIBUTION` | `© OpenStreetMap contributors`                   | Attribution shown on the map |

Separate config per environment: `.env` (development), `.env.test` (tests use
`LOCATION_PROVIDER=none` and inject fakes), and real environment variables in
production.

## Database changes (migrations `17382000x0000_*`)

- `locations` — `latitude`/`longitude numeric(10,7)` (≈1 cm) with range `CHECK`s,
  `address`, `place_name`, `city`, `province`, `country`, `postal_code`,
  `provider_metadata jsonb`. Created only for places a user explicitly saves; later
  phases will reference it for ride pickup/destination. Not a GPS log.
- `saved_places` — `user_id`, `location_id`, `kind` (`HOME`/`WORK`/`FAVOURITE`), `name`,
  optional `label`. Unique: one Home and one Work per user; names unique per user
  (case-insensitive).
- `driver_last_locations` — one row per driver, overwritten on each explicit share.
  No history.

**PostGIS is not required.** Nothing runs spatial queries until driver matching.
When it does, add a `geography(Point,4326)` column + GiST index to the relevant
table (and `CREATE EXTENSION postgis`); the coordinate columns remain the source of
truth. Coordinates are never stored as strings.

## API (all under `/api/v1`, all require a signed-in user)

| Method & path                                                 | Role      | Notes                                                                  |
| ------------------------------------------------------------- | --------- | ---------------------------------------------------------------------- |
| `GET /location/search?q=&limit=&nearLatitude=&nearLongitude=` | any       | 2–100 chars, limit 1–10 (default 5). Bias point is coarsened to ~1 km. |
| `GET /location/reverse-geocode?latitude=&longitude=`          | any       | 404 `LOCATION_NOT_FOUND` when nothing is known there                   |
| `POST /location/distance`                                     | any       | `{origin, destination, method: 'straight_line'\|'route'}`              |
| `GET/POST /users/me/saved-places`                             | passenger | Max 50 per user                                                        |
| `GET/PATCH/DELETE /users/me/saved-places/:id`                 | passenger | Scoped to the owner in SQL — others get 404                            |
| `PUT/GET/DELETE /drivers/me/location`                         | driver    | Explicit one-shot last-known position                                  |

Coordinates are validated server-side: finite numbers (or plain decimal strings),
lat ∈ [−90, 90], lon ∈ [−180, 180], `0,0` rejected as a "no fix" placeholder; NaN,
Infinity, blank, hex/exponent, arrays and missing values are rejected.

Errors: `VALIDATION_ERROR` (400), `RATE_LIMITED` (429), `LOCATION_NOT_FOUND` (404),
`LOCATION_PROVIDER_BUSY` (503, provider rate limit/quota), `LOCATION_PROVIDER_UNAVAILABLE`
(503, outage/timeout/bad response), `SAVED_PLACE_EXISTS` / `SAVED_PLACE_DUPLICATE_NAME` /
`SAVED_PLACE_LIMIT` (409). Provider messages, URLs and keys are logged server-side and
never returned.

## Permissions & privacy

- Location is requested only after the UI explains why, and only when the user taps
  "Use current location" / "Get my current location". Foreground, one-shot; no
  background or continuous tracking. Android `ACCESS_FINE/COARSE_LOCATION` and the iOS
  `NSLocationWhenInUseUsageDescription` come from the `expo-location` config plugin
  (see each app's `app.json`).
- Handled: denied (can ask again), blocked (Settings only, with an "Open phone
  settings" button), location services off, no fix, timeout, and poor accuracy
  (> 100 m is flagged and the user is asked to confirm or search instead).
- No passenger location history is stored. The driver's last position is one
  overwritten row, readable only by that driver; the driver can delete it. Passengers
  cannot read any driver location.
- Search sends the provider only a coarsened (~1 km) bias point; reverse-geocode
  caches are keyed by place (~11 m cell), never by user.
- Search/reverse/distance require authentication and are rate limited per user.

## Accessibility approach

The map is **never** the only way to do anything. `YatriMap` is hidden from assistive
technology; everything it shows exists as text, and zoom / re-centre are native,
labelled 44 pt buttons.

`LocationPicker` (shared by pickup, destination and saved-place flows):

- Explanatory text before any permission prompt; every state (denied, blocked, off,
  timeout, poor accuracy, search failure, map failure) has a plain-language alert with
  a next step.
- Labelled search field; results are a list of buttons announced like
  "Thamel, Kathmandu, Bagmati Province. Result 1 of 5."; result counts, progress and
  selection are spoken through a polite live region (plus explicit announcements on
  iOS, where live regions are unreliable).
- After selection, focus moves to a summary — "Pickup selected: Thamel Chowk,
  Kathmandu, Bagmati Province. Latitude and longitude are available to the system." —
  which also lists coordinates and accuracy as text.
- Debounced (350 ms), cancellable, cached search: no request per keystroke.
- No colour-only state (selected radio has a tick and thicker border); ≥ 44 pt targets.

## Provider limitations

- The public OSM Nominatim server is for development only (1 req/s, no autocomplete
  use). Production must use a self-hosted or commercial Nominatim-compatible service;
  the server refuses to boot with the public URL when `NODE_ENV=production`.
- Nepali-script search depends on the provider's data; OSM coverage of names and
  landmarks varies by area.
- Nominatim has no business/POI ranking guarantees.
- The Leaflet map loads its library from unpkg and tiles from the configured URL, so
  it needs connectivity (an error state with retry is shown otherwise). Public OSM
  tiles have a usage policy; use a tile provider for production.
- Route distance/ETA needs OSRM (or another `RouteProvider`); otherwise
  `method: 'route'` transparently reports `straight_line`.

## Local development

```bash
pnpm install
pnpm --filter @yatri/api migrate:up        # dev DB
pnpm --filter @yatri/api migrate:test:up   # test DB
pnpm --filter @yatri/api test              # needs Postgres + Redis
pnpm --filter @yatri/mobile-location test  # pure-logic tests, no services
```

Use `EXPO_PUBLIC_API_URL` for a device/emulator (see `packages/mobile-auth/src/config.ts`).

## Intentionally deferred

Ride requests, driver matching/dispatch, continuous driver location broadcasting,
live tracking and ETA-over-time, fares, payments, ratings, SOS, trip sharing, ride
history, PostGIS/spatial queries, route geometry display and turn-by-turn navigation.
