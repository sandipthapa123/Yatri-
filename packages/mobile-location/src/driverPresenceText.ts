import type { PresenceState } from './driverPresenceController';
import { ageText } from './tripText';

/**
 * The short, plain-language status lines the driver sees (and a screen reader
 * reads). Each carries its meaning in words, so nothing depends on colour.
 */
export type LocationStatusKey =
  | 'permission-required'
  | 'unavailable'
  | 'weak'
  | 'updating'
  | 'delayed'
  | 'connection-lost'
  | 'not-sharing';

export const LOCATION_STATUS_TEXT: Record<LocationStatusKey, string> = {
  'permission-required': 'Location permission required',
  unavailable: 'Location unavailable',
  weak: 'Weak GPS accuracy',
  updating: 'Location updating',
  delayed: 'Location update delayed',
  'connection-lost': 'Connection lost',
  'not-sharing': 'Location not being shared',
};

export const LOCATION_STATUS_HELP: Record<LocationStatusKey, string> = {
  'permission-required': 'Allow location for Yatri in your phone settings to go online.',
  unavailable: 'Your phone could not get a GPS reading. Move to an open area.',
  weak: 'Your GPS signal is weak. Move to an open area for better accuracy.',
  updating: 'Your location is being sent to Yatri.',
  delayed: 'Yatri has not received a location update recently. Check your signal.',
  'connection-lost':
    'You are not connected to Yatri, so your location is NOT being shared. Reconnecting automatically.',
  'not-sharing': 'You are offline. Location sharing is off.',
};

export function locationStatusKey(s: PresenceState): LocationStatusKey {
  if (s.permission === 'denied' || s.permission === 'blocked') return 'permission-required';
  if (s.phase === 'offline' || s.phase === 'going-offline') return 'not-sharing';
  if (s.gps === 'unavailable' || s.gps === 'lost') return 'unavailable';
  if (s.sharing === 'connection-lost') return 'connection-lost';
  if (s.sharing === 'delayed') return 'delayed';
  if (s.gps === 'weak') return 'weak';
  return 'updating';
}

/** The full screen-reader description, e.g. "Status: Online. Location updating. Accuracy 8 meters…" */
export function describePresence(s: PresenceState, nowMs: number): string[] {
  const key = locationStatusKey(s);
  const lines = [
    `Status: ${s.phase === 'online' ? 'Online' : s.phase === 'offline' ? 'Offline' : s.phase === 'going-online' ? 'Going online' : 'Going offline'}`,
  ];
  lines.push(
    `Location permission: ${s.permission === 'granted' ? 'Granted' : s.permission === 'unknown' ? 'Not asked yet' : s.permission === 'denied' ? 'Not allowed' : 'Blocked in settings'}`,
  );
  if (s.phase === 'online') {
    lines.push(`Location: ${LOCATION_STATUS_TEXT[key]}`);
    lines.push(`Current location: ${s.placeName ?? 'Place name unavailable'}`);
    lines.push(
      s.accuracyMeters === null
        ? 'Location accuracy: unknown'
        : `Location accuracy: ${Math.max(1, Math.round(s.accuracyMeters))} meters`,
    );
    lines.push(
      `Last update: ${s.lastAckAt ? ageText(Math.max(0, Math.round((nowMs - s.lastAckAt) / 1000))) : 'not confirmed yet'}`,
    );
    lines.push(`Connection: ${s.connection === 'live' ? 'Connected' : 'Not connected'}`);
  }
  return lines;
}
