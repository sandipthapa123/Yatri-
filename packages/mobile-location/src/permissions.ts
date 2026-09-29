/**
 * Turns the many ways obtaining a GPS fix can go wrong into a small set of
 * outcomes the UI can explain in plain language. Pure so it can be tested
 * without a device.
 */
export type LocationIssue =
  | 'denied' // user said no; we may ask again
  | 'blocked' // "don't ask again" / restricted: only system Settings can fix it
  | 'services-off' // device location switch is off
  | 'unavailable' // no fix / provider error
  | 'timeout';

/** Above this the fix is too coarse to auto-confirm as a pickup; the user is asked to confirm or search instead. */
export const POOR_ACCURACY_METERS = 100;

export function classifyPermission(p: {
  granted: boolean;
  canAskAgain: boolean;
}): 'granted' | 'denied' | 'blocked' {
  if (p.granted) return 'granted';
  return p.canAskAgain ? 'denied' : 'blocked';
}

export function classifyFixError(err: unknown): LocationIssue {
  const e = err as { code?: string; message?: string } | null;
  const text = `${e?.code ?? ''} ${e?.message ?? ''}`.toLowerCase();
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (
    text.includes('services') ||
    text.includes('disabled') ||
    text.includes('e_location_settings')
  ) {
    return 'services-off';
  }
  return 'unavailable';
}

export const ISSUE_MESSAGES: Record<LocationIssue, { title: string; body: string }> = {
  denied: {
    title: 'Location permission was not allowed',
    body: 'Yatri needs your location only to set your pickup point. You can allow it and try again, or search for your pickup instead.',
  },
  blocked: {
    title: 'Location access is turned off for Yatri',
    body: 'Open your phone settings, allow location for Yatri, then come back. Or search for your pickup instead.',
  },
  'services-off': {
    title: 'Your phone’s location service is off',
    body: 'Turn on location in your phone settings and try again, or search for your pickup instead.',
  },
  unavailable: {
    title: 'We could not find your location',
    body: 'Your phone could not get a GPS fix. Move to an open area and try again, or search for your pickup.',
  },
  timeout: {
    title: 'Finding your location took too long',
    body: 'Try again, or search for your pickup.',
  },
};

export function isPoorAccuracy(accuracyMeters: number | null | undefined): boolean {
  return (
    accuracyMeters === null ||
    accuracyMeters === undefined ||
    !Number.isFinite(accuracyMeters) ||
    accuracyMeters > POOR_ACCURACY_METERS
  );
}
