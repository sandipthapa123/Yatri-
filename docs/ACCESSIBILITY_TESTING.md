# Manual accessibility test protocol (locations & live trips)

Automated tests cover the logic (announcement thresholds, spoken text, realtime client,
gateway flow). They **cannot** prove screen-reader behaviour. Run this protocol before a
release; record device, OS, screen reader and result. Nothing here has been run yet.

Setup: API running with Postgres + Redis (`LOCATION_PROVIDER=static` works offline); one passenger
device and one driver device (or emulators) each signed in; the driver goes online, the passenger
requests a ride and the driver accepts it in the app; drive the "driver" with a mock GPS (Android
emulator extended controls → Location route, or Xcode simulated location).

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

## F. Driver availability (Driver home)

With TalkBack / VoiceOver / NVDA, offline → online → offline:

1. Focus order: status heading ("OFFLINE") → announcements → each text row (Status, Location
   permission, …) → any problem/eligibility box → **Go online** → secondary buttons.
2. Deny location: an alert says location is required and you are still offline; blocked shows
   **Open phone settings**.
3. Go online in a weak-GPS spot (indoors): refused with the accuracy in meters; still offline.
4. Go online outside: assertive "You are now online. Your location is being shared with
   Yatri." exactly once; status heading now reads ONLINE; rows show place, accuracy, last update.
5. Airplane mode: assertive "Connection lost. Your location is not being shared." and the
   location row reads "Connection lost"; turn it off → "Connection restored…".
6. Keep the app in the background for 3+ minutes, return: told you were taken offline because
   location stopped; **Go online** works again.
7. Go offline: assertive "You are now offline. Location sharing has stopped."
8. Confirm the "Last update" row ticking never interrupts speech, and no state is conveyed by
   colour alone.

## G. Requesting a ride, and offers (passenger + driver)

Nothing here has been run on a device yet.

1. Passenger: **See fare and request a ride** is announced as disabled, with a hint, until both
   places are chosen. On the request screen the fare, distance and waiting rule are read as text;
   "Based on the straight-line distance…" is read when it applies.
2. **Request ride** → the ride screen says "Looking for a driver" (no colour-only state) and
   **Cancel request** asks for confirmation.
3. Driver (online): an offer is announced **assertively once** ("New ride request. Pickup …, N meters
   from you. Destination …. Fare NPR …. Respond within N seconds."). The countdown row is visible but
   is not re-announced every second. **Accept ride** and **Decline** are the first controls reached.
4. Let an offer expire: "The ride request expired." is spoken once, politely. Have another driver take
   it: "Another driver took this ride."
5. No drivers: the passenger hears "No drivers are available right now…" (assertive) and can go back.

## H. Waiting, arrival, payment, rating

1. Driver arrives → passenger hears "Your driver has arrived." **once** (assertive). The rows change
   to "Your driver has been waiting" with the free time remaining, in words.
2. Keep waiting: the passenger hears **only** the server's milestones ("Your driver has been waiting
   for 2 minutes.") — never a per-second timer. Reading the waiting row shows the current time.
3. Before the driver arrives the passenger hears "You have been waiting for N minutes." at the
   milestones; the driver hears "The passenger has been waiting…" once the ride has waited long enough.
4. After the driver's no-show wait, **Passenger did not arrive** appears for the driver, with a
   confirmation that states how long they waited.
5. Start → "Your ride has started." End → fare in words; the driver hears/reads the cash instruction;
   the passenger hears "Please pay your driver NPR … in cash."
6. As soon as the ride completes (payment is separate): **Rate your driver** appears; stars are a radio group read as
   "3 stars out of 5, selected". **Report a problem** works with the keyboard/screen reader.
7. Reconnect test: airplane mode for 30 s during the wait, then restore. You hear "Live updates
   restored." and anything you missed **once, batched**; opening the screen never replays history.

## I. Chat and calls

1. Chat tab label reads "Chat, 2 unread messages" when relevant. In the tab, every line is one
   element: "You, 10:32, delivered: …" / "Your driver, 10:33: …" / "Ride update, 10:34: …".
2. A message from the other person is announced **once**, politely, from any tab
   ("Message from your driver: …"). System lines ("Your driver has arrived.") are **not** read twice.
3. Send with the keyboard; a failed message shows **Try sending again**; closed chat shows the reason.
4. Incoming call: assertive "Incoming audio call from your driver. Answer or decline."; the Call tab
   opens with **Answer** first. During the call, mute/speaker/camera are switches with state; the
   timer and quality line are silent until focused.
5. Poor connection → "Call quality is poor." once; recovery → "Call quality has improved." "HD audio"
   appears only after a sustained measurement — confirm it never shows on a bad connection.
6. Decline / miss / end / ride ends during a call: the reason is spoken in words for each side.
7. **Requires a development build with WebRTC (not Expo Go).** In a build without it the Call tab must
   say calling is unavailable and point to chat.

## J. Safety: SOS, contacts, reports (passenger + driver)

Nothing here has been run with a real screen reader yet; do all of it with TalkBack, VoiceOver and
a hardware keyboard (or switch access) before relying on it.

1. During an assigned ride the trip tab has an **Emergency help** card near the top, in reading order,
   with a button labelled **Emergency SOS** (text, not just red). Focus order reaches it without
   passing through the map or any timer.
2. Activate it: the card switches to **Send an emergency alert?** with **Send emergency alert now**
   and **Not now**. No system dialog. Confirm: hear (once, assertive) "Emergency alert sent. The Yatri
   safety team has been notified." (plus how many contacts were sent a link).
3. The card then shows **Call emergency services (100)** and **I am safe: cancel the alert**. Both work
   by touch and keyboard. Cancelling is spoken: "You cancelled the emergency alert."
4. From the admin side acknowledge the alert: the person hears "The Yatri safety team has seen your
   alert and is responding." once. The **other** person on the ride hears and sees nothing.
5. Turn off the network and press the alert: hear "The alert could not be sent. Call 100 now…" and find
   the **Call emergency services** button under it. Confirm the failure is never silent.
6. Report a safety concern (any active or finished ride): the form is a radio group of categories plus
   a labelled text box; **Send report** says why it is disabled ("Choose what kind of concern this
   is"). After sending, hear "Your report was sent. The safety team will review it."
7. Emergency contacts (Home, both apps): the count is read as a sentence; **Remove {name}** asks for a
   second step ("Yes, remove {name}") in the page; adding and removing are announced politely.
8. Admin dashboard, keyboard only: **Safety** page, filters, the SOS alert (Acknowledge; **Resolve this
   alert…** needs the in-page confirmation and a note), an incident (status form offers only the
   moves the ride's state allows). Every result is announced in a status region. There is no browser
   alert/confirm dialog anywhere.

## K. Admin console (keyboard and screen reader)

Structural checks are automated (`admin-ops.test.ts`, "admin accessibility"); none of this has been run with a
real screen reader yet. Do all of it with NVDA (or VoiceOver) and the keyboard only:

1. First Tab stop is **Skip to the main content**; activating it moves focus into the page. There is one main
   landmark and a "Main" navigation; the current page is read as "current page" and is underlined.
2. Every menu entry you cannot use is absent (sign in as an administrator with few permissions). Opening a page
   you lack by address shows "You do not have access to ..." and nothing else.
3. Dashboard: each figure reads as "Label, number" and, where there is a list behind it, the label is a link.
   The 15-second refresh has an on/off checkbox, never moves focus and does not announce.
4. Filters (period, search, selects) are reachable in order, each with its label; **Apply** submits with Enter.
   Tables read their caption first, then column headers with each cell; sort links say "(sorted)".
5. Change a setting: **Change ...** moves focus into the field; **Review this change** moves focus to the
   "Are you sure?" sentence, which states old and new values; **Yes, change it** announces "... changed" and
   focus returns to the **Change ...** button. Escape steps back at every stage. Try a stale edit from two
   windows: the message says someone else changed it.
6. Users: suspend and reactivate use the same confirmation and need a reason; the result is announced.
7. Administrators: permission checkboxes read their name and what they allow; ones you cannot grant say so.
8. No browser dialog appears anywhere. Zoom to 200% and 400%: nothing is cut off, tables scroll sideways.

## L. Focus and structure (Phase 12 audit)

Automated (`packages/mobile-ride/src/a11y.static.test.ts` for every mobile screen, `admin-ops.test.ts` for the
console) and run on every push: every Pressable has a role and a spoken name, every TextInput and Image is named
or marked decorative, nothing that must be operable hangs its action on a Text or View, announcements never use
disappearing toasts, the console has one main landmark and a skip link, every field is labelled, every table has a
caption and headers, every result has a status region, and no browser dialog is used.

Fixed in the audit: when a confirmation or a form replaces what was on screen, the screen reader now moves to it
instead of being left on a control that has gone (the SOS confirmation question, the report-a-concern form, the
rating form, the report-a-problem form). Check each by hand:

1. Turn on TalkBack or VoiceOver. Open the SOS control, activate **Emergency SOS**: focus lands on "Send an
   emergency alert?" and the two buttons follow. **Not now** returns to the SOS button.
2. After a ride ends, activate **Rate your driver**: focus lands on the form's title; the stars read as a group
   of options with their state.
3. Activate **Report a safety concern**: focus lands on its title before the first category.
4. Repeat 1-3 with a hardware keyboard or switch access; the order must match the reading order.

Still only verifiable by a person with the real tools (nothing in this repository can prove it): how TalkBack,
VoiceOver and NVDA actually speak each announcement, whether announcements collide when several arrive together,
and touch-target size on small phones. Run sections F-K of this document with them before each release.
