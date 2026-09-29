import {
  formatDistance,
  formatDuration,
  formatNpr,
  type ServerRealtimeMessage,
  type TripOfferInfo,
  type TripSummary,
} from '@yatri/types';

export interface SpokenMessage {
  id: number;
  text: string;
}

export interface OfferState {
  offer: TripOfferInfo | null;
  /** Local time the offer arrived — with its serverTime this gives a countdown that ignores clock skew. */
  receivedAtMs: number | null;
  responding: boolean;
  error: string | null;
  assertive: SpokenMessage | null;
  polite: SpokenMessage | null;
}

export interface OfferSocket {
  onMessage(listener: (m: ServerRealtimeMessage) => void): () => void;
  onConnectionChange(listener: (c: string) => void): () => void;
}

export interface OfferControllerOptions {
  socket: OfferSocket;
  api: {
    currentOffer(): Promise<TripOfferInfo | null>;
    respond(
      offerId: string,
      accept: boolean,
    ): Promise<{ accepted: boolean; trip: TripSummary | null }>;
  };
  now?: () => number;
}

/**
 * Seconds left to answer an offer. The SERVER decides when an offer expires (`expiresAt`); the
 * device only shows how long is left, measured from the server clock at send time so a wrong
 * phone clock cannot make an offer look longer or shorter than it is. Display only: accepting
 * after expiry is refused by the server regardless of this number.
 */
export function offerSecondsLeft(
  offer: TripOfferInfo,
  receivedAtMs: number,
  nowMs: number,
): number {
  const sentAt = Date.parse(offer.serverTime);
  const expiresAt = Date.parse(offer.expiresAt);
  const elapsedSinceSend = nowMs - receivedAtMs;
  return Math.max(0, Math.ceil((expiresAt - sentAt - elapsedSinceSend) / 1000));
}

export function describeOffer(o: TripOfferInfo, secondsLeft: number): string {
  return [
    'New ride request.',
    `Pickup ${o.pickup.name}, ${formatDistance(o.pickupDistanceMeters)} from you.`,
    `Destination ${o.destination.name}, ${formatDistance(o.tripDistanceMeters)} trip.`,
    `Fare ${formatNpr(o.fareEstimateNpr)}.`,
    `Respond within ${formatDuration(secondsLeft)}.`,
  ].join(' ');
}

const CLOSED_TEXT = {
  EXPIRED: 'The ride request expired.',
  TAKEN: 'Another driver took this ride.',
  CANCELLED: 'The passenger cancelled the request.',
  DECLINED: '',
} as const;

/**
 * The driver's current offer. The server pushes offers (and their closing), so nothing polls;
 * a reconnect re-reads the current offer, because an offer pushed while offline must not be lost.
 */
export class OfferController {
  private state: OfferState = {
    offer: null,
    receivedAtMs: null,
    responding: false,
    error: null,
    assertive: null,
    polite: null,
  };
  private listeners = new Set<() => void>();
  private unsubs: Array<() => void> = [];
  private messageId = 0;
  private everLive = false;

  constructor(private readonly opts: OfferControllerOptions) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getState = () => this.state;

  private now() {
    return (this.opts.now ?? Date.now)();
  }

  start() {
    this.unsubs.push(
      this.opts.socket.onMessage((m) => this.onSocket(m)),
      this.opts.socket.onConnectionChange((c) => {
        if (c !== 'live') return;
        void this.refresh(this.everLive);
        this.everLive = true;
      }),
    );
    void this.refresh(false);
  }

  stop() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.listeners.clear();
  }

  private async refresh(announce: boolean) {
    try {
      const offer = await this.opts.api.currentOffer();
      if (offer && offer.offerId !== this.state.offer?.offerId) this.show(offer, announce);
      else if (!offer && this.state.offer) this.set({ offer: null, receivedAtMs: null });
    } catch {
      /* the socket will push it */
    }
  }

  private show(offer: TripOfferInfo, announce: boolean) {
    const receivedAtMs = this.now();
    this.set({
      offer,
      receivedAtMs,
      error: null,
      ...(announce
        ? {
            assertive: {
              id: ++this.messageId,
              text: describeOffer(offer, offerSecondsLeft(offer, receivedAtMs, receivedAtMs)),
            },
          }
        : {}),
    });
  }

  private onSocket(m: ServerRealtimeMessage) {
    if (m.type === 'trip_offer') {
      if (m.offer.offerId !== this.state.offer?.offerId) this.show(m.offer, true);
    } else if (m.type === 'trip_offer_closed' && m.offerId === this.state.offer?.offerId) {
      const text = CLOSED_TEXT[m.reason];
      this.set({
        offer: null,
        receivedAtMs: null,
        responding: false,
        ...(text ? { polite: { id: ++this.messageId, text } } : {}),
      });
    }
  }

  /** Accept: resolves to the trip on success, null when the offer was already gone. */
  async accept(): Promise<TripSummary | null> {
    return this.respond(true);
  }
  async decline(): Promise<void> {
    await this.respond(false);
  }

  private async respond(accept: boolean): Promise<TripSummary | null> {
    const offer = this.state.offer;
    if (!offer || this.state.responding) return null;
    this.set({ responding: true, error: null });
    try {
      const r = await this.opts.api.respond(offer.offerId, accept);
      this.set({ offer: null, receivedAtMs: null, responding: false });
      if (accept && !r.accepted) {
        this.set({ polite: { id: ++this.messageId, text: 'That ride is no longer available.' } });
      }
      return r.accepted ? r.trip : null;
    } catch (e) {
      this.set({
        responding: false,
        offer: null,
        receivedAtMs: null,
        error: e instanceof Error ? e.message : 'Could not respond to the request.',
      });
      return null;
    }
  }

  private set(patch: Partial<OfferState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
