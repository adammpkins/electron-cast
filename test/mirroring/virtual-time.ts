import { MAX_RTP_PACKET_SIZE_IPV4 } from "../../src/mirroring/protocol/constants.ts";
import type { SessionEnvironment } from "../../src/mirroring/sender/sender-session.ts";
import type { FakeReceiver } from "./fake-receiver.ts";

/**
 * A clock the test drives by hand. Events run in time order (ties in the order they were scheduled), and the
 * microtasks an event queues run before the next event, so a session behaves the same on every run and on any machine.
 */
export class VirtualClock {
  private time = 0;
  private seq = 0;
  private queue: { at: number; seq: number; cb: () => void; live: boolean }[] = [];

  now = (): number => this.time;

  schedule(at: number, cb: () => void): () => void {
    const entry = { at: Math.max(at, this.time), seq: this.seq++, cb, live: true };
    this.queue.push(entry);
    return () => {
      entry.live = false;
    };
  }

  setTimeout = (cb: () => void, ms: number): (() => void) => this.schedule(this.time + ms, cb);

  setInterval = (cb: () => void, ms: number): (() => void) => {
    let cancelled = false;
    const tick = (): void => {
      if (cancelled) return;
      cb();
      if (!cancelled) this.schedule(this.time + ms, tick);
    };
    this.schedule(this.time + ms, tick);
    return () => {
      cancelled = true;
    };
  };

  /** Run every event up to `ms` from now, then leave the clock there. */
  async advance(ms: number): Promise<void> {
    const target = this.time + ms;
    for (;;) {
      let next = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const e = this.queue[i]!;
        if (!e.live || e.at > target) continue;
        if (next < 0 || e.at < this.queue[next]!.at || (e.at === this.queue[next]!.at && e.seq < this.queue[next]!.seq)) next = i;
      }
      if (next < 0) break;
      const [event] = this.queue.splice(next, 1);
      this.time = event!.at;
      event!.cb();
      // Microtasks (queueMicrotask, resolved promises) settle before time moves on.
      for (let i = 0; i < 4; i++) await Promise.resolve();
      if (this.queue.length > 4096) this.queue = this.queue.filter((e) => e.live);
    }
    this.time = target;
  }
}

/** The sender side of an in-memory network to a `FakeReceiver`: no sockets, and a fixed one-way delay. */
export class VirtualEnvironment implements SessionEnvironment {
  readonly maxPacketSize = MAX_RTP_PACKET_SIZE_IPV4;
  private handler: ((arrivalTimeMs: number, packet: Buffer) => void) | undefined;
  receiver!: FakeReceiver;
  readonly clock: VirtualClock;
  private readonly oneWayDelayMs: number;

  constructor(clock: VirtualClock, oneWayDelayMs = 1) {
    this.clock = clock;
    this.oneWayDelayMs = oneWayDelayMs;
  }

  now(): number {
    return this.clock.now();
  }

  schedule(atMs: number, cb: () => void): () => void {
    return this.clock.schedule(atMs, cb);
  }

  setRemoteEndpoint(): void {}

  sendPacket(packet: Buffer): void {
    const copy = Buffer.from(packet);
    this.clock.schedule(this.clock.now() + this.oneWayDelayMs, () => this.receiver.deliver(copy));
  }

  consumeIncomingPackets(consumer: (arrivalTimeMs: number, packet: Buffer) => void): void {
    this.handler = consumer;
  }

  dropIncomingPackets(): void {
    this.handler = undefined;
  }

  /** The receiver's RTCP, after the same one-way delay. */
  fromReceiver(packet: Buffer): void {
    const copy = Buffer.from(packet);
    this.clock.schedule(this.clock.now() + this.oneWayDelayMs, () => this.handler?.(this.clock.now(), copy));
  }
}
