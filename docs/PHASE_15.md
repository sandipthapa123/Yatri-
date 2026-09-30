# Phase 15: advanced dispatch, dynamic pricing and zones

Phase 15 adds the operational controls a growing ride service needs, on top of the existing ride, driver,
vehicle, location, fare, realtime, payment, notification, admin and analytics systems. Nothing here is a
second version of any of them: every rule is defined once (the owners are in the table in
[`ARCHITECTURE.md`](ARCHITECTURE.md)), the backend stays authoritative, and the apps only show what the server
reports.

## What was built

| Brief                        | Where it is                                                                                                                                                                                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dynamic driver dispatch      | `dispatch/matching.ts`: one eligibility query, a ranking strategy, a search radius; `dispatch.service.ts` only schedules                                                                                                                              |
| ETA-based matching           | strategy `eta_workload` (the default): the shared `estimateEta` rule from each driver's distance and speed, plus a penalty per recently finished ride; `proximity` remains selectable                                                                 |
| Dispatch retry and fallback  | every offer that is not taken widens the next search (`DISPATCH_RADIUS_EXPANSION_PERCENT`, up to `DISPATCH_MAX_RADIUS_METERS`); if a strategy ever throws, matching falls back to proximity; the existing offer limit and deadline still end a search |
| Service zones and geofencing | `service_zones` (a boundary as latitude/longitude corners) + `checkZoneAccess` in `@yatri/types` over the ONE `pointInPolygon` in `geo.ts`; enforced on estimate and request, and on which drivers are matched                                        |
| Airport and venue zones      | zone kinds AIRPORT and VENUE with separate "rides may start / end here" flags and a note riders read before confirming                                                                                                                                |
| Dynamic pricing              | `operations/surge.ts` (`pickSurge`, `surgeFor`) decides the multiplier; `pricing/pricing.ts` does the arithmetic; rules in `pricing_rules` (zone, time window, vehicle category, demand, special-event dates)                                         |
| Fare shown before confirming | the estimate carries `surgeMultiplier`, `surgeNpr` and the label; the request carries only `confirmedTotalNpr` (a confirmation, never a price); a changed fare answers 409 `FARE_CHANGED` with the new fare                                           |
| Driver heatmap               | `operations/heatmap.ts` on the one demand/supply source (`demand.ts`); squares of `HEATMAP_CELL_METERS`, counts under `HEATMAP_MIN_COUNT` hidden, no driver id or exact position; a zone table with ratio and current multiplier                      |
| Demand/supply monitoring     | `demandSupplyTable` (the same numbers pricing reacts to), shown in Admin > Demand, zones and pricing                                                                                                                                                  |
| Driver incentives            | `operations/incentives.service.ts`: ride-target, time-of-day and zone bonuses, calculated once when a ride completes and recorded once in `incentive_awards`; audited; the driver sees progress in the app                                            |
| Driver operational limits    | `availability/driver-limits.ts`: most rides per day and longest continuous time online; enforced at go-online (with the reason) and in matching                                                                                                       |
| Admin                        | Demand, zones and pricing (overview, zones, pricing rules, incentives) and dispatch/driver limits under Settings; reading needs `OPERATIONS_VIEW`, every change `DISPATCH_MANAGE` with a stated reason, audited                                       |

## Decisions worth knowing

- **One geography.** A zone is a list of `[latitude, longitude]` corners in the same coordinates as every
  other location; `pointInPolygon` (edges count as inside) is the only containment test, used by zones,
  pricing, dispatch, incentives and the heatmap. No PostGIS and no second coordinate system. Corners are
  checked (at least three, real places, enclosing area); self-intersecting shapes are not detected.
- **Open until configured.** With no service area or city boundary in use, rides are allowed everywhere.
  Once one is in use, both ends of a ride must be inside one, and a driver outside it is not offered rides.
  Restricted, airport and venue zones forbid starting or ending a ride by their flags. A zone is switched
  off, never deleted, so the rules that point at it keep working.
- **Pricing never stacks and is capped.** Among the rules that match (zone, vehicle type, time, demand) the
  highest multiplier wins, never above `SURGE_MAX_MULTIPLIER`. Time windows are in the platform time zone,
  support overnight spans, weekdays and exact special-event dates, and are the same window rule the
  incentives use.
- **The price is locked when requested.** The ride records the multiplier it was quoted; the final fare uses
  it (waiting charges are never multiplied), whatever the rules say later. Payment and the refund quote read
  that one final fare, so the parts always add up: `total = normal fare + demand extra`.
- **Demand is one number.** Requests in the window per available driver, from the matching module's own
  "available driver" conditions, per zone or overall. Pricing rules react to it, and the same figures are on
  the admin overview, so the number a rule reacts to is the number an admin sees.
- **Workload is shared.** Ranking adds `DISPATCH_WORKLOAD_PENALTY_SECONDS` of arrival time for every ride the
  driver finished in the workload window, so a slightly farther rested driver can be offered a ride before a
  nearer busy one. Ties break by distance, then id, so the order is stable.
- **Incentives are records.** A bonus is one row (unique per ride, or per driver and period for a target), so
  a repeated completion or two instances cannot pay twice. It never changes a fare, a payment or a refund.
  Yatri is cash-only and holds no wallet: nothing here pays a driver; the awards list is what finance pays from.
- **The heatmap cannot point at a person.** Positions are snapped to squares, only squares leave the server,
  a square with fewer than the minimum shows "fewer than N" (and a square where both counts are small is
  left out), and each square is drawn at its middle. The map always has the same content as a table and a
  list in words.

## Accessibility

- Every price the rider sees is text: the total, then "Normal fare NPR X plus NPR Y for higher demand" and a
  sentence from one function (`describeSurge`); it is an alert so it is read, and the request button itself
  says the amount ("Request Car for NPR 450"). Zone notes are listed in the estimate. A changed fare is
  announced as an alert and the new fare is shown before anything is requested.
- Category rows read as one sentence including "higher demand pricing".
- The heatmap is an image with a description, each square prints its numbers, and the same squares are
  listed in words and in the zone table; nothing depends on colour.
- Zone, pricing and bonus forms use real labels, checkboxes for days, a confirmation in the page (focus moves
  to it, Escape backs out) before any change that affects riders or drivers, and a status region for results.
- The driver's bonuses are a list of sentences ("3 of 5 rides done this day; 2 to go.").

## Verified, and not

Verified by automated tests (`operations.test.ts`, 37 tests, plus the updated ride, availability and admin
tests): point-in-polygon (inside, outside, edge, corner, concave), boundary validation, zone rules and their
enforcement on estimate and request (including a point on the edge and one a metre outside), window matching
(days, hours, overnight, event dates, time zone), surge selection (zone, category, window, demand, cap,
highest-wins), the fare parts adding up, the price being shown before confirming and refused when changed,
the multiplier being locked and used for the final fare and payment, workload ranking, radius widening and
its limits, matching exclusions (outside the service area, stale location, online too long, daily ride
limit), one driver never holding two offers under simultaneous requests, heatmap privacy, incentive rules,
once-only awards, bonuses never touching fares, payments or refund quotes, RBAC on every route, audit.

**Not verified, and open:**

- No screen reader or device was used; the screens are typechecked, linted and statically checked. Run
  `ACCESSIBILITY_TESTING.md` section N before a release.
- The road-route ETA is not asked for each candidate (too slow); ranking uses the shared straight-line ETA
  estimate with the driver's speed. Swap in the route provider behind `estimateEta` when a provider is chosen.
- There is no map tile view of zones; boundaries are typed as corners. A drawing tool is a separate feature.
- Fare rules, surge caps, radius, limits and heatmap privacy numbers are operating defaults, not legal or
  commercial advice. Some places regulate surge pricing or require a cap or a notice: check before using it.
- Load beyond the test dataset was not measured. The zone list, pricing rules and demand are cached for 5 to
  10 seconds per instance, so a change can take that long to reach another instance.
- Bonuses are not paid by this system.
