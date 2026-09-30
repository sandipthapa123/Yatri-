import type {
  AdminIncidentDetail,
  AdminIncidentRow,
  AdminLowRating,
  AdminSosDetail,
  AdminSosRow,
  ApiResponse,
  IncidentInfo,
  SosInfo,
} from '@yatri/types';
import type { Request, Response } from 'express';
import type { z } from 'zod';

import { auditTrail, recordAudit } from '../../lib/audit';
import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import {
  addIncidentNote,
  changeIncidentStatus,
  incidentDetail,
  listIncidents,
} from '../safety/incidents.service';
import type {
  adminIncidentsQuerySchema,
  adminSosQuerySchema,
  lowRatingsQuerySchema,
} from '../safety/safety.validators';
import { listSos, sosDetail, toSosInfo, transitionSos } from '../safety/sos.service';
import { hasPermission } from './permissions';

/**
 * The safety team's endpoints. Everything needs SAFETY_REVIEW (holding the admin role is not enough),
 * every read of an alert or a report is audited, and every change goes through the same service the
 * rest of the system uses — no admin-only path around a state machine.
 */
async function safetyAdmin(req: Request): Promise<string> {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  if (!(await hasPermission(req.auth.userId, 'SAFETY_REVIEW'))) {
    throw new HttpError(403, 'FORBIDDEN', 'You do not have permission to handle safety alerts.');
  }
  return req.auth.userId;
}
const idParam = (req: Request) => {
  const v = req.params.id;
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
};

// ---------------------------------------------------------------- SOS

export async function listSosHandler(
  req: Request,
  res: Response<ApiResponse<{ items: AdminSosRow[]; total: number }>>,
) {
  await safetyAdmin(req);
  res.json({
    success: true,
    data: await listSos(req.validatedQuery as z.infer<typeof adminSosQuerySchema>),
  });
}

export async function sosDetailHandler(req: Request, res: Response<ApiResponse<AdminSosDetail>>) {
  const admin = await safetyAdmin(req);
  const detail = await sosDetail(idParam(req));
  // The recorded position is sensitive: reading it is written to the audit log.
  await recordAudit({
    actorId: admin,
    actorRole: 'ADMIN',
    action: 'VIEW_SOS',
    subjectType: 'sos',
    subjectIds: [detail.id],
    detail: { locationShown: detail.location !== null },
  });
  res.json({ success: true, data: { ...detail, audit: await auditTrail('sos', detail.id) } });
}

export async function acknowledgeSosHandler(req: Request, res: Response<ApiResponse<SosInfo>>) {
  const admin = await safetyAdmin(req);
  const row = await transitionSos(
    idParam(req),
    'ACKNOWLEDGED',
    { id: admin, role: 'ADMIN' },
    (req.body as { note?: string }).note,
  );
  res.json({ success: true, data: toSosInfo(row) });
}

export async function resolveSosHandler(req: Request, res: Response<ApiResponse<SosInfo>>) {
  const admin = await safetyAdmin(req);
  const row = await transitionSos(
    idParam(req),
    'RESOLVED',
    { id: admin, role: 'ADMIN' },
    (req.body as { note: string }).note,
  );
  res.json({ success: true, data: toSosInfo(row) });
}

// ---------------------------------------------------------------- incidents

export async function listIncidentsHandler(
  req: Request,
  res: Response<ApiResponse<{ items: AdminIncidentRow[]; total: number }>>,
) {
  await safetyAdmin(req);
  res.json({
    success: true,
    data: await listIncidents(req.validatedQuery as z.infer<typeof adminIncidentsQuerySchema>),
  });
}

export async function incidentDetailHandler(
  req: Request,
  res: Response<ApiResponse<AdminIncidentDetail>>,
) {
  const admin = await safetyAdmin(req);
  const detail = await incidentDetail(idParam(req));
  await recordAudit({
    actorId: admin,
    actorRole: 'ADMIN',
    action: 'VIEW_INCIDENT',
    subjectType: 'incident',
    subjectIds: [detail.id],
  });
  res.json({ success: true, data: { ...detail, audit: await auditTrail('incident', detail.id) } });
}

export async function incidentStatusHandler(
  req: Request,
  res: Response<ApiResponse<IncidentInfo>>,
) {
  const admin = await safetyAdmin(req);
  const b = req.body as { status: IncidentInfo['status']; note?: string };
  res.json({
    success: true,
    data: await changeIncidentStatus(idParam(req), admin, b.status, b.note),
  });
}

export async function incidentNoteHandler(
  req: Request,
  res: Response<ApiResponse<{ added: true }>>,
) {
  const admin = await safetyAdmin(req);
  const b = req.body as { kind: 'NOTE' | 'ACTION'; body: string };
  await addIncidentNote(idParam(req), admin, b.kind, b.body);
  res.status(201).json({ success: true, data: { added: true } });
}

// ---------------------------------------------------------------- ratings that need a look

/** Low ratings with their written feedback — one of the signals the safety team watches. */
export async function lowRatingsHandler(
  req: Request,
  res: Response<ApiResponse<{ items: AdminLowRating[]; total: number }>>,
) {
  const admin = await safetyAdmin(req);
  const q = req.validatedQuery as z.infer<typeof lowRatingsQuerySchema>;
  const [rows, count] = await Promise.all([
    query<{
      trip_id: string;
      rater_role: 'PASSENGER' | 'DRIVER';
      stars: number;
      comment: string | null;
      created_at: Date;
    }>(
      `SELECT trip_id, rater_role, stars, comment, created_at FROM trip_ratings
       WHERE stars <= $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [q.maxStars, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: string }>('SELECT count(*)::text AS n FROM trip_ratings WHERE stars <= $1', [
      q.maxStars,
    ]),
  ]);
  await recordAudit({
    actorId: admin,
    actorRole: 'ADMIN',
    action: 'VIEW_LOW_RATINGS',
    subjectType: 'admin',
    subjectIds: [admin],
    detail: { maxStars: q.maxStars },
  });
  res.json({
    success: true,
    data: {
      total: Number(count.rows[0]?.n ?? 0),
      items: rows.rows.map((r) => ({
        tripId: r.trip_id,
        raterRole: r.rater_role,
        stars: r.stars,
        comment: r.comment,
        createdAt: r.created_at.toISOString(),
      })),
    },
  });
}
