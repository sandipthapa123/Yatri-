import type { ConnectivityState } from '@yatri/mobile-auth';

import { ageText } from './tripText';

/** How long "Back online" stays on screen after the connection returns. */
export const RECOVERED_NOTICE_MS = 6000;

export type ConnectivityNoticeKind = 'offline' | 'recovered' | 'none';

export interface ConnectivityNotice {
  kind: ConnectivityNoticeKind;
  /** The visible line, the same words a screen reader announces. */
  title: string;
  /** What it means for the person, without alarm and without guessing about their ride. */
  detail: string;
}

/**
 * What to tell the person about their connection, in words (never colour alone). Offline says the screens may be out of
 * date and how old the last update is; it does not claim anything about the ride, which the server keeps. Recovery says
 * the app has caught up, since the apps re-fetch the server's state on reconnect.
 */
export function connectivityNotice(state: ConnectivityState, nowMs: number): ConnectivityNotice {
  if (state.status === 'offline') {
    const since =
      state.lastOkAt !== null
        ? ` Last updated ${ageText(Math.max(0, Math.round((nowMs - state.lastOkAt) / 1000)))}.`
        : '';
    return {
      kind: 'offline',
      title: 'You are offline.',
      detail: `What you see may be out of date.${since} Your ride is kept by Yatri. Reconnecting automatically.`,
    };
  }
  if (state.recoveredAt !== null && nowMs - state.recoveredAt < RECOVERED_NOTICE_MS) {
    return { kind: 'recovered', title: 'Back online.', detail: 'Your screen is up to date again.' };
  }
  return { kind: 'none', title: '', detail: '' };
}
