# Phase 17: fraud, risk and trust

Phase 17 adds a central risk engine that raises **signals** about suspicious behaviour, derives a **level** from
them, and gives administrators the tools to investigate, note, restrict temporarily, suspend and restore, with
every consequential action in the one audit log. It reads the records the other systems already own (sign-in
events, trips, ratings, tickets, refunds, location flags, incentive awards) and keeps no copy of any of them.
The backend stays authoritative; no app holds a rule.

## What it does and does not do

A signal is a reason for a human to look, never proof.

- It **never suspends and never bans.** Suspending and restoring are the existing account moves (`USERS_MANAGE`,
  `admin/admin-users.ts`), made by an administrator.
- **No single signal restricts anyone.** The only automatic measure is a short temporary restriction, **off by
  default** (`RISK_AUTO_RESTRICT_SCORE=0`). When switched on it needs the score to reach the threshold **and**
  at least `RISK_MIN_DISTINCT_RULES` different rules to have fired, lasts `RISK_AUTO_RESTRICT_HOURS`, ends by
  itself, and an administrator can lift it. Only signals newer than the last restriction decision count, so
  lifting a restriction is not undone by the next sweep.
- **False positives are handled, not just tolerated.** An administrator can dismiss an event: it stops counting,
  and the same rule stays quiet for that person for two windows. A confirmed event can later be dismissed and the
  reverse. Several rules are written to say why an innocent person trips them (shared networks, plans changing).
- **Privacy.** Events hold counts and record ids, never a phone number, an address or a coordinate. They are
  deleted after the `RISK_EVENTS` retention period (365 days, floor 90). Notes are staff-only; the audit log
  records that a note was added, not what it says. Risk data is not part of the personal-data export (it is
  internal security information, not data the person supplied).

## What was built

| Brief                          | Where it is                                                                                                                                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rules, levels, wording         | `@yatri/types` `risk.ts`: `RISK_RULES` (definitions and defaults), `RISK_LEVELS`, `deriveRiskLevel`, status transitions, wording. The one place; the detectors, the API and the screens read it                                        |
| Detectors                      | `risk/detectors.ts`: one query per rule over the existing tables                                                                                                                                                                       |
| Suspicious activity, OTP abuse | `LOGIN_FAILURE_BURST`, `SUSPENDED_RETRIES`, `OTP_REQUEST_BURST`, `OTP_WRONG_CODES` over `auth_events`                                                                                                                                  |
| Fake and multiple accounts     | `SHARED_ADDRESS_ACCOUNTS`: several accounts verifying from one address (few points, because shared networks are common)                                                                                                                |
| GPS anomalies                  | `GPS_SPOOFING_FLAGS` over `driver_location_flags` (the flags `detectFlags` already raises); kinds only, never places                                                                                                                   |
| Cancellation patterns          | `PASSENGER_CANCELLATIONS`, `DRIVER_CANCELLATIONS`: a count **and** a share of their rides (`RISK_CANCELLATION_MIN_SHARE_PERCENT`)                                                                                                      |
| Payment abuse                  | `UNPAID_RIDES` (finished rides unpaid after a grace period), `REFUND_REQUEST_BURST`                                                                                                                                                    |
| Fake ratings                   | `RATING_BOOSTING` (repeated five stars between the same two people), `RATING_BOMBING` (many one-star ratings in a day)                                                                                                                 |
| Collusion                      | `REPEAT_PAIR_RIDES`: the same rider and driver, ride after ride; the partner is named by id so an administrator can follow it                                                                                                          |
| Repeated disputes              | `REPEATED_DISPUTES` over dispute tickets                                                                                                                                                                                               |
| Unusual payout activity        | `INCENTIVE_SPIKE`: large incentive earnings in a short time. Incentives are the only money the platform pays out                                                                                                                       |
| Configurable rules             | `risk_rule_overrides` holds only what an administrator changed (on or off, points, threshold, window), with a reason, audited; defaults are in the types. Putting the defaults back removes the override                               |
| Levels                         | LOW_RISK, REVIEW_REQUIRED, RESTRICTED, SUSPENDED: **derived**, never stored, from the events, the restriction and `users.status` (`deriveRiskLevel`). One source, so they cannot disagree                                              |
| Effect of a restriction        | `risk/restriction.service.ts`; a passenger's ride request is refused with a neutral message (403 `ACCOUNT_RESTRICTED`), a driver is excluded by `DRIVER_RIDEABLE_SQL` and taken offline. Support, sign-in and rides under way continue |
| Admin tools                    | Fraud and risk: overview, signals, people (investigation), rides (investigation), rules, history. `RISK_VIEW` reads, `RISK_MANAGE` changes. Suspending and restoring use the existing `USERS_MANAGE` moves from the person page        |
| Audit                          | `RISK_USER_RESTRICTED`, `RISK_USER_AUTO_RESTRICTED`, `RISK_USER_RESTRICTION_LIFTED`, `RISK_RESTRICTION_EXPIRED`, `RISK_EVENT_REVIEWED`, `RISK_NOTE_ADDED`, `RISK_RULE_CHANGED`, `RISK_USER_VIEWED`, `RISK_TRIP_VIEWED`                 |
| Abuse controls                 | New rate limits on cancelling a ride, rating a ride and confirming a payment (tested for 429); sign-in and code requests already had them                                                                                              |
| Review notice                  | The `RISK_MANAGE` team is told once a week per person that a review is due. The notice carries no names or details                                                                                                                     |

## Decisions worth knowing

- **No wallet, promo, referral or payout system exists in Yatri** (it is a cash platform; refunds and incentive
  awards are records). Phase 17 therefore has nothing to protect there and does **not** invent those systems.
  Wallet integrity is covered the other way round: tests prove a risk action (review, restriction, lifting, the
  sweep) leaves payments, refunds and incentive awards byte-for-byte unchanged, and that settling a payment stays
  idempotent for a restricted passenger. When such a system is added, its signals are new rows in `RISK_RULES`
  and `DETECTORS`; nothing else changes.
- **Restricting is guarded under a row lock on the person.** Two administrators (or an administrator and the
  sweep) cannot both apply one: one wins, the other is told it is already restricted. Reviews are applied only if
  the event is still in the state the reviewer saw.
- **The score is a sum, not a probability.** Detectors are heuristics: the defaults are reasoned, not tuned.
  Expect to adjust thresholds on real traffic, which is why they are data.
- **The users list** contains people with a signal that still counts or an active restriction; people with no
  signals are not listed (open them from the account page by id).

## Not done, honestly

- Detectors have only been run on test data; thresholds need tuning on real traffic.
- Device fingerprints and payment instruments are not collected, so "multiple accounts" rests on network address
  only; this is weak evidence by design and is scored low.
- No machine learning, no external fraud service, no blocking of sign-up.
- Screen-reader behaviour of the new pages was not checked with NVDA, TalkBack or VoiceOver here; only the
  automated console accessibility checks and the manual checklist (section P) exist.
