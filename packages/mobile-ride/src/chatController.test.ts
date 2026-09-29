import type {
  ChatHistory,
  ChatMessage,
  ServerRealtimeMessage,
  TripEventRecord,
} from '@yatri/types';
import { describe, expect, it, vi } from 'vitest';

import { ChatController, type ChatSocket } from './chatController';

const T0 = Date.UTC(2026, 0, 1, 10, 0, 0);
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

const msg = (
  seq: number,
  from: 'PASSENGER' | 'DRIVER',
  body: string,
  over: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: `m${seq}`,
  tripId: 't',
  seq,
  senderRole: from,
  body,
  clientMessageId: `c${seq}`,
  createdAt: at(seq * 10),
  deliveredAt: null,
  readAt: null,
  ...over,
});
const event = (seq: number, type: TripEventRecord['type'], s: number): TripEventRecord => ({
  tripId: 't',
  seq,
  type,
  payload: {},
  createdAt: at(s),
});

class FakeSocket implements ChatSocket {
  private ml = new Set<(m: ServerRealtimeMessage) => void>();
  private cl = new Set<(c: string) => void>();
  onMessage(l: (m: ServerRealtimeMessage) => void) {
    this.ml.add(l);
    return () => this.ml.delete(l);
  }
  onConnectionChange(l: (c: string) => void) {
    this.cl.add(l);
    return () => this.cl.delete(l);
  }
  push(m: ServerRealtimeMessage) {
    this.ml.forEach((l) => l(m));
  }
  connection(c: string) {
    this.cl.forEach((l) => l(c));
  }
}

const history = (over: Partial<ChatHistory> = {}): ChatHistory => ({
  items: [],
  unreadCount: 0,
  canSend: true,
  closedReason: null,
  ...over,
});

function setup(role: 'PASSENGER' | 'DRIVER' = 'PASSENGER', h: ChatHistory = history()) {
  const socket = new FakeSocket();
  let history$ = h;
  let n = 0;
  const api = {
    history: vi.fn(async () => history$),
    send: vi.fn(async (cid: string, body: string) =>
      msg(100, role, body, { clientMessageId: cid, id: `srv-${cid}` }),
    ),
    markRead: vi.fn(async () => ({})),
  };
  const c = new ChatController({ tripId: 't', role, socket, api, newId: () => `id-${++n}` });
  c.start();
  return { c, socket, api, setHistory: (x: ChatHistory) => (history$ = x) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('ChatController: history, order and system messages', () => {
  it('shows people’s messages and the server’s trip events in time order, worded per viewer', async () => {
    const { c } = setup(
      'PASSENGER',
      history({
        items: [
          { kind: 'system', at: at(5), event: event(2, 'DRIVER_ASSIGNED', 5) },
          { kind: 'message', at: at(10), message: msg(1, 'DRIVER', 'On my way') },
          { kind: 'system', at: at(15), event: event(3, 'DRIVER_ARRIVED', 15) },
        ],
        unreadCount: 1,
      }),
    );
    await flush();
    const s = c.getState();
    expect(s.loaded).toBe(true);
    expect(s.unreadCount).toBe(1);
    expect(
      s.entries.map((e) => (e.kind === 'system' ? e.text : `${e.mine ? 'me' : 'them'}: ${e.body}`)),
    ).toEqual(['Driver has been assigned.', 'them: On my way', 'Your driver has arrived.']);
  });

  it('adds new system messages live from trip events and ignores ones that are not for chat', async () => {
    const { c, socket } = setup();
    await flush();
    socket.push({ type: 'trip_event', event: event(4, 'DRIVER_WAITING', 30), important: false });
    socket.push({
      type: 'trip_event',
      event: event(5, 'DRIVER_LOCATION_LOST', 31),
      important: true,
    });
    socket.push({ type: 'trip_event', event: event(4, 'DRIVER_WAITING', 30), important: false }); // duplicate
    const sys = c.getState().entries.filter((e) => e.kind === 'system');
    expect(sys).toHaveLength(1);
    expect(sys[0]).toMatchObject({ text: 'Your driver has been waiting for a while.' });
    // and never announced by chat: the event pipeline already speaks it
    expect(c.getState().announcement).toBeNull();
  });
});

describe('ChatController: sending', () => {
  it('shows a message as sending, then sent once the server has it — and only once', async () => {
    const { c, socket, api } = setup();
    await flush();
    const done = c.send('  I am at the gate  ');
    expect(c.getState().entries[0]).toMatchObject({ body: 'I am at the gate', status: 'sending' });
    await done;
    expect(api.send).toHaveBeenCalledWith('id-1', 'I am at the gate');
    // the socket echo of the same message must not duplicate it
    socket.push({
      type: 'chat_message',
      message: msg(100, 'PASSENGER', 'I am at the gate', {
        clientMessageId: 'id-1',
        id: 'srv-id-1',
      }),
    });
    const mine = c.getState().entries.filter((e) => e.kind === 'message');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'sent', seq: 100 });
  });

  it('keeps a failed message, says so, and a retry reuses the same client id', async () => {
    const { c, api } = setup();
    await flush();
    api.send.mockRejectedValueOnce(new Error('Network request failed'));
    expect(await c.send('Hello')).toBe(false);
    expect(c.getState().error).toMatch(/network/i);
    expect(c.getState().entries[0]).toMatchObject({ status: 'failed', body: 'Hello' });
    expect(await c.retry('id-1')).toBe(true);
    expect(api.send).toHaveBeenLastCalledWith('id-1', 'Hello');
    expect(c.getState().entries.filter((e) => e.kind === 'message')).toHaveLength(1);
  });

  it('refuses empty, over-long and closed-chat sends without calling the server', async () => {
    const { c, api } = setup(
      'PASSENGER',
      history({ canSend: false, closedReason: 'Chat opens when a driver accepts.' }),
    );
    await flush();
    expect(await c.send('hello')).toBe(false);
    expect(c.getState().closedReason).toBe('Chat opens when a driver accepts.');
    const open = setup();
    await flush();
    expect(await open.c.send('   ')).toBe(false);
    expect(await open.c.send('x'.repeat(1001))).toBe(false);
    expect(open.c.getState().error).toMatch(/1000/);
    expect(api.send).not.toHaveBeenCalled();
    expect(open.api.send).not.toHaveBeenCalled();
  });
});

describe('ChatController: receiving, unread and receipts', () => {
  it('counts and announces the other person’s message when the chat is closed, once', async () => {
    const { c, socket } = setup('DRIVER');
    await flush();
    socket.push({ type: 'chat_message', message: msg(1, 'PASSENGER', 'I am in a red jacket') });
    socket.push({ type: 'chat_message', message: msg(1, 'PASSENGER', 'I am in a red jacket') }); // duplicate
    expect(c.getState().unreadCount).toBe(1);
    expect(c.getState().announcement?.text).toBe(
      'Message from the passenger: I am in a red jacket',
    );
  });

  it('marks messages read as they arrive while the chat is open, and when it is opened', async () => {
    const { c, socket, api } = setup('PASSENGER');
    await flush();
    socket.push({ type: 'chat_message', message: msg(1, 'DRIVER', 'Almost there') });
    expect(c.getState().unreadCount).toBe(1);
    c.setOpen(true);
    expect(c.getState().unreadCount).toBe(0);
    expect(api.markRead).toHaveBeenCalledWith(1);
    socket.push({ type: 'chat_message', message: msg(2, 'DRIVER', 'Here now') });
    expect(c.getState().unreadCount).toBe(0);
    expect(api.markRead).toHaveBeenLastCalledWith(2);
  });

  it('turns delivered/read receipts into the sender’s message status', async () => {
    const { c, socket } = setup(
      'PASSENGER',
      history({ items: [{ kind: 'message', at: at(10), message: msg(1, 'PASSENGER', 'Hi') }] }),
    );
    await flush();
    const status = () => (c.getState().entries[0] as { status: string }).status;
    expect(status()).toBe('sent');
    socket.push({ type: 'chat_receipt', tripId: 't', kind: 'delivered', upToSeq: 1, at: at(11) });
    expect(status()).toBe('delivered');
    socket.push({ type: 'chat_receipt', tripId: 't', kind: 'read', upToSeq: 1, at: at(12) });
    expect(status()).toBe('read');
  });

  it('reloads instead of showing a gap, and catches up after a reconnect', async () => {
    const { c, socket, api, setHistory } = setup('PASSENGER');
    await flush();
    setHistory(
      history({
        items: [
          { kind: 'message', at: at(10), message: msg(1, 'DRIVER', 'one') },
          { kind: 'message', at: at(20), message: msg(2, 'DRIVER', 'two') },
          { kind: 'message', at: at(30), message: msg(3, 'DRIVER', 'three') },
        ],
        unreadCount: 3,
      }),
    );
    socket.push({ type: 'chat_message', message: msg(3, 'DRIVER', 'three') }); // 1 and 2 were missed
    await flush();
    expect(api.history).toHaveBeenCalledTimes(2);
    expect(c.getState().entries.map((e) => (e.kind === 'message' ? e.body : ''))).toEqual([
      'one',
      'two',
      'three',
    ]);

    socket.connection('live'); // first connect: nothing to catch up
    await flush();
    expect(api.history).toHaveBeenCalledTimes(2);
    socket.connection('live'); // a later reconnect
    await flush();
    expect(api.history).toHaveBeenCalledTimes(3);
  });
});
