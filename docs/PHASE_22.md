# Phase 22: inclusive and accessible ride features

Phase 22 lets a passenger say what they need for a ride, lets a driver say what their vehicle offers, and makes the
existing matching engine put the two together. It reuses the vehicle records, the matching engine, the preferences
system, trips, chat and calls, the location snapshot, the notification service, admin RBAC, the audit log and the
retention rules. There is no second vehicle database, no second matching path and no second preferences model.

Two rules run through all of it:

- **Nothing is inferred.** A passenger's needs are only what they chose to state. Nothing in any profile, ride history,
  device setting or personal detail is used to guess a disability.
- **Minimum necessary, never public.** The matching engine learns which vehicle features a ride needs, never who needs
  them. A driver learns what they must do to serve the passenger, from the moment they are assigned, and not once the
  ride has ended. Staff read a ride's details only for a case, and every read is audited.

## What was built

| Brief                                       | Where it is                                                                                                                                                                                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passenger accessibility needs               | `PASSENGER_NEEDS` (`@yatri/types` `accessibility.ts`): wheelchair accessible vehicle, help getting in and out, blind or low vision, deaf or hard of hearing, service animal, other (with a note). Saved in `passenger_accessibility`, edited in Settings               |
| One authoritative model for all apps        | the types and wording are in `@yatri/types`; the API validates and stores (`accessibility.service.ts`); both apps render from them. A save names the version it saw (two devices cannot overwrite each other)                                                          |
| Attributes on the existing vehicle system   | `accessibility_attributes` (the catalogue) and `vehicle_accessibility` (per vehicle, hanging off `vehicles`). Core features: wheelchair accessible, ramp or lift, extra space, accessible seating, service animals welcome; an administrator can add more              |
| Accessible matching in the existing engine  | `findEligibleDrivers` takes `requiredAttributes`; the vehicle condition `attributesSatisfiedSql` requires every one as APPROVED. The estimate's "available" answers for this rider's needs, so "no accessible vehicle nearby" is said, not hidden                      |
| Driver capabilities with admin approval     | a driver declares features for their own vehicle (`PUT /vehicles/:id/accessibility`). Features that need verification (wheelchair accessible, ramp or lift) wait as PENDING; only an administrator approves. A driver can never mark one approved                      |
| Structured pickup instructions              | accessible entrance, call on arrival, need help finding the vehicle, cannot use stairs, other, plus a 200 character note. A copy is taken for each ride (`trip_accessibility`); the passenger can change it until the ride starts and the driver is told               |
| Communication preferences via chat and call | any, messages first, messages only. Messages only stops the driver starting a call (`CALL_NOT_PREFERRED`, with words); chat is unchanged, and the passenger can still call                                                                                             |
| Text-based location                         | `PickupGuideCard`: pickup address, landmark, which way the driver is from the pickup (compass word), distance, time, vehicle and number plate, all from the server snapshot. The map is never needed                                                                   |
| Preferences integration                     | the existing preference table gained Vibration feedback (`hapticFeedback`, used by the shared announcer for important updates) and Simpler screens (`simplifiedNavigation`, used by the ride screen). Reduced motion, larger text and speaking updates already existed |
| Admin controls                              | Accessible rides page: counts, the approval queue, the feature catalogue (add, edit, require approval, switch off) with version checks, reasons and audit. New permissions `ACCESSIBILITY_VIEW` / `ACCESSIBILITY_MANAGE`; a ride's details need `SUPPORT_MANAGE`       |
| Privacy                                     | see below                                                                                                                                                                                                                                                              |
| Realtime updates                            | a pickup change records `ACCESSIBILITY_UPDATED`: announced politely to the driver, not a notification, and the event carries none of the words                                                                                                                         |

## Privacy, concretely

- **Driver before accepting:** the offer says only what the vehicle must have ("Wheelchair accessible vehicle"). Never the
  person's other needs, notes or communication choice.
- **Driver after assignment:** the needs as instructions ("Needs a wheelchair-accessible vehicle", "Messages only"), the
  pickup instructions and note. Gone from the driver's view when the ride ends.
- **Never in** a notification, a chat message, the ride's event record, the trip-sharing link or the admin ride detail.
- **Staff:** `GET /admin/trips/:id/accessibility` needs `SUPPORT_MANAGE` (the people handling a case) and writes an audit
  entry on every read. The counts page shows numbers only.
- **Retention:** a ride's copy is deleted 30 days after the ride ends (`ACCESSIBILITY_RIDE_DETAILS`, editable down to
  1 day). The saved profile is included in the person's data export and removed when the account is deleted.

## Rules worth knowing

- **A vehicle need is a hard filter.** A ride that needs a wheelchair accessible vehicle is offered only to approved ones,
  so it may wait longer or end with no driver found. The request screen says so before the person asks.
- **Needs without a vehicle feature** (help getting in and out, blind or low vision, deaf or hard of hearing, other) do not
  filter anyone; they tell the assigned driver how to help.
- **Changing the rules of a feature acts on existing claims.** Starting to require approval puts approved claims back in the
  queue; no longer requiring it counts the waiting ones. Core features cannot be switched off (the needs map to them).
- **The profile and the ride are separate.** Editing the profile later never changes a ride under way.

## Not done, honestly

- **Nothing was tested with real users who rely on these features**, on a device, or with NVDA, TalkBack or VoiceOver.
  Rules, matching, privacy and wording are tested at the API and as unit tests; section U of `ACCESSIBILITY_TESTING.md` lists
  the manual checks. Wording was written to be plain, not reviewed by disability organisations. That review should happen.
- **"Sounds for alerts" is not built.** The apps have no in-app sounds, and no push provider is connected, so there is
  nothing for such a switch to control. Vibration and simpler screens are real and used.
- **A wheelchair accessible claim is as good as the administrator's check.** There is no inspection workflow, photo
  evidence step or recheck schedule. The approval is recorded with a reason; verification itself is a human process.
- **Fleet-owned vehicles** can be declared by their assigned driver; a fleet manager has no separate screen for it.
- **Pickup instructions are not translated** (Nepali is still "not translated yet" in the apps); the wording of the options is
  English only.
- **No accessible ride is reserved or guaranteed**, and there is no scheduling or priority for accessible requests.
- **Chat messages are not marked as accessibility related** and are not read differently; the messages-only rule only
  stops the driver from starting a call.
- Staff statistics are counts for 30 days and "online now"; there is no per-city breakdown yet.
