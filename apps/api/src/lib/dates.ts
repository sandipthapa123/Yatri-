/** A database time as the API sends it: an ISO 8601 string, or null when there is none. The one conversion for every response. */
export function isoOrNull(at: Date | null | undefined): string | null {
  return at ? at.toISOString() : null;
}
