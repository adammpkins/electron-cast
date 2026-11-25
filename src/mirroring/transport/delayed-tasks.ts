/**
 * Delayed tasks for the sender's environment: what openscreen's `Alarm` (util/alarm.cc) gets from its `TaskRunner`,
 * which in Chrome is `openscreen_platform::TaskRunner` (components/openscreen_platform/task_runner.cc) posting to a
 * `base::SequencedTaskRunner`.
 *
 * Chrome's task runner runs a task that is already due without waiting (`PostTask`) and a short delay on time: on
 * Windows it switches the system timer to its high resolution while such a task is pending
 * (`base::Time::ActivateHighResolutionTimer`, base/time/time.h; a low-resolution timer is ~15.6 ms,
 * `kMinLowResolutionThresholdMs`). Node has neither: `setTimeout` waits at least 1 ms, and on Windows every wait ends
 * on the 15.6 ms system tick, so `setTimeout(0)` and `setTimeout(10)` both take about 15.6 ms. With the packet router
 * that made every burst late (62 bursts a second instead of 100, a frame waiting 8.5 ms on average and up to 30 ms
 * before its first packet left), which the receiver's acknowledgements and the in-flight accounting then carried.
 *
 * So a due task runs from `setImmediate`, which does not sleep, and a delayed one is woken by whichever comes first:
 * Node's timer, or a `WakeSource` that has a real high-resolution timer (the capture agent's renderer, whose timers
 * are Chromium's). A wake that comes early or late only decides when the queue is looked at: tasks never run before
 * their time.
 */

/** Something that can call back after a delay more punctually than Node's timers. A wake cannot be cancelled. */
export interface WakeSource {
  requestWake(delayMs: number, wake: () => void): void;
}

/** The timer functions used, replaceable in tests. */
export interface TimerFunctions {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setImmediate(cb: () => void): unknown;
  clearImmediate(handle: unknown): void;
}

const NODE_TIMERS: TimerFunctions = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setImmediate: (cb) => setImmediate(cb),
  clearImmediate: (handle) => clearImmediate(handle as ReturnType<typeof setImmediate>),
};

interface DelayedTask {
  /** When to run: the time asked for, or the time of asking when that had already passed. */
  at: number;
  seq: number;
  cb: () => void;
}

export class DelayedTaskQueue {
  /** Set while there is one (the capture agent, once the engine has its port). */
  wakeSource: WakeSource | undefined;
  private readonly now: () => number;
  private readonly timers: TimerFunctions;
  private readonly tasks = new Set<DelayedTask>();
  private seq = 0;
  private timer: unknown;
  private immediate: unknown;
  /** `Alarm::has_queued_fire_` / `next_fire_time_` / `current_fire_id_`, for the wake source. */
  private queuedWakeAt = Number.POSITIVE_INFINITY;
  private wakeId = 0;
  private closed = false;
  /** Where to write the timer statistics (a debug aid, not in openscreen). */
  debugLog: ((message: string) => void) | undefined;
  private stats = { since: Number.POSITIVE_INFINITY, tasks: 0, lateSum: 0, lateMax: 0, wakes: 0, byWake: 0 };

  constructor(now: () => number, timers: TimerFunctions = NODE_TIMERS) {
    this.now = now;
    this.timers = timers;
  }

  /** Run `cb` at `atMs` (at once, in a later task, when that is not in the future). Returns a cancel function. */
  schedule(atMs: number, cb: () => void): () => void {
    if (this.closed) return () => {};
    // `Alarm::ScheduleWithTask`: `alarm_time_ = std::max(now, desired_alarm_time)`.
    const task: DelayedTask = { at: Math.max(atMs, this.now()), seq: this.seq++, cb };
    this.tasks.add(task);
    this.arm();
    return () => {
      // A wake already asked for is left in place, as `Alarm::Cancel` leaves its queued firing.
      this.tasks.delete(task);
    };
  }

  /** Drop every task and timer. */
  close(): void {
    this.closed = true;
    this.tasks.clear();
    this.disarm();
    this.wakeId++;
  }

  private disarm(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.immediate !== undefined) this.timers.clearImmediate(this.immediate);
    this.immediate = undefined;
  }

  private earliest(): number {
    let earliest = Number.POSITIVE_INFINITY;
    for (const task of this.tasks) earliest = Math.min(earliest, task.at);
    return earliest;
  }

  /** Make sure something will call `run` when the earliest task is due. */
  private arm(): void {
    if (this.immediate !== undefined) return; // `run` is about to look at everything anyway.
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    const earliest = this.earliest();
    if (earliest === Number.POSITIVE_INFINITY) return;
    const now = this.now();
    if (earliest <= now) {
      // `PostTask`: Node's shortest timer would wait for a millisecond, and on Windows for the next system tick.
      this.immediate = this.timers.setImmediate(() => {
        this.immediate = undefined;
        this.run();
      });
      return;
    }
    // Rounded up, as a timer that fires early only has to be set again.
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.run();
    }, Math.ceil(earliest - now));
    // `Alarm::ScheduleWithTask`: a wake already on its way that is not too late is reused; it re-arms if it is early.
    if (this.wakeSource === undefined || this.queuedWakeAt <= earliest) return;
    this.queuedWakeAt = earliest;
    const id = ++this.wakeId;
    this.stats.wakes++;
    this.wakeSource.requestWake(earliest - now, () => {
      if (id !== this.wakeId) return; // Superseded by a later request, or closed.
      this.queuedWakeAt = Number.POSITIVE_INFINITY;
      this.run(true);
    });
  }

  /** Every five seconds: how late delayed tasks ran, and how many of them the wake source was first to. */
  private noteTask(now: number, lateMs: number, fromWakeSource: boolean): void {
    if (this.debugLog === undefined) return;
    const s = this.stats;
    if (s.since === Number.POSITIVE_INFINITY) s.since = now;
    s.tasks++;
    s.lateSum += lateMs;
    s.lateMax = Math.max(s.lateMax, lateMs);
    if (fromWakeSource) s.byWake++;
    if (now - s.since < 5000) return;
    const r = (n: number) => Math.round(n * 10) / 10;
    this.debugLog(
      `timers: ${s.tasks} tasks in ${r((now - s.since) / 1000)} s, late by mean ${r(s.lateSum / s.tasks)} ms, max ${r(s.lateMax)} ms; ` +
        `${s.wakes} wakes asked of the capture agent, ${s.byWake} tasks run by one`,
    );
    this.stats = { since: now, tasks: 0, lateSum: 0, lateMax: 0, wakes: 0, byWake: 0 };
  }

  /** `Alarm::TryInvoke` for every task: run those that are due, in time order, and wait again for the rest. */
  private run(fromWakeSource = false): void {
    if (this.closed) return;
    try {
      const now = this.now();
      if (now >= this.queuedWakeAt) {
        // The wake that was asked for is overdue (Node's timer got here first, or the source is gone): do not let it
        // stand in for later requests.
        this.queuedWakeAt = Number.POSITIVE_INFINITY;
        this.wakeId++;
      }
      const due = [...this.tasks].filter((task) => task.at <= now).sort((a, b) => a.at - b.at || a.seq - b.seq);
      for (const task of due) {
        // A task may have been cancelled by one that ran before it.
        if (!this.tasks.delete(task)) continue;
        this.noteTask(now, now - task.at, fromWakeSource);
        task.cb();
      }
    } finally {
      if (!this.closed) this.arm();
    }
  }
}
