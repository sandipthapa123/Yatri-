# Phase 16: fleets and driver operations

Phase 16 adds fleet (operator) management, vehicle assignment and lifecycle, expiry monitoring with automatic
reminders, inspection and maintenance records, and an operational status for drivers, on top of the existing
driver, vehicle, document, location, ride, notification, admin, RBAC, audit and analytics systems. Nothing here
is a second version of any of them: every rule is defined once (the owners are in the table in
[`ARCHITECTURE.md`](ARCHITECTURE.md)), and the backend stays authoritative.

## What was built

| Brief                          | Where it is                                                                                                                                                                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fleet / operator management    | `fleets` (name, contact, status) in `fleet/fleets.service.ts`; a fleet's vehicles and drivers are the records that point at it (`vehicles.fleet_id`, `driver_profiles.fleet_id`), not a second list                                                |
| Driver-to-vehicle assignment   | ONE source: `vehicles.driver_user_id` (now nullable for an unassigned fleet vehicle). `assignmentProblems` validates, `assignVehicle` / `unassignVehicle` apply under row locks                                                                    |
| Vehicle lifecycle              | `VEHICLE_LIFECYCLE_STATES` and its transition table in `@yatri/types`, applied in `fleet/vehicle-lifecycle.ts` (`setLifecycle` under a row lock); separate from the vehicle's verification status                                                  |
| Ineligible vehicles never ride | `VEHICLE_RIDEABLE_SQL` / `DRIVER_RIDEABLE_SQL` in `fleet/eligibility.ts` are in the matching and supply queries; `vehicleRideProblems` / `driverFleetProblems` say the same rules in words (go-online, admin pages); a test keeps the two in step  |
| Document expiry monitoring     | `fleet/expiry.service.ts` reads driver and vehicle documents from the existing document tables, the licence date from `driver_details`, registration and insurance from `vehicles`, and service dates from service records; one `expiryState` rule |
| Reminders                      | `fleet/monitor.ts` (hourly and on demand): reminders at the thresholds in `EXPIRY_REMINDER_DAYS`, plus expired and missing, each sent once (`expiry_notices`) through the one notification service                                                 |
| Expiry changes eligibility     | it does, immediately: matching and go-online compute eligibility live, so an expired required paper stops rides before any job runs; the monitor then takes an online driver offline and tells them                                                |
| Inspections and maintenance    | `fleet/service-records.service.ts`: start and complete maintenance, inspections (a failure takes the vehicle out of service and opens the repair), services with a next date; records point only at the vehicle                                    |
| Driver operational status      | `OPERATIONAL_STATES` (active, restricted, suspended) and its table in `@yatri/types`, applied in `fleet/operational.service.ts`; a restriction has a real effect (a lower daily ride cap), a suspension takes the driver out of matching           |
| Notifications                  | `FLEET_NOTIFICATION_TYPES` through `lib/notifications`: expiring, expired, missing, vehicle status, maintenance, assigned, unassigned, suspended, restricted, reinstated, eligibility lost                                                         |
| Admin                          | Fleets and driver operations: fleet list and details, drivers, vehicles, assignments, expiring documents, maintenance, suspensions, operational history; `FLEET_VIEW` reads and `FLEET_MANAGE` changes, every change audited with its reason       |

## Decisions worth knowing

- **Five statuses, five models.** Account (`users.status`), verification (`driver_profiles.status`),
  operational (`driver_profiles.operational_status`), availability (the availability machine) and ride
  (the trip machine) each keep their one owner. The driver page shows them side by side, in a table, and
  changing the operational status touches none of the others. The existing "suspend driver" in driver review is
  the verification layer (the driver must be re-verified); the operational suspension is lifted by
  reinstating, without re-verification. They are different decisions, recorded separately.
- **Eligibility is never stored.** There is no "eligible" flag to drift. Matching and go-online work it out
  from the records every time, so a document that expires, a vehicle put in maintenance or a driver suspended
  stops rides at once.
- **What the written reasons and the query agree on.** A vehicle can be used when its lifecycle is active, its
  papers were approved, its fleet (if any) is active, its registration and insurance dates have not passed and
  no required document is expired or rejected. A driver can be offered rides when not suspended by operations,
  in an active fleet (if any), with a licence date that has not passed and no required driver document expired
  or rejected. Account, verification and availability are checked by their own modules.
- **Assignment rules.** A fleet vehicle goes only to a driver of the same fleet, who is verified, with an
  active account, not suspended, with a valid licence and valid required papers; the vehicle must not be
  rejected, retired or suspended, and its dates must be valid. A vehicle not yet approved can be assigned:
  its papers are uploaded by its driver and reviewed after (review itself needs a driver, since a review is
  recorded against one). A vehicle already with someone is a conflict; only fleet vehicles can be unassigned
  (a driver's own stays with them); a driver on a ride cannot be unassigned; a driver with a vehicle of another
  fleet cannot be moved. Two administrators assigning at once cannot both win.
- **One "today".** The database session time zone is the platform's (`PLATFORM_TIME_ZONE`), so SQL
  `current_date` and the code's `todayKey()` always name the same day; a date is valid through the day it
  names. (Before this, a licence date could read as valid for hours after it ran out near midnight.)
- **Maintenance cannot touch money or rides.** A service record has no ride, payment or refund column, and its
  only links are to its vehicle and the administrator; a test also proves that doing all the work on a vehicle
  leaves every trip, payment and refund row exactly as it was.
- **Reminders once.** Each reminder is remembered by item, date and stage, so the hourly job never repeats one,
  and a renewed document with a new date is reminded afresh.

## Accessibility

- Every status is a word in its own cell: vehicle lifecycle, verification, operational status, availability,
  expiry state ("Expired", "Expiring soon", "Missing", "Valid"), maintenance status; nothing is colour alone.
- Tables have captions and row/column headers; filters are plain forms; every field has a label; results
  are in a status region; changes that affect a driver or a vehicle take an in-page confirmation that says
  what will happen, with focus moved to it and Escape to back out.
- The driver page explains in a list every reason a driver or vehicle cannot be used for rides.
- The driver hears of every change in the shared sentences, through the notification service.

## Verified, and not

Verified by automated tests (`fleet.test.ts`, 29 tests, plus the updated admin and availability tests): the
two state tables; the expiry rule on both sides of the boundary and the reminder thresholds; fleets (CRUD,
validation, audit, RBAC); assignment (success, every conflict and every ineligible vehicle or driver, in words,
simultaneous assignment, unassignment and its conflicts); the lifecycle (legal moves, final state, simultaneous
moves, matching exclusion, taking the online driver offline); written reasons against the matching query for
every way a vehicle is out; expired documents (live effect, monitor, once-only reminders, renewal), licence,
registration and insurance, missing papers, thresholds as a setting; operational status (separate models,
every move, words, notices, the restricted cap, timed lifting, simultaneous changes); the maintenance
workflow, inspections, services, next-date reminders, and no effect on rides or money; RBAC on every route;
the operational history.

**Not verified, and open:**

- No screen reader or device was used; the screens are typechecked, linted and statically scanned. Run
  `ACCESSIBILITY_TESTING.md` section O before a release.
- The driver apps have no screen for expiry or status: drivers learn of them through notifications and the
  server's go-online reasons (which are shown). A driver document screen is a separate piece of work.
- A vehicle with no driver and no one to tell is listed for administrators but notifies nobody; fleet contacts
  are recorded but the system does not email or call them.
- An expired document is caught immediately in matching and go-online, but the hourly monitor is what sends
  reminders and takes an online driver offline; between the two, the driver simply receives no offers.
- Fleet invoicing, revenue sharing and payouts are not built (and were not asked for).
- Load beyond the test data was not measured; the expiry view reads all verified drivers and in-use vehicles
  each hour and on demand.
