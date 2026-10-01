# Phase 18: business and institutional transport

Phase 18 lets an organization (a company, school or hospital) have riders book and pay for rides together:
members with roles, rides booked for employees, a policy that every booking is checked against, approvals,
cost-centre tags, a monthly statement, and reports. It is built on the existing ride, pricing, dispatch, payment,
notification, support, RBAC and audit systems. There is **no** separate corporate ride model, ledger, pricing or
permission system; every rule is defined once (the owners are in the table in
[`ARCHITECTURE.md`](ARCHITECTURE.md)), and the backend stays authoritative.

## What was built

| Brief                          | Where it is                                                                                                                                                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Business accounts, profiles    | `organizations` (name, legal name, billing contact, status), `organizations/organizations.service.ts`. A rider account creates one and becomes its owner; the platform can only suspend or reactivate it                                                        |
| Organization roles             | `ORG_ROLES` OWNER, ADMIN, BOOKER, MEMBER, VIEWER and the one table `ORG_ROLE_PERMISSIONS` in `@yatri/types` `organization.ts`; read from the database on every request (`organizations/access.ts`). **Separate from platform roles**: see below                 |
| Employee and member management | `organization_members`: invite by phone, accept, change role, default cost centre, remove, leave. `assignableOrgRoles` / `canManageOrgMember` say who may change whom; the last owner is protected under a lock                                                 |
| Corporate booking, on behalf   | `POST /organizations/:id/bookings`: an ordinary ride through `quoteTrip` / `requestTrip` / `requestAndOffer`. `trips.passenger_id` is the rider, the new `trips.booked_by` is the booker; they differ exactly when someone books for someone else               |
| Policy                         | `organization_policies` (one row per organization): vehicle types, service zones, per-ride, per-rider and monthly limits, approval threshold, member self-booking, cost centre required, payment mode. Applied only by `evaluateBooking` (`@yatri/types`)       |
| Approval workflow              | `organization_approvals`: a booking that needs approval waits as a request (it is not a ride yet, so nothing is dispatched). Approving creates the ride through the same path, with the policy and limits applied again at that moment                          |
| Spending limits                | Checked before booking and again inside the ride's own transaction under a lock on the organization (`BusinessRequest.guard`), so two simultaneous bookings cannot both pass a limit that only one fits under                                                   |
| Organization payment methods   | The policy's payment mode: `ON_ACCOUNT` (the ride's payment method is `ORGANIZATION`, billed on a statement) or `EMPLOYEE_CASH` (an ordinary cash ride, tagged for reports). `ORG_PAYMENT_MODE_METHOD` is the one mapping                                       |
| Corporate billing, statements  | The existing `trip_payments` is the authoritative record. A statement is a grouping of those payments (`trip_payments.statement_id`, one statement per payment, so a ride is never billed twice) with a status and dates; its total is always their sum         |
| Department / cost-centre tags  | `organization_cost_centers` (code, name, department); rides carry `cost_center_id` and `purpose`; reports and statements split by cost centre                                                                                                                   |
| Corporate ride history         | `organizations/history.service.ts`: who booked, who rode, where, the cost, the payment words, the statement. People without `RIDES_VIEW_ALL` see only rides they booked or rode in. No live position, route, phone number or chat                               |
| Usage reports                  | By month, cost centre, rider and vehicle type over the platform's one date range (`resolveRange`); the cost is `ORG_TRIP_COST_SQL`, the same expression the monthly limits use                                                                                  |
| Organization administration UI | Passenger app: **Business rides** (`packages/mobile-business`): organizations and invitations, rides, approvals, members, rules and cost centres, statements, usage, and "who pays" while requesting a ride. Platform admin console: **Business accounts**      |
| Notifications                  | `ORG_NOTIFICATION_TYPES` through the one notification service: invited, role changed, removed, ride booked for you, approval needed and decided, statement issued and paid, suspended and reactivated. None carries a fare breakdown, a place or a phone number |
| Audit                          | Every change is in the one audit log under the subject type `organization`: created, updated, members, policy, cost centres, bookings, approvals, statements issued, paid or cancelled, suspension. The organization's owners and administrators can read it    |

## Organization roles are not platform roles

A person is a platform PASSENGER (or a platform administrator with permissions of their own, `RISK_VIEW` and the
others). Inside an organization they hold one organization role, which says only what they may do for **that**
organization. An organization role grants no platform permission; a platform administrator is not thereby a member
of any organization (the business endpoints are for rider accounts); and the platform's new `ORGANIZATIONS_VIEW` /
`ORGANIZATIONS_MANAGE` permissions let staff see an organization, suspend or reactivate it and settle its
statements, but never change its members, policy or rides. A person who is not a member is told the organization
does not exist (404), so someone else's organization is not revealed.

## Booker and passenger stay different

The ride's only participants are still the rider and the driver (`requireParticipant` is unchanged). A booker who
books for an employee is **not** a participant: they cannot open the ride, see its live position, chat or call. They
see it in the organization's history (with the address, cost and status), and the rider is told, sees it in their own
app as a business ride (`TripSummary.business`), and is the only one who can cancel it.

## Billing, honestly

- Yatri has **no ledger or invoice system**; the authoritative financial record is `trip_payments`. A billed ride's
  payment method is `ORGANIZATION` and it stays `PENDING`. The driver has nothing to collect (the cash confirmation is
  refused with 409 and not offered in the app).
- Statements are issued for a finished month (automatically in the first days of the month, and on demand by staff).
  Issuing again does nothing new; a late ride rolls into the next statement, never into an issued one.
- **Yatri takes no money here.** "Paid" is a platform administrator recording that the organization's bank transfer
  arrived: the amount must equal the statement total exactly, and the statement and all its payments change in one
  transaction. Recording it again is harmless; a different reference is refused. A cancelled statement frees its rides
  to be billed again.
- **There is no driver payout system.** For an organization-billed ride the driver is owed the fare by the platform, and
  settling that is outside this system, as with incentive awards. Phase 18 does not invent a payout system.
- A ride billed to an organization is **not refunded to the rider** (the refund request is refused with 409, support
  settles it with the organization). Statement adjustments and credit notes are not built.

## Decisions worth knowing

- **Approval is a record, not a ride state.** A ride in a "waiting" state would start dispatch or need a new trip
  status everywhere. The request waits in `organization_approvals`, expires (`ORG_APPROVAL_TTL_MINUTES`), and a request
  that was approved but never became a ride (a crash between the two steps) is restored by the sweep.
- **Those who approve are not asked to approve their own rides**, but are held to every limit, and nobody can decide a
  request they made.
- **Inviting never reveals whether a number has an account**: the answer is the same, and nobody joins without accepting.
- **A suspended organization** cannot start anything new (bookings, approvals); its rides under way, records and
  statements are unchanged and still readable.
- **A sole owner cannot delete their account** (`deletionBlockers`); an organization always has an owner.

## Not done, honestly

- No card, wallet, bank or mobile-money payment: organizations pay by transfer, recorded by an administrator.
- No scheduled or recurring bookings, shared or pooled rides, or booking from a web portal: business features are in the
  passenger app and the platform console only.
- No export (PDF or CSV) of a statement or report; they are read in the app and the console.
- Statement adjustments, credit notes and partial payments are not built.
- Nothing here was tried on a real device, with NVDA, TalkBack or VoiceOver; only the automated tests, the static
  accessibility checks and the manual checklist (section Q of `ACCESSIBILITY_TESTING.md`) exist.
