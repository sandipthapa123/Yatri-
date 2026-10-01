import { connectivity } from '@yatri/mobile-auth';
import { quickFix } from '@yatri/mobile-location';
import type { TripRole } from '@yatri/types';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useUiPreferences } from '@yatri/mobile-ui';
import {
  AccessibilityInfo,
  AppState,
  findNodeHandle,
  Platform,
  Vibration,
  type Text,
} from 'react-native';

import { CallController, type CallSocket, type CallUiState } from './callController';
import { ChatController, type ChatSocket, type ChatState } from './chatController';
import { SosController, type SosState } from './sosController';
import { OfferController, type OfferSocket, type OfferState } from './offerController';
import { rideApi } from './rideApi';
import type { ServerMessageBus } from './rideSocket';
import { createNativeRtc } from './webrtcAdapter';

type Store<S> = { subscribe: (l: () => void) => () => void; getState: () => S };

/** Read a framework-free controller's state. */
export function useStore<S>(store: Store<S> | null, idle: S): S {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getState : () => idle,
  );
}
const noopSubscribe = () => () => undefined;

/** A ticking clock for on-screen timers (display only — never announced, never authoritative). */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs, enabled]);
  return now;
}

/** iOS VoiceOver ignores live regions, so speak explicitly there; elsewhere the live region speaks. */
export function useSpeakOnIos(message: { id: number; text: string } | null) {
  const { speakUpdates } = useUiPreferences(); // the person can turn the app's own speaking off
  useEffect(() => {
    if (message && speakUpdates && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(message.text);
    }
  }, [message, speakUpdates]);
}

/**
 * A short vibration with an important (assertive) update, when the person has not turned vibration feedback off, so
 * the news does not depend on sound or on looking at the screen. Once per message; never for routine ones.
 */
export function useVibrateOnUrgent(message: { id: number; text: string } | null) {
  const { hapticFeedback } = useUiPreferences();
  const id = message?.id ?? null;
  useEffect(() => {
    if (id !== null && hapticFeedback) Vibration.vibrate(200);
  }, [id, hapticFeedback]);
}

/**
 * Move the screen reader's focus to an element when something replaces what was on screen (a
 * confirmation opens, a form appears), so a screen-reader or switch user lands on it instead of being
 * left on a control that is no longer there. Attach the returned ref to the element's Text. It only
 * moves while `active` is true, waits a moment for the element to be laid out, and does nothing when
 * no screen reader is running (setAccessibilityFocus is a no-op then).
 */
export function useFocusWhen(active: boolean) {
  const ref = useRef<Text>(null);
  useEffect(() => {
    if (!active) return;
    const timer = setTimeout(() => {
      const node = ref.current ? findNodeHandle(ref.current) : null;
      if (node) AccessibilityInfo.setAccessibilityFocus(node);
    }, 150);
    return () => clearTimeout(timer);
  }, [active]);
  return ref;
}

const IDLE_CHAT: ChatState = {
  loaded: false,
  entries: [],
  unreadCount: 0,
  canSend: false,
  closedReason: null,
  error: null,
  announcement: null,
};

let idCounter = 0;
const newClientMessageId = () =>
  `m-${Date.now().toString(36)}-${(++idCounter).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function useChat(opts: {
  socket: ChatSocket | null;
  tripId: string;
  role: TripRole;
  getAccessToken: () => Promise<string>;
}) {
  const { socket, tripId, role, getAccessToken } = opts;
  const controller = useMemo(
    () =>
      socket
        ? new ChatController({
            tripId,
            role,
            socket,
            newId: newClientMessageId,
            api: {
              history: async () => rideApi.chatHistory(await getAccessToken(), tripId),
              send: async (cid, body) =>
                rideApi.chatSend(await getAccessToken(), tripId, cid, body),
              markRead: async (upTo) => rideApi.chatRead(await getAccessToken(), tripId, upTo),
            },
          })
        : null,
    [socket, tripId, role, getAccessToken],
  );
  useEffect(() => {
    controller?.start();
    return () => controller?.stop();
  }, [controller]);
  return { state: useStore(controller, IDLE_CHAT), controller };
}

const IDLE_CALL: CallUiState = {
  phase: 'idle',
  call: null,
  outgoing: false,
  media: 'none',
  mediaSupported: false,
  muted: false,
  speaker: false,
  cameraOn: false,
  videoPausedByApp: false,
  quality: null,
  remoteStreamUrl: null,
  error: null,
  polite: null,
  assertive: null,
};

export function useCall(opts: {
  socket: CallSocket | null;
  tripId: string;
  role: TripRole;
  getAccessToken: () => Promise<string>;
}) {
  const { socket, tripId, role, getAccessToken } = opts;
  const controller = useMemo(
    () =>
      socket
        ? new CallController({
            tripId,
            role,
            socket,
            rtc: createNativeRtc(),
            api: {
              activeCall: async () => rideApi.activeCall(await getAccessToken(), tripId),
              iceServers: async () => rideApi.iceServers(await getAccessToken(), tripId),
            },
          })
        : null,
    [socket, tripId, role, getAccessToken],
  );
  useEffect(() => {
    controller?.start();
    // Calls keep audio in the background; video pauses (the controller decides).
    const sub = AppState.addEventListener('change', (s) =>
      controller?.setAppActive(s === 'active'),
    );
    return () => {
      sub.remove();
      controller?.dispose();
    };
  }, [controller]);
  return { state: useStore(controller, IDLE_CALL), controller };
}

const IDLE_OFFER: OfferState = {
  offer: null,
  receivedAtMs: null,
  responding: false,
  error: null,
  assertive: null,
  polite: null,
};

export function useDriverOffers(socket: OfferSocket | null, getAccessToken: () => Promise<string>) {
  const controller = useMemo(
    () =>
      socket
        ? new OfferController({
            socket,
            api: {
              currentOffer: async () => rideApi.currentOffer(await getAccessToken()),
              respond: async (id, accept) =>
                rideApi.respondToOffer(await getAccessToken(), id, accept),
            },
          })
        : null,
    [socket, getAccessToken],
  );
  useEffect(() => {
    controller?.start();
    return () => controller?.stop();
  }, [controller]);
  return { state: useStore(controller, IDLE_OFFER), controller };
}

const IDLE_SOS: SosState = { sos: null, busy: null, error: null, assertive: null };

/** The person's own SOS for this ride; the position comes from a quick, permission-free read. */
export function useSos(opts: {
  socket: ServerMessageBus | null;
  tripId: string;
  getAccessToken: () => Promise<string>;
}) {
  const { socket, tripId, getAccessToken } = opts;
  const controller = useMemo(
    () =>
      socket
        ? new SosController({
            tripId,
            socket,
            api: {
              mine: async () => rideApi.mySos(await getAccessToken(), tripId),
              raise: async (body) => rideApi.sos(await getAccessToken(), tripId, body),
              cancel: async () => rideApi.cancelSos(await getAccessToken(), tripId),
            },
            getPosition: async () => quickFix(),
          })
        : null,
    [socket, tripId, getAccessToken],
  );
  useEffect(() => {
    controller?.start();
    return () => controller?.stop();
  }, [controller]);
  return { state: useStore(controller, IDLE_SOS), controller };
}

/**
 * Asks the server again, and only then trusts what it says, in the two moments a screen is most likely to be wrong:
 * the app coming back to the foreground, and the connection coming back after being lost. `refresh` must fetch the
 * authoritative state (never reuse what was on screen). The newest `refresh` is always the one called.
 */
export function useResyncOnReturn(refresh: () => void): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') latest.current();
    });
    let wasOffline = connectivity.getState().status === 'offline';
    const off = connectivity.subscribe(() => {
      const offline = connectivity.getState().status === 'offline';
      if (wasOffline && !offline) latest.current();
      wasOffline = offline;
    });
    return () => {
      sub.remove();
      off();
    };
  }, []);
}
