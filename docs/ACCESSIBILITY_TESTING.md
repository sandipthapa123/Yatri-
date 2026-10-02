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

## M. Support, disputes, refunds and privacy (Phase 14)

Automated: the static scan covers `packages/mobile-support`; status sentences come from one function each and are
unit-tested; the console pages use labelled fields, a status region for every result and in-page confirmations.
Check by hand with TalkBack or VoiceOver (and NVDA in the console), and with a keyboard:

1. **Ask for help** (passenger and driver): the categories read as a group of options with their help text as a
   hint; choose one, leave the title empty and press **Send request**: the problem is announced once and shown
   as text beginning "Problem:" beside the field; nothing is conveyed by colour.
2. **Report a problem with this ride** from a finished ride: focus lands on the form title; a safety category
   shows the emergency advice as an alert before the fields.
3. Open a request: each message is one stop ("Support, 3 Oct, 14:05. ...") and its file buttons are separate
   stops ("Open screenshot.png (12 KB)"). Reply, then add a photo with the device picker: the result is announced.
4. Have an administrator reply and change the status while the request is open: within half a minute a polite
   announcement says so, in the same words as the notification; it does not interrupt speech.
5. **Ask for a refund** on a paid ride: the money facts read as sentences ("You paid: NPR 320"); radio options
   state their amount; an invalid amount is explained in words.
6. **Delete my account**: focus moves to the confirmation, which says what goes and what must be kept; **No, keep
   my account** returns focus to the start.
7. Console: the ticket queue table has a caption and headers and works without scripts; in a ticket, resolving,
   closing and each refund money step open an in-page confirmation and Escape backs out; zoom to 200% and 400%.

## N. Dynamic pricing, zones, heatmap and bonuses (Phase 15)

Automated: fare parts adding up, the price sentence (`describeSurge`), the heatmap's text equivalents and the
console forms' labels and status regions are covered by tests and the static scans. Check by hand with
TalkBack or VoiceOver (and NVDA in the console), and with a keyboard:

1. **Request a ride** in a pricing rule's time or zone: the estimate card reads the total, then "Higher demand
   pricing ... NPR Y more on this ride" as an alert, then "Normal fare ... plus ... for higher demand". The
   button reads "Request Car for NPR ...". Choosing another vehicle type re-reads its own price.
2. Let the price change between looking and requesting (raise the multiplier in the console): the request
   is refused, the new fare is announced as an alert and shown, and nothing was requested.
3. A pickup in a zone with a note (airport): the note is read in the estimate before confirming. A pickup
   outside the area or in a restricted zone reads the reason and offers no ride.
4. **Driver > Your bonuses**: each rule is a heading and a sentence; progress reads "3 of 5 rides done this
   day; 2 to go"; the earned total and the note about cash are read.
5. Console > Demand, zones and pricing: the heatmap is announced as an image with its description; the table
   and the list of squares in words carry the same information; counts below the minimum read "fewer than 3".
6. Console forms (zones, pricing, bonuses): every field has a label; the day checkboxes read their names; the
   confirmation sentence takes focus and Escape backs out; the result is announced; zoom to 200% and 400%.

## O. Fleets, vehicles and driver operations (Phase 16)

Automated: the admin pages are scanned by the console accessibility tests (labelled fields, table captions and
headers, status regions, no dialogs) and every status is a word in the data the pages print. Check by hand with
NVDA and a keyboard:

1. **Fleet list and details:** the tables have captions and row headers; statuses read as words ("Active",
   "Suspended"); the edit form opens from a button, every field has a label.
2. **Vehicle page:** the summary says the status and whether the vehicle can be used for rides, then lists each
   reason as a list item; the status change opens an in-page confirmation, focus moves to its sentence, and
   Escape backs out; the result is announced.
3. **Assign a vehicle:** the driver list says for each driver whether they can take rides; a refusal is read as
   "Problem: ..." with every reason.
4. **Driver page:** the five statuses are a table with a row header each (Account, Verification, Operational,
   Availability, Ride); suspending needs a reason and a confirmation that says the driver goes offline now.
5. **Expiring documents:** the state is its own column of words (Expired, Expiring soon, Missing), sorted worst
   first; filter by state, kind and fleet with the keyboard; "Check documents and dates now" announces the result.
6. **Maintenance:** in-progress records come first and say "In progress"; completing one asks where the vehicle
   goes next; recording a failed inspection says the vehicle was taken out of service.
7. Zoom to 200% and 400%: tables scroll sideways, nothing is cut off.

## P. Fraud and risk (Phase 17)

Automated: the risk pages are scanned by the console accessibility tests (labelled fields, table captions and
headers, status regions, no dialogs) and every level and status is a word in the data the pages print. Check by
hand with NVDA and a keyboard:

1. **Overview:** the counts are links with words ("3 need a review"); the people table has a caption and row
   headers; the level is a column of words (Low risk, Review required, Restricted, Suspended), never colour.
   "Check now" announces how many signals were raised.
2. **Filters:** the level, status and kind selects have labels; Filter works with Enter.
3. **A person:** the first section says the level and what it means; the actions shown are only those the server
   allows; restricting and suspending open an in-page confirmation, focus moves to its sentence, Escape backs
   out, and the result is announced as a status.
4. **A signal:** it says what fired, the evidence in words (counts and kinds), and links to the person, the ride and
   related people; the decision form says what dismissing does.
5. **Rules:** each rule is its own section with a heading; "Change this rule" is a disclosure that opens with the
   keyboard; every number has a label.
6. Zoom to 200% and 400%: tables scroll sideways, nothing is cut off.

## Q. Business accounts (Phase 18)

Automated: the console pages are scanned by the console accessibility tests, and `packages/mobile-business` has static checks
(every field labelled, every pressable with a role, radio groups and tabs grouped, news announced). Check by hand with
TalkBack or VoiceOver in the passenger app, and NVDA in the console:

1. **Business rides:** each organization is one button that says the person's role; invitations say who invited you and have
   Accept and Decline buttons; creating an organization announces "was created" and moves to it.
2. **Sections:** the sections are a tab list built from the role (a member sees My rides, My requests and Rules; an owner
   also Members, Statements and Usage); the selected tab is announced as selected.
3. **Rides, approvals, members:** each row reads as one sentence (who, where, how much, status in words). Approve, Decline,
   Remove and Leave ask in an alert with a way back; the result is announced.
4. **Rules form:** every number has a label; switches say "yes" or "no"; a problem is read as "Problem: ..." with the field.
5. **Requesting a ride:** "Who pays for this ride" is a radio group; choosing an organization offers who the ride is for, the
   cost centre and the purpose, and reads what the organization's rules say about this ride before you book; a refusal is read
   as an alert and the book button is unavailable.
6. **A business ride:** the rider and the driver hear that it is a business ride, who booked it, and that there is nothing to
   pay or collect.
7. **Console:** organizations and statements are tables with captions and row headers; recording payment asks for the amount
   and reference, then an in-page confirmation, and announces the result.
8. Zoom to 200% and 400%: tables scroll sideways, nothing is cut off.

## R. Settings and preferences (Phase 19)

Automated: `packages/mobile-preferences` has static checks (choices are radio groups and switches with the selected one
exposed, changes and problems are announced, every group has a heading, no raw unlabelled inputs, no motion). Check by hand
with TalkBack or VoiceOver in both apps:

1. **Settings** opens from the home screen; each group is a heading and each setting reads its label, what it does and what
   is chosen now ("Now: Dark (standard)").
2. **Choices** are a radio group: the selected one is announced as selected; a language that is not translated yet is
   read as not available and cannot be chosen.
3. **Switches** read as "<name>: On" or "Off"; turning one announces "<name>: On. Saved."
4. **Larger buttons and text size** take effect at once in the shared buttons, cards and announcements; check that nothing is
   cut off at the largest size and at the phone's own largest text size.
5. **Notifications:** switch off ride updates, start a ride, and confirm no ride notification is pushed but safety alerts
   still are.
6. **Conflict:** change a setting on two phones; the second one reads that the settings were changed elsewhere and shows the
   new values.
7. **Devices:** each device reads as a sentence (name, this phone, when signed in and last used); signing one out is announced.
8. **Emergency alert:** with "ask before sending" off, the button's hint says it alerts straight away.
9. **Recent destinations:** the location picker lists them under a heading; "Clear my recent destinations" announces that the
   history is unchanged.

## S. Cities and service areas (Phase 20)

Automated: the console accessibility tests scan the new pages (labelled fields, table captions and headers, status regions,
in-page confirmations), and a test keeps city names out of the apps' code. Check by hand with NVDA and a keyboard:

1. **Cities list:** a table with a caption and row headers; the status and "Open now" are words (Open, Paused, Coming soon; Yes, No).
2. **A city page:** each part is its own section with a heading; the summary says whether the city is taking rides now and why not.
3. **Opening hours:** each window is a fieldset with a legend; the days are checkboxes inside a labelled group; opening and
   closing times are labelled time fields and the hint explains an overnight window.
4. **Checkbox lists** (boundary, vehicle types, payment options, driver documents) sit in a fieldset with a legend and each box
   reads its own label; notes such as "not in use" or "now in another city" are part of the label.
5. **Saving:** every part asks for a reason, then an in-page confirmation that says what will happen; focus moves to it,
   Escape backs out, and the result (or a refusal such as "changed by someone else") is announced as a status.
6. **Passenger and driver apps:** when a ride is refused because of the city (paused, closed, another city, vehicle type not
   offered) the message is read as an alert in words; a driver refused at go-online hears each reason, including a missing
   city document by name.
7. **Maps:** the picker starts on the city's centre, but selecting a place never needs the map; search and saved places do the same.

## T. Reliability and offline recovery (Phase 21)

Automated: the structural accessibility test scans the connectivity banner; unit tests keep its words (offline says the
screen may be out of date and how old; back online is brief; nothing is said about the ride). Check by hand with TalkBack,
VoiceOver and NVDA, with airplane mode and a weak network:

1. **Going offline** (airplane mode on during a screen): one polite announcement "You are offline. What you see may be out
   of date...", once, not repeated every few seconds as "last updated" changes.
2. **Reading the banner** by swiping: the title and the detail are plain sentences; the meaning does not depend on the
   colour of the border.
3. **Coming back:** one announcement "Back online. Your screen is up to date again", and the banner goes away by itself after
   a few seconds. The active ride on screen matches the server (check against the other person's phone).
4. **Acting while offline** (tap Request ride, Start ride, Cancel): the message is read as an alert and says in words that
   Yatri could not be reached and to try again; the control is usable again.
5. **Killing the app during a ride and reopening it**, with and without a connection: the active ride is shown (offline,
   from the last profile, the ride itself as soon as the server answers), and the person is not signed out.
6. **Foreground:** switching away and back refreshes the home screen's active-ride check; no stale "you have no ride".
7. **Driver, GPS lost:** the existing location status line (permission, unavailable, weak, delayed, connection lost) is
   still spoken in words; combined with the banner, the driver hears both that Yatri cannot be reached and that location is
   not being shared.
8. **Admin Background jobs:** the table has a caption and row headers; state is words ("OK: Ran 20 seconds ago", "Needs
   attention: Failed 3 minutes ago"); "Run <job> now" names the job; the result is announced as a status.

## U. Inclusive and accessible rides (Phase 22)

Automated: the structural accessibility test scans the new panels; unit tests keep the wording (profile summary, the "no
accessible vehicle" sentence, the text pickup guide, feature states); API tests cover privacy, matching and approval. These
checks need a person, a device and a screen reader, and ideally someone who relies on them:

1. **Settings > Accessibility needs for rides** (passenger): each need is a switch whose label ends "On" or "Off"; the heading
   of each group is announced; the notes have labels; Save says what happened as a status, and a conflict from another device
   is read as a problem.
2. **Request screen:** the "Accessibility for this ride" card states, in words, what will be used and, for a vehicle need,
   that only approved vehicles are offered. With nobody nearby, the "No accessible vehicle..." sentence is read as an alert.
3. **Finding the driver without the map:** "Finding your driver, in words" gives address, landmark, direction, distance, time
   and vehicle with number plate. Walk to a pickup using only this and the chat.
4. **Messages only:** the driver cannot start a call and is told why in words; chat still works; the passenger can call.
5. **Changing pickup instructions during a ride** (passenger): the form is reachable by keyboard and switch; after saving, the
   driver hears one polite announcement and finds the new instructions in "Passenger's accessibility needs".
6. **Driver offer:** "This ride needs: Wheelchair accessible vehicle" is read with the other offer details; nothing else about
   the passenger is read before accepting.
7. **Vehicle features** (driver): each feature's state is words ("Waiting for approval", "Approved", "Not approved: reason");
   a save that leaves features waiting says so.
8. **Vibration and simpler screens:** with Vibration feedback on, an arrival or an offer vibrates once; off, it does not. With
   Simpler screens on, the ride shows the essentials and a "More options" button that reveals trip sharing and details.
9. **Admin Accessible rides:** the stats list and the table have captions and row headers; each decision form names the
   feature and vehicle; results are announced as a status.
10. **Text size, high contrast, reduced motion:** all of the above stay usable at the largest text size.

## V. Navigation and route guidance (Phase 23)

Automated: unit tests keep the sentences (the passenger's trip progress, the driver's next maneuver), when they are spoken
(never for jitter), and that the controller keeps the last route offline; API tests cover deviation, rerouting, arrival and
privacy. These need a person, a device, a screen reader and ideally a moving vehicle (or a recorded drive):

1. **Driver, directions to the pickup:** "Directions to the pickup" gives the next maneuver as a sentence first, then the
   distance remaining and estimated arrival as separate facts; the phase is text ("Approaching the pickup"); nothing needs the map.
2. **Spoken updates are rare:** a maneuver is announced once at about 300 metres and once at about 40 metres; driving
   straight or GPS wobble is silent; a deviation is announced at once and "New route found" when the route changes.
3. **Off the route:** drive away from the route; after a few readings the driver hears that they are off it and then that a new
   route was found; the step list starts again from the new position.
4. **Offline:** turn the network off mid-ride: the last directions stay, with "Directions may be out of date"; on return they
   refresh by themselves.
5. **Show all steps:** the button says how many steps; the list reads each step with its distance.
6. **Passenger, "Your trip so far":** read it with the screen reader when asked (it is not a live region); it matches the
   example in the brief (travelling toward your destination, current location, distance remaining, estimated arrival, metres
   from the destination). Approaching, near and at the destination are each said once, politely.
7. **Estimate wording:** with the default engine the driver is told the estimate does not include live traffic; with no engine
   they are told it is a straight-line estimate.
8. **Text size and reduced motion:** all of it stays readable at the largest size; the map line is the only thing that depends on sight.

## W. Offers, rewards and referrals (Phase 24)

Automated: unit tests keep every sentence (points, offers, invites, the fare breakdown) and the structural accessibility test checks
the screens (labelled fields, headings, announcements, problems in words, no arithmetic on money). These need a person, a device
and a screen reader:

1. **Offers and rewards screen:** each part is a heading ("Your reward points", "Offers for you", "Invite friends", "Points
   history"); the balance is one sentence with what it is worth; each offer is one sentence saying how it is used and until when.
2. **Promo code:** the field has the name "Promo code"; "Check the code" reads the result politely ("Code accepted: ..." or why not).
3. **Invite code:** read as spaced letters ("A B C D 2 3 4 5") so it can be heard clearly; "Share my invite code" opens the share sheet.
4. **Request screen:** the "Offers and reward points" card is reachable before "Estimate"; the breakdown is one announced group
   ("Fare: NPR 237. Offer: ... You pay: NPR 164."), and changing the code or the points switch announces the new total.
5. **A refused code** on request is read as a problem in words and the rider can request without it.
6. **Points switch:** its label ends "On" or "Off"; the points used and what they take off are in the breakdown.
7. **Admin campaigns:** the tables have captions and row headers; the filters are links; each start/pause/end form names the campaign;
   confirmations appear in the page and results are announced.

## X. Online payment and provider status (Phase 25)

- Passenger, after a ride: "Pay online" and "I have paid: check my payment" are labelled buttons offered only when the server
  says online payment is available; the result ("Your payment was received", "has not been confirmed yet", "did not go through")
  is announced politely and is text, not colour. Cash still works if the provider is down.
- Admin **Service providers**: a table with a caption, row headers, and a state written as words ("OK: Working", "Needs
  attention: Not working"), never colour alone.

## Y. Disability benefit verification (Phase 26)

- Passenger: from Home, "Disability benefit". The screen says first that it is optional. Each part is a heading; every field has a
  label; the consent is a button that says whether it is selected; status changes are announced politely as one sentence
  ("Disability benefit verification submitted. Status: Under review. ..."); a problem is read as "Problem: ..."; erasing asks
  twice with the consequence in words.
- Admin: the applications list and a case are captioned tables and lists with row headers; state is written as words; filters and
  paging are links; each decision is a two-step confirmation with the consequence read first and a result announced.
