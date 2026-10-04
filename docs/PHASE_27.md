# Phase 27: disability benefits and accessible ride services

Everything here stands on Phase 26: **the verification result is the only source of eligibility.** There is no second
verification system, no second discount engine, no second points ledger and no second matching system.

## How a benefit works (verified user, policy, eligibility, benefit, usage)

1. **Verified user**: `benefitActiveFor(userId)` (and its SQL twin `benefitActiveSql`) says whether the rider has a verified,
   unexpired benefit with consent in force. Expiry is judged by the date itself.
2. **Policy**: an administrator creates a campaign of kind **Disability benefit** (`DISABILITY_BENEFIT`) in Campaigns. It is an
   ordinary campaign whose eligibility is fixed to `requiresDisabilityVerified` (the API refuses one that is not). Its
   configuration is the whole policy:
   - benefit type and value: percent or fixed off the fare, bonus loyalty points, or a points multiplier (`CampaignOffer`);
   - vehicle types and cities (`vehicleCategoryCodes`, `cityIds`), minimum fare;
   - usage limits per rider and in total, validity dates, activate / pause / end (the one campaign state machine);
   - combination rules: `stackable` (the one rule that stops one offer silently stacking on another);
   - companion eligibility: `companionAllowed` (default yes; "no" means the benefit does not apply when a companion rides along).
3. **Eligibility**: `evaluateEligibility` (one pure rule in `@yatri/types`) with the facts `disabilityVerified` and the ride's
   `withCompanion`.
4. **Apply**: `quoteRide` / `reserveForRide` / `settleRide` (the one promotion engine). The platform pays the discount; the rider
   pays the fare minus it; the driver earns the full fare. Reservation takes the campaign's row lock, so a limited benefit goes
   to exactly one of two riders booking at the same moment.
5. **Record usage**: `campaign_redemptions` holds only references (campaign, rider, ride, amounts, the campaign's own snapshot):
   never a card, a name, a document or any identity detail. Bonus points go through the one ledger (`reward_ledger`).

## Before booking

`PromotionQuote.breakdown` (decided by the server, `payableBreakdown`) is the **standard fare, disability benefit, loyalty
benefit, other discount and amount payable**; the five figures always add up. The passenger app lists them in that order when a
disability benefit applies (`quoteLines`), as sentences a screen reader reads in order, and does no arithmetic.

## Booker, passenger and companion

- **Booker**: the account that books and pays. Personal rides: the same person as the passenger. A business ride can be booked
  by someone else, but business rides take no promotions and earn no points.
- **Passenger**: `trips.passenger_id`, the beneficiary. The benefit follows this account only.
- **Companion**: a flag on the ride (`trip_accessibility.companion`, set from the rider's saved profile or the request). It needs
  no account and no verification, nothing is asked or kept about the companion, and the driver is told only "Someone travels with
  the passenger. Please allow room for them." The companion never discloses a disability. Whether the benefit applies with a
  companion is the policy's `companionAllowed`.

## Accessible ride services

All reuse the existing accessibility and dispatch modules.

| Service                       | How                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wheelchair-accessible vehicle | existing need `WHEELCHAIR` → required vehicle feature → matching only offers the ride to approved vehicles                                                                                                                                                                                                      |
| Pickup assistance             | existing need `ASSISTANCE` and pickup instructions (accessible entrance, meeting point, note)                                                                                                                                                                                                                   |
| Communication preference      | existing preference (any, text preferred, text only)                                                                                                                                                                                                                                                            |
| Extra boarding time           | new need `EXTRA_BOARDING_TIME`: the free waiting time and the wait before a driver may cancel for a no-show grow by `EXTRA_BOARDING_SECONDS` (platform setting). One function (`pricingConfigForTrip`) feeds the waiting charge, the no-show rule and the rule the apps display, so they agree. No extra charge |
| Accessible vehicle priority   | a request that needs a vehicle feature searches `ACCESSIBLE_SEARCH_RADIUS_BONUS_PERCENT` wider from the first offer on (`searchRadius`)                                                                                                                                                                         |
| Accessible pickup point       | existing pickup instructions and note                                                                                                                                                                                                                                                                           |

Drivers get **operational instructions only** (the need's driver sentence, the companion line, the pickup note), never an identity,
a card or a verification. The separate, rider-controlled "verified benefit" note from Phase 26 is unchanged.

## Admin

- **Policies**: Campaigns, kind "Disability benefit" (create, edit while not live, schedule, activate, pause, end, with a reason
  recorded and audited like every campaign).
- **Disability benefits** page (`/disability/benefits`, `DISABILITY_VERIFICATION_VIEW`): policies with times used, money taken off and
  different riders; the service options (extra boarding time, vehicle priority, switches); and what looks unusual for a person to
  review (benefit used on many rides in a day, a card on several accounts, repeated applications), linked to Fraud and risk.
  Counts and references only.
- **Service options** are platform settings (`EXTRA_BOARDING_SECONDS`, `ACCESSIBLE_SEARCH_RADIUS_BONUS_PERCENT`,
  `DISABILITY_VERIFICATION_ENABLED`, `DISABILITY_OFFICIAL_API_ENABLED`), changed in Settings with an audit entry.
- **Manual review**: the verification workspace (Phase 26) and the risk review. One signal never stops a benefit.

## Abuse prevention

Self-service eligibility is impossible (only the server marks anyone verified); the same card on two accounts needs a reviewer's
acknowledgement and raises a signal; a benefit used on many rides in a day (`DISABILITY_BENEFIT_BURST`) raises a signal; limits
and validity are enforced under row locks; a ride's offers are reserved and settled once (idempotent); revoking, expiring,
withdrawing consent or switching the feature off stops every benefit at once.

## What was verified, and what was not

Verified by tests (`apps/api/src/test/disability-benefits.test.ts`, the mobile text tests, `accessibility.test.ts`): the pure rules
(eligibility, companion, breakdown, radius, driver wording), the benefit through the real estimate / request / complete flow
(applies only to a verified rider, stops on revoke, expiry, withdrawal and the platform switch, vehicle-type and companion rules,
bonus points through the one ledger, per-rider limits, one settlement, exactly one winner for a limited benefit), extra boarding
time (the waiting rule shown to the apps and the no-show refusal), the driver's companion note, the staff overview and its
authorization, the abuse signal, and SSOT checks.

**Not verified**: the apps and admin pages were type-checked and checked statically but not exercised on a device or in a browser
or with a screen reader; accessible-vehicle priority is a wider search radius (measured by its rule), not observed against a
real driver fleet.
