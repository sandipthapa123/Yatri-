/** Small pure helpers the ride screens share (kept free of React Native so they are unit-tested). */

/** The words for a rating: a number when there is one, an honest placeholder until there is. */
export function ratingText(rating: number | null, count?: number): string {
  if (rating === null) return 'No ratings yet';
  const base = `Rating ${rating.toFixed(1)} out of 5`;
  return count === undefined
    ? base
    : `${base}, from ${count} ${count === 1 ? 'rating' : 'ratings'}`;
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
