/** Small pure helpers the ride screens share (kept free of React Native so they are unit-tested). */

/** The words for a rating: a number when there is one, an honest placeholder until there is. */
export function ratingText(rating: number | null): string {
  return rating === null ? 'No ratings yet' : `Rating ${rating.toFixed(1)} out of 5`;
}

/** The link that opens the phone's own maps app on a destination (no map SDK, no second location system). */
export function mapsUrl(
  target: { latitude: number; longitude: number },
  label: string,
  platform: string,
): string {
  const { latitude, longitude } = target;
  return platform === 'ios'
    ? `http://maps.apple.com/?daddr=${latitude},${longitude}&dirflg=d`
    : `geo:0,0?q=${latitude},${longitude}(${encodeURIComponent(label)})`;
}

/** "10:32 AM", or '' for a value that is not a date. The one time-of-day format. */
export function formatClockTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Sep 29, 2026, 10:32 AM", or '' for a value that is not a date. The one date-and-time format. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}
