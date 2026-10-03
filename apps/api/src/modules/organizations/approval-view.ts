import { isoOrNull } from '../../lib/dates';
import {
  orgRoleHolds,
  type OrgApprovalInfo,
  type OrgApprovalStatus,
  type TripRequestBody,
} from '@yatri/types';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import type { OrgContext } from './access';

/** Reading approvals, for the people who decide them and the people who asked. The decisions are in approvals.service. */
interface Row {
  id: string;
  status: OrgApprovalStatus;
  requested_by: string | null;
  requested_by_name: string | null;
  passenger_id: string;
  passenger_name: string | null;
  request: TripRequestBody;
  vehicle_category: string;
  fare_estimate_npr: number;
  cost_center_name: string | null;
  purpose: string | null;
  reasons: string[];
  expires_at: Date;
  created_at: Date;
  decided_by_name: string | null;
  decided_at: Date | null;
  decision_note: string | null;
  trip_id: string | null;
}

const SELECT = `SELECT a.id, a.status, a.requested_by, rb.full_name AS requested_by_name, a.passenger_id,
       p.full_name AS passenger_name, a.request, a.vehicle_category, a.fare_estimate_npr,
       cc.name AS cost_center_name, a.purpose, a.reasons, a.expires_at, a.created_at,
       db.full_name AS decided_by_name, a.decided_at, a.decision_note, a.trip_id
  FROM organization_approvals a
  LEFT JOIN users rb ON rb.id = a.requested_by
  JOIN users p ON p.id = a.passenger_id
  LEFT JOIN users db ON db.id = a.decided_by
  LEFT JOIN organization_cost_centers cc ON cc.id = a.cost_center_id`;

const toInfo = (r: Row, ctx: OrgContext): OrgApprovalInfo => {
  const pending = r.status === 'PENDING' && r.expires_at.getTime() > Date.now();
  return {
    id: r.id,
    status: r.status,
    requestedByName: r.requested_by_name,
    passengerName: r.passenger_name,
    pickupAddress: r.request.pickup.address,
    destinationAddress: r.request.destination.address,
    vehicleCategory: r.vehicle_category,
    fareNpr: r.fare_estimate_npr,
    costCenterName: r.cost_center_name,
    purpose: r.purpose,
    reasons: r.reasons,
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    decidedByName: r.decided_by_name,
    decidedAt: isoOrNull(r.decided_at),
    decisionNote: r.decision_note,
    tripId: r.trip_id,
    canDecide: pending && orgRoleHolds(ctx.role, 'RIDES_APPROVE') && r.requested_by !== ctx.userId,
    canCancel: pending && r.requested_by === ctx.userId,
  };
};

export async function approvalInfo(id: string, ctx: OrgContext): Promise<OrgApprovalInfo> {
  const r = await query<Row>(`${SELECT} WHERE a.id = $1 AND a.organization_id = $2`, [
    id,
    ctx.orgId,
  ]);
  if (!r.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Approval not found.');
  return toInfo(r.rows[0], ctx);
}

/** Approvers see every request; everyone else sees only the ones they asked for or that are for them. */
export async function listApprovals(
  ctx: OrgContext,
  status?: OrgApprovalStatus,
): Promise<OrgApprovalInfo[]> {
  const all = orgRoleHolds(ctx.role, 'RIDES_APPROVE');
  const r = await query<Row>(
    `${SELECT} WHERE a.organization_id = $1 AND ($2::text IS NULL OR a.status = $2)
       AND ($3::boolean OR a.requested_by = $4 OR a.passenger_id = $4)
     ORDER BY (a.status = 'PENDING') DESC, a.created_at DESC LIMIT 100`,
    [ctx.orgId, status ?? null, all, ctx.userId],
  );
  return r.rows.map((x) => toInfo(x, ctx));
}
