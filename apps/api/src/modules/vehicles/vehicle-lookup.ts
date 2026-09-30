import { query } from '../../lib/db';

/**
 * The vehicle a passenger is told to look for: the driver's first APPROVED vehicle, described the
 * way a person would say it. The one place this is decided — the ride summary and the shared-trip
 * page both use it.
 */
export async function approvedVehicleOf(
  driverId: string,
): Promise<{ description: string; registrationNumber: string } | null> {
  const r = await query<{
    make: string;
    model: string;
    color: string;
    registration_number: string;
  }>(
    `SELECT make, model, color, registration_number FROM vehicles
     WHERE driver_user_id = $1 AND verification_status = 'APPROVED' AND lifecycle_status <> 'RETIRED'
     ORDER BY (lifecycle_status = 'ACTIVE') DESC, created_at LIMIT 1`,
    [driverId],
  );
  const row = r.rows[0];
  return row
    ? {
        description: `${row.color} ${row.make} ${row.model}`,
        registrationNumber: row.registration_number,
      }
    : null;
}
