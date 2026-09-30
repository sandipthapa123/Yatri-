# Phase 14: support, disputes and compliance

Phase 14 adds one support system for passengers and drivers, ride disputes inside it, refunds on top of the
existing payment record, and the records a platform must keep about privacy: what a person agreed to, what
they asked us to delete or give them, and how long each kind of data is kept. Every rule lives once; this page
is the record and the honest limits. The owners are in the table in [`ARCHITECTURE.md`](ARCHITECTURE.md).

## What was built

| Brief                    | Where it is                                                                                                                                                                                                                                    |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Customer support         | `modules/support/` (API), `@yatri/mobile-support` (both apps: **Help and support**), the console **Support and disputes** queue and ticket workspace                                                                                           |
| One ticket state machine | `TICKET_TRANSITIONS` and `statusAfterReply` in `@yatri/types`, applied by `tickets.service.ts` with a row lock; invalid moves answer 409 with what is possible                                                                                 |
| Ride disputes            | a ticket whose category has kind `DISPUTE`; it holds `trip_id` and nothing else about the ride. The old `trip_disputes` table was migrated into tickets and dropped; `/trips/:id/disputes` and `/admin/disputes` are gone                      |
| Refunds                  | `refunds` refer to `trip_payments`; workflow `REQUESTED` to `COMPLETED` / `REJECTED` / `FAILED` in `@yatri/types`; amounts from `pricing/refunds.ts`; the payment row is never edited                                                          |
| Evidence                 | photos, screenshots and PDFs through the existing upload middleware, type sniffing, random storage keys and signed short-lived links; admin opens are audited                                                                                  |
| Admin workspace          | queue (search, status, group, kind, priority, category, assignee, late), assignment, priority, reply (with file), internal notes, status with resolution and outcome, refund actions, ride and payment context, earlier tickets, audit trail   |
| Configurable priorities  | `support_priorities` (hours to first answer, what to escalate to) and `support_categories` are data edited in **Settings**, audited with a reason; nothing is listed in an app                                                                 |
| Notifications            | created, reply, status, dispute updated, refund decision, refund completed, escalation: all through `lib/notifications`, types in `SUPPORT_NOTIFICATION_TYPES`                                                                                 |
| Compliance records       | `compliance_policies` (current version and where the words are) and append-only `compliance_records`; accepted key, version and time; no policy text anywhere in the code                                                                      |
| Data privacy             | deletion and data-access requests (`data_requests`, due date from a setting), an anonymising deletion, a personal-data copy built on demand, sensitive-document and evidence access audited, retention as configuration (`retention_policies`) |
| Accessibility            | see below                                                                                                                                                                                                                                      |
| Permissions              | `SUPPORT_MANAGE` (implies `DISPUTES_MANAGE`), `REFUNDS_MANAGE`, `COMPLIANCE_MANAGE`; every route names one                                                                                                                                     |

## Decisions worth knowing

- **A dispute is a ticket.** Two records with two state machines for "a person has a problem" would drift. The
  ride problem categories (fare, cancellation, driver behaviour, passenger behaviour, payment, route, waiting
  time, safety, other) are rows of `support_categories`; `RIDE_*` tickets need a ride and only someone who was
  on it can name it. One open problem per person per ride is enforced by a unique index, so simultaneous
  requests cannot create two.
- **Who sees what.** `DISPUTES_MANAGE` holders see and work ride problems only; general tickets need
  `SUPPORT_MANAGE` (the API narrows the list, the detail and every action; a general ticket answers 404 to
  someone who may not see it). Refunds: raising needs `SUPPORT_MANAGE`, deciding needs `REFUNDS_MANAGE`, and
  **nobody approves a refund they raised** (four eyes).
- **Refunds move no money.** Yatri is cash-only and holds no wallet. `PROCESSING` and `COMPLETED` record who paid
  the passenger back (Yatri, or the driver returning cash) and a reference. What has been refunded is the sum of
  `COMPLETED` refunds, so the payment row never changes and cannot disagree with them. A ticket cannot be
  resolved or closed while a refund on it is still being handled.
- **Escalation is data.** After `first_response_hours` without an answer a ticket that is waiting on us is
  raised to its priority's `escalates_to` (or only the team is told at the top), once per wait. Resolved tickets
  nobody replied to close after `SUPPORT_AUTO_CLOSE_DAYS`. Both are single guarded statements run every
  `SUPPORT_SWEEP_SECONDS`, so a sweep racing an admin cannot apply a move twice.
- **Compliance stores a version, not a document.** A person accepts the _current_ version; quoting an older one
  is refused with a clear message, so nobody is recorded as agreeing to words they did not see. Publishing a
  new version keeps every earlier acceptance and asks everyone again.
- **Deletion keeps what must be kept.** Completing a deletion request removes the name, phone number, email,
  saved places, emergency contacts, driver details and identity documents (files too), ends sessions, and leaves
  rides, payments, refunds, tickets, safety records, the audit log, compliance records and the request itself
  (now without a name). It is refused, with the reason, while a ride is under way, a cash payment is unsettled
  or a refund is being handled. Pausing an account is still the existing **Deactivate**; it was not rebuilt.
- **Retention is a table.** `retention_policies` has one row per kind of record: DELETE with a number of days and
  a floor, or KEEP. The hourly job is the only code that deletes by age; chat text moved from an environment
  variable to this table (`CHAT_MESSAGES`), and a ride with an unfinished ride problem keeps its chat.

## Accessibility

- Every status change is a sentence from one function (`describeTicketStatus`, `describeRefundStatus`,
  `describeDataRequest`): shown on the screen, sent as the notification, and read out politely when a list or
  conversation changes while it is open. Nothing is conveyed by colour: each state is written, and a field
  problem is text beginning "Problem:" beside the field and announced once.
- Forms use real labels; choices are radio groups with their state; evidence is chosen with the system
  document picker (works with TalkBack, VoiceOver and a keyboard); files read "Open screenshot.png (12 KB)".
- Closing a request, deleting an account and money steps use an in-page confirmation (never a dialog) that
  states what will happen; focus moves to it and Escape backs out in the console.
- The static accessibility test now scans `packages/mobile-support` too.

## Verified, and not

Verified by automated tests: the state tables agree with themselves and with the reply rules; ticket creation,
replies, reopening, closing, illegal and concurrent moves; disputes referencing (not copying) the ride and the
one-open rule under parallel requests; the whole refund lifecycle including rejection, failure and retry,
four-eyes, the payment row staying untouched and parallel requests and decisions; evidence type checks,
per-ticket cap, privacy of the stored key and link, and audited admin opens; internal notes never reaching the
person; RBAC (DISPUTES vs SUPPORT vs REFUNDS vs COMPLIANCE, unauthenticated and wrong-role); notification
content and recipients; escalation once per wait and auto-close; policy acceptance, stale versions and
publishing; data-request lifecycle, due dates, the personal-data copy's contents; anonymising deletion and its
blockers; retention edits (reason, floor, KEEP) and the job. Files: `support.test.ts`, `refunds.test.ts`,
`compliance.test.ts`, `supportText.test.ts`, plus the updated ride, chat and admin tests.

**Not verified, and open:**

- No screen reader (NVDA, TalkBack, VoiceOver) and no real device was used; the screens are typechecked, linted
  and statically checked only. Run [`ACCESSIBILITY_TESTING.md`](ACCESSIBILITY_TESTING.md) section M before a
  release.
- Refunds record money returned; nothing pays anyone. Connect a payment provider before promising a payout.
- There is no push provider: a person hears of a reply or a decision in the app or notification list, not on a
  closed phone.
- **Legal retention periods are placeholders for counsel.** Seed periods for chat, evidence, sign-in events and
  so on are reasonable operating defaults; the periods for rides, payments, refunds and tax records are
  deliberately KEEP with no number. Confirm the right periods for your country (and data-protection response
  times for `DATA_REQUEST_RESPONSE_DAYS`) before launch.
- Signing in and requesting rides are **not** blocked until a policy is accepted: acceptance is recorded and the
  privacy screen shows what is waiting, but no gate enforces it. Decide the legal need, then add a gate.
- The admin console was type-checked and built but not driven in a browser.
