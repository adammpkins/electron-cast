import type { SenderEnvironment } from "../../src/mirroring/sender/packet-router.ts";

/** A manual clock with timers, as a `SenderEnvironment` that records what the router sends. */
export class FakeEnvironment implements SenderEnvironment {
  time = 1_000_000;
  readonly sent: { at: number; packet: Buffer }[] = [];
  readonly maxPacketSize: number;
  private timers: { at: number; seq: number; cb: () => void }[] = [];
  private seq = 0;

  constructor(maxPacketSize = 1472) {
    this.maxPacketSize = maxPacketSize;
  }

  now(): number {
    return this.time;
  }

  sendPacket(packet: Buffer): void {
    this.sent.push({ at: this.time, packet: Buffer.from(packet) });
  }

  schedule(atMs: number, cb: () => void): () => void {
    const t = { at: atMs, seq: this.seq++, cb };
    this.timers.push(t);
    return () => {
      this.timers = this.timers.filter((x) => x !== t);
    };
  }

  /** Advance time, running timers in order. */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (next === undefined || next.at > end) break;
      this.timers.shift();
      this.time = Math.max(this.time, next.at);
      next.cb();
    }
    this.time = end;
  }

  takeSent(): Buffer[] {
    const out = this.sent.map((s) => s.packet);
    this.sent.length = 0;
    return out;
  }
}
