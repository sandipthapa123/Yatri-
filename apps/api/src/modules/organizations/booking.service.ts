import {
  ORG_NOTIFICATION_TYPES,
  evaluateBooking,
  orgRoleHolds,
  type BookingDecision,
  type OrgBookingBody,
  type OrgBookingResult,
  type OrgPolicy,
  type OrgRole,
  type TripRequestBody,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { settingNumber } from '../settings/settings.service';
import { requestAndOffer } from '../dispatch/dispatch.service';
import { quoteTrip } from '../trips/trips.service';
import type { BusinessRequest } from '../trips/trips.repository';
import { assertOrgActive, loadContext, type OrgContext } from './access';
import { approvalInfo } from './approval-view';
import { membersWithRoles, notifyPerson } from './org-notify';
import { getPolicy } from './policy.service';
import { spentThisMonth } from './spend';

/**
 * Booking a ride for an organization, on behalf of an employee or for oneself. The ride is an ordinary ride
 * (trips.service `requestTrip`: the one pricing, zones, dispatch and payment systems); this adds the policy
 * (`evaluateBooking`, the one rule) and who-booked-for-whom:
 *   booker  = whoever makes the booking (`trips.booked_by`), needs RIDES_BOOK_SELF or RIDES_BOOK_FOR_OTHERS;
 *   rider   = the member the ride is for (`trips.passenger_id`), who is the ride's only participant.
 * The outcome is a ride, a refusal in words (nothing created), or a waiting approval (nothing dispatched yet).
 */
export interface PreparedBooking {
  passengerId: string;
  costCenterId: string | null;
  purpose: string | null;
  policy: OrgPolicy;
  bookerRole: OrgRole;
  request: TripRequestBody;
  fareNpr: number;
  decision: BookingDecision;
  facts: Omit<Parameters<typeof evaluateBooking>[0], 'spentThisMonthNpr'>;
}

export const requestOf = (b: OrgBookingBody): TripRequestBody => ({
  vehicleCategory: b.vehicleCategory,
  pickup: b.pickup,
  destination: b.destination,
  ...(b.confirmedTotalNpr !== undefined ? { confirmedTotalNpr: b.confirmedTotalNpr } : {}),
});

export function refuse(decision: BookingDecision): never {
  throw new HttpError(422, 'BOOKING_NOT_ALLOWED', decision.reasons.join(' ')).withDetails({
    reasons: decision.reasons,
  });
}

/** Validate who and what, price it, and apply the policy. Creates nothing. */
export async function prepareBooking(
  orgId: string,
  bookerId: string,
  bookerRole: OrgRole,
  body: OrgBookingBody,
  passengerId: string,
): Promise<PreparedBooking> {
  const forSelf = passengerId === bookerId;
  const rider = forSelf ? null : await loadContext(orgId, passengerId);
  if (!forSelf && !rider) {
    throw new HttpError(
      422,
      'PASSENGER_NOT_MEMBER',
      'That person is not a member of this organization.',
    );
  }
  let costCenterId = body.costCenterId ?? null;
  if (!costCenterId) {
    const d = await query<{ default_cost_center_id: string | null }>(
      `SELECT default_cost_center_id FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
      [orgId, passengerId],
    );
    costCenterId = d.rows[0]?.default_cost_center_id ?? null;
  }
  if (costCenterId) {
    const cc = await query(
      'SELECT 1 FROM organization_cost_centers WHERE id = $1 AND organization_id = $2 AND is_active',
      [costCenterId, orgId],
    );
    if (!cc.rowCount)
      throw new HttpError(400, 'UNKNOWN_COST_CENTER', 'That cost centre is not available.');
  }
  const request = requestOf(body);
  const quote = await quoteTrip(request);
  if (
    request.confirmedTotalNpr !== undefined &&
    request.confirmedTotalNpr !== quote.fare.totalNpr
  ) {
    throw new HttpError(
      409,
      'FARE_CHANGED',
      `The fare changed to NPR ${quote.fare.totalNpr}. Please check it and confirm again.`,
    ).withDetails({ fare: quote.fare });
  }
  const policy = await getPolicy(orgId);
  const facts = {
    policy,
    bookerRole,
    forSelf,
    categoryCode: body.vehicleCategory,
    fareNpr: quote.fare.totalNpr,
    pickupZoneIds: quote.pickupZones.map((z) => z.id),
    dropoffZoneIds: quote.dropoffZones.map((z) => z.id),
    costCenterId,
  };
  const spend = await spentThisMonth(orgId, passengerId);
  return {
    passengerId,
    costCenterId,
    purpose: body.purpose?.trim() || null,
    policy,
    bookerRole,
    request,
    fareNpr: quote.fare.totalNpr,
    facts,
    decision: evaluateBooking({ ...facts, spentThisMonthNpr: spend }),
  };
}

/**
 * Create the ride. The organization row is locked inside the ride's own transaction and the monthly limits are
 * checked again there, so two bookings at once cannot both pass a limit only one fits under.
 */
export async function startBusinessRide(
  orgId: string,
  bookerId: string,
  p: PreparedBooking,
  body: TripRequestBody,
): Promise<string> {
  const business: BusinessRequest = {
    organizationId: orgId,
    bookedBy: bookerId,
    costCenterId: p.costCenterId,
    purpose: p.purpose,
    guard: async (client) => {
      await client.query('SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE', [orgId]);
      const spend = await spentThisMonth(orgId, p.passengerId, client);
      const d = evaluateBooking({ ...p.facts, spentThisMonthNpr: spend });
      if (d.outcome === 'DENIED') refuse(d);
    },
  };
  const row = await requestAndOffer(
    p.passengerId,
    { ...body, confirmedTotalNpr: p.fareNpr },
    business,
  );
  return row.id;
}

export async function orgName(orgId: string): Promise<string> {
  const r = await query<{ name: string }>('SELECT name FROM organizations WHERE id = $1', [orgId]);
  return r.rows[0]?.name ?? 'your organization';
}

export async function bookRide(ctx: OrgContext, body: OrgBookingBody): Promise<OrgBookingResult> {
  assertOrgActive(ctx);
  const passengerId = body.passengerId ?? ctx.userId;
  const forSelf = passengerId === ctx.userId;
  if (!orgRoleHolds(ctx.role, forSelf ? 'RIDES_BOOK_SELF' : 'RIDES_BOOK_FOR_OTHERS')) {
    throw new HttpError(
      403,
      'FORBIDDEN',
      forSelf
        ? 'Your role in this organization does not allow booking rides.'
        : 'Your role in this organization does not allow booking rides for other people.',
    );
  }
  const p = await prepareBooking(ctx.orgId, ctx.userId, ctx.role, body, passengerId);
  if (p.decision.outcome === 'DENIED') refuse(p.decision);

  if (p.decision.outcome === 'NEEDS_APPROVAL') {
    const ins = await query<{ id: string }>(
      `INSERT INTO organization_approvals
         (organization_id, requested_by, passenger_id, request, vehicle_category, fare_estimate_npr, cost_center_id,
          purpose, reasons, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9::jsonb, now() + ($10::int * interval '1 minute'))
       RETURNING id`,
      [
        ctx.orgId,
        ctx.userId,
        passengerId,
        // What the rider confirmed is a price at that moment; the approver decides on the fare as it is then.
        JSON.stringify({ ...p.request, confirmedTotalNpr: undefined }),
        body.vehicleCategory,
        p.fareNpr,
        p.costCenterId,
        p.purpose,
        JSON.stringify(p.decision.reasons),
        settingNumber('ORG_APPROVAL_TTL_MINUTES'),
      ],
    );
    const id = ins.rows[0]?.id as string;
    await recordAudit({
      actorId: ctx.userId,
      actorRole: 'PASSENGER',
      action: 'ORG_APPROVAL_REQUESTED',
      subjectType: 'organization',
      subjectIds: [ctx.orgId],
      detail: { approvalId: id, fareNpr: p.fareNpr, forOther: !forSelf },
    });
    // The people who can decide are told something is waiting: no names, places or fares in the message.
    for (const approver of await membersWithRoles(ctx.orgId, ['OWNER', 'ADMIN'])) {
      if (approver === ctx.userId) continue;
      await notifyPerson(
        approver,
        ORG_NOTIFICATION_TYPES.APPROVAL_NEEDED,
        `${await orgName(ctx.orgId)}: a ride is waiting for your approval.`,
        { organizationId: ctx.orgId, approvalId: id },
      );
    }
    return {
      outcome: 'NEEDS_APPROVAL',
      tripId: null,
      approval: await approvalInfo(id, ctx),
      reasons: p.decision.reasons,
    };
  }

  const tripId = await startBusinessRide(ctx.orgId, ctx.userId, p, p.request);
  await recordAudit({
    actorId: ctx.userId,
    actorRole: 'PASSENGER',
    action: 'ORG_RIDE_BOOKED',
    subjectType: 'organization',
    subjectIds: [ctx.orgId],
    detail: { tripId, forOther: !forSelf, fareNpr: p.fareNpr },
  });
  if (!forSelf) await tellRider(ctx.orgId, passengerId, tripId);
  return { outcome: 'REQUESTED', tripId, approval: null, reasons: [] };
}

/** Someone else booked it: the rider is told, and from then on sees it in their own app like any ride. */
export async function tellRider(orgId: string, riderId: string, tripId: string): Promise<void> {
  await notifyPerson(
    riderId,
    ORG_NOTIFICATION_TYPES.RIDE_BOOKED_FOR_YOU,
    `${await orgName(orgId)} booked a ride for you. Open the app to follow it.`,
    { organizationId: orgId, tripId },
  );
}
