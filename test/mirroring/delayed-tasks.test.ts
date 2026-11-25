import { test } from "node:test";
import assert from "node:assert/strict";
import { DelayedTaskQueue, type TimerFunctions } from "../../src/mirroring/transport/delayed-tasks.ts";
import { SenderPacketRouter, type RoutedSender, type SenderEnvironment } from "../../src/mirroring/sender/packet-router.ts";

interface ManualTimeout {
  at: number;
  ms: number;
  cb: () => void;
}

/**
 * Timers on a manual clock. `tickMs` makes `setTimeout` behave as Node's does on Windows, where a wait ends on the
 * next system tick (15.6 ms apart) at or after the time asked for.
 */
class ManualTimers implements TimerFunctions {
  time = 1000;
  readonly timeouts: ManualTimeout[] = [];
  readonly immediates: (() => void)[] = [];
  timeoutsSet = 0;
  private readonly tickMs: number;
  constructor(tickMs = 0) {
    this.tickMs = tickMs;
  }
  setTimeout(cb: () => void, ms: number): unknown {
    this.timeoutsSet++;
    const due = this.time + ms;
    const t: ManualTimeout = { at: this.tickMs > 0 ? Math.ceil(due / this.tickMs) * this.tickMs : due, ms, cb };
    this.timeouts.push(t);
    return t;
  }
  clearTimeout(handle: unknown): void {
    const i = this.timeouts.indexOf(handle as ManualTimeout);
    if (i >= 0) this.timeouts.splice(i, 1);
  }
  setImmediate(cb: () => void): unknown {
    this.immediates.push(cb);
    return cb;
  }
  clearImmediate(handle: unknown): void {
    const i = this.immediates.indexOf(handle as () => void);
    if (i >= 0) this.immediates.splice(i, 1);
  }
  runImmediates(): void {
    while (this.immediates.length > 0) this.immediates.shift()!();
  }
  /** Advance to `time`, running immediates, the timeouts that come due on the way, and the `alsoAt` events. */
  advanceTo(time: number, alsoAt: { at: number; run: () => void }[] = []): void {
    for (;;) {
      this.runImmediates();
      this.timeouts.sort((a, b) => a.at - b.at);
      alsoAt.sort((a, b) => a.at - b.at);
      const timeout = this.timeouts[0];
      const other = alsoAt[0];
      const next = Math.min(timeout?.at ?? Infinity, other?.at ?? Infinity);
      if (next > time) break;
      this.time = Math.max(this.time, next);
      if (other !== undefined && other.at === next) {
        alsoAt.shift();
        other.run();
      } else {
        this.timeouts.shift();
        timeout!.cb();
      }
    }
    this.time = time;
    this.runImmediates();
  }
}

/** A wake source that records what was asked of it; the test decides when a wake arrives. */
class ManualWakes {
  readonly asked: { delayMs: number; wake: () => void }[] = [];
  requestWake(delayMs: number, wake: () => void): void {
    this.asked.push({ delayMs, wake });
  }
}

test("delayed tasks: a task that is already due runs from setImmediate, with no timer (PostTask)", () => {
  const timers = new ManualTimers();
  const queue = new DelayedTaskQueue(() => timers.time, timers);
  const ran: string[] = [];
  queue.schedule(Number.NEGATIVE_INFINITY, () => ran.push("immediately"));
  queue.schedule(timers.time, () => ran.push("now"));
  assert.deepEqual(ran, [], "never inside schedule()");
  assert.equal(timers.timeoutsSet, 0, "setTimeout would wait a millisecond, and a system tick on Windows");
  assert.equal(timers.immediates.length, 1);
  timers.runImmediates();
  assert.deepEqual(ran, ["immediately", "now"]);
});

test("delayed tasks: a delayed task is run by the wake source when that is first, and only once", () => {
  const timers = new ManualTimers();
  const wakes = new ManualWakes();
  const queue = new DelayedTaskQueue(() => timers.time, timers);
  queue.wakeSource = wakes;
  let ran = 0;
  queue.schedule(timers.time + 9.5, () => ran++);
  assert.equal(wakes.asked.length, 1);
  assert.equal(wakes.asked[0]!.delayMs, 9.5);
  assert.equal(timers.timeouts[0]!.ms, 10, "Node's timer is the fallback, rounded up");
  timers.time += 9.6;
  wakes.asked[0]!.wake();
  assert.equal(ran, 1);
  assert.equal(timers.timeouts.length, 0, "nothing left to wait for");
  timers.advanceTo(timers.time + 100);
  assert.equal(ran, 1);
});

test("delayed tasks: an early wake runs nothing and asks again (Alarm::TryInvoke)", () => {
  const timers = new ManualTimers();
  const wakes = new ManualWakes();
  const queue = new DelayedTaskQueue(() => timers.time, timers);
  queue.wakeSource = wakes;
  let ran = 0;
  queue.schedule(timers.time + 10, () => ran++);
  timers.time += 9;
  wakes.asked[0]!.wake();
  assert.equal(ran, 0, "a task never runs before its time");
  assert.equal(wakes.asked.length, 2);
  assert.equal(wakes.asked[1]!.delayMs, 1);
  timers.time += 1;
  wakes.asked[1]!.wake();
  assert.equal(ran, 1);
});

test("delayed tasks: a wake on its way is reused unless it would be too late, and a superseded one is ignored", () => {
  const timers = new ManualTimers();
  const wakes = new ManualWakes();
  const queue = new DelayedTaskQueue(() => timers.time, timers);
  queue.wakeSource = wakes;
  const ran: string[] = [];
  const start = timers.time;
  const cancel = queue.schedule(start + 10, () => ran.push("first"));
  cancel();
  queue.schedule(start + 20, () => ran.push("later"));
  assert.equal(wakes.asked.length, 1, "the wake at +10 comes before +20, so it is kept (Alarm::ScheduleWithTask)");
  queue.schedule(start + 5, () => ran.push("sooner"));
  assert.equal(wakes.asked.length, 2, "+10 is too late for +5");
  timers.time = start + 5;
  wakes.asked[1]!.wake();
  assert.deepEqual(ran, ["sooner"]);
  assert.equal(wakes.asked.length, 3, "and the rest is asked for again");
  assert.equal(wakes.asked[2]!.delayMs, 15);
  timers.time = start + 20;
  wakes.asked[0]!.wake();
  assert.deepEqual(ran, ["sooner"], "the wake that was superseded does nothing");
  wakes.asked[2]!.wake();
  assert.deepEqual(ran, ["sooner", "later"]);
});

test("delayed tasks: a wake source that never answers costs punctuality only, and is asked again afterwards", () => {
  const timers = new ManualTimers(15.6);
  const wakes = new ManualWakes();
  const queue = new DelayedTaskQueue(() => timers.time, timers);
  queue.wakeSource = wakes;
  const ranAt: number[] = [];
  const start = timers.time;
  queue.schedule(start + 10, () => ranAt.push(timers.time));
  timers.advanceTo(start + 40);
  assert.equal(ranAt.length, 1, "Node's timer ran it");
  assert.ok(ranAt[0]! >= start + 10 && ranAt[0]! <= start + 10 + 15.6);
  queue.schedule(timers.time + 10, () => ranAt.push(timers.time));
  assert.equal(wakes.asked.length, 2, "the overdue wake does not stand in for the new one");
});

test("delayed tasks: due tasks run in time order, a cancelled one does not run, and close drops everything", () => {
  const timers = new ManualTimers();
  const queue = new DelayedTaskQueue(() => timers.time, timers);
  const ran: string[] = [];
  const start = timers.time;
  let cancelC = (): void => {};
  queue.schedule(start + 3, () => ran.push("b"));
  queue.schedule(start + 1, () => {
    ran.push("a");
    cancelC();
  });
  cancelC = queue.schedule(start + 3, () => ran.push("c"));
  queue.schedule(start + 3, () => ran.push("d"));
  const cancelE = queue.schedule(start + 2, () => ran.push("e"));
  cancelE();
  timers.advanceTo(start + 5);
  assert.deepEqual(ran, ["a", "b", "d"]);
  queue.schedule(timers.time + 1, () => ran.push("after close"));
  queue.schedule(timers.time, () => ran.push("after close"));
  queue.close();
  timers.advanceTo(timers.time + 10);
  assert.deepEqual(ran, ["a", "b", "d"]);
  assert.equal(timers.timeouts.length + timers.immediates.length, 0);
  queue.schedule(timers.time, () => ran.push("after close"));
  assert.equal(timers.immediates.length, 0);
});

/** A sender with one RTP packet to send every 10 ms, like 10 ms audio frames, asking the router as each is ready. */
function runRouter(seconds: number, punctualWakes: boolean): { burstTimes: number[]; waits: number[] } {
  const timers = new ManualTimers(15.6);
  const queue = new DelayedTaskQueue(() => timers.time, timers);
  const pending: { at: number; run: () => void }[] = [];
  // A wake source as punctual as a Chromium timer: it answers when asked, on the manual clock.
  if (punctualWakes) queue.wakeSource = { requestWake: (delayMs, wake) => pending.push({ at: timers.time + delayMs, run: wake }) };
  const burstTimes: number[] = [];
  const waits: number[] = [];
  const env: SenderEnvironment = {
    now: () => timers.time,
    maxPacketSize: 1472,
    sendPacket: () => {
      if (burstTimes.at(-1) !== timers.time) burstTimes.push(timers.time);
    },
    schedule: (atMs, cb) => queue.schedule(atMs, cb),
  };
  const router = new SenderPacketRouter(env);
  const queued: number[] = [];
  const sender: RoutedSender = {
    streamType: "audio",
    wasLastRtpPacketRetransmission: false,
    onReceivedRtcpPacket() {},
    getRtcpPacketForImmediateSend: () => undefined,
    getRtpPacketForImmediateSend: (sendTime) => {
      const readyAt = queued.shift();
      if (readyAt === undefined) return undefined;
      waits.push(sendTime - readyAt);
      return Buffer.alloc(200);
    },
    getRtpResumeTime: () => (queued.length > 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY),
  };
  router.onSenderCreated(1, sender);
  const start = timers.time;
  // Every other frame is ready a little before its 10 ms boundary, so the router has to wait out its burst interval:
  // the case a timer decides.
  for (let i = 0; i < seconds * 100; i++) {
    pending.push({
      at: start + i * 10 + (i % 2 === 0 ? 0 : -0.3),
      run: () => {
        queued.push(timers.time);
        router.requestRtpSend(1);
      },
    });
  }
  timers.advanceTo(start + seconds * 1000 + 50, pending);
  return { burstTimes, waits };
}

test("packet router: with a punctual wake source a 10 ms stream goes out in 100 bursts a second, as on Chrome's task runner", () => {
  const { burstTimes, waits } = runRouter(2, true);
  assert.equal(burstTimes.length, 200);
  assert.ok(Math.max(...waits) <= 0.3 + 1e-6, `a frame waits only for the burst interval, not for a system tick (max ${Math.max(...waits)} ms)`);
});

test("packet router: Node's timers alone, on a 15.6 ms tick, send the same stream late (the fallback, and what the wake source is for)", () => {
  const { burstTimes, waits } = runRouter(2, false);
  assert.ok(burstTimes.length < 140, `bursts fall onto the system tick (${burstTimes.length} in 2 s)`);
  assert.ok(Math.max(...waits) > 10);
  assert.equal(waits.length, 200, "every frame is still sent");
});
