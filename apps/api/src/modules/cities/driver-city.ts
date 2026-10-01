import { describeCityClosed, type LatLng } from '@yatri/types';

import { query } from '../../lib/db';
import { cityAtPoint, serviceState, type CityData } from './cities.service';

/**
 * What a city asks of a DRIVER who wants to work in it: service must be on there now, and every extra document the
 * city requires (on top of what Yatri requires everywhere) must be held, approved and unexpired. Said in the
 * driver's own words so the go-online refusal tells them exactly what to do.
 */
async function missingCityDocuments(driverId: string, city: CityData): Promise<string[]> {
  const r = await query<{ label: string; owner_type: string; held: boolean }>(
    `SELECT t.label, t.owner_type,
            EXISTS (
              SELECT 1 FROM documents d
              WHERE d.document_type_id = t.id AND d.status = 'APPROVED'
                AND (d.expiry_date IS NULL OR d.expiry_date >= current_date)
                AND ((t.owner_type = 'DRIVER' AND d.driver_user_id = $2)
                     OR (t.owner_type = 'VEHICLE' AND d.vehicle_id IN
                           (SELECT id FROM vehicles WHERE driver_user_id = $2)))
            ) AS held
     FROM city_requirements c JOIN document_types t ON t.id = c.document_type_id
     WHERE c.city_id = $1 AND t.is_active`,
    [city.info.id, driverId],
  );
  return r.rows
    .filter((x) => !x.held)
    .map(
      (x) =>
        `${city.info.name} also needs your ${x.label}${x.owner_type === 'VEHICLE' ? ' for your vehicle' : ''}: upload it and wait for approval.`,
    );
}

/** Reasons (empty: fine) a driver at this point may not go online, from the city's own rules. */
export async function cityProblemsForDriver(driverId: string, at: LatLng): Promise<string[]> {
  const { city } = await cityAtPoint(at);
  if (!city) return [];
  const state = serviceState(city);
  if (!state.open) return [describeCityClosed(city.info, state.reason)];
  return missingCityDocuments(driverId, city);
}
