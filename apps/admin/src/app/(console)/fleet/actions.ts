'use server';

import {
  FLEET_STATUSES,
  INSPECTION_RESULTS,
  OPERATIONAL_STATES,
  VEHICLE_LIFECYCLE_STATES,
  type FleetStatus,
  type InspectionResult,
  type OperationalStatus,
  type VehicleLifecycle,
} from '@yatri/types';
import { revalidatePath } from 'next/cache';

import {
  ApiError,
  assignVehicleApi,
  completeMaintenanceApi,
  createFleetVehicleApi,
  logServiceApi,
  recordInspectionApi,
  runFleetCheck,
  saveFleet,
  setDriverFleetApi,
  setDriverOperational,
  setVehicleLifecycle,
  startMaintenanceApi,
  unassignVehicleApi,
} from '../../../lib/apiClient';
import { requireAdminAccessToken } from '../../../lib/session';

export interface FleetActionState {
  error?: string;
  done?: string;
}

const field = (fd: FormData, name: string) => {
  const v = fd.get(name);
  return typeof v === 'string' ? v.trim() : '';
};
const orNull = (v: string) => (v === '' ? null : v);

/**
 * Every action only passes the administrator's choices to the API and shows what it answered. The API
 * applies the state tables in @yatri/types under a row lock and records the change; a refusal (a conflict,
 * an ineligible driver, an illegal move) is shown in its own words, with every reason when there are several.
 */
async function run(
  work: (token: string) => Promise<unknown>,
  done: string,
  paths: string[],
): Promise<FleetActionState> {
  const token = await requireAdminAccessToken();
  try {
    await work(token);
  } catch (e) {
    if (e instanceof ApiError) {
      const problems = e.details?.problems;
      return {
        error: Array.isArray(problems) ? (problems as string[]).join(' ') : e.message,
      };
    }
    return { error: 'Something went wrong. Please try again.' };
  }
  for (const p of paths) revalidatePath(p);
  return { done };
}

export async function fleetAction(_p: FleetActionState, fd: FormData): Promise<FleetActionState> {
  const status = field(fd, 'status') as FleetStatus;
  if (!FLEET_STATUSES.includes(status)) return { error: 'Choose a status.' };
  const id = orNull(field(fd, 'id'));
  return run(
    (t) =>
      saveFleet(t, id, {
        name: field(fd, 'name'),
        contactName: orNull(field(fd, 'contactName')),
        contactPhone: orNull(field(fd, 'contactPhone')),
        contactEmail: orNull(field(fd, 'contactEmail')),
        status,
        reason: field(fd, 'reason'),
      }),
    id ? 'Fleet saved.' : 'Fleet created.',
    ['/fleet', ...(id ? [`/fleet/${id}`] : [])],
  );
}

export async function fleetVehicleAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const fleetId = field(fd, 'fleetId');
  return run(
    (t) =>
      createFleetVehicleApi(t, {
        fleetId,
        categoryId: field(fd, 'categoryId'),
        make: field(fd, 'make'),
        model: field(fd, 'model'),
        year: Number(field(fd, 'year')),
        color: field(fd, 'color'),
        registrationNumber: field(fd, 'registrationNumber'),
        registrationExpiryDate: orNull(field(fd, 'registrationExpiryDate')),
        insuranceExpiryDate: orNull(field(fd, 'insuranceExpiryDate')),
      }),
    'Vehicle added. Assign it to a driver to get it reviewed.',
    [`/fleet/${fleetId}`, '/fleet/vehicles'],
  );
}

export async function lifecycleAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const to = field(fd, 'to') as VehicleLifecycle;
  if (!VEHICLE_LIFECYCLE_STATES.includes(to)) return { error: 'Choose a status.' };
  const id = field(fd, 'vehicleId');
  return run(
    (t) => setVehicleLifecycle(t, id, { to, reason: field(fd, 'reason') }),
    'Vehicle status changed. The driver has been told.',
    [`/fleet/vehicles/${id}`, '/fleet/vehicles'],
  );
}

export async function assignVehicleAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const id = field(fd, 'vehicleId');
  const driverId = field(fd, 'driverId');
  if (!driverId) return { error: 'Choose a driver.' };
  return run(
    (t) => assignVehicleApi(t, id, driverId),
    'Vehicle assigned. The driver has been told.',
    [`/fleet/vehicles/${id}`, '/fleet/vehicles'],
  );
}

export async function unassignAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const id = field(fd, 'vehicleId');
  return run(
    (t) => unassignVehicleApi(t, id, field(fd, 'reason')),
    'Vehicle unassigned. The driver has been told.',
    [`/fleet/vehicles/${id}`, '/fleet/vehicles'],
  );
}

export async function operationalAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const to = field(fd, 'to') as OperationalStatus;
  if (!OPERATIONAL_STATES.includes(to)) return { error: 'Choose a status.' };
  const id = field(fd, 'driverId');
  const until = field(fd, 'until');
  return run(
    (t) =>
      setDriverOperational(t, id, {
        to,
        reason: field(fd, 'reason'),
        ...(until ? { until } : {}),
      }),
    'Status changed. The driver has been told.',
    [`/fleet/drivers/${id}`, '/fleet/drivers'],
  );
}

export async function driverFleetAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const id = field(fd, 'driverId');
  return run(
    (t) =>
      setDriverFleetApi(t, id, {
        fleetId: orNull(field(fd, 'fleetId')),
        reason: field(fd, 'reason'),
      }),
    'Fleet changed.',
    [`/fleet/drivers/${id}`, '/fleet'],
  );
}

export async function maintenanceStartAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const id = field(fd, 'vehicleId');
  return run(
    (t) => startMaintenanceApi(t, id, { notes: field(fd, 'notes') || undefined }),
    'Maintenance started. The vehicle is out of service.',
    [`/fleet/vehicles/${id}`, '/fleet/maintenance'],
  );
}

export async function maintenanceCompleteAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const vehicleId = field(fd, 'vehicleId');
  const returnTo = field(fd, 'returnTo');
  if (returnTo !== 'ACTIVE' && returnTo !== 'INACTIVE')
    return { error: 'Choose where the vehicle goes next.' };
  return run(
    (t) =>
      completeMaintenanceApi(t, field(fd, 'recordId'), {
        performedOn: field(fd, 'performedOn'),
        nextDueOn: orNull(field(fd, 'nextDueOn')),
        notes: field(fd, 'notes') || undefined,
        returnTo,
      }),
    'Maintenance completed.',
    [`/fleet/vehicles/${vehicleId}`, '/fleet/maintenance'],
  );
}

export async function inspectionAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const id = field(fd, 'vehicleId');
  const result = field(fd, 'result') as InspectionResult;
  if (!INSPECTION_RESULTS.includes(result)) return { error: 'Choose the result.' };
  return run(
    (t) =>
      recordInspectionApi(t, id, {
        performedOn: field(fd, 'performedOn'),
        result,
        nextDueOn: orNull(field(fd, 'nextDueOn')),
        notes: field(fd, 'notes') || undefined,
      }),
    result === 'FAILED'
      ? 'Inspection recorded. The vehicle was taken out of service for repair.'
      : 'Inspection recorded.',
    [`/fleet/vehicles/${id}`, '/fleet/maintenance'],
  );
}

export async function serviceLogAction(
  _p: FleetActionState,
  fd: FormData,
): Promise<FleetActionState> {
  const id = field(fd, 'vehicleId');
  return run(
    (t) =>
      logServiceApi(t, id, {
        performedOn: field(fd, 'performedOn'),
        nextDueOn: orNull(field(fd, 'nextDueOn')),
        notes: field(fd, 'notes') || undefined,
      }),
    'Service recorded.',
    [`/fleet/vehicles/${id}`, '/fleet/maintenance'],
  );
}

export async function checkNowAction(_p: FleetActionState): Promise<FleetActionState> {
  const token = await requireAdminAccessToken();
  try {
    const r = await runFleetCheck(token);
    revalidatePath('/fleet/expiring');
    return {
      done: `Checked. ${r.reminders} reminder${r.reminders === 1 ? '' : 's'} sent, ${r.takenOffline} driver${r.takenOffline === 1 ? '' : 's'} taken offline, ${r.lifted} restriction${r.lifted === 1 ? '' : 's'} lifted.`,
    };
  } catch (e) {
    return { error: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' };
  }
}
