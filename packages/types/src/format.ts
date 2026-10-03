/**
 * Plain-language formatting shared by the API (system messages, notifications) and every
 * app (screen-reader text). ONE implementation: spoken words, never symbols, so TTS reads
 * "85 meters" and "3 minutes" correctly. Do not re-implement these in an app.
 */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters) || meters < 0) return 'unknown distance';
  if (meters < 1000) {
    const rounded = Math.round(meters);
    return `${rounded} ${rounded === 1 ? 'meter' : 'meters'}`;
  }
  const km = Math.round(meters / 100) / 10;
  return `${km} ${km === 1 ? 'kilometre' : 'kilometres'}`;
}

/** "45 seconds", "3 minutes", "1 hour 5 minutes". */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return 'unknown time';
  if (totalSeconds < 60) {
    // Round to 5 s so a ticking value doesn't churn the text every second.
    const s = Math.max(5, Math.round(totalSeconds / 5) * 5);
    return s >= 60 ? '1 minute' : `${s} seconds`;
  }
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = `${h} ${h === 1 ? 'hour' : 'hours'}`;
  return m === 0 ? hours : `${hours} ${m} ${m === 1 ? 'minute' : 'minutes'}`;
}

/** Exact elapsed time for timers: "2 minutes 5 seconds" (used where seconds matter, e.g. waiting). */
export function formatElapsed(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return 'unknown time';
  const s = Math.floor(totalSeconds);
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return `${rest} ${rest === 1 ? 'second' : 'seconds'}`;
  const minutes = `${m} ${m === 1 ? 'minute' : 'minutes'}`;
  return rest === 0 ? minutes : `${minutes} ${rest} ${rest === 1 ? 'second' : 'seconds'}`;
}

/** "NPR 450" — whole rupees. */
export function formatNpr(amount: number): string {
  return `NPR ${Math.round(amount)}`;
}

/** Eight-point compass word for a heading in degrees: 0 = north. */
export function compassWord(headingDegrees: number): string {
  const words = [
    'north',
    'north-east',
    'east',
    'south-east',
    'south',
    'south-west',
    'west',
    'north-west',
  ];
  const norm = ((headingDegrees % 360) + 360) % 360;
  return words[Math.round(norm / 45) % 8] as string;
}

/** The platform's own time zone: times are shown in it wherever a person reads them, whatever zone a server runs in. */
export const PLATFORM_TIME_ZONE = 'Asia/Kathmandu';

/**
 * A moment as a person reads it: "2 Oct 2026, 16:05" (or only the date, or only the time), always in the platform's time zone
 * and one fixed locale, so a page rendered on a server in another zone never shows a shifted time. `empty` is the words for
 * "no time" (for example "not yet").
 */
export function formatWhen(
  at: string | Date | null | undefined,
  opts: { style?: 'datetime' | 'date' | 'time'; empty?: string; timeZone?: string } = {},
): string {
  if (!at) return opts.empty ?? '';
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return opts.empty ?? '';
  const style = opts.style ?? 'datetime';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: opts.timeZone ?? PLATFORM_TIME_ZONE,
    ...(style !== 'time' ? { dateStyle: 'medium' as const } : {}),
    ...(style !== 'date' ? { timeStyle: 'short' as const } : {}),
  }).format(d);
}
