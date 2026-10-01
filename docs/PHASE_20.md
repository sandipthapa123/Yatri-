# Phase 20: multi-city service configuration

Phase 20 makes "where Yatri operates, and under which rules" data. A city is a record an administrator adds and
configures; nothing in the API or any app names a city. It reuses the existing geofence (`service_zones`), the fare,
waiting and cancellation settings (`platform_settings`), vehicle categories, document types, drivers, matching,
rides, payments, admin screens and RBAC. There is no second map, geofence or settings system.

## How a place maps to rules

```
a point → the coverage zones that contain it (service_zones, kinds SERVICE_AREA and CITY)
        → the highest-priority one that has a city (service_zones.city_id)
        → the city
```

A city's boundary is therefore its zones. A point inside a zone that belongs to no city keeps the platform-wide rules
exactly as before cities existed, so nothing changes for a deployment that configures none.

## What was built

| Brief                                   | Where it is                                                                                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cities, provinces                       | `cities` (code, name, province, time zone, map centre, status, version). `PROVINCES` (Nepal's seven) is reference data in `@yatri/types` `cities.ts`                                                                                           |
| Service areas (boundaries)              | the existing zones: a zone's `city_id` assigns it to a city (city page, or the zone form). Only service-area and city-boundary zones can be part of a city; airport and venue zones keep working inside it                                     |
| Operating status                        | `COMING_SOON`, `ACTIVE`, `PAUSED` with a transition table; a city with no active service area cannot be opened, and an open city cannot lose its last one                                                                                      |
| Operating hours                         | `city_hours` windows in the one time-window shape (`windowActive`); none means open all day. `cityServiceState` is the one rule, words from `describeWindow`                                                                                   |
| Available vehicle categories            | `city_categories` (a row switches a category off here; no row means offered, so a new category appears everywhere by itself). A city must offer at least one                                                                                   |
| City fare, cancellation, waiting values | `city_settings`: the city's value for a platform setting of the same key (nine keys, `CITY_OVERRIDABLE_SETTINGS`), checked by that platform setting's own definition. `city-rules.ts` lays them over `pricingConfig()` / `cancellationRules()` |
| City payment options                    | `city_payment_methods`; the personal methods only (a business account pays by its own policy). A city must offer at least one                                                                                                                  |
| City driver requirements                | `city_requirements`: extra documents a driver must hold (approved, unexpired) to go online there; the refusal names the document                                                                                                               |
| Service availability                    | `assertRideService` (`cities.service.ts`): asked by every estimate and ride request (so also business bookings and approvals): city open now, drop-off in the same city, category offered; `GET /config/service-at` tells the apps first       |
| Right city, automatically               | the ride records `trips.city_id` from the pickup; fare, waiting and cancellation use the ride's city; go-online uses the driver's own opening fix; matching offers a ride only to drivers inside the pickup's city                             |
| Admin                                   | Cities and service areas: list, add, edit, open/pause, boundary, hours, vehicle types, fares/waiting/cancellation, payment options, driver requirements, city analytics (rides, completion, fares, drivers online), audit trail                |
| One source for the apps                 | `GET /config/platform` now lists the cities (open now, hours, offered categories and payment methods). The map start comes from it; the hard-coded city centre in the picker and the map is gone (a test keeps it gone)                        |

## Rules worth knowing

- **Precedence for money rules:** a vehicle category's own rates, then the city's value, then the platform value. A key
  a city does not set is the platform's, so changing the platform value reaches every city that has not overridden it.
- **A ride follows its city.** `trips.city_id` is set once, at the request. The ride's waiting, no-show and cancellation
  rules and its final fare read that city's values; if an administrator edits the city's values while a ride is under way,
  the new values apply to it from then (the rider's quoted surge multiplier, as before, is locked).
- **No ride crosses a city line.** A pickup in one city and a drop-off in another is refused (`CROSS_CITY_RIDE`), and so
  is a pickup outside every city with a drop-off inside one. A drop-off outside every service area is the zones' own refusal.
- **Concurrent edits.** Every change to a city or anything under it locks the city row, requires the version the
  administrator saw, raises it, and writes the audit entry with the stated reason: of two simultaneous edits one wins and
  the other is told to reload.
- **Who may change it.** Reading needs `OPERATIONS_VIEW`; every change needs `DISPATCH_MANAGE`, the permission that
  already governs zones, pricing and incentives. The platform-wide fare settings stay with `SETTINGS_MANAGE`.

## Not done, honestly

- **Existing deployments start with no cities.** Until an administrator adds one and assigns zones, behaviour is exactly as
  before. The Kathmandu service area, if one exists, must be put into a city by an administrator; nothing creates it.
- A driver who is online when their city is paused is not forced offline; they stop receiving offers only because new rides
  are refused in the paused city. Going online again is refused.
- A driver's city is where they were at go-online and at matching time; the extra city documents are checked at go-online
  only, not continuously.
- Intercity rides, a different currency or tax per city, per-city notification wording and per-city languages are not built.
- Operating hours use one time zone per city; daylight-saving rules come from the zone name. Nepal has none.
- Nothing here was checked on a device or with a screen reader; see section S of `ACCESSIBILITY_TESTING.md` for the manual
  checks.
