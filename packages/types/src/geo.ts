import type { LatLng } from './index';

const EARTH_RADIUS_METERS = 6_371_008.8; // IUGG mean radius

/**
 * Great-circle (haversine) distance in meters — straight-line, not road distance.
 * The ONE implementation: the API, the mobile apps and the admin all use this.
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** True for the (0, 0) "no GPS fix" placeholder many stacks report. */
/** The compass direction (degrees, 0 = north, clockwise) you would travel in to go from `from` to `to`. */
export function bearingDegrees(from: LatLng, to: LatLng): number {
  const rad = Math.PI / 180;
  const dLon = (to.longitude - from.longitude) * rad;
  const y = Math.sin(dLon) * Math.cos(to.latitude * rad);
  const x =
    Math.cos(from.latitude * rad) * Math.sin(to.latitude * rad) -
    Math.sin(from.latitude * rad) * Math.cos(to.latitude * rad) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

export function isNullIsland(c: { latitude?: number; longitude?: number }): boolean {
  return c.latitude === 0 && c.longitude === 0;
}

/** A zone boundary: corners as [latitude, longitude], closed implicitly (the last joins the first). */
export type PolygonPoints = Array<[number, number]>;
export const POLYGON_MIN_POINTS = 3;
export const POLYGON_MAX_POINTS = 500;

/**
 * Whether a point is inside a polygon (ray casting; a point exactly on an edge counts as inside).
 * The ONE implementation: zones, pricing, dispatch, incentives and the heatmap all ask this.
 * Planar on latitude/longitude, which is exact enough at city scale.
 */
export function pointInPolygon(p: LatLng, polygon: PolygonPoints): boolean {
  const n = polygon.length;
  if (n < POLYGON_MIN_POINTS) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [latI, lngI] = polygon[i] as [number, number];
    const [latJ, lngJ] = polygon[j] as [number, number];
    // On the edge: within the segment's box and collinear.
    const cross = (p.longitude - lngI) * (latJ - latI) - (p.latitude - latI) * (lngJ - lngI);
    if (
      Math.abs(cross) < 1e-12 &&
      p.latitude >= Math.min(latI, latJ) &&
      p.latitude <= Math.max(latI, latJ) &&
      p.longitude >= Math.min(lngI, lngJ) &&
      p.longitude <= Math.max(lngI, lngJ)
    ) {
      return true;
    }
    const crosses =
      lngI > p.longitude !== lngJ > p.longitude &&
      p.latitude < ((latJ - latI) * (p.longitude - lngI)) / (lngJ - lngI) + latI;
    if (crosses) inside = !inside;
  }
  return inside;
}

/** Why a polygon cannot be used, or null when it can. One rule for the API and any form. */
export function polygonProblem(polygon: unknown): string | null {
  if (!Array.isArray(polygon)) return 'The boundary must be a list of corners.';
  if (polygon.length < POLYGON_MIN_POINTS) {
    return `A boundary needs at least ${POLYGON_MIN_POINTS} corners.`;
  }
  if (polygon.length > POLYGON_MAX_POINTS) {
    return `A boundary can have at most ${POLYGON_MAX_POINTS} corners.`;
  }
  const seen = new Set<string>();
  for (const pt of polygon) {
    if (
      !Array.isArray(pt) ||
      pt.length !== 2 ||
      typeof pt[0] !== 'number' ||
      typeof pt[1] !== 'number' ||
      !Number.isFinite(pt[0]) ||
      !Number.isFinite(pt[1])
    ) {
      return 'Each corner must be a latitude and a longitude.';
    }
    if (pt[0] < -90 || pt[0] > 90 || pt[1] < -180 || pt[1] > 180) {
      return 'A corner is outside the range of latitude (-90 to 90) and longitude (-180 to 180).';
    }
    if (isNullIsland({ latitude: pt[0], longitude: pt[1] })) {
      return 'A corner at 0, 0 is a missing position, not a place.';
    }
    seen.add(`${pt[0]},${pt[1]}`);
  }
  if (seen.size < POLYGON_MIN_POINTS) return 'The corners must be at least three different places.';
  // Twice the signed area: zero means the corners lie on a line.
  let area2 = 0;
  for (let i = 0; i < polygon.length; i++) {
    const [la, lo] = polygon[i] as [number, number];
    const [lb, lp] = polygon[(i + 1) % polygon.length] as [number, number];
    area2 += lo * lb - lp * la;
  }
  if (Math.abs(area2) < 1e-12) return 'The corners enclose no area.';
  return null;
}

/** The corner-list the admin form shows and reads: one "latitude, longitude" per line. */
export function polygonToText(polygon: PolygonPoints): string {
  return polygon.map(([a, b]) => `${a}, ${b}`).join('\n');
}
export function polygonFromText(text: string): PolygonPoints | null {
  const out: PolygonPoints = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line);
    if (!m) return null;
    out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

// ---------------------------------------------------------------- routes (polylines)

const METERS_PER_DEGREE = 111_195;

/**
 * Where a point stands against a route line: how far from it, and how far along it the nearest spot is. The ONE
 * implementation (deviation detection, progress along a route and step tracking all use it). Distances are measured on a
 * local flat projection around the point, which is exact enough over the few hundred metres that matter here.
 * `line` is [latitude, longitude] pairs.
 */
export function nearestOnPolyline(
  point: LatLng,
  line: ReadonlyArray<readonly [number, number]>,
): { distanceMeters: number; alongMeters: number; segmentIndex: number } | null {
  if (line.length === 0) return null;
  const cos = Math.cos((point.latitude * Math.PI) / 180);
  const toXY = (p: readonly [number, number]) => ({
    x: (p[1] - point.longitude) * METERS_PER_DEGREE * cos,
    y: (p[0] - point.latitude) * METERS_PER_DEGREE,
  });
  if (line.length === 1) {
    const only = toXY(line[0] as [number, number]);
    return { distanceMeters: Math.hypot(only.x, only.y), alongMeters: 0, segmentIndex: 0 };
  }
  let best = { distanceMeters: Infinity, alongMeters: 0, segmentIndex: 0 };
  let walked = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = toXY(line[i] as [number, number]);
    const b = toXY(line[i + 1] as [number, number]);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / len2));
    const d = Math.hypot(a.x + t * dx, a.y + t * dy);
    const segLen = Math.sqrt(len2);
    if (d < best.distanceMeters)
      best = { distanceMeters: d, alongMeters: walked + t * segLen, segmentIndex: i };
    walked += segLen;
  }
  return best;
}

/** The length of a route line in metres. */
export function polylineLengthMeters(line: ReadonlyArray<readonly [number, number]>): number {
  let total = 0;
  for (let i = 0; i < line.length - 1; i += 1) {
    const a = line[i] as [number, number];
    const b = line[i + 1] as [number, number];
    total += haversineMeters(
      { latitude: a[0], longitude: a[1] },
      { latitude: b[0], longitude: b[1] },
    );
  }
  return total;
}

/**
 * Fewer points for the same line (Douglas-Peucker): the route that goes over the network and onto the map. Keeps the
 * first and last point and never moves the line more than `toleranceMeters` from where it was.
 */
export function simplifyPolyline(
  line: ReadonlyArray<readonly [number, number]>,
  toleranceMeters: number,
  maxPoints = Infinity,
): Array<[number, number]> {
  const pts = line.map((p) => [p[0], p[1]] as [number, number]);
  if (pts.length <= 2) return pts;
  const simplify = (tol: number): Array<[number, number]> => {
    const keep = new Array<boolean>(pts.length).fill(false);
    keep[0] = true;
    keep[pts.length - 1] = true;
    const stack: Array<[number, number]> = [[0, pts.length - 1]];
    while (stack.length > 0) {
      const [lo, hi] = stack.pop() as [number, number];
      let worst = -1;
      let worstD = tol;
      const a = pts[lo] as [number, number];
      const b = pts[hi] as [number, number];
      for (let i = lo + 1; i < hi; i += 1) {
        const p = pts[i] as [number, number];
        const near = nearestOnPolyline({ latitude: p[0], longitude: p[1] }, [a, b]);
        if (near && near.distanceMeters > worstD) {
          worstD = near.distanceMeters;
          worst = i;
        }
      }
      if (worst !== -1) {
        keep[worst] = true;
        stack.push([lo, worst], [worst, hi]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  };
  let tol = Math.max(0, toleranceMeters);
  let out = simplify(tol);
  // Too many points for the wire: widen the tolerance until it fits.
  while (out.length > maxPoints && tol < 500) {
    tol = tol === 0 ? 1 : tol * 1.6;
    out = simplify(tol);
  }
  return out;
}
