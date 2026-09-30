# Phase 10 — Ratings and safety

## What exists, what was built

| Area                          | Before                                                | Now                                                                                                                      |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Ratings                       | one per rater per ride, gated on payment              | open at **completion** (payment is a separate matter); aggregate `ratingSummary` (average + count) computed once, on read |
| Written feedback              | optional comment on the rating                        | unchanged; never shown to the person it is about; low ratings visible to the safety team only                            |
| SOS                           | none                                                  | `sos_events`, one open alert per person per ride, guarded state machine, notifies the person's devices and the safety team |
| Emergency contacts            | none                                                  | owner-only CRUD, limit from env; contacts get a quiet share link by SMS when an SOS is raised                            |
| Trip sharing                  | passenger shares a ride (Phase 8)                     | same service; SOS links use `purpose = 'SOS'` (not counted against the share limit, no ride event)                        |
| Incident reports              | none                                                  | six categories, tied to a ride, legal moves from one table, internal notes and actions                                    |
| Disputes (Phase 6)            | money/service decision by an admin                    | unchanged and deliberately **separate** (see below)                                                                      |
| Admin safety                  | none                                                  | `/admin/sos*`, `/admin/incidents*`, `/admin/ratings/low` behind the new `SAFETY_REVIEW` permission; pages under `/safety` |
| Audit                         | `admin_access_log` (reads only)                       | one `audit_log` (renamed) for sensitive reads **and** safety/admin actions                                               |

## Design decisions

- **SOS is not a trip event.** Trip events reach both participants; the other person may be the threat.
  An alert is a per-person `sos_state` realtime message and a safety-team notification. The follow-up
  link for contacts is a share with `purpose = 'SOS'`, excluded from the passenger's share list, the
  share limit and the "sharing started" event.
- **An emergency is never refused for missing data.** No position, no contacts, an SMS failure: the alert
  is still recorded. The position is the phone's fix (passenger), or the server's own driver feed
  (driver; a forged body position is ignored). The person is told what was and was not possible.
- **Safety-team notifications carry no personal data** ("An SOS alert needs attention."); the detail is
  behind `SAFETY_REVIEW` and every read of a position is audited.
- **Contacts receive the minimum:** a first name and a link. The link view shows driver, vehicle and live
  location like any trip share, never the passenger's name, phone, or full ride details.
- **Concurrency.** One open alert per person per ride is a partial unique index; moves are a single
  guarded `UPDATE ... WHERE status = ANY(legal predecessors)`; incident moves take a row lock. Repeat
  presses return the same alert; two people moving one alert at once cannot both win.
- **Disputes vs incidents.** A dispute asks for a money/service decision with a written outcome for the
  reporter. An incident is a safety record with internal notes, recorded actions and its own states, and
  it can be filed by either person on any ride that had a driver. They share the audit log, the
  permission model and the ride, not a table; merging them would put internal safety notes next to a
  reporter-visible resolution.
- **Ratings.** `TripCounterpart.rating` and `ratingCount` come from the one aggregate. The passenger
  rates the driver and the driver rates the passenger once each; a concurrent burst records one.

## Accessibility

SOS is a labelled button (text, not colour), in reading order, with an in-page confirmation instead of a
system dialog, spoken results (assertive, once per status), and a permanent **Call emergency services**
fallback. Failure is spoken. Admin forms are labelled, results are in status regions, resolving an alert
needs an in-page confirmation. See `ACCESSIBILITY_TESTING.md` section J.

## Verification

- API: `safety.test.ts` (30 tests) — ratings (completion gate, duplicates under concurrency, aggregate,
  feedback privacy), contacts (validation, privacy, limit under burst), SOS (recording, position source,
  authorization, idempotency, who is and is not told, SMS content and failure, state changes, concurrent
  actions, audit), incidents (categories, privacy, notifications, RBAC, state machine, concurrent admins),
  state-table consistency. Full API suite passes.
- Mobile: `sosController.test.ts`, updated `rideActions` and `rideText` tests.

## Not done / limits

1. **Nothing has been run on a device, with a screen reader, or with a real SMS or push provider.** The
   SMS goes through the configured provider (a logging provider in development); a closed app is not
   woken.
2. **Emergency contacts are not verified by consent.** Nobody is asked to confirm before being listed; a
   number typed wrongly would receive a link if the person raised an SOS.
3. **The safety team is whoever holds `SAFETY_REVIEW`.** There is no rota, escalation or unanswered-alert
   timeout yet.
4. **Location in the admin view is shown as numbers** (no map service, by design).
5. Subscriptions, referrals, promotions and advanced analytics were not touched.
