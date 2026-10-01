import {
  ACCOUNT_RESTRICTED_MESSAGE,
  VEHICLE_LIFECYCLE_LABELS,
  type RideEligibility,
  type VehicleLifecycle,
} from '@yatri/types';

import { query } from '../../lib/db';
import { RISK_RESTRICTED_SQL } from '../risk/restricted-sql';
import { activeRestriction } from '../risk/restriction.service';
import { listRequiredDocumentTypes } from '../documents/document-types.repository';
import { expireStaleDocuments } from '../documents/documents.repository';
import { documentSatisfies, isPastDate } from '../drivers/onboarding.service';
import type { DocumentRow } from '../documents/documents.types';

/**
 * Who and what may be used for rides, in ONE place, stated twice only because SQL and TypeScript must both
 * say it: the SQL fragments below are what matching and the supply count put in their queries (so an
 * ineligible vehicle or driver is never offered a ride), and the functions explain the same rules in words
 * for go-online, the admin screens and the expiry monitor. `fleet.test.ts` keeps the two in step.
 *
 * A VEHICLE can be used when: its lifecycle is ACTIVE, its papers were APPROVED, its fleet (if any) is ACTIVE,
 * and neither its registration or insurance date has passed nor is a required document expired or rejected.
 * A DRIVER can be offered rides when: their operational status is not SUSPENDED, their fleet (if any) is
 * ACTIVE, and neither their licence date nor a required driver document has expired. (Account status,
 * verification and availability are checked by their own modules.)
 */
const FLEET_ACTIVE = (col: string) =>
  `(${col} IS NULL OR EXISTS (SELECT 1 FROM fleets f WHERE f.id = ${col} AND f.status = 'ACTIVE'))`;
const NO_EXPIRED_REQUIRED_DOCUMENT = (owner: string) => `NOT EXISTS (
    SELECT 1 FROM documents d JOIN document_types t ON t.id = d.document_type_id
    WHERE ${owner} AND t.is_required
      AND (d.expiry_date < current_date OR d.status IN ('EXPIRED', 'REJECTED')))`;

/** For a query that aliases `vehicles` as `v`. */
export const VEHICLE_RIDEABLE_SQL = `v.verification_status = 'APPROVED'
  AND v.lifecycle_status = 'ACTIVE'
  AND ${FLEET_ACTIVE('v.fleet_id')}
  AND (v.registration_expiry_date IS NULL OR v.registration_expiry_date >= current_date)
  AND (v.insurance_expiry_date IS NULL OR v.insurance_expiry_date >= current_date)
  AND ${NO_EXPIRED_REQUIRED_DOCUMENT('d.vehicle_id = v.id')}`;

/** For a query that aliases `driver_profiles` as `dp`. */
export const DRIVER_RIDEABLE_SQL = `dp.operational_status <> 'SUSPENDED'
  AND NOT ${RISK_RESTRICTED_SQL('dp.user_id')}
  AND ${FLEET_ACTIVE('dp.fleet_id')}
  AND NOT EXISTS (SELECT 1 FROM driver_details dd
                  WHERE dd.user_id = dp.user_id AND dd.license_expiry_date < current_date)
  AND ${NO_EXPIRED_REQUIRED_DOCUMENT('d.driver_user_id = dp.user_id')}`;

interface VehicleFacts {
  id: string;
  registration_number: string;
  category_id: string;
  verification_status: string;
  lifecycle_status: VehicleLifecycle;
  fleet_id: string | null;
  fleet_status: string | null;
  registration_expiry_date: string | null;
  insurance_expiry_date: string | null;
  driver_user_id: string | null;
}

async function vehicleFacts(vehicleId: string): Promise<VehicleFacts | null> {
  const r = await query<VehicleFacts>(
    `SELECT v.id, v.registration_number, v.category_id, v.verification_status::text AS verification_status,
            v.lifecycle_status, v.fleet_id, f.status AS fleet_status,
            v.registration_expiry_date::text AS registration_expiry_date,
            v.insurance_expiry_date::text AS insurance_expiry_date, v.driver_user_id
     FROM vehicles v LEFT JOIN fleets f ON f.id = v.fleet_id WHERE v.id = $1`,
    [vehicleId],
  );
  return r.rows[0] ?? null;
}

/** Why a vehicle cannot be used for rides right now, in words (empty: it can). */
export async function vehicleRideProblems(vehicleId: string): Promise<RideEligibility> {
  const v = await vehicleFacts(vehicleId);
  if (!v) return { eligible: false, reasons: ['Vehicle not found.'] };
  await expireStaleDocuments();
  const reasons: string[] = [];
  const reg = v.registration_number;
  if (v.lifecycle_status !== 'ACTIVE') {
    reasons.push(
      `Vehicle ${reg} is ${VEHICLE_LIFECYCLE_LABELS[v.lifecycle_status].toLowerCase()}.`,
    );
  }
  if (v.verification_status !== 'APPROVED') {
    reasons.push(`Vehicle ${reg} has not been approved (${v.verification_status.toLowerCase()}).`);
  }
  if (v.fleet_id && v.fleet_status !== 'ACTIVE') {
    reasons.push(`The fleet that owns vehicle ${reg} is not active.`);
  }
  if (isPastDate(v.registration_expiry_date))
    reasons.push(`The registration of ${reg} has expired.`);
  if (isPastDate(v.insurance_expiry_date)) reasons.push(`The insurance of ${reg} has expired.`);
  const docs = await query<DocumentRow>(
    `SELECT d.*, dt.code AS document_type_code, dt.label AS document_type_label
     FROM documents d JOIN document_types dt ON dt.id = d.document_type_id
     WHERE d.owner_type = 'VEHICLE' AND d.vehicle_id = $1`,
    [vehicleId],
  );
  for (const t of await listRequiredDocumentTypes('VEHICLE', v.category_id)) {
    if (!documentSatisfies(docs.rows, t.id, vehicleId, true)) {
      reasons.push(`${t.label} for ${reg} is missing, rejected, or expired.`);
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

/**
 * The fleet and operational reasons a driver cannot go online or be offered rides, apart from the account,
 * verification and document checks that `checkVerificationEligibility` and the availability module own:
 * operational suspension, an inactive fleet, and having no vehicle that can be used (with the reason each
 * approved vehicle cannot).
 */
export async function driverFleetProblems(driverId: string): Promise<string[]> {
  const r = await query<{
    operational_status: string;
    operational_reason: string | null;
    fleet_id: string | null;
    fleet_status: string | null;
  }>(
    `SELECT dp.operational_status, dp.operational_reason, dp.fleet_id, f.status AS fleet_status
     FROM driver_profiles dp LEFT JOIN fleets f ON f.id = dp.fleet_id WHERE dp.user_id = $1`,
    [driverId],
  );
  const d = r.rows[0];
  if (!d) return [];
  const reasons: string[] = [];
  if (d.operational_status === 'SUSPENDED') {
    reasons.push(
      `Your driving is suspended by operations${d.operational_reason ? `: ${d.operational_reason}` : '.'}`,
    );
  }
  if (d.fleet_id && d.fleet_status !== 'ACTIVE') reasons.push('Your fleet is not active.');
  if (await activeRestriction(driverId)) reasons.push(ACCOUNT_RESTRICTED_MESSAGE);
  const vehicles = await query<{ id: string; verification_status: string }>(
    `SELECT v.id, v.verification_status::text AS verification_status FROM vehicles v
     WHERE v.driver_user_id = $1 AND v.lifecycle_status <> 'RETIRED'`,
    [driverId],
  );
  // Only a driver who has an approved vehicle is told about its lifecycle: the verification check already
  // says "no approved vehicle" for one who has none.
  const approved = vehicles.rows.filter((v) => v.verification_status === 'APPROVED');
  if (approved.length > 0) {
    const checks = await Promise.all(approved.map((v) => vehicleRideProblems(v.id)));
    if (!checks.some((c) => c.eligible)) reasons.push(...checks.flatMap((c) => c.reasons));
  }
  return reasons;
}
