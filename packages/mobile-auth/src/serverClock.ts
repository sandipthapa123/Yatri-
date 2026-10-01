/**
 * The server's clock, as far as this device can tell. Times in the app that mean "how long ago did the server see X"
 * (a driver's last location, an offer's remaining seconds) must be measured against the server, because a phone clock
 * can be minutes wrong. Every server answer carries its time (the `Date` header, and `serverTime` in live snapshots);
 * the offset between that and the device clock is kept here, preferring the reading with the least delay.
 */
export class ServerClock {
  private offsetMs = 0;
  private bestRoundTripMs = Infinity;
  private seen = false;

  constructor(private readonly deviceNow: () => number = Date.now) {}

  /**
   * `serverMs`: the server's time in the answer. `sentAtMs` / `receivedAtMs`: the device clock when the request left
   * and when the answer arrived (the server stamped it somewhere between the two).
   */
  observe(serverMs: number, sentAtMs: number, receivedAtMs: number): void {
    if (!Number.isFinite(serverMs)) return;
    const roundTrip = Math.max(0, receivedAtMs - sentAtMs);
    // A reading with a smaller round trip has a smaller possible error, so it replaces a worse one; a worse one only
    // counts when we have nothing yet or the clock has clearly drifted (the best reading is old).
    if (this.seen && roundTrip > this.bestRoundTripMs + 1000) return;
    this.offsetMs = serverMs - (sentAtMs + roundTrip / 2);
    this.bestRoundTripMs = roundTrip;
    this.seen = true;
  }

  /** The server's time now, in ms. Before any answer it is the device time. */
  now(): number {
    return this.deviceNow() + this.offsetMs;
  }

  /** How far the device clock is from the server's (positive: the device is behind). 0 until known. */
  get offset(): number {
    return this.offsetMs;
  }

  get known(): boolean {
    return this.seen;
  }
}

export const serverClock = new ServerClock();
