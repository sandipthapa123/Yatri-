# Phase 23: advanced navigation and route intelligence

Phase 23 gives an active ride a route, turn-by-turn directions for the driver, a plain-text picture of the trip for the
passenger, and a server that notices when the driver leaves the route and finds a new one. It is built on what already
existed: the route provider abstraction (Phase 4), the tracking pipeline that accepts GPS readings, the live snapshot and
trip events, the settings registry, the risk system, the Phase 21 recovery pieces and the Phase 22 accessibility work.
There is no second location system, no second routing path and no second event channel, and nothing here prices a ride.

## Who decides what

- **The server** keeps the route, knows which maneuver is next, whether the driver is off the route, which phase of the
  approach they are in, and when to plan a new route. Every device therefore agrees, and nothing depends on a phone's
  battery or on a client's arithmetic. The ride's state, and the fare, stay exactly where they were.
- **The apps** show the guidance, speak it sparingly, draw an optional map line, and open a maps app if asked. They never
  decide that a ride has arrived, that a driver went the wrong way, or what anything costs.

## What was built

| Brief                                 | Where it is                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| One route/navigation abstraction      | the existing `RouteProvider` now returns steps, geometry and a `trafficAware` flag in ONE shape, and states its `capabilities`. OSRM, GraphHopper and Valhalla adapters fill it; a new vendor is one adapter (`location/providers/route-provider.ts`)                          |
| Route creation, distance and duration | `navigation/navigation.service.ts` plans the route for the current target (pickup, then destination) with one provider call that also gives the ETA; a straight-line guide in words when no engine answers. `GET /trips/:id/navigation` (driver only)                          |
| Turn-by-turn, next step               | the server tracks progress along the route and puts the next maneuver in the driver's live snapshot (`navigation`); the app shows "In 300 meters, turn left onto New Road." and the whole step list                                                                            |
| Route display                         | an optional line on the existing map (`YatriMap routeLine`); never needed: everything is text                                                                                                                                                                                  |
| Deviation detection and rerouting     | several accurate readings in a row beyond a distance (widened by the reading's own inaccuracy) confirm a deviation; a new route is planned, at most once per interval. One reading, or a poor reading, changes nothing                                                         |
| Traffic-aware ETA where supported     | a provider that follows traffic sets `trafficAware`; its duration is refreshed every minute without a new route. The screens say whether the estimate includes live traffic. No bundled engine does, so by default they say it does not                                        |
| Pickup and destination intelligence   | the pure `approachPhase` rule (`@yatri/types`): heading to / approaching / near / at the pickup, leaving it, heading to / approaching / near / at the destination. The thresholds are platform settings (`NAV_*`), edited in the admin Settings                                |
| Arrival detection                     | at the destination it records one `DESTINATION_NEARBY` event per milestone (approaching, near, at), worded for each person; the pickup keeps its existing "driver nearby" events and the driver's own arrival action. Detection tells people; it never ends a ride             |
| Accessible navigation information     | the driver's directions and the passenger's "Your trip so far" are sentences; spoken updates are rare (a new route, a deviation, a maneuver coming up once at 300 m and once at 40 m, the pickup); the figures are not live regions                                            |
| Passenger text progress               | `describeTripProgress`: "You are travelling toward your destination. Current location: Kalimati, Kathmandu. Distance remaining: 3.4 kilometres. Estimated arrival: 11 minutes. You are approximately 180 metres from the destination." Built only from the server's figures    |
| Risk, without penalising              | a confirmed deviation is a count on the ride. The risk rule `ROUTE_DEVIATION_PATTERN` (a few points, driver, category GPS) fires only for a pattern: at least three separate deviations on each of at least three rides in a week. It raises a signal for review, nothing else |
| Admin                                 | Routes and arrival times: counts and percentages (routes planned, fallbacks, new routes, deviations, arrivals detected, how good first estimates were). No driver, passenger or place appears                                                                                  |
| Recovery (Phase 21)                   | the route survives a dropped connection (the app keeps the last route and says "Directions may be out of date"), is fetched again when the app returns or the connection comes back, and is planned again from the next reading if the server's cache was lost                 |

## Rules worth knowing

- **Fares.** The route can change mid-ride; the fare cannot be changed by it. The estimate was priced by the fare engine
  at request time, and the final fare uses the existing actuals (distance driven, duration, waiting) through the same
  engine. A test checks the estimate does not move when a ride is rerouted, and another that the navigation module does not
  touch pricing at all.
- **A deviation is not a fault.** It is counted privately on the ride and the driver is simply given a new route. Only a
  repeated pattern across rides produces a low-weight risk signal, which a person reviews. The risk system never suspends.
- **GPS accuracy.** Readings worse than the accuracy setting never count towards a deviation, and a reading is never taken as
  "near" or "at" a place whose radius is smaller than its own error. The existing tracking rules still drop impossible jumps first.
- **Battery and data.** The phone sends location exactly as before. The route is fetched only when the server says its version
  changed, one request at a time, and an unchanged route is not sent again. The line is simplified to within 5 metres of itself
  and to at most 400 points. A new route is planned at most every 20 seconds by default.
- **Privacy.** A route starts at the driver's position, so only the driver of an active ride can fetch it; the passenger's
  snapshot has no guidance and no route, only text figures. Routes and positions live in Redis only while the ride is active and
  are deleted with it. The database keeps counts (deviations, new routes, the first estimated duration) and daily counters,
  never a coordinate or a track.

## Not done, honestly

- **Nothing was driven.** No real route engine was connected in testing (a controllable one stands in), no phone was in a
  moving car, and the voice and screen-reader behaviour was not heard with TalkBack, VoiceOver or NVDA. Section V of
  `ACCESSIBILITY_TESTING.md` lists the checks that need a person on a road.
- **No live traffic provider exists in this system.** The abstraction, the flag, the refresh and the wording are in place and
  tested with a stand-in, but the bundled adapters (OSRM, GraphHopper, Valhalla) use typical speeds, so real arrival times will
  not reflect congestion until a traffic-aware adapter is written and configured.
- **Matching the vehicle to the road is not done.** Positions are not snapped to roads; "off the route" is distance from the
  line, so a wide road, a service road beside it, or a poor map can look like a deviation or hide one. That is why the
  thresholds are settings and why one deviation means only a new route.
- **Voice guidance is the screen reader's.** The app does not generate spoken turn instructions through its own speech
  engine or play sounds. It writes the sentences to a live region (and speaks them on iPhone) like the rest of the app.
- **Maps are the existing map.** Tiles, theme and offline map downloads are unchanged; a release build with no tile server
  shows no map (the text carries everything).
- **No lane guidance, speed limits, tolls or multi-stop routes.** Rides have one pickup and one destination.
- **The route is not recomputed when a passenger changes the destination mid-ride**, because the destination cannot be
  changed mid-ride in this product.
- A route shown on the map is as simplified as the wire needs, not survey-grade.
