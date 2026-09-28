# Authentication

Phase 2 scope: identity, authentication, sessions, and role-based access control for all
three Yatri user types. Ride booking, driver document verification, and admin fleet/trip
tooling are later phases — see [`PHASE_2.md`](PHASE_2.md).

## Architecture

Three roles, one `users` table, two different login mechanisms:

- **Passenger / Driver** — phone number + OTP. No passwords. The same phone number may hold
  both a passenger account and a driver account (two separate `users` rows, one per role);
  they don't share state.
- **Admin** — email + password. A deliberately separate flow: admins are internal staff, not
  end users, and mixing the two would blur the role boundary the rest of this document exists
  to protect. There is no self-serve admin signup — see [Admin accounts](#admin-accounts).

`role` and `status` on `users` are the only things authorization ever trusts, and both are
read from the database on every request (see [Sessions](#sessions--tokens)) — never from a
client-supplied value. A client cannot become a driver or an admin by editing a request body.

### Database

| Table             | Purpose                                                                    |
| ----------------- | -------------------------------------------------------------------------- |
| `users`           | Identity for all three roles: role, status, phone/email, name, avatar      |
| `driver_profiles` | 1:1 extension of `users` for drivers: verification status                  |
| `otp_requests`    | One row per OTP issued: hash, expiry, attempts, consumed/invalidated flags |
| `auth_sessions`   | One row per refresh token (= one logged-in device): hash, expiry, revoked  |
| `auth_events`     | Append-only audit log of every auth-relevant event                         |

Migrations live in `apps/api/migrations/` (`node-pg-migrate`, plain JS, one file per table).
Run them with `pnpm --filter @yatri/api migrate:up`; see [Local testing](#local-testing)
for the full setup. Every table uses a UUID primary key, proper foreign keys with
`ON DELETE CASCADE`/`SET NULL` as appropriate, unique constraints (`(phone_number, role)`,
`email`, `refresh_token_hash`), indexes on every column queried by the hot paths, and
`created_at`/`updated_at` timestamps (`updated_at` maintained by a trigger, not application
code).

Only the user's own `id` is ever returned by `/users/me`, `/drivers/me`, or `/admin/me` — no
endpoint returns another user's internal ID, a session ID, or an OTP request ID.

## OTP flow

```
Passenger/driver app                    API                              Database / Redis
--------------------                    ---                              ----------------
POST /auth/request-otp  ─────────────►  check resend cooldown (Redis)
  { phoneNumber, role }                 check phone/IP rate limit (Redis)
                                         invalidate prior active OTP  ───► otp_requests
                                         generate 6-digit OTP (crypto.randomInt)
                                         bcrypt-hash it, store          ───► otp_requests
                                         send via SmsProvider
                                         log OTP_REQUESTED             ───► auth_events
                         ◄─────────────  { expiresAt, resendAvailableInSeconds }

POST /auth/verify-otp   ─────────────►  find active OTP for phone/role  ◄── otp_requests
  { phoneNumber, role, code }           check attempts < max
                                         bcrypt.compare(code, hash)
                                         on mismatch: increment attempts, log, 401
                                         on match: mark consumed, log OTP_VERIFIED
                                         find or create user             ───► users
                                         if new DRIVER: create driver_profiles
                                         if status != ACTIVE: 403, log LOGIN_FAILED
                                         issue session (see below)
                         ◄─────────────  { user, isNewUser, accessToken, refreshToken, ... }
```

**Security properties, and where each is enforced** (`apps/api/src/modules/auth/otp.service.ts`):

| Requirement                    | Enforcement                                                                 |
| ------------------------------ | --------------------------------------------------------------------------- |
| Secure generation              | `crypto.randomInt` (CSPRNG), not `Math.random`                              |
| Secure storage                 | bcrypt hash only; plaintext code is never persisted                         |
| Expiration                     | `expires_at` on the row; `OTP_TTL_MINUTES` (default 5)                      |
| One-time use                   | `consumed_at` set on success; a consumed OTP is never found again           |
| Max verification attempts      | `attempts`/`max_attempts` columns; locked at `OTP_MAX_ATTEMPTS` (default 5) |
| Resend cooldown                | Redis key with TTL, `OTP_RESEND_COOLDOWN_SECONDS` (default 60)              |
| Rate limiting (flooding)       | Redis fixed-window counters, per phone number **and** per IP                |
| Invalidate superseded OTPs     | Requesting a new OTP marks any still-active prior OTP `invalidated_at`      |
| Auth event logging             | Every request/verify/lock/lockout is written to `auth_events`               |
| Account enumeration resistance | Wrong code and "no active OTP" return the identical `INVALID_OTP` response  |

An incorrect guess and an already-expired/consumed/nonexistent OTP are indistinguishable to
the caller (`INVALID_OTP`, 401) — only "too many attempts" gets its own code (`OTP_LOCKED`,
429), which is safe to reveal since the caller already knows how many guesses they made.

### SMS provider abstraction

`apps/api/src/modules/auth/sms/sms-provider.ts` defines a one-method `SmsProvider` interface.
Business logic (the OTP service) only ever depends on that interface — swapping the real
vendor later is "write one new class", not "touch auth logic":

- `ConsoleSmsProvider` — logs the message. Throws at construction if `NODE_ENV=production`,
  so it can never accidentally ship as the production provider.
- `HttpSmsProvider` — generic `POST { to, body }` to `SMS_HTTP_ENDPOINT` with a bearer
  `SMS_HTTP_API_KEY`. A placeholder integration point for a real vendor (Sparrow SMS, Twilio,
  etc.) — point it at your provider's webhook, or replace the class if its API shape differs.

Selected via `SMS_PROVIDER=console|http`. The env schema (`apps/api/src/config/env.ts`)
**refuses to start** with `SMS_PROVIDER=console` when `NODE_ENV=production`.

### Development OTP mode

`OTP_DEV_MODE=true` makes `request-otp` include the generated code in its JSON response
(`data.devOtp`) so you can complete the flow locally without a real SMS provider. The env
schema throws at startup if `OTP_DEV_MODE=true` and `NODE_ENV=production` — this is a hard
failure, not a warning, so it can't ship on accidentally. No real OTP is ever hard-coded
anywhere in the codebase; `devOtp` only ever echoes the code that was actually just generated
and hashed.

## Sessions & tokens

- **Access token**: a short-lived JWT (`ACCESS_TOKEN_TTL_MINUTES`, default 15) signed with
  `JWT_ACCESS_SECRET`. Payload: `{ sub: userId, sid: sessionId, role }`.
- **Refresh token**: a 256-bit random opaque token (`crypto.randomBytes`), returned to the
  client once and stored server-side only as a SHA-256 hash, in `auth_sessions`
  (`REFRESH_TOKEN_TTL_DAYS`, default 30). One row = one logged-in device.
- **Refresh rotation**: every `POST /auth/refresh` issues a _new_ refresh token and
  invalidates the old one (same session row, new hash). Reusing an old, rotated-away refresh
  token fails with `INVALID_REFRESH_TOKEN` — this detects token theft/replay.
- **Revocation**: `POST /auth/logout` sets `revoked_at` on the session (or, with
  `{ "allDevices": true }`, on every session for that user). A revoked session is rejected
  immediately, not just once its access token naturally expires.
- **Live status/session check on every request**: `authenticate` middleware
  (`apps/api/src/middleware/authenticate.ts`) verifies the JWT _and_ re-checks the backing
  session (`auth_sessions.revoked_at`, `expires_at`) and the user's account `status` against
  the database on every request — one indexed join. A pure JWT-signature check would let a
  just-suspended account or a just-revoked session keep working for up to 15 minutes; this
  makes both take effect immediately.
- **Suspended/deactivated accounts** are blocked from every protected endpoint
  (`ACCOUNT_SUSPENDED` / `ACCOUNT_DEACTIVATED`, 403), even mid-session with an otherwise
  valid token.

### Web (admin) vs. mobile (passenger/driver)

The API itself is transport-agnostic — every client gets tokens back in the JSON response
body. What differs is how each client _stores_ them:

- **Mobile** (`packages/mobile-auth`): tokens live in `expo-secure-store` (iOS Keychain /
  Android Keystore) — never `AsyncStorage`, never plain state that could be inspected via a
  debug bridge.
- **Admin web** (`apps/admin`): a server action calls the API, then sets both tokens as
  **httpOnly, `SameSite=Lax`** cookies on the admin app's own origin (`secure` in
  production). Client-side JavaScript never touches them. `apps/admin/src/proxy.ts` (Next's
  middleware/proxy convention) verifies the access-token JWT locally on every navigation
  (same secret as the API, no network round trip) and, if it's missing/expired but a refresh
  cookie is present, transparently calls `POST /auth/refresh` and re-issues both cookies
  before continuing — an admin doesn't get bounced to `/login` just because 15 minutes
  passed. The dashboard page itself additionally calls `GET /admin/me` server-side before
  rendering, which _does_ hit the database — this is what catches a revoked session or a
  suspended account immediately, since the proxy's local JWT check alone cannot.

## Authorization

`apps/api/src/middleware/requireRole.ts` checks `req.auth.role`, which `authenticate` set
from the database-backed session — never from anything on the incoming request. Routes
declare their required role(s) once:

```ts
driversRouter.use(authenticate, requireRole('DRIVER'));
adminRouter.get('/me', authenticate, requireRole('ADMIN'), getMeHandler);
```

`/users/me` is intentionally role-agnostic (any authenticated role reads/updates their own
base profile); `/drivers/me` and `/admin/me` are role-gated extensions of the same idea. See
`apps/api/src/test/authorization.test.ts` for the full passenger/driver/admin isolation
matrix, including a client that tries to smuggle a different `role` in a request body.

## Admin accounts

There is no admin signup endpoint and no hard-coded admin credential anywhere in the
codebase. `pnpm --filter @yatri/api seed:admin` creates exactly one admin account from
`ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` — both **required**, no defaults — and the script
refuses to run at all when `NODE_ENV=production`. In a real environment, create admin
accounts out-of-band (a direct, audited DB operation, or a future admin-invite flow), not
with this script.

## API endpoints

All under `/api/v1`.

| Method  | Path                | Auth                | Purpose                                                |
| ------- | ------------------- | ------------------- | ------------------------------------------------------ |
| `POST`  | `/auth/request-otp` | —                   | Send an OTP to a phone number for `PASSENGER`/`DRIVER` |
| `POST`  | `/auth/verify-otp`  | —                   | Verify the OTP; creates the account on first sign-in   |
| `POST`  | `/auth/refresh`     | —（refresh token）  | Rotate a refresh token for a new access/refresh pair   |
| `POST`  | `/auth/logout`      | Bearer access token | Revoke the current session (or all, with `allDevices`) |
| `POST`  | `/auth/admin/login` | —                   | Admin email + password login                           |
| `GET`   | `/users/me`         | Bearer, any role    | Read the caller's own profile                          |
| `PATCH` | `/users/me`         | Bearer, any role    | Update `fullName` / `profilePictureUrl`                |
| `GET`   | `/drivers/me`       | Bearer, `DRIVER`    | Read profile + `driverStatus`                          |
| `PATCH` | `/drivers/me`       | Bearer, `DRIVER`    | Update `fullName` / `profilePictureUrl`                |
| `GET`   | `/admin/me`         | Bearer, `ADMIN`     | Read the admin's own profile (used by the admin app)   |

Every request body is validated with `zod`; invalid input gets `400 VALIDATION_ERROR` with
per-field messages, never a stack trace.

## Security considerations

- **OTP brute force / enumeration** — see the [OTP flow](#otp-flow) table above.
- **Account enumeration (admin login)** — an unknown email and a correct-email-wrong-password
  both return the exact same `401 INVALID_CREDENTIALS` (status, code, _and_ message), and a
  bcrypt comparison against a dummy hash runs even when the email doesn't exist, so response
  timing doesn't leak which case occurred either.
- **Request flooding** — a coarse per-IP Redis-backed limiter wraps every `/auth/*` route, on
  top of the OTP-specific phone/IP limits and a per-email/IP limiter on admin login.
- **Unauthorized role access** — see [Authorization](#authorization).
- **Token theft / session abuse** — refresh-token rotation with reuse detection; revocation
  checked live, not just at expiry; tokens are opaque+hashed at rest, never logged.
- **Injection** — every query uses parameterized `pg` calls (no string-built SQL).
- **Invalid input** — `zod` validation on every mutating endpoint.
- **CORS** — `cors` restricted to the explicit `CORS_ORIGINS` allow-list; no wildcard.
- **Secrets in logs/responses** — OTP codes, password hashes, and token values are never
  logged (only bcrypt/SHA-256 hashes or high-level event metadata reach `auth_events`), and
  unexpected 500 errors return a generic message to the client while the real error goes to
  the server log only — application error messages (`HttpError`) are the only ones ever
  echoed back, and none of those ever contain a secret.

## Environment variables

See `apps/api/.env.example` (backend) and `apps/admin/.env.example` (admin app) for the full,
commented list. The ones specific to this phase:

| Variable                                                    | App        | Notes                                                                                |
| ----------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------ |
| `JWT_ACCESS_SECRET`                                         | api, admin | ≥32 chars, rejected if it looks like a placeholder. Must match between the two apps. |
| `ACCESS_TOKEN_TTL_MINUTES`                                  | api        | Default 15                                                                           |
| `REFRESH_TOKEN_TTL_DAYS`                                    | api        | Default 30                                                                           |
| `OTP_LENGTH` / `OTP_TTL_MINUTES` / `OTP_MAX_ATTEMPTS`       | api        | OTP shape and lifetime                                                               |
| `OTP_RESEND_COOLDOWN_SECONDS`                               | api        | Minimum gap between OTP requests for one phone                                       |
| `OTP_REQUEST_MAX_PER_WINDOW` / `OTP_REQUEST_WINDOW_MINUTES` | api        | Per-phone request rate limit                                                         |
| `OTP_IP_REQUEST_MAX_PER_WINDOW`                             | api        | Per-IP request rate limit                                                            |
| `OTP_DEV_MODE`                                              | api        | **Development only** — see above. Refused in production.                             |
| `SMS_PROVIDER` / `SMS_HTTP_ENDPOINT` / `SMS_HTTP_API_KEY`   | api        | SMS provider selection                                                               |
| `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD`                  | api        | **Development only** — see [Admin accounts](#admin-accounts).                        |
| `API_BASE_URL`                                              | admin      | Where the admin app's server actions call the API                                    |

## Local testing

1. Start Postgres and Redis, then create dev + test databases (see the main
   [README](../README.md#getting-started) for the one-time setup).
2. `cp apps/api/.env.example apps/api/.env` and fill in `JWT_ACCESS_SECRET` (generate one with
   `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`); leave
   `OTP_DEV_MODE=true` and `SMS_PROVIDER=console` for local dev.
3. `pnpm --filter @yatri/api migrate:up`
4. `pnpm --filter @yatri/api seed:admin` (uses `ADMIN_SEED_EMAIL`/`ADMIN_SEED_PASSWORD` from
   `.env`)
5. `pnpm dev:api`, then `POST /api/v1/auth/request-otp` — the response's `devOtp` is the real
   code, no SMS needed.
6. **Automated tests**: `cp apps/api/.env.example apps/api/.env.test`, point its
   `DATABASE_URL` at a separate test database (e.g. `yatri_test`) and `REDIS_URL` at a
   different Redis DB index (e.g. `redis://localhost:6379/1`) so tests never touch your dev
   data, then `pnpm --filter @yatri/api migrate:test:up` and `pnpm --filter @yatri/api test`.
   The suite runs against a real Postgres + Redis (truncating tables between tests), not
   mocks — see `apps/api/src/test/`.
7. **Admin app locally**: `cp apps/admin/.env.example apps/admin/.env.local`, set
   `JWT_ACCESS_SECRET` to the _same_ value as `apps/api/.env`, then `pnpm dev:admin`.
