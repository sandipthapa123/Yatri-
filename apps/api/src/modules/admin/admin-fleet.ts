import {
  EXPIRY_KINDS,
  EXPIRY_STATES,
  INSPECTION_RESULTS,
  OPERATIONAL_STATES,
  SERVICE_NOTE_MAX,
  SERVICE_STATUSES,
  VEHICLE_LIFECYCLE_STATES,
  type AdminFleetBody,
  type AdminFleetVehicleBody,
  type AdminInspectionBody,
  type AdminLifecycleBody,
  type AdminMaintenanceCompleteBody,
  type AdminMaintenanceStartBody,
  type AdminOperationalBody,
  type AdminServiceLogBody,
  type AdminUnassignBody,
  type AdminVehicleAssignBody,
  type ApiResponse,
  type AuditEntry,
  type ExpiryItem,
  type FleetDetail,
  type FleetDriverDetail,
  type FleetDriverRow,
  type FleetInfo,
  type FleetVehicleDetail,
  type FleetVehicleRow,
  type ServiceRecordInfo,
} from '@yatri/types';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { recentAudit } from '../../lib/audit';
import { HttpError } from '../../middleware/errorHandler';
import { requireParam } from '../../lib/params';
import { listActiveCategories } from '../pricing/categories';
import { expiryItems } from '../fleet/expiry.service';
import {
  createFleet,
  fleetDetail,
  listFleets,
  setDriverFleet,
  updateFleet,
} from '../fleet/fleets.service';
import { runFleetMonitor, type MonitorResult } from '../fleet/monitor';
import {
  fleetDriverDetail,
  listFleetDrivers,
  setOperationalStatus,
} from '../fleet/operational.service';
import {
  completeMaintenance,
  listAllServiceRecords,
  logService,
  recordInspection,
  startMaintenance,
} from '../fleet/service-records.service';
import {
  assignVehicle,
  changeVehicleLifecycle,
  createFleetVehicle,
  fleetVehicleDetail,
  listFleetVehicles,
  unassignVehicle,
} from '../fleet/vehicles.service';

/** Handlers for the fleet workspace. Thin calls into the fleet services; permissions are named on the routes. */
const adminId = (req: Request) => {
  if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Authentication required.');
  return req.auth.userId;
};
const idParam = (req: Request) => requireParam(req, 'id');
type Res<T> = Response<ApiResponse<T>>;

const reason = z.string().trim().min(3).max(300);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-10-31.');
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const uuid = z.string().uuid();

export const fleetVehiclesQuerySchema = z.object({
  fleetId: uuid.optional(),
  lifecycle: z.enum(VEHICLE_LIFECYCLE_STATES).optional(),
  assigned: z.enum(['yes', 'no']).optional(),
  search: z.string().trim().max(100).optional(),
  page,
  pageSize,
});
export const fleetDriversQuerySchema = z.object({
  fleetId: uuid.optional(),
  operational: z.enum(OPERATIONAL_STATES).optional(),
  search: z.string().trim().max(100).optional(),
  page,
  pageSize,
});
export const expiringQuerySchema = z.object({
  state: z.enum(EXPIRY_STATES).optional(),
  kind: z.enum(EXPIRY_KINDS).optional(),
  fleetId: uuid.optional(),
});
export const serviceRecordsQuerySchema = z.object({
  status: z.enum(SERVICE_STATUSES).optional(),
  page,
  pageSize,
});
export const fleetHistoryQuerySchema = z.object({ page, pageSize });

export const lifecycleSchema = z.object({ to: z.enum(VEHICLE_LIFECYCLE_STATES), reason }).strict();
export const assignSchema = z.object({ driverId: uuid }).strict();
export const unassignSchema = z.object({ reason }).strict();
export const operationalSchema = z
  .object({
    to: z.enum(OPERATIONAL_STATES),
    reason,
    until: z.string().datetime().nullable().optional(),
  })
  .strict();
export const driverFleetSchema = z.object({ fleetId: uuid.nullable(), reason }).strict();
export const fleetVehicleSchema = z
  .object({
    fleetId: uuid.nullable(),
    categoryId: uuid,
    make: z.string().trim().min(1).max(60),
    model: z.string().trim().min(1).max(60),
    year: z.number().int().min(1970).max(2100),
    color: z.string().trim().min(1).max(40),
    registrationNumber: z.string().trim().min(2).max(30),
    registrationExpiryDate: date.nullable().optional(),
    insuranceExpiryDate: date.nullable().optional(),
  })
  .strict();
const notes = z.string().trim().max(SERVICE_NOTE_MAX).optional();
export const maintenanceStartSchema = z.object({ notes }).strict();
export const maintenanceCompleteSchema = z
  .object({
    performedOn: date,
    nextDueOn: date.nullable().optional(),
    notes,
    returnTo: z.enum(['ACTIVE', 'INACTIVE']),
  })
  .strict();
export const inspectionSchema = z
  .object({
    performedOn: date,
    result: z.enum(INSPECTION_RESULTS),
    nextDueOn: date.nullable().optional(),
    notes,
  })
  .strict();
export const serviceLogSchema = z
  .object({ performedOn: date, nextDueOn: date.nullable().optional(), notes })
  .strict();

export async function listFleetsHandler(_req: Request, res: Res<FleetInfo[]>) {
  res.json({ success: true, data: await listFleets() });
}
export async function fleetDetailHandler(req: Request, res: Res<FleetDetail>) {
  res.json({ success: true, data: await fleetDetail(idParam(req)) });
}
export async function createFleetHandler(req: Request, res: Res<FleetDetail>) {
  res
    .status(201)
    .json({ success: true, data: await createFleet(req.body as AdminFleetBody, adminId(req)) });
}
export async function updateFleetHandler(req: Request, res: Res<FleetDetail>) {
  res.json({
    success: true,
    data: await updateFleet(idParam(req), req.body as AdminFleetBody, adminId(req)),
  });
}
export async function fleetOptionsHandler(
  _req: Request,
  res: Res<{
    fleets: Array<{ id: string; name: string }>;
    categories: Array<{ id: string; label: string }>;
  }>,
) {
  const [fleets, categories] = await Promise.all([listFleets(), listActiveCategories()]);
  res.json({
    success: true,
    data: {
      fleets: fleets.map((f) => ({ id: f.id, name: f.name })),
      categories: categories.map((c) => ({ id: c.id, label: c.label })),
    },
  });
}
export async function listFleetVehiclesHandler(
  req: Request,
  res: Res<{ items: FleetVehicleRow[]; total: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof fleetVehiclesQuerySchema>;
  res.json({ success: true, data: await listFleetVehicles(q) });
}
export async function vehicleDetailHandler(req: Request, res: Res<FleetVehicleDetail>) {
  res.json({ success: true, data: await fleetVehicleDetail(idParam(req)) });
}
export async function createFleetVehicleHandler(req: Request, res: Res<FleetVehicleDetail>) {
  res.status(201).json({
    success: true,
    data: await createFleetVehicle(req.body as AdminFleetVehicleBody, adminId(req)),
  });
}
export async function lifecycleHandler(req: Request, res: Res<FleetVehicleDetail>) {
  const b = req.body as AdminLifecycleBody;
  res.json({
    success: true,
    data: await changeVehicleLifecycle(idParam(req), b.to, b.reason, adminId(req)),
  });
}
export async function assignHandler(req: Request, res: Res<FleetVehicleDetail>) {
  const b = req.body as AdminVehicleAssignBody;
  res.json({ success: true, data: await assignVehicle(idParam(req), b.driverId, adminId(req)) });
}
export async function unassignHandler(req: Request, res: Res<FleetVehicleDetail>) {
  const b = req.body as AdminUnassignBody;
  res.json({ success: true, data: await unassignVehicle(idParam(req), b.reason, adminId(req)) });
}
export async function listFleetDriversHandler(
  req: Request,
  res: Res<{ items: FleetDriverRow[]; total: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof fleetDriversQuerySchema>;
  res.json({ success: true, data: await listFleetDrivers(q) });
}
export async function driverDetailHandler(req: Request, res: Res<FleetDriverDetail>) {
  res.json({ success: true, data: await fleetDriverDetail(idParam(req)) });
}
export async function operationalHandler(req: Request, res: Res<FleetDriverDetail>) {
  const b = req.body as AdminOperationalBody;
  res.json({
    success: true,
    data: await setOperationalStatus(idParam(req), b.to, b.reason, b.until ?? null, adminId(req)),
  });
}
export async function driverFleetHandler(req: Request, res: Res<FleetDriverDetail>) {
  const b = req.body as { fleetId: string | null; reason: string };
  await setDriverFleet(idParam(req), b.fleetId, b.reason, adminId(req));
  res.json({ success: true, data: await fleetDriverDetail(idParam(req)) });
}
export async function expiringHandler(req: Request, res: Res<ExpiryItem[]>) {
  const q = req.validatedQuery as z.infer<typeof expiringQuerySchema>;
  res.json({
    success: true,
    data: await expiryItems({
      ...(q.state ? { states: [q.state], includeValid: q.state === 'VALID' } : {}),
      ...(q.kind ? { kinds: [q.kind] } : {}),
      ...(q.fleetId ? { fleetId: q.fleetId } : {}),
    }),
  });
}
export async function serviceRecordsHandler(
  req: Request,
  res: Res<{ items: ServiceRecordInfo[]; total: number }>,
) {
  const q = req.validatedQuery as z.infer<typeof serviceRecordsQuerySchema>;
  res.json({ success: true, data: await listAllServiceRecords(q) });
}
export async function startMaintenanceHandler(req: Request, res: Res<ServiceRecordInfo>) {
  res.status(201).json({
    success: true,
    data: await startMaintenance(idParam(req), req.body as AdminMaintenanceStartBody, adminId(req)),
  });
}
export async function completeMaintenanceHandler(req: Request, res: Res<ServiceRecordInfo>) {
  res.json({
    success: true,
    data: await completeMaintenance(
      idParam(req),
      req.body as AdminMaintenanceCompleteBody,
      adminId(req),
    ),
  });
}
export async function inspectionHandler(req: Request, res: Res<ServiceRecordInfo>) {
  res.status(201).json({
    success: true,
    data: await recordInspection(idParam(req), req.body as AdminInspectionBody, adminId(req)),
  });
}
export async function serviceLogHandler(req: Request, res: Res<ServiceRecordInfo>) {
  res.status(201).json({
    success: true,
    data: await logService(idParam(req), req.body as AdminServiceLogBody, adminId(req)),
  });
}
export async function fleetHistoryHandler(
  req: Request,
  res: Res<{
    items: Array<AuditEntry & { subjectType: string; subjectId: string | null }>;
    total: number;
  }>,
) {
  const q = req.validatedQuery as z.infer<typeof fleetHistoryQuerySchema>;
  res.json({
    success: true,
    data: await recentAudit(
      ['fleet', 'vehicle', 'driver_operations', 'vehicle_service'],
      q.pageSize,
      (q.page - 1) * q.pageSize,
    ),
  });
}
export async function runMonitorHandler(_req: Request, res: Res<MonitorResult>) {
  res.json({ success: true, data: await runFleetMonitor() });
}
