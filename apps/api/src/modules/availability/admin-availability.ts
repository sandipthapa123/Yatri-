import type { Request, Response } from 'express';
import type {
  AdminDriverAvailabilityResponse,
  AdminDriverAvailabilityRow,
  ApiResponse,
  DriverAvailabilityState,
  LocationFreshness,
} from '@yatri/types';

import { query } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';
import { availabilityConfig } from './availability.service';

export const LOCATION_VIEW_PERMISSION = 'DRIVER_LOCATION_VIEW';

async function hasPermission(adminId: string, permission: string): Promise<boolean> {
  const r = await query<{ ok: boolean }>(
    "SELECT $2 = ANY(admin_permissions) AS ok FROM users WHERE id = $1 AND role = 'ADMIN'",
    [adminId, permission],
  );
  return r.rows[0]?.ok === true;
}

interface Row {
  id: string;
  full_name: string | null;
  vstatus: string;
  state: DriverAvailabilityState;
  latitude: string | null;
  longitude: string | null;
  accuracy_meters: number | null;
  recorded_at: Date | null;
  freshness: LocationFreshness;
}

const FRESHNESS_SQL = `(CASE
  WHEN l.recorded_at IS NULL THEN 'none'
  WHEN l.recorded_at >= now() - ($5::int * interval '1 second') THEN 'fresh'
  ELSE 'stale' END)`;

/**
 * Operational driver list. Server-side filtering and pagination (never the whole
 * fleet in the browser). Every admin may see who is online and how fresh their
 * location is; exact coordinates are returned ONLY to admins holding
 * DRIVER_LOCATION_VIEW, and each such disclosure is written to the audit trail.
 * Freshness here is as of the last persisted sample (persisted at most every
 * DRIVER_LOCATION_PERSIST_SECONDS), so the threshold gets that much slack.
 */
export async function listAvailabilityHandler(
  req: Request,
  res: Response<ApiResponse<AdminDriverAvailabilityResponse>>,
) {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  const q = req.validatedQuery as {
    state?: string;
    freshness?: string;
    verification?: string;
    search?: string;
    page: number;
    pageSize: number;
  };
  const cfg = availabilityConfig();
  const canViewLocation = await hasPermission(req.auth.userId, LOCATION_VIEW_PERMISSION);
  const slack = cfg.freshSeconds + cfg.persistSeconds;

  const from = `
    FROM users u
    JOIN driver_profiles dp ON dp.user_id = u.id
    LEFT JOIN driver_availability a ON a.driver_id = u.id
    LEFT JOIN driver_last_locations l ON l.driver_id = u.id
    WHERE u.role = 'DRIVER'
      AND ($1::text IS NULL OR COALESCE(a.state, 'OFFLINE') = $1)
      AND ($2::text IS NULL OR dp.status::text = $2)
      AND ($3::text IS NULL OR u.full_name ILIKE '%' || $3 || '%' OR u.phone_number ILIKE '%' || $3 || '%')
      AND ($4::text IS NULL OR ${FRESHNESS_SQL} = $4)`;
  const params = [
    q.state ?? null,
    q.verification ?? null,
    q.search || null,
    q.freshness ?? null,
    slack,
  ];

  const [rows, count] = await Promise.all([
    query<Row>(
      `SELECT u.id, u.full_name, dp.status::text AS vstatus, COALESCE(a.state, 'OFFLINE') AS state,
              l.latitude, l.longitude, l.accuracy_meters, l.recorded_at,
              ${FRESHNESS_SQL} AS freshness
       ${from}
       ORDER BY (COALESCE(a.state, 'OFFLINE') = 'ONLINE') DESC, l.recorded_at DESC NULLS LAST, u.created_at DESC
       LIMIT $6 OFFSET $7`,
      [...params, q.pageSize, (q.page - 1) * q.pageSize],
    ),
    query<{ n: string }>(`SELECT count(*)::text AS n ${from}`, params),
  ]);

  const items: AdminDriverAvailabilityRow[] = rows.rows.map((r) => ({
    driverId: r.id,
    name: r.full_name,
    verificationStatus: r.vstatus,
    availabilityState: r.state,
    online: r.state === 'ONLINE',
    lastLocationAt: r.recorded_at?.toISOString() ?? null,
    locationFreshness: r.freshness,
    location:
      canViewLocation && r.latitude !== null && r.longitude !== null
        ? {
            latitude: Number(r.latitude),
            longitude: Number(r.longitude),
            accuracyMeters: r.accuracy_meters,
          }
        : null,
  }));

  if (canViewLocation) {
    const disclosed = items.filter((i) => i.location).map((i) => i.driverId);
    if (disclosed.length > 0) {
      await query(
        `INSERT INTO driver_availability_events (driver_id, actor_id, event_type)
         SELECT d, $2, 'ADMIN_LOCATION_VIEW' FROM unnest($1::uuid[]) AS d`,
        [disclosed, req.auth.userId],
      );
    }
  }

  res.json({
    success: true,
    data: { items, total: Number(count.rows[0]?.n ?? 0), canViewLocation },
  });
}
