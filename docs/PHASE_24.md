# Phase 24: growth and loyalty

Phase 24 adds offers, coupons, first-ride offers, referrals, reward points, win-back offers, message campaigns and the
figures for them. It is ONE promotion and reward engine on the server. The apps and the admin dashboard only edit or show what
it decides. It reuses users, rides, payments, pricing, notifications, admin, analytics and risk; nothing here prices a ride.

```
Campaign -> Eligibility -> Offer -> Usage limit -> Validity -> Redemption -> Result
```

## What a campaign is

A campaign is a row of data (`campaigns`) with a kind, an eligibility rule, an offer, limits and a schedule. The shapes and
every pure rule (is it live, who is eligible, what an offer takes off, how offers combine, how many points a fare earns) are in
`@yatri/types` `growth.ts`, are unit tested once, and are called by the engine (`modules/growth/engine.ts`). A test fails if any
other module calls them.

| Kind       | What it is                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| Promotion  | an offer for the riders it fits, applied automatically (or only with a code if it has one)                |
| Coupon     | the same, used by entering its code                                                                       |
| First ride | an offer for a rider's first completed ride, and only that                                                |
| Referral   | what a new rider gets for using an invite, and the points the inviter earns when their first ride is done |
| Win-back   | an offer, with a message, for riders who have not ridden for a while                                      |
| Message    | a notification sent once, at its scheduled time, to the riders it fits                                    |

Offers: percent off (with a cap), a fixed amount off, bonus points, or a points multiplier. Eligibility parts (all optional, all
must hold): first-ride only, most/least completed rides, newly opened accounts, inactive for N days, vehicle types, cities,
smallest fare, named riders. Limits: per rider, in total, and how long a given offer stays usable. Validity: start and end dates.
Status: Draft, Active, Paused, Ended, with one transition table; a running campaign is paused before it is edited.

## The life of a ride's offers

1. **Quote** (the estimate): what the rider would pay, per vehicle type, after offers and points. Reads only.
2. **Reserve** (the request): in the same transaction that creates the ride, the offers and the points choice are held for it, under
   the campaign's row lock, so two riders cannot both take the last use. The offer as it was is copied onto the reservation. A typed
   code that cannot be used refuses the request in words; a code that merely lost to a better offer does not.
3. **Release**: if the ride is cancelled or finds no driver, the reservation is void and the use is given back.
4. **Settle** (the ride completes): the discount is worked out again on the FINAL fare from the copied offer, points are used and
   earned, a referral may qualify, and what the platform paid is recorded on the ride. Idempotent (a marker on the ride), and the
   payment reconcile job settles a ride whose completion was interrupted.

## Money

A promotion never changes a fare. The fare engine alone prices a ride. A discount is an amount **Yatri pays**, recorded on the ride
(`trips.discount_npr`); the rider's payment is for what they owe after it, and the driver still earns the full fare. The finance
screens show it ("Yatri paid towards fares") and no longer count it as an unpaid fare. Business rides (an organization pays by its own
policy) take no promotions and earn no points.

## Reward points

`reward_ledger` is append-only: nothing edits or deletes an entry and only `growth/loyalty.ts` writes one (a test checks). Earned
points are lots, so spending and expiry are first-expiring-first, and a balance is what the unexpired lots hold (expired points
cannot be spent even before the expiry job writes them off). Every change to one person's points happens under one lock per
person; a source can write a kind of entry for a person once (a unique index), so a repeated completion cannot pay twice.
Earning, value, minimum, maximum share and expiry are platform settings (Settings > Rewards and referrals). Only an administrator
with `GROWTH_MANAGE` can correct points, with a reason, in the entry and in the audit log.

## Referrals

Each rider has one invite code. A new rider (no completed ride, never invited) uses ONE code, once. Their own code and a circle are
refused and recorded for the risk system; one code can bring in only so many riders in 30 days (a setting); the referee row is
unique, so simultaneous uses count once. The inviter is paid when the invited rider's first ride completes (not when the code is
typed), once, and held, not paid, if their account is not active then.

## Abuse and the risk system

Four risk rules read the records above (promotion and referral abuse): many offers used in a day, many invites in a week, invited
accounts signing in from the inviter's network address, and repeated attempts to use one's own code. They raise signals for review
with few points and the usual "can be innocent" wording; nothing here suspends or bans, and one signal restricts nobody.

## Messages and win-back offers

The `growth-messages` job (the one job architecture) sends message campaigns when due and gives win-back offers to riders they fit.
Both use the existing notification service: its dedupe key makes a repeat harmless, and its preference check records, without
pushing, a message to a rider who has not opted in. **Offers and news are opt-in (off by default).**

## Driver incentives

Driver incentives are not a second system. They remain the existing incentive rules (set in Demand, zones and pricing); the campaign
service presents them: `GET /growth/driver` is the one function the driver endpoints call (the old route returns the same), the
driver app reads it from there, and the campaign analytics show driver bonuses beside the rider figures.

## The dashboards

- **Admin** (`/campaigns`): list with filters, figures, create/edit, start/pause/end with reason, schedule, limits, who used each
  campaign, and a rider's reward points with a corrections form. New permissions `GROWTH_VIEW` / `GROWTH_MANAGE`. Every change is
  versioned, reasoned and audited.
- **Rider app** (`Offers and rewards`): reward points and history, available offers, promo-code entry (checked by the server), the
  invite code and how invited friends are doing. The request screen has a promo field, a points switch and a fare breakdown
  (fare, each offer, points, what you pay, what you will earn) from the server's answer, announced politely when it changes.
- **No campaign configuration is held in an app**: apps receive sentences and numbers the server computed.

## Not done, honestly

- **Nothing was tried on a device** or with a screen reader; section W of `ACCESSIBILITY_TESTING.md` lists the checks.
- **Device-level abuse detection does not exist**: there is no device fingerprint in the system, so duplicate accounts are only
  found through the existing network-address signal (which is innocent for households) and by review.
- **Push delivery**: messages go through the notification service, but no push provider is connected (Phase 25 adds the provider
  layer), so "sent" means handed to it.
- **Points are rider-only**; drivers have incentives, not points.
- **A discount is not reversed automatically** if a ride's payment is refunded; support handles that with the existing refund flow and
  an administrator can correct points.
- **Segment targeting is limited** to the eligibility parts above (rides, account age, inactivity, vehicle type, city, named riders).
- Campaign budgets (a total rupee cap) are not built; the usage limit is a count.
