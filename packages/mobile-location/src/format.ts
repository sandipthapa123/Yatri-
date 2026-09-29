/**
 * Plain-language formatting for screen readers. Distances are spoken as
 * words ("85 meters", "1.2 kilometres") rather than symbols ("85 m") so
 * TTS engines never misread the unit.
 */
export { formatDistance } from '@yatri/types';

export function formatAccuracy(meters: number | null | undefined): string | null {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) return null;
  return `Location accuracy approximately ${Math.max(1, Math.round(meters))} meters.`;
}

/** Latitude/longitude as text for users who want the exact numbers (5 decimals ≈ 1 m). */
export function formatCoordinates(latitude: number, longitude: number): string {
  return `Latitude ${latitude.toFixed(5)}, longitude ${longitude.toFixed(5)}`;
}

/** "Result 2 of 5: Thamel, Kathmandu, Bagmati Province" */
export function describeResult(
  place: { name: string; address: string },
  index: number,
  total: number,
): string {
  return `${place.name}${place.address ? `, ${place.address}` : ''}. Result ${index + 1} of ${total}.`;
}

export function describeResultCount(count: number, query: string): string {
  if (count === 0)
    return `No places found for ${query}. Try a different spelling or a nearby landmark.`;
  return `${count} ${count === 1 ? 'result' : 'results'} found. Swipe or use the arrow keys to review them.`;
}
