# Phase 2 — Authentication & Accounts

## Goal

Make Yatri's identity, authentication, sessions, and role-based access control work
reliably and securely for all three user types, without building any ride-related feature
yet. Full detail: [`AUTHENTICATION.md`](AUTHENTICATION.md).

## In scope

- [x] Database: `users`, `otp_requests`, `auth_sessions`, `driver_profiles`, `auth_events`
      tables with proper PKs/FKs/unique constraints/indexes/timestamps, via `node-pg-migrate`
      migrations
- [x] OTP service: secure generation, hashed storage, expiry, one-time use, max attempts,
      resend cooldown, phone+IP rate limiting, invalidation of superseded codes, event
      logging — backed by a swappable `SmsProvider` abstraction
- [x] Development-only OTP mode, hard-disabled when `NODE_ENV=production`
- [x] JWT access tokens + opaque, hashed, rotating refresh tokens; live session/status
      re-check on every authenticated request; logout/revocation (single device or all)
- [x] Role-based authorization middleware (`authenticate` + `requireRole`), verified with a
      passenger/driver/admin isolation test matrix
- [x] Account status (`ACTIVE`/`SUSPENDED`/`DEACTIVATED`) enforced on every protected route
- [x] Passenger profile: `GET`/`PATCH /users/me`
- [x] Driver account foundation: `driver_profiles` with
      `PENDING_VERIFICATION`/`VERIFIED`/`SUSPENDED`/`REJECTED` status, `GET`/`PATCH /drivers/me`
- [x] Admin authentication: separate email+password flow, dev-only seed script (no hard-coded
      credentials), `GET /admin/me`
- [x] Passenger app: Welcome → phone → OTP → profile setup → home, wired to the real API,
      with secure on-device token storage
- [x] Driver app: Welcome → phone → OTP → driver profile setup → verification-pending screen
      that clearly states the driver cannot accept rides yet
- [x] Admin app: real login (httpOnly cookies, `proxy.ts` route protection with silent
      refresh), protected dashboard, sign-out
- [x] Automated backend tests (OTP, sessions, authorization, profiles) against a real
      Postgres + Redis
- [x] Accessible auth UI: labeled/typed inputs, associated error messages, live-region
      announcements for loading/errors, 44pt touch targets, single (not segmented) OTP field
      for screen-reader reliability

## Explicitly out of scope (future phases)

- Ride booking, driver matching, live GPS tracking, maps, fare calculation
- Payments, ratings, SOS, promotions
- Driver document verification (the `driver_profiles.status` structure exists; the workflow
  to actually move a driver from `PENDING_VERIFICATION` to `VERIFIED` does not)
- Payment information on the passenger profile
- Multi-device session _management UI_ (revocation exists server-side and via
  `allDevices` on logout; there's no "your devices" screen yet)

## Notes for the next phase

- Ride/trip domain types belong in `packages/types` alongside the auth primitives added this
  phase, not duplicated per app.
- The driver verification workflow (documents, review queue, admin approval) is a natural
  next slice: `driver_profiles.status` and the admin role/auth foundation are already there
  for it to build on.
- `packages/mobile-auth`'s `AuthContext` already exposes `getAccessToken()` for any future
  authenticated API call from the passenger/driver apps — ride booking's API client should
  use it rather than re-implementing token handling.
