# Phase 26: disability identity card verification

A rider can choose, privately and voluntarily, to have a disability identity card verified so that disability benefits apply to
their rides. The server decides every status; no client can ever mark anyone verified.

## The flow

1. **Opt in.** The rider reads the consent and agrees. The consent is a row in the existing consent system
   (`compliance_policies` kind `CONSENT`, key `DISABILITY_BENEFIT_CONSENT`) and its acceptance is a `compliance_records` row. There is
   no second consent store. Nothing is collected before it.
2. **Details and document.** Card number, who issued it, issue and expiry dates, and a photo or PDF. The number is never stored:
   only a keyed hash (HMAC, key derived from the storage signing secret for this one purpose) and its last four characters. The
   document goes behind the storage provider with the same file checks as every other document (`detectFileType`, size limit).
3. **Submit.** The server lists anything still missing (the same list the app shows) and moves the application to `SUBMITTED`.
4. **Decision.** A reviewer starts the review, approves, rejects (reason required), asks for a correction (message required) or later
   revokes. An official check, when one is connected, can only confirm; anything else goes to a person.
5. **Benefit.** Approved riders are `VERIFIED` until the card's expiry date. The benefit itself is an ordinary campaign (see below).
6. **Ending.** A card past its date becomes `EXPIRED` (the benefit stops by the date even before the job runs) and the rider is told;
   they are reminded at 30 and 7 days. The rider can withdraw at any time: consent is withdrawn, the benefit ends, and the card
   details and the document are erased at once.

## Verification architecture

- **State machine**: `NOT_SUBMITTED, SUBMITTED, UNDER_REVIEW, NEEDS_CORRECTION, VERIFIED, REJECTED, EXPIRED, REVOKED`, defined once
  in `packages/types/src/disability.ts` (`DISABILITY_TRANSITIONS`) with who may enter each state (`DISABILITY_ACTOR_TARGETS`):
  a rider can only apply, withdraw or step away; `VERIFIED` belongs to staff and to a confirming official check; expiry is the
  system's. The API applies `checkDisabilityMove` under the row lock (`applyMove`), and every move writes an event
  (`disability_verification_events`: who, from, to, how, why). Two reviewers racing produce exactly one decision.
- **Manual versus official** are separate in the data (`method` chosen, `verified_method` actual) and in every screen. No government
  service is assumed or bundled: `modules/disability/verifier.ts` is an interface with nothing registered, so the official method
  is "not available" (with the reason) until an administrator switches it on **and** a service is connected.
- **Duplicates**: the same card hash on another active application is shown to reviewers (count and links), requires them to
  acknowledge it before approving, and raises a low-weight risk signal (`DISABILITY_DUPLICATE_CARD`). A repeated-submission signal
  (`DISABILITY_REPEATED_SUBMISSIONS`) exists too. One signal never rejects anybody.
- **Expiry**: the `disability-expiry` job (hourly). `benefitActiveFor` (and the SQL twin `benefitActiveSql`, one rule) also checks the
  date itself.
- **APIs**: `POST|GET|PATCH /api/v1/me/disability-verification`, `.../documents`, `.../submit` (passengers only); admin
  `GET /admin/disability-verifications`, `/:id`, `/:id/document`, and `POST /:id/start-review|approve|reject|request-correction|revoke`.
- **Admin**: permissions `DISABILITY_VERIFICATION_VIEW` (cases, last four characters) and `DISABILITY_VERIFICATION_REVIEW` (decide,
  open a document). Pages: list with filters (links), case with history, duplicates, document link and decisions through the shared
  two-step confirmation. Every decision, every case view and every document opening is audited.

## Benefit integration (no second engine, no second ledger)

A disability benefit is a campaign whose eligibility says `requiresDisabilityVerified`. `EligibilityFacts.disabilityVerified` is filled
by `benefitActiveFor` (the verification module is the only source). Everything else is existing campaign configuration an
administrator edits: percent or fixed discount, vehicle types, cities, limits, dates, stacking, and bonus points or a points
multiplier through the one loyalty ledger. The fare shows **Normal fare / Disability benefit / You pay**, all from the server's
`PromotionQuote` (an offer is labelled `disabilityBenefit`). Nothing about a card is stored on a redemption.

## Privacy controls

- Card number: never stored, shown or logged; only a keyed hash and the last four characters.
- Document: private storage, only a short-lived signed link, only for reviewers with the review permission, each opening audited.
- Driver: never the number, the document, the history, the dates or the identity. Only the driver of an **accepted, live** ride,
  only if the rider turned on `shareDisabilityStatusWithDriver` (off by default), and only the sentence "has a verified disability
  benefit". Nothing before acceptance, after the ride ends, or once the verification ends.
- Consent: withdrawal erases the card and the document, ends the benefit, and stops all of the above.
- Retention: ended applications are erased after 730 days (`DISABILITY_VERIFICATION`, enforced).
- Notifications and audit entries carry no card detail.

## Accessibility

The passenger screen (`DisabilityBenefitCenter`) is optional-first, one heading per part, every field labelled, status announced
politely when it changes ("Disability benefit verification submitted. Status: Under review. We will tell you when it changes."),
problems read as "Problem: …", the erase action asks twice, and nothing depends on colour or motion. The admin workspace uses
captioned tables with row headers, state written as words, and filters and paging as links.

## What was verified, and what was not

Verified by tests: `apps/api/src/test/disability-verification.test.ts` (state machine and actor rules, consent, hashing, validation,
the rider flow, staff decisions and permissions, duplicates and risk, the official check with a fake service, expiry and reminders,
withdrawal and erasure, and the driver-visibility rules), `packages/mobile-preferences/src/disabilityText.test.ts` (words and static
accessibility checks), and the eligibility rule in `growth.test.ts`.

**Not verified**: no official verification service exists to test against; the passenger screen and the admin pages were
type-checked and statically checked but not exercised on a device or in a browser, and not with TalkBack, VoiceOver or NVDA.
