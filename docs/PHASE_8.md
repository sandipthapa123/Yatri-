# Phase 8 — ride communication and trip sharing

Phase 8 was audited against what already existed. Chat, calls and the waiting timer were built with
the ride lifecycle ([PHASE_6](PHASE_6.md) documents their design and rules; this file does not repeat
them). This phase added what was missing and consolidated what had been duplicated.

## What already existed (Phase 6), and how the brief maps onto it

| Brief                                                                    | Where it is                                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Realtime chat, timestamps, sent/delivered, unread, history, reconnection | `chat/`, `ChatController` (server `seq`, receipts, unread count, REST catch-up on reconnect)           |
| Only the two participants; read-only after the ride; retention           | `chatWindow`, `CHAT_OPEN_AFTER_TRIP_MINUTES`, `CHAT_RETENTION_DAYS` (deleted unless a dispute is open) |
| Basic abuse controls                                                     | length and control-character limits, idempotent sends, `CHAT_RATE_LIMIT_PER_MINUTE`                    |
| Voice calls, no phone numbers, accept/decline/end/failure/reconnect      | `calls/` (server state machine, role-addressed), `CallController` (grace period, ICE restart)          |
| Waiting time, authoritative                                              | `trips/waiting.ts` `computeWaiting`, ticking in every snapshot, milestones as events                   |
| Events                                                                   | one event model (`TRIP_EVENT_TYPES`) and one socket protocol (`realtime.ts`)                           |

The brief's event names map onto that one protocol rather than adding a second: `CHAT_MESSAGE` =
`chat_message`, `CHAT_DELIVERED` = `chat_receipt` (`kind: 'delivered'`), `CALL_REQUESTED` /
`CALL_CONNECTED` / `CALL_ENDED` = `call_state` (`RINGING` / `CONNECTED` / `ENDED`),
`WAITING_TIME_UPDATED` = the `waiting` block of every snapshot plus the `DRIVER_WAITING` milestones,
and `LOCATION_SHARE_STARTED` / `LOCATION_SHARE_STOPPED` = the new `TRIP_SHARE_STARTED` /
`TRIP_SHARE_STOPPED` trip events (below).

## What this phase added

### Trip sharing with a trusted contact

A passenger creates a secret link to **one** ride and sends it through the phone's own share sheet
(so Yatri never sees or stores the contact). The person opens it in any browser — no app, no account.

- **Who:** only that ride's passenger, only once a driver is assigned and until the ride ends. The
  driver gets 403, anyone else 404 (the same answer as a missing ride). At most `SHARE_MAX_PER_TRIP`
  live links per ride, enforced under the ride row lock so a burst cannot exceed it.
- **The secret:** 32 random bytes (base64url, 43 characters). Only its SHA-256 is stored
  (`trip_shares.token_hash`); it is returned once and can never be read back or listed. Events and
  notifications never contain it.
- **What the holder sees** (`ShareView`, derived from the **same live snapshot** the passenger sees, so
  there is no second location or ETA calculation): the driver's first name, vehicle and registration,
  status, the driver's current location with its place name, distance and ETA (to the pickup while the
  driver approaches, to the destination while riding), the driver's waiting time, and the destination.
  Never a phone number, the passenger's name or id, the driver's surname, or any other ride.
- **Words:** `describeShareView` (`@yatri/types`) produces one headline and the detail lines. The page,
  the JSON (`GET /share/:token/data`) and any future client render those lines; nobody re-words them.
- **The page** (`GET /share/:token`): text first, a headline in a polite live region (announced only when
  it changes), details updated quietly every 10 s, and a link that opens the location in the contact's
  own maps app — the contact never needs a map to understand it. A per-request nonce CSP
  (`default-src 'none'`), `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `noindex`.
  Public routes are IP rate limited.
- **When it stops:** the passenger stops it (immediately); the sharing period (`SHARE_DURATION_HOURS`)
  runs out (a sweep records it; the link is dead the instant `expires_at` passes); the ride ends (links
  stop sharing, show the outcome and **no** location for `SHARE_ENDED_GRACE_MINUTES`, then go away). A
  driver change (the ride returns to searching) keeps the link and shows "Looking for a driver".
- **Every failure looks the same:** malformed, unknown, stopped, expired, ended-past-grace all return the
  same 404, so a link cannot be probed.
- **Events:** starting and stopping are ride events (`TRIP_SHARE_STARTED`, `TRIP_SHARE_STOPPED` with a
  reason of `PASSENGER`, `EXPIRED` or `RIDE_ENDED`). Both people hear them — the driver is told "This
  trip is being shared with a trusted contact." (a deliberate safety-visible choice) — on every signed-in
  device, spoken politely, and raised as notifications.

### Notifications for communication (one notification system)

`recordTripEvent` now decides notification by a `notify` flag in the event metadata (by default exactly
the important events; the two sharing events opt in without being alarms). New messages and incoming
calls use the same `notify()`: a message nudges the **other** person, worded by the shared
`describeNewMessage` (never the message text, and at most one a minute per conversation through
`notifyThrottled`); an incoming call notifies the person called with `describeIncomingCall`. Driver
arrival was already a notification. There is still no push provider: notifications are stored and sent
to the console provider (see limitations).

### Provider abstraction for calls (server side)

`calls/call-provider.ts` defines `CallProvider`: it answers only "how do these two connect"
(`connectionInfo`). Authorization, the call state machine and the signalling relay never know which
provider carries media. `CALL_PROVIDER=webrtc` (peer-to-peer media, STUN and short-lived TURN
credentials) is the only implementation; another is a new class and a config value. The client side is
already behind `RtcFactory`. Yatri never stores call audio or video.

### Waiting communication

At the pickup the passenger's ride screen offers **Message your driver** and **Call your driver** next to
the live status; the driver gets the same for the passenger. The driver's waiting row also reads "The
passenger has been notified." from the server's timestamp (set the instant the driver arrives), and the
waiting time shown to both people is the server's, advanced on screen only by local elapsed time.

## SSOT audit (this phase)

Consolidated: the "is this person on this ride" check (it had been written out in eight places) is now
one function, `trips/access.ts`; "seconds since" for waiting was computed by hand in five places and is
now `secondsSince` in `waiting.ts`; the driver's approved-vehicle lookup is `vehicles/vehicle-lookup.ts`
(used by the ride summary and the share page); "your driver / the passenger" wording is
`counterpartLabel` (`@yatri/types`, used by notifications, announcements and the call/chat controllers);
the call provider's connection details left `calls.service`.

## Verification

API tests: `sharing.test.ts` (authorization, secrecy, live data, expiry, revocation, limits, the events
on every device, notifications), `ride-communication.test.ts` (chat and call notifications,
throttling, provider, waiting facts, multi-device chat in order). Mobile: announcements for sharing
started/ended, the driver's "passenger notified" line, and the call/chat wording. Chat and call
lifecycle, ordering, duplicates and reconnection are covered by the Phase 6 suites.

## Not done / limits

1. **No push provider.** Notifications are stored and logged; a closed app is not woken. The wording and
   triggers are ready for one.
2. **Nothing has been run on a device or with a screen reader.** Announcement decisions are unit tested;
   how TalkBack, VoiceOver and NVDA speak them, and how the share sheet behaves, are not verified. Run
   sections H and I of `docs/ACCESSIBILITY_TESTING.md`, and open a share link with a screen reader.
3. **The share page needs a public address.** Set `PUBLIC_BASE_URL` to where the API is reachable from
   the contact's phone; the default is `localhost`, which only works on your own machine.
4. **Real call media is still unverified** (see PHASE_6 limitations: dev build, TURN, background audio).
5. **A contact cannot reply or message the rider** through the link: it is read-only by design.
6. **No emergency communication** — advanced SOS is a later phase; the sharing link is the integration point.
