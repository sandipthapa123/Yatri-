import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import WebSocket from 'ws';

import { app } from './helpers';
import {
  attachRealtimeGateway,
  REALTIME_PATH,
  type RealtimeGateway,
} from '../modules/realtime/gateway';

/** A real HTTP server + realtime gateway on an ephemeral port, shared by the websocket suites. */
export async function startTestServer(): Promise<{
  port: number;
  gateway: RealtimeGateway;
  close: () => Promise<void>;
}> {
  const server: Server = createServer(app);
  const gateway = await attachRealtimeGateway(server);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    gateway,
    close: async () => {
      await gateway.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export type Msg = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export class Client {
  msgs: Msg[] = [];
  closed: { code: number } | null = null;
  private cursor = 0;
  private waiters: Array<() => void> = [];
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      this.msgs.push(JSON.parse(d.toString()));
      this.waiters.forEach((w) => w());
    });
    ws.on('close', (code) => {
      this.closed = { code };
      this.waiters.forEach((w) => w());
    });
  }
  static async connect(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_PATH}`);
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
    });
    return new Client(ws);
  }
  send(m: object) {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor(pred: (m: Msg) => boolean, timeoutMs = 4000): Promise<Msg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      while (this.cursor < this.msgs.length) {
        const m = this.msgs[this.cursor++] as Msg;
        if (pred(m)) return m;
      }
      if (this.closed) throw new Error(`socket closed (${this.closed.code}) while waiting`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout; got ${JSON.stringify(this.msgs.slice(-4))}`);
      await new Promise<void>((res) => {
        const t = setTimeout(res, left);
        this.waiters.push(() => {
          clearTimeout(t);
          res();
        });
      });
    }
  }
  async expectNothing(pred: (m: Msg) => boolean, ms = 400) {
    const from = this.msgs.length;
    await new Promise((r) => setTimeout(r, ms));
    expect(this.msgs.slice(from).filter(pred)).toEqual([]);
  }
  async close() {
    if (this.closed) return;
    this.ws.close();
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Opens a socket, authenticates, and resolves once the server says `authed`. */
export async function login(port: number, token: string): Promise<Client> {
  const c = await Client.connect(port);
  c.send({ type: 'auth', token });
  await c.waitFor((m) => m.type === 'authed');
  return c;
}
