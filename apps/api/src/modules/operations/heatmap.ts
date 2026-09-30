import type { HeatCell, HeatmapData, ZoneDemandSupply } from '@yatri/types';

import { settingNumber } from '../settings/settings.service';
import { listActiveCategories } from '../pricing/categories';
import { demandSupplyTable, rawDemand } from './demand';
import { surgeFor } from './surge';
import { activeZones } from './zones.service';

/**
 * The demand and supply heatmap for administrators, built from the ONE demand/supply source (`demand.ts`).
 * It is aggregated so nobody can be picked out: positions are snapped to squares of HEATMAP_CELL_METERS,
 * only squares are returned (never a driver id or a rider), and a square with fewer than HEATMAP_MIN_COUNT
 * requests or drivers shows "fewer than N" instead of the number. The zone table beside it carries the
 * exact figures pricing reacts to, per admin-defined zone (areas, not people).
 */
const METERS_PER_DEGREE = 111_195;

export async function buildHeatmap(): Promise<HeatmapData> {
  const d = await rawDemand();
  const cellMeters = settingNumber('HEATMAP_CELL_METERS');
  const minCount = settingNumber('HEATMAP_MIN_COUNT');
  const all = [...d.requests, ...d.drivers];
  const meanLat = all.length ? all.reduce((n, p) => n + p.latitude, 0) / all.length : 27.7;
  const dLat = cellMeters / METERS_PER_DEGREE;
  const dLng = dLat / Math.max(0.2, Math.cos((meanLat * Math.PI) / 180));
  const cellOf = (p: { latitude: number; longitude: number }) =>
    `${Math.floor(p.latitude / dLat)}:${Math.floor(p.longitude / dLng)}`;
  const counts = new Map<string, { row: number; col: number; requests: number; drivers: number }>();
  const bump = (p: { latitude: number; longitude: number }, what: 'requests' | 'drivers') => {
    const key = cellOf(p);
    const c = counts.get(key) ?? {
      row: Math.floor(p.latitude / dLat),
      col: Math.floor(p.longitude / dLng),
      requests: 0,
      drivers: 0,
    };
    c[what]++;
    counts.set(key, c);
  };
  d.requests.forEach((p) => bump(p, 'requests'));
  d.drivers.forEach((p) => bump(p, 'drivers'));

  const cells: HeatCell[] = [...counts.values()]
    // A square where both counts are small says nothing safe to show: it is left out entirely.
    .filter((c) => c.requests >= minCount || c.drivers >= minCount)
    .map((c) => ({
      row: c.row,
      col: c.col,
      // The middle of the square, never a real position.
      centre: { latitude: (c.row + 0.5) * dLat, longitude: (c.col + 0.5) * dLng },
      requests: c.requests >= minCount ? c.requests : null,
      drivers: c.drivers >= minCount ? c.drivers : null,
    }))
    .sort((a, b) => (b.requests ?? 0) - (a.requests ?? 0) || a.row - b.row || a.col - b.col);

  // The multiplier each zone would give right now: the highest across vehicle categories.
  const [table, zones, categories] = await Promise.all([
    demandSupplyTable(),
    activeZones(),
    listActiveCategories(),
  ]);
  const zoneRows: ZoneDemandSupply[] = [];
  for (const row of table) {
    const zone = zones.find((z) => z.id === row.zoneId);
    const probe = zone
      ? {
          latitude: zone.polygon.reduce((n, p) => n + p[0], 0) / zone.polygon.length,
          longitude: zone.polygon.reduce((n, p) => n + p[1], 0) / zone.polygon.length,
        }
      : null;
    let surgeMultiplier = 1;
    if (probe) {
      for (const c of categories) {
        surgeMultiplier = Math.max(
          surgeMultiplier,
          (await surgeFor({ pickup: probe, categoryId: c.id })).multiplier,
        );
      }
    }
    zoneRows.push({ ...row, surgeMultiplier });
  }
  return {
    generatedAt: new Date().toISOString(),
    windowMinutes: d.windowMinutes,
    cellMeters,
    minCount,
    cells,
    zones: zoneRows,
  };
}
