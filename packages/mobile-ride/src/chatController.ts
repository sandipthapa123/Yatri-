import {
  CHAT_MAX_LENGTH,
  TRIP_EVENT_META,
  counterpartLabel,
  describeTripEvent,
  type ChatHistory,
  type ChatMessage,
  type ServerRealtimeMessage,
  type TripEventRecord,
  type TripRole,
} from '@yatri/types';
import type { SpokenMessage } from '@yatri/mobile-location';

import type { ServerMessageBus } from './rideSocket';

export type OutgoingStatus = 'sending' | 'failed';
/** What the sender can be told about a message: on its way, sent, delivered, or read. */
export type MessageStatus = OutgoingStatus | 'sent' | 'delivered' | 'read';

export type ChatEntry =
  | {
      kind: 'message';
      key: string;
      at: string;
      mine: boolean;
      body: string;
      status: MessageStatus;
      seq: number | null;
      clientMessageId: string;
    }
  | { kind: 'system'; key: string; at: string; text: string; seq: number };

export interface ChatState {
  loaded: boolean;
  entries: ChatEntry[];
  unreadCount: number;
  canSend: boolean;
  closedReason: string | null;
  error: string | null;
  /** Spoken when a message arrives while the chat is not on screen (and, politely, while it is). */
  announcement: SpokenMessage | null;
}

export type ChatSocket = ServerMessageBus;

export interface ChatControllerOptions {
  tripId: string;
  /** Which side this device is on. */
  role: TripRole;
  socket: ChatSocket;
  api: {
    history(): Promise<ChatHistory>;
    send(clientMessageId: string, body: string): Promise<ChatMessage>;
    markRead(upToSeq: number): Promise<unknown>;
  };
  newId: () => string;
}

interface Pending {
  clientMessageId: string;
  body: string;
  at: string;
  status: OutgoingStatus;
}

/**
 * Trip chat, client side. The server owns order (`seq`), storage, delivery/read receipts and
 * who may write; this class only presents that state and keeps sending honest:
 *  - a message shows as "sending" until the server confirms it, "failed" (retryable, same
 *    client id so a retry can never post twice) if it did not;
 *  - unread is a count the server can reproduce after a reconnect, so it is reloaded then;
 *  - system messages are the server's trip events, worded by the shared describeTripEvent —
 *    they are shown in the list but never announced here (the event pipeline already speaks
 *    them once);
 *  - the other person's text is announced politely as it arrives, whether or not the chat is open.
 */
export class ChatController {
  private state: ChatState = {
    loaded: false,
    entries: [],
    unreadCount: 0,
    canSend: false,
    closedReason: null,
    error: null,
    announcement: null,
  };
  private listeners = new Set<() => void>();
  private messages = new Map<string, ChatMessage>(); // by message id
  private system = new Map<number, TripEventRecord>(); // by event seq
  private pending = new Map<string, Pending>();
  private highestSeq = 0;
  private lastReadSent = 0;
  private open = false;
  private messageId = 0;
  private unsubs: Array<() => void> = [];
  private started = false;
  private everLive = false;

  constructor(private readonly opts: ChatControllerOptions) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  getState = () => this.state;

  start() {
    if (this.started) return;
    this.started = true;
    this.unsubs.push(
      this.opts.socket.onMessage((m) => this.onSocket(m)),
      this.opts.socket.onConnectionChange((c) => {
        if (c !== 'live') return;
        if (this.everLive) void this.reload(); // catch up on anything sent while offline
        this.everLive = true;
      }),
    );
    void this.reload();
  }

  stop() {
    this.started = false;
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  /** The chat screen is showing: everything from the other person counts as read. */
  setOpen(open: boolean) {
    this.open = open;
    if (open) this.markReadNow();
  }

  async send(rawBody: string): Promise<boolean> {
    const body = rawBody.trim();
    if (!body) return false;
    if (body.length > CHAT_MAX_LENGTH) {
      this.set({ error: `Messages can be up to ${CHAT_MAX_LENGTH} characters.` });
      return false;
    }
    if (!this.state.canSend) return false;
    const clientMessageId = this.opts.newId();
    this.pending.set(clientMessageId, {
      clientMessageId,
      body,
      at: new Date().toISOString(),
      status: 'sending',
    });
    this.set({ error: null });
    this.rebuild();
    return this.deliver(clientMessageId);
  }

  /** Try a failed message again. Same client id: the server stores it once even if both got through. */
  async retry(clientMessageId: string): Promise<boolean> {
    const p = this.pending.get(clientMessageId);
    if (!p || p.status !== 'failed') return false;
    p.status = 'sending';
    this.rebuild();
    return this.deliver(clientMessageId);
  }

  private async deliver(clientMessageId: string): Promise<boolean> {
    const p = this.pending.get(clientMessageId);
    if (!p) return false;
    try {
      const saved = await this.opts.api.send(clientMessageId, p.body);
      this.pending.delete(clientMessageId);
      this.absorb(saved);
      this.rebuild();
      return true;
    } catch (e) {
      p.status = 'failed';
      const message = e instanceof Error ? e.message : 'The message could not be sent.';
      this.set({ error: message });
      // A closed chat (ride ended, window over) is not a retryable failure: drop it and say why.
      if (/CHAT_CLOSED/.test(String((e as { code?: string }).code ?? ''))) {
        this.pending.delete(clientMessageId);
        void this.reload();
      }
      this.rebuild();
      return false;
    }
  }

  private async reload() {
    try {
      const h = await this.opts.api.history();
      this.messages.clear();
      this.system.clear();
      for (const item of h.items) {
        if (item.kind === 'message') this.absorb(item.message);
        else this.system.set(item.event.seq, item.event);
      }
      this.set({
        loaded: true,
        canSend: h.canSend,
        closedReason: h.closedReason,
        unreadCount: h.unreadCount,
        error: null,
      });
      this.rebuild();
      if (this.open) this.markReadNow();
    } catch (e) {
      this.set({
        loaded: true,
        error: e instanceof Error ? e.message : 'Could not load the conversation.',
      });
    }
  }

  private absorb(m: ChatMessage) {
    this.messages.set(m.id, m);
    if (m.seq > this.highestSeq) this.highestSeq = m.seq;
  }

  private onSocket(m: ServerRealtimeMessage) {
    switch (m.type) {
      case 'chat_message': {
        const msg = m.message;
        if (msg.tripId !== this.opts.tripId || this.messages.has(msg.id)) return;
        if (msg.seq > this.highestSeq + 1) {
          void this.reload(); // a message was missed: refetch rather than show a gap
          return;
        }
        this.absorb(msg);
        this.pending.delete(msg.clientMessageId); // our own echo confirms it
        const theirs = msg.senderRole !== this.opts.role;
        if (theirs) {
          const who = counterpartLabel(this.opts.role);
          this.set({
            unreadCount: this.open ? this.state.unreadCount : this.state.unreadCount + 1,
            announcement: { id: ++this.messageId, text: `Message from ${who}: ${msg.body}` },
          });
          if (this.open) this.markReadNow();
        }
        this.rebuild();
        return;
      }
      case 'chat_receipt': {
        if (m.tripId !== this.opts.tripId) return;
        for (const [id, msg] of this.messages) {
          if (msg.senderRole !== this.opts.role || msg.seq > m.upToSeq) continue;
          this.messages.set(id, {
            ...msg,
            deliveredAt: msg.deliveredAt ?? m.at,
            readAt: m.kind === 'read' ? (msg.readAt ?? m.at) : msg.readAt,
          });
        }
        this.rebuild();
        return;
      }
      case 'trip_event': {
        const e = m.event;
        if (e.tripId !== this.opts.tripId || !TRIP_EVENT_META[e.type].chatVisible) return;
        if (this.system.has(e.seq)) return;
        this.system.set(e.seq, e);
        this.rebuild();
        // Closing/opening the window follows the ride, so refresh what is allowed.
        if (
          e.type === 'DRIVER_ASSIGNED' ||
          e.type === 'TRIP_COMPLETED' ||
          e.type === 'TRIP_CANCELLED'
        ) {
          void this.reload();
        }
        return;
      }
      default:
    }
  }

  private markReadNow() {
    const latestTheirs = [...this.messages.values()]
      .filter((m) => m.senderRole !== this.opts.role)
      .reduce((max, m) => Math.max(max, m.seq), 0);
    if (this.state.unreadCount !== 0) this.set({ unreadCount: 0 });
    if (latestTheirs === 0 || latestTheirs <= this.lastReadSent) return;
    this.lastReadSent = latestTheirs;
    void this.opts.api.markRead(latestTheirs).catch(() => {
      this.lastReadSent = 0; // try again next time the chat is shown
    });
  }

  private rebuild() {
    const entries: ChatEntry[] = [];
    for (const m of this.messages.values()) {
      const mine = m.senderRole === this.opts.role;
      entries.push({
        kind: 'message',
        key: m.id,
        at: m.createdAt,
        mine,
        body: m.body,
        status: !mine ? 'sent' : m.readAt ? 'read' : m.deliveredAt ? 'delivered' : 'sent',
        seq: m.seq,
        clientMessageId: m.clientMessageId,
      });
    }
    for (const p of this.pending.values()) {
      entries.push({
        kind: 'message',
        key: `pending-${p.clientMessageId}`,
        at: p.at,
        mine: true,
        body: p.body,
        status: p.status,
        seq: null,
        clientMessageId: p.clientMessageId,
      });
    }
    for (const e of this.system.values()) {
      entries.push({
        kind: 'system',
        key: `event-${e.seq}`,
        at: e.createdAt,
        text: describeTripEvent(e, this.opts.role),
        seq: e.seq,
      });
    }
    // The server's seq orders people's messages; time interleaves system lines between them.
    entries.sort((a, b) => a.at.localeCompare(b.at) || (a.seq ?? Infinity) - (b.seq ?? Infinity));
    this.set({ entries });
  }

  private set(patch: Partial<ChatState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
