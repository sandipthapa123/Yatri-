import {
  daysUntil,
  describeExpiry,
  expiryState,
  periodKey,
  type ExpiryItem,
  type ExpiryKind,
  type ExpiryState,
} from '@yatri/types';

import { env } from '../../config/env';
import { query } from '../../lib/db';
import { listRequiredDocumentTypes } from '../documents/document-types.repository';
import { expireStaleDocuments } from '../documents/documents.repository';
import { settingList } from '../settings/settings.service';

/**
 * THE expiry monitor's view: everything that can run out, from where it already lives. Driver and vehicle
 * documents are read from the document system (nothing here stores one); the licence date is
 * `driver_details`; registration and insurance are `vehicles`; service and inspection due dates are the
 * next-due date on the latest completed service record. One function (`expiryState`, in @yatri/types)
 * turns a date into VALID / EXPIRING_SOON / EXPIRED / MISSING, for all of them.
 *
 * It covers VERIFIED drivers, and the vehicles that are in use (a driver is assigned) or belong to a fleet,
 * leaving out retired vehicles.
 */
export interface ExpiryFilter {
  states?: readonly ExpiryState[];
  kinds?: readonly ExpiryKind[];
  fleetId?: string;
  driverId?: string;
  vehicleId?: string;
  /** Include items that are fine (default: only those that need attention). */
  includeValid?: boolean;
}

/** Today in the platform's own time zone, as YYYY-MM-DD: the day a date is valid through. */
export const todayKey = () => periodKey(new Date(), 'DAILY', env.PLATFORM_TIME_ZONE);
/** How early "expiring soon" shows: the largest reminder threshold. */
export const soonDays = () => Math.max(1, ...settingList('EXPIRY_REMINDER_DAYS'));

interface Holder {
  driverId: string | null;
  driverName: string | null;
  fleetId: string | null;
  fleetName: string | null;
}

/** All expiry items for the scope, worst first. */
export async function expiryItems(filter: ExpiryFilter = {}): Promise<ExpiryItem[]> {
  await expireStaleDocuments();
  const today = todayKey();
  const soon = soonDays();
  const items: ExpiryItem[] = [];
  const add = (
    kind: ExpiryKind,
    itemKey: string,
    label: string,
    expiresOn: string | null,
    who: Holder & { vehicleId: string | null; vehicleRegistration: string | null },
    forceMissing = false,
  ) => {
    const state = forceMissing ? 'MISSING' : expiryState(expiresOn, today, soon);
    const daysLeft = expiresOn && !forceMissing ? daysUntil(expiresOn, today) : null;
    const subject = who.vehicleRegistration
      ? `Vehicle ${who.vehicleRegistration}`
      : (who.driverName ?? 'Driver');
    items.push({
      kind,
      itemKey,
      label,
      state,
      expiresOn: forceMissing ? null : expiresOn,
      daysLeft,
      ...who,
      text: describeExpiry({ label, state, expiresOn, daysLeft, subject }),
    });
  };

  // ---- drivers: licence date, documents with a date, required documents that are missing
  const drivers = await query<{
    user_id: string;
    full_name: string | null;
    fleet_id: string | null;
    fleet_name: string | null;
    license_expiry_date: string | null;
  }>(
    `SELECT dp.user_id, u.full_name, dp.fleet_id, f.name AS fleet_name, dd.license_expiry_date::text AS license_expiry_date
     FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
     LEFT JOIN fleets f ON f.id = dp.fleet_id
     LEFT JOIN driver_details dd ON dd.user_id = dp.user_id
     WHERE dp.status = 'VERIFIED' AND u.status = 'ACTIVE'
       AND ($1::uuid IS NULL OR dp.fleet_id = $1) AND ($2::uuid IS NULL OR dp.user_id = $2)`,
    [filter.fleetId ?? null, filter.driverId ?? null],
  );
  const driverHolder = (d: (typeof drivers.rows)[number]): Holder => ({
    driverId: d.user_id,
    driverName: d.full_name,
    fleetId: d.fleet_id,
    fleetName: d.fleet_name,
  });
  const driverIds = drivers.rows.map((d) => d.user_id);
  const driverDocs = driverIds.length
    ? await query<{
        id: string;
        driver_user_id: string;
        document_type_id: string;
        label: string;
        status: string;
        expiry_date: string | null;
      }>(
        `SELECT d.id, d.driver_user_id, d.document_type_id, t.label, d.status::text AS status,
                d.expiry_date::text AS expiry_date
         FROM documents d JOIN document_types t ON t.id = d.document_type_id
         WHERE d.owner_type = 'DRIVER' AND d.driver_user_id = ANY($1::uuid[])`,
        [driverIds],
      )
    : { rows: [] };
  const requiredDriver = await listRequiredDocumentTypes('DRIVER');
  for (const d of drivers.rows) {
    const who = { ...driverHolder(d), vehicleId: null, vehicleRegistration: null };
    if (d.license_expiry_date) {
      add('DRIVER_LICENCE', 'licence', 'Driving licence', d.license_expiry_date, who);
    }
    const mine = driverDocs.rows.filter((x) => x.driver_user_id === d.user_id);
    for (const doc of mine) {
      if (doc.expiry_date && doc.status !== 'REJECTED') {
        add('DRIVER_DOCUMENT', doc.id, doc.label, doc.expiry_date, who);
      }
    }
    for (const t of requiredDriver) {
      if (!mine.some((x) => x.document_type_id === t.id && x.status !== 'REJECTED')) {
        add('DRIVER_DOCUMENT', `missing:${t.id}`, t.label, null, who, true);
      }
    }
  }

  // ---- vehicles in use or owned by a fleet
  const vehicles = await query<{
    id: string;
    registration_number: string;
    category_id: string;
    verification_status: string;
    driver_user_id: string | null;
    driver_name: string | null;
    fleet_id: string | null;
    fleet_name: string | null;
    registration_expiry_date: string | null;
    insurance_expiry_date: string | null;
  }>(
    `SELECT v.id, v.registration_number, v.category_id, v.verification_status::text AS verification_status,
            v.driver_user_id, u.full_name AS driver_name, f.id AS fleet_id, f.name AS fleet_name,
            v.registration_expiry_date::text AS registration_expiry_date,
            v.insurance_expiry_date::text AS insurance_expiry_date
     FROM vehicles v LEFT JOIN users u ON u.id = v.driver_user_id
     LEFT JOIN driver_profiles dpv ON dpv.user_id = v.driver_user_id
     LEFT JOIN fleets f ON f.id = COALESCE(v.fleet_id, dpv.fleet_id)
     WHERE v.lifecycle_status <> 'RETIRED' AND (v.driver_user_id IS NOT NULL OR v.fleet_id IS NOT NULL)
       AND ($1::uuid IS NULL OR v.fleet_id = $1 OR dpv.fleet_id = $1) AND ($2::uuid IS NULL OR v.driver_user_id = $2)
       AND ($3::uuid IS NULL OR v.id = $3)`,
    [filter.fleetId ?? null, filter.driverId ?? null, filter.vehicleId ?? null],
  );
  const vehicleIds = vehicles.rows.map((v) => v.id);
  const vehicleDocs = vehicleIds.length
    ? await query<{
        id: string;
        vehicle_id: string;
        document_type_id: string;
        label: string;
        status: string;
        expiry_date: string | null;
      }>(
        `SELECT d.id, d.vehicle_id, d.document_type_id, t.label, d.status::text AS status,
                d.expiry_date::text AS expiry_date
         FROM documents d JOIN document_types t ON t.id = d.document_type_id
         WHERE d.owner_type = 'VEHICLE' AND d.vehicle_id = ANY($1::uuid[])`,
        [vehicleIds],
      )
    : { rows: [] };
  const due = vehicleIds.length
    ? await query<{ vehicle_id: string; kind: string; next_due_on: string }>(
        `SELECT DISTINCT ON (vehicle_id, kind) vehicle_id, kind, next_due_on::text AS next_due_on
         FROM vehicle_service_records
         WHERE vehicle_id = ANY($1::uuid[]) AND status = 'COMPLETED' AND next_due_on IS NOT NULL
         ORDER BY vehicle_id, kind, COALESCE(performed_on, created_at::date) DESC, created_at DESC`,
        [vehicleIds],
      )
    : { rows: [] };
  // The papers a category requires, asked once per category rather than once per vehicle.
  const requiredByCategory = new Map<string, ReturnType<typeof listRequiredDocumentTypes>>();
  const requiredFor = (categoryId: string) => {
    let found = requiredByCategory.get(categoryId);
    if (!found)
      requiredByCategory.set(
        categoryId,
        (found = listRequiredDocumentTypes('VEHICLE', categoryId)),
      );
    return found;
  };
  for (const v of vehicles.rows) {
    const who = {
      driverId: v.driver_user_id,
      driverName: v.driver_name,
      fleetId: v.fleet_id,
      fleetName: v.fleet_name,
      vehicleId: v.id,
      vehicleRegistration: v.registration_number,
    };
    if (v.registration_expiry_date) {
      add('VEHICLE_REGISTRATION', 'registration', 'Registration', v.registration_expiry_date, who);
    }
    if (v.insurance_expiry_date) {
      add('VEHICLE_INSURANCE', 'insurance', 'Insurance', v.insurance_expiry_date, who);
    }
    const mine = vehicleDocs.rows.filter((x) => x.vehicle_id === v.id);
    for (const doc of mine) {
      if (doc.expiry_date && doc.status !== 'REJECTED') {
        add('VEHICLE_DOCUMENT', doc.id, doc.label, doc.expiry_date, who);
      }
    }
    // Missing papers only matter for a vehicle that is in use and was approved.
    if (v.driver_user_id && v.verification_status === 'APPROVED') {
      for (const t of await requiredFor(v.category_id)) {
        if (!mine.some((x) => x.document_type_id === t.id && x.status !== 'REJECTED')) {
          add('VEHICLE_DOCUMENT', `missing:${t.id}`, t.label, null, who, true);
        }
      }
    }
    for (const s of due.rows.filter((x) => x.vehicle_id === v.id)) {
      const label = s.kind === 'INSPECTION' ? 'Next inspection' : 'Next service';
      add('VEHICLE_SERVICE', `service:${s.kind}`, label, s.next_due_on, who);
    }
  }

  const rank: Record<ExpiryState, number> = { EXPIRED: 0, MISSING: 1, EXPIRING_SOON: 2, VALID: 3 };
  return items
    .filter((i) => filter.includeValid || i.state !== 'VALID')
    .filter((i) => !filter.states || filter.states.includes(i.state))
    .filter((i) => !filter.kinds || filter.kinds.includes(i.kind))
    .sort(
      (a, b) =>
        rank[a.state] - rank[b.state] ||
        (a.daysLeft ?? -1e9) - (b.daysLeft ?? -1e9) ||
        a.text.localeCompare(b.text),
    );
}
