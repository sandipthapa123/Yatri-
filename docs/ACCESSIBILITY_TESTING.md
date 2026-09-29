# Manual accessibility test protocol (locations & live trips)

Automated tests cover the logic (announcement thresholds, spoken text, realtime client,
gateway flow). They **cannot** prove screen-reader behaviour. Run this protocol before a
release; record device, OS, screen reader and result. Nothing here has been run yet.

Setup: API running with Postgres + Redis (`LOCATION_PROVIDER=static` works offline);
create a trip with `POST /api/v1/admin/trips`; drive the "driver" with a mock GPS
(Android emulator extended controls → Location route, or Xcode simulated location).

## A. Location selection (passenger) — TalkBack, VoiceOver, and NVDA on the web build

1. Open Home → **Pickup** button is announced with its state ("not chosen").
2. Screen reader focus reads: explanation of why location is needed, **Use current
   location**, search field label + hint.
3. Deny permission → alert is announced; **Try again** / **Open phone settings** reachable.
4. Type "thamel" → wait: "N results found…" is announced once (no per-keystroke speech).
5. Move through results: each reads "Name, area. Result i of N." Activate one.
6. Focus lands on the summary: "Pickup selected: …. Latitude and longitude are available…".
7. **Confirm pickup** is reachable and activates; Home shows the choice.
8. Repeat with Nepali input (थमेल) and a saved place. Complete everything with the map
   never touched.

## B. Live trip status

1. Open the active trip. Focus order: header "Live trip status" → announcements → each
   row → actions → map (hidden from the screen reader).
2. Start the mock driver 1 km away, moving toward pickup. Verify: polite announcements
   only at meaningful steps (≈500 m, 100 m, 50 m, very close), never for jitter; ETA in
   words; place changes ("Driver is on New Road.") announced once per change.
3. Cut the mock GPS for > 60 s → assertive "signal lost"; restore → polite "back".
4. Toggle airplane mode 20 s → "Live updates interrupted", then "restored" and current
   state appears with no manual refresh.
5. Driver taps **I have arrived** → assertive "Your driver has arrived at the pickup."
   exactly once; rows switch from "Driver arrival ETA" to "Waiting time".
6. Start / complete / cancel → assertive announcements; "Trip ETA" (never "arrival") while
   riding.
7. Reading a row never gets interrupted by the ticking "Last location update".

## C. Keyboard (web build / external keyboard)

Tab reaches every control in visual order; Enter/Space activates; no keyboard trap in
the picker or map area; visible focus ring; zoom in/out/re-centre reachable.

## D. NVDA on Windows (web build or Android via emulator + external SR)

Repeat A and B; confirm live-region behaviour: polite waits for speech to finish,
assertive interrupts, no duplicate speech for a single event.

## E. Driver app

Permission denied / blocked / services off each show a plain message; GPS-lost notice
appears after ~15 s without fixes and sharing resumes automatically; sharing stops when the
trip ends or the screen closes.
