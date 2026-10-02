# Phase 28: online money out (refunds and payouts), push in the apps, and a live provider check

Phase 25 let riders pay online. This phase closes the loop in the other direction and makes the Phase 25 adapters checkable
against real vendors.

## 1. Refunds of online payments

The refund state machine, amounts and four-eyes rule are unchanged (Phase 13). What is new is where the money goes.

- **Cash payment**: unchanged. The driver returns the cash (`DRIVER_CASH`) or staff record that Yatri paid (`PLATFORM`).
- **Online payment**: Yatri pays it back, never the driver. A `DRIVER_CASH` refund of an online payment is refused.
  - If the payment provider can refund through its API (`PaymentGateway.supportsRefund`), moving the refund to
    PROCESSING sends it (`settleOnlineRefund`). The refund's own id is the idempotency key, so a repeat, the sweep or a
    crash in between can never pay back twice. The provider's answer decides: COMPLETED (with the provider's reference), FAILED
    (in plain words; never the vendor's text) or still pending (stays PROCESSING). The `refund-settle` job (every 2 minutes)
    finishes any that were cut short.
  - If it cannot (Khalti's ePayment API has no refund endpoint), the refund waits in PROCESSING for staff to return it in the
    provider's dashboard, and COMPLETED then **requires the provider's reference**.
- The over-refund check, the audit entry (the system acts as `SYSTEM`) and the rider's notification are the same single path.

## 2. Driver payouts

Cash never touches Yatri. An online payment does, so Yatri owes the driver.

- **What is owed** (`driverPayableForRide`, `@yatri/types`): the full fare of each online-paid ride (a promotion is paid by
  Yatri, never taken from the driver), less the share of any refund on it that `ONLINE_REFUND_DRIVER_SHARE_PERCENT` puts on the
  driver (default 0: Yatri bears refunds). One SQL definition (`OWED_SQL`) feeds the driver's balance, the staff totals and the
  preparation of a payout, so they cannot disagree.
- **Hold**: a ride is paid out only `PAYOUT_HOLD_HOURS` (48) after it was paid, and never while a refund on it is being decided.
- **Once only**: a ride is in at most one payout, ever (`driver_payout_items.trip_id` is unique), and preparation is serialised per
  driver. Two staff pressing "prepare" together produce one payout.
- **States** (one table): PENDING, PROCESSING, PAID, FAILED, CANCELLED. PAID needs the bank or wallet **reference**; FAILED needs
  a reason; **the person who prepared a payout cannot mark it paid**; cancelling releases its rides; PAID and CANCELLED are final.
- **Accounts**: the driver saves where to be paid (bank, Khalti, eSewa, IME Pay). The number is encrypted (AES-256-GCM, key derived
  from the storage signing secret for this one purpose); the driver sees the last four characters; a payout keeps a snapshot, so
  changing the account later never redirects a payout under way. Staff with `PAYOUTS_MANAGE` see the full number only after asking
  for it, and each opening is audited. `PAYOUTS_VIEW` never sees it.
- **Yatri has no payout API to a bank or wallet.** Staff send the money and record the reference. That is stated, not hidden.
- **Where**: driver app "Earnings and payouts" (sentences from the server, account form, history); admin Driver payouts (list,
  prepare, detail, steps, account); finance and analytics show real figures (online collected, refunded, owed, in payouts, paid).

## 3. Push notifications in the apps

`expo-notifications` is added. After sign-in both apps ask once for permission, get the phone's push address and register it
(`usePushRegistration`, `POST /users/me/push-token`). Declining is respected. Just before sign-out the address is removed
(`onBeforeLogout`), and the server also drops an account's addresses whenever its sessions are revoked. What is pushed is
unchanged (title, body, type and ride id: never an accessibility detail, note, location or document).

## 4. A live check for the providers

`pnpm --filter @yatri/api providers:check` (run it against staging with the real test credentials) does what Yatri would do:
every provider's own check, a place search and a route, a private file round trip (store, link, fetch, delete), and, only when
asked, one text, one email, one NPR 10 test payment and one test error. It prints one line per step with the vendor's name,
success, time and the **kind** of any failure, and never a key, token, address or vendor message. Exit code 0 means every step that
ran worked.

## What was verified, and what was not

Verified by tests: `apps/api/src/test/payouts.test.ts` (23 tests: the rules, encryption, refunds through a capable and an
incapable provider, retry and idempotency, refusal, the driver's balance and hold, accounts, preparing, concurrency, refund
shares, the payout states and four-eyes, cancellation, snapshot accounts, authorization, privacy and finance figures),
`providers.test.ts` (push tokens removed with sessions), `pushRegistration.test.ts` (permission, token and failure handling).
The harness was run here against the development configuration: real Nominatim search worked, the local storage round trip worked,
and the steps that need a vendor key reported "skipped".

**Not verified**: no real Twilio, Mapbox, Khalti, S3, Resend or Sentry credentials were available, so the staging run is still
yours to do with `providers:check`. Push could not be tried on a device. Screen-reader and device testing could not be done from
here.
