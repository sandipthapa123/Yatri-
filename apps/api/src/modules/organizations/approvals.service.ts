import {
  ORG_NOTIFICATION_TYPES,
  ORG_APPROVAL_TRANSITIONS,
  orgRoleHolds,
  type DecideApprovalBody,
  type OrgApprovalInfo,
  type OrgBookingBody,
  type TripRequestBody,
} from '@yatri/types';

import { recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { log } from '../../lib/logger';
import { HttpError } from '../../middleware/errorHandler';
import { assertOrgActive, loadContext, type OrgContext } from './access';
import { approvalInfo } from './approval-view';
import { prepareBooking, refuse, startBusinessRide, tellRider, orgName } from './booking.service';
import { notifyPerson } from './org-notify';

/**
 * Deciding a booking that needs approval. The request waits as a record (it is not a ride yet: a ride would
 * start dispatch); approving it creates the ride through the same path as any business booking, with the policy
 * and the limits applied again at that moment, because things may have changed while it waited.
 *
 * The moves are the table in @yatri/types (ORG_APPROVAL_TRANSITIONS) and each is a single guarded update, so two
 * approvers cannot both decide it, and a request that was approved but never became a ride (a crash between the
 * two steps) is put back by the sweep rather than lost.
 */
interface Claimed {
  id: string;
  requested_by: string | null;
  passenger_id: string;
  request: TripRequestBody;
  cost_center_id: string | null;
  purpose: string | null;
  fare_estimate_npr: number;
}

async function tellRequester(
  approvalId: string,
  orgId: string,
  requestedBy: string | null,
  text: string,
) {
  if (!requestedBy) return;
  await notifyPerson(
    requestedBy,
    ORG_NOTIFICATION_TYPES.APPROVAL_DECIDED,
    `${await orgName(orgId)}: ${text}`,
    { organizationId: orgId, approvalId },
  );
}

export async function decideApproval(
  ctx: OrgContext,
  id: string,
  body: DecideApprovalBody,
): Promise<OrgApprovalInfo> {
  assertOrgActive(ctx);
  if (!orgRoleHolds(ctx.role, 'RIDES_APPROVE')) {
    throw new HttpError(403, 'FORBIDDEN', 'Your role in this organization does not allow this.');
  }
  const note = body.note?.trim() || null;
  const pending = await query<{ requested_by: string | null }>(
    `SELECT requested_by FROM organization_approvals WHERE id = $1 AND organization_id = $2`,
    [id, ctx.orgId],
  );
  if (!pending.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Approval not found.');
  if (pending.rows[0].requested_by === ctx.userId) {
    throw new HttpError(403, 'OWN_REQUEST', 'You cannot decide a request you made yourself.');
  }

  if (body.decision === 'DECLINE') {
    const r = await query<{ requested_by: string | null }>(
      `UPDATE organization_approvals SET status = 'DECLINED', decided_by = $3, decided_at = now(), decision_note = $4
       WHERE id = $1 AND organization_id = $2 AND status = 'PENDING' RETURNING requested_by`,
      [id, ctx.orgId, ctx.userId, note],
    );
    if (!r.rows[0]) throw notPending();
    await audit(ctx, id, 'DECLINED', note);
    await tellRequester(id, ctx.orgId, r.rows[0].requested_by, 'your ride request was declined.');
    return approvalInfo(id, ctx);
  }

  // APPROVE: claim it first (one winner), then create the ride; put it back if the ride cannot be created.
  const claimed = await query<Claimed>(
    `UPDATE organization_approvals SET status = 'APPROVED', decided_by = $3, decided_at = now(), decision_note = $4
     WHERE id = $1 AND organization_id = $2 AND status = 'PENDING' AND expires_at > now()
     RETURNING id, requested_by, passenger_id, request, cost_center_id, purpose, fare_estimate_npr`,
    [id, ctx.orgId, ctx.userId, note],
  );
  const a = claimed.rows[0];
  if (!a) {
    await query(
      `UPDATE organization_approvals SET status = 'EXPIRED' WHERE id = $1 AND status = 'PENDING' AND expires_at <= now()`,
      [id],
    );
    throw notPending();
  }
  try {
    const rider = await loadContext(ctx.orgId, a.passenger_id);
    if (!rider) {
      await query(
        `UPDATE organization_approvals SET status = 'CANCELLED', decision_note = 'The rider is no longer a member.' WHERE id = $1`,
        [id],
      );
      throw new HttpError(
        409,
        'PASSENGER_NOT_MEMBER',
        'The rider is no longer a member of this organization.',
      );
    }
    const requester = a.requested_by ? await loadContext(ctx.orgId, a.requested_by) : null;
    const booking: OrgBookingBody = {
      ...a.request,
      passengerId: a.passenger_id,
      costCenterId: a.cost_center_id,
      purpose: a.purpose,
    };
    const prepared = await prepareBooking(
      ctx.orgId,
      a.requested_by ?? ctx.userId,
      requester?.role ?? 'MEMBER',
      booking,
      a.passenger_id,
    );
    if (prepared.decision.outcome === 'DENIED') refuse(prepared.decision);
    // The approver saw one fare. A dearer one needs a fresh look; a cheaper or equal one is fine.
    if (prepared.fareNpr > a.fare_estimate_npr) {
      throw new HttpError(
        409,
        'FARE_CHANGED',
        `The fare is now NPR ${prepared.fareNpr}, up from NPR ${a.fare_estimate_npr}. Please check it and approve again.`,
      ).withDetails({ fare: { totalNpr: prepared.fareNpr } });
    }
    const tripId = await startBusinessRide(
      ctx.orgId,
      a.requested_by ?? ctx.userId,
      prepared,
      prepared.request,
    );
    await query('UPDATE organization_approvals SET trip_id = $2 WHERE id = $1', [id, tripId]);
    await audit(ctx, id, 'APPROVED', note, { tripId });
    await tellRequester(
      id,
      ctx.orgId,
      a.requested_by,
      'your ride request was approved and the ride was requested.',
    );
    if (a.passenger_id !== a.requested_by) await tellRider(ctx.orgId, a.passenger_id, tripId);
    return approvalInfo(id, ctx);
  } catch (err) {
    // Still waiting: the approver can try again, decline it, or it expires. (Not for a rider who left: that is final.)
    await query(
      `UPDATE organization_approvals SET status = 'PENDING', decided_by = NULL, decided_at = NULL, decision_note = NULL
       WHERE id = $1 AND status = 'APPROVED' AND trip_id IS NULL`,
      [id],
    );
    // A fare that moved while it waited is recorded, so the next look shows what is being approved.
    const fare = (err as { details?: { fare?: { totalNpr?: number } } }).details?.fare?.totalNpr;
    if (typeof fare === 'number') {
      await query('UPDATE organization_approvals SET fare_estimate_npr = $2 WHERE id = $1', [
        id,
        fare,
      ]);
    }
    throw err;
  }
}

const notPending = () =>
  new HttpError(409, 'NOT_PENDING', 'This request is no longer waiting for a decision.');

async function audit(
  ctx: OrgContext,
  approvalId: string,
  to: (typeof ORG_APPROVAL_TRANSITIONS.PENDING)[number],
  note: string | null,
  extra: Record<string, unknown> = {},
) {
  await recordAudit({
    actorId: ctx.userId,
    actorRole: 'PASSENGER',
    action: `ORG_APPROVAL_${to}`,
    subjectType: 'organization',
    subjectIds: [ctx.orgId],
    detail: { approvalId, note, ...extra },
  });
}

/** The person who asked withdraws their own waiting request. */
export async function cancelApproval(ctx: OrgContext, id: string): Promise<OrgApprovalInfo> {
  const r = await query(
    `UPDATE organization_approvals SET status = 'CANCELLED', decided_at = now()
     WHERE id = $1 AND organization_id = $2 AND requested_by = $3 AND status = 'PENDING'`,
    [id, ctx.orgId, ctx.userId],
  );
  if (!r.rowCount) {
    const exists = await query(
      'SELECT 1 FROM organization_approvals WHERE id = $1 AND organization_id = $2',
      [id, ctx.orgId],
    );
    throw exists.rowCount ? notPending() : new HttpError(404, 'NOT_FOUND', 'Approval not found.');
  }
  await audit(ctx, id, 'CANCELLED', null);
  return approvalInfo(id, ctx);
}

/**
 * Housekeeping, run by the sweep: requests nobody decided in time expire (and the person who asked is told),
 * and a request that was approved but never became a ride (the process died between the two steps) goes back
 * to waiting instead of being lost.
 */
export async function sweepApprovals(): Promise<{ expired: number; restored: number }> {
  const expired = await query<{ id: string; organization_id: string; requested_by: string | null }>(
    `UPDATE organization_approvals SET status = 'EXPIRED'
     WHERE status = 'PENDING' AND expires_at <= now() RETURNING id, organization_id, requested_by`,
  );
  for (const e of expired.rows) {
    await tellRequester(
      e.id,
      e.organization_id,
      e.requested_by,
      'your ride request expired before anyone decided it.',
    ).catch((err) => log.error('Approval expiry notice failed', err));
  }
  const restored = await query(
    `UPDATE organization_approvals SET status = 'PENDING', decided_by = NULL, decided_at = NULL
     WHERE status = 'APPROVED' AND trip_id IS NULL AND decided_at < now() - interval '2 minutes'`,
  );
  return { expired: expired.rows.length, restored: restored.rowCount ?? 0 };
}
