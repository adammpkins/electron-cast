import { EventEmitter } from "node:events";
import type { CastDevice } from "../../src/discovery/index.ts";
import type { ReceiverApplication, ReceiverStatus } from "../../src/client/index.ts";
import { CastRequestError, CastConnectionError } from "../../src/client/index.ts";
import type { BridgeEvent } from "../../src/polyfill/bridge-types.ts";

export function device(over: Partial<CastDevice> = {}): CastDevice {
  const id = over.id ?? "dev-tv";
  return {
    id,
    name: "Lounge Cast TV",
    model: "Chromecast",
    host: "10.0.0.10",
    addresses: ["10.0.0.10"],
    port: 8009,
    capabilities: 5, // video_out + audio_out
    isGroup: false,
    statusText: "",
    instanceName: `Chromecast-${id}._googlecast._tcp.local`,
    txt: {},
    ...over,
  };
}

export const TV = device();
export const SPEAKER = device({ id: "dev-speaker", name: "Study Room speaker", model: "Google Home Mini", host: "10.0.0.20", addresses: ["10.0.0.20"], capabilities: 4 });
export const GROUP = device({ id: "dev-group", name: "Upstairs group", model: "Google Cast Group", host: "10.0.0.30", addresses: ["10.0.0.30"], port: 32044, capabilities: 36, isGroup: true });

export class FakeDevices extends EventEmitter<{ deviceUp: [CastDevice]; deviceDown: [CastDevice]; deviceChanged: [CastDevice] }> {
  list: CastDevice[];
  /** Ids of devices a test has made unreachable: a test's createClient makes their clients fail to connect. */
  unreachable = new Set<string>();
  constructor(list: CastDevice[] = [TV, SPEAKER, GROUP]) {
    super();
    this.list = list;
  }
  devices(): CastDevice[] {
    return this.list.map((d) => ({ ...d }));
  }
  up(d: CastDevice): void {
    this.list.push(d);
    this.emit("deviceUp", d);
  }
  down(d: CastDevice): void {
    this.list = this.list.filter((x) => x.id !== d.id);
    this.emit("deviceDown", d);
  }
}

export class FakeClient extends EventEmitter<{
  message: [{ namespace: string; sourceId: string; destinationId: string; data: string | Buffer }];
  receiverStatus: [ReceiverStatus];
  transportClosed: [string];
  close: [Error?];
}> {
  readonly device: CastDevice;
  readonly senderId = "sender-fake0001";
  connected = false;
  connectError: Error | null = null;
  connectDelayMs = 0;
  launchError: Error | null = null;
  launchDelayMs = 0;
  /** `LAUNCH_STATUS` values the fake receiver sends before the launch resolves. */
  launchStatuses: string[] = [];
  apps: ReceiverApplication[] = [];
  volume = { level: 0.5, muted: false, controlType: "attenuation", stepInterval: 0.05 };
  sent: { namespace: string; destinationId: string; payload: unknown }[] = [];
  transports = new Set<string>();
  calls: string[] = [];
  closed = false;
  /** Like CastClient: every reply that carries a status is also emitted as receiverStatus before the call resolves. */
  echoReplies = false;
  private n = 0;

  constructor(device: CastDevice) {
    super();
    this.device = device;
  }

  status(): ReceiverStatus {
    return { applications: this.apps.map((a) => ({ ...a })), volume: { ...this.volume } };
  }

  async connect(): Promise<void> {
    this.calls.push("connect");
    if (this.connectDelayMs) await new Promise((r) => setTimeout(r, this.connectDelayMs));
    if (this.connectError) throw this.connectError;
    this.connected = true;
  }

  close(): void {
    this.calls.push("close");
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.emit("close");
  }

  /** Simulate the device dropping the connection. */
  fail(): void {
    this.connected = false;
    this.closed = true;
    this.emit("close", new CastConnectionError("heartbeat timeout"));
  }

  send(namespace: string, destinationId: string, payload: unknown): void {
    if (!this.connected) throw new CastConnectionError("not connected");
    this.sent.push({ namespace, destinationId, payload });
  }

  private echo(): void {
    if (this.echoReplies) this.emit("receiverStatus", this.status());
  }

  /** Apps the device reports as available; null means every one. */
  availableApps: string[] | null = null;
  availabilityDelayMs = 0;
  async getAppAvailability(appIds: string[]): Promise<Record<string, boolean>> {
    this.calls.push(`availability ${appIds.join(",")}`);
    if (this.availabilityDelayMs) await new Promise((r) => setTimeout(r, this.availabilityDelayMs));
    if (!this.connected) throw new CastConnectionError("not connected");
    return Object.fromEntries(appIds.map((id) => [id, this.availableApps === null || this.availableApps.includes(id)]));
  }

  async launch(appId: string, options?: { onStatus?: (status: never) => void }): Promise<ReceiverApplication> {
    this.calls.push(`launch ${appId}`);
    if (!this.connected) throw new CastConnectionError("not connected");
    for (const status of this.launchStatuses) options?.onStatus?.(status as never);
    if (this.launchDelayMs) await new Promise((r) => setTimeout(r, this.launchDelayMs));
    if (this.launchError) throw this.launchError;
    const k = ++this.n;
    const app: ReceiverApplication = {
      appId,
      displayName: "YouTube",
      sessionId: `${this.device.id}-session-${k}`,
      transportId: `${this.device.id}-transport-${k}`,
      statusText: "YouTube",
      namespaces: [{ name: "urn:x-cast:com.google.youtube.mdx" }],
      iconUrl: "https://example.test/yt.png",
    };
    this.apps = [app];
    this.echo();
    return { ...app };
  }

  async stop(sessionId: string): Promise<ReceiverStatus> {
    this.calls.push(`stop ${sessionId}`);
    this.apps = this.apps.filter((a) => a.sessionId !== sessionId);
    this.echo();
    return this.status();
  }

  async setVolume(v: { level: number } | { muted: boolean }): Promise<ReceiverStatus> {
    this.calls.push(`volume ${JSON.stringify(v)}`);
    Object.assign(this.volume, v);
    this.echo();
    return this.status();
  }

  async getStatus(): Promise<ReceiverStatus> {
    this.echo();
    return this.status();
  }

  connectTransport(id: string): void {
    this.calls.push(`connectTransport ${id}`);
    this.transports.add(id);
  }

  closeTransport(id: string): void {
    this.calls.push(`closeTransport ${id}`);
    this.transports.delete(id);
  }

  /** Push an unsolicited RECEIVER_STATUS. */
  pushStatus(): void {
    this.emit("receiverStatus", this.status());
  }

  /** Push an app message from the given transport. */
  pushMessage(sourceId: string, namespace: string, data: string | Buffer): void {
    this.emit("message", { namespace, sourceId, destinationId: this.senderId, data });
  }
}

export function launchError(reason: string): CastRequestError {
  return new CastRequestError({ type: "LAUNCH_ERROR", requestId: 1, reason });
}

export class EventLog {
  events: { senderId: number; event: BridgeEvent }[] = [];
  readonly emit = (senderId: number, event: BridgeEvent) => {
    this.events.push({ senderId, event: JSON.parse(JSON.stringify(event)) });
  };
  of(senderId: number, type?: BridgeEvent["type"]): BridgeEvent[] {
    return this.events.filter((e) => e.senderId === senderId && (!type || e.event.type === type)).map((e) => e.event);
  }
  clear(): void {
    this.events = [];
  }
}

export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A frame of a {@link FramedWebContents}: what Electron's WebFrameMain exposes to the manager. */
export class FakeFrame {
  sent: { channel: string; payload: any }[] = [];
  readonly owner: FramedWebContents;
  readonly frameTreeNodeId: number;
  url: string;
  readonly parent: FakeFrame | null;
  processId: number;
  routingId: number;
  constructor(owner: FramedWebContents, frameTreeNodeId: number, url: string, parent: FakeFrame | null, processId: number, routingId: number) {
    this.owner = owner;
    this.frameTreeNodeId = frameTreeNodeId;
    this.url = url;
    this.parent = parent;
    this.processId = processId;
    this.routingId = routingId;
  }
  get origin(): string {
    return new URL(this.url).origin;
  }
  send(channel: string, payload: unknown): void {
    if (!this.owner.frames.includes(this)) throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    this.sent.push({ channel, payload: JSON.parse(JSON.stringify(payload)) });
  }
  /** Events of one kind that this frame received. */
  events(kind: "presentation" | "cast"): any[] {
    const channel = kind === "presentation" ? "electron-cast:presentation:event" : "electron-cast:event";
    return this.sent.filter((s) => s.channel === channel).map((s) => s.payload);
  }
}

/** A webContents with a frame tree. Its main frame is reached with `send`, a subframe only through `frame.send`. */
export class FramedWebContents extends EventEmitter {
  destroyed = false;
  frames: FakeFrame[] = [];
  private nodes = 100;
  private process = 50;
  readonly id: number;
  constructor(id: number, url = "https://music.youtube.com/") {
    super();
    this.id = id;
    this.frames.push(new FakeFrame(this, ++this.nodes, url, null, ++this.process, 1));
  }
  get main(): FakeFrame {
    return this.frames[0]!;
  }
  get mainFrame(): { framesInSubtree: FakeFrame[] } {
    return { framesInSubtree: [...this.frames] };
  }
  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error("Object has been destroyed");
    this.main.send(channel, payload);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
  addFrame(url: string): FakeFrame {
    const f = new FakeFrame(this, ++this.nodes, url, this.main, ++this.process, 1);
    this.frames.push(f);
    return f;
  }
  /** The iframe element was removed; Electron announces nothing. */
  removeFrame(f: FakeFrame): void {
    this.frames = this.frames.filter((x) => x !== f);
  }
  /** A frame navigates: like a cross-process navigation it comes back as a new frame object with new ids. */
  navigate(f: FakeFrame, url: string): FakeFrame {
    const next = new FakeFrame(this, f.frameTreeNodeId, url, f.parent, ++this.process, 1);
    this.frames = this.frames.map((x) => (x === f ? next : x));
    if (f.parent === null) this.emit("did-navigate", {}, url);
    this.emit("did-frame-navigate", {}, url, 200, "OK", f.parent === null, next.processId, next.routingId);
    return next;
  }
}

/** Chrome's delays (a random wait of up to 5 s before opening channels, a 3 s quiet before reporting) shortened to nothing. */
export const FAST_SINKS = { openDelayMaxMs: 0, reportDelayMs: 0 };

/**
 * Make a service's `handle` (and `observeAppAvailability`, when it has one) wait until its channels are open first, so
 * a test that sets up devices and calls at once sees them as sinks, which in production they become a moment after
 * discovery.
 */
export function waitForSinks<T extends { handle: (...a: any[]) => Promise<any>; settled(): Promise<void> }>(service: T): T {
  const handle = service.handle.bind(service);
  service.handle = async (...args: any[]) => {
    await service.settled();
    return handle(...args);
  };
  const target = service as T & { observeAppAvailability?: (...a: any[]) => { available: Promise<boolean>; close(): void } };
  const observe = target.observeAppAvailability?.bind(service);
  if (observe !== undefined) {
    target.observeAppAvailability = (...args: any[]) => {
      let inner: { available: Promise<boolean>; close(): void } | undefined;
      let closed = false;
      const available = service.settled().then(() => {
        if (closed) return false;
        inner = observe(...args);
        return inner.available;
      });
      return { available, close: () => { closed = true; inner?.close(); } };
    };
  }
  return service;
}

/** True when no client was used for anything but its channel (connecting and asking its status): no launch, stop, volume or transport. */
export const onlyChannels = (clients: FakeClient[]): boolean => clients.every((c) => c.calls.every((x) => x === "connect"));

/**
 * A clock for tests of timers: `install()` replaces `setTimeout` and `clearTimeout`, and `advance(ms)` runs what comes due
 * in order, letting promises settle between timers. Nothing waits in real time. Do not call `service.settled()` under it
 * (that polls with a timer); advance instead.
 */
export class FakeClock {
  now = 0;
  /** The delay of every timer set while installed, in order. */
  delays: number[] = [];
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();
  private readonly realSet = globalThis.setTimeout;
  private readonly realClear = globalThis.clearTimeout;

  install(): this {
    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms = 0, ...args: unknown[]) => {
      const id = ++this.seq;
      this.delays.push(ms);
      this.timers.set(id, { at: this.now + Math.max(0, ms), fn: () => fn(...args) });
      return { id, unref() { return this; }, ref() { return this; }, hasRef: () => true, refresh() { return this; }, [Symbol.toPrimitive]: () => id };
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((t?: { id?: number }) => void (t?.id !== undefined && this.timers.delete(t.id))) as typeof clearTimeout;
    return this;
  }

  restore(): void {
    globalThis.setTimeout = this.realSet;
    globalThis.clearTimeout = this.realClear;
  }

  private async flush(): Promise<void> {
    for (let i = 0; i < 60; i++) await Promise.resolve();
  }

  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      await this.flush();
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (next === undefined || entry[1].at < next[1].at)) next = entry;
      if (next === undefined) break;
      this.timers.delete(next[0]);
      this.now = Math.max(this.now, next[1].at);
      next[1].fn();
    }
    this.now = end;
    await this.flush();
  }

  /** Timers still waiting. */
  get pending(): number {
    return this.timers.size;
  }
}

/**
 * Makes every timer of `minMs` or more fire at once (and records its delay), so a test goes through a retry backoff
 * without waiting. Short timers are left alone, so polling such as `settled()` still works. Call the returned function to
 * undo it.
 */
export function instantTimers(minMs: number, delays: number[] = []): () => void {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
    if (ms !== undefined && ms >= minMs) {
      delays.push(ms);
      return real(fn, 0, ...rest);
    }
    return real(fn, ms, ...rest);
  }) as typeof setTimeout;
  return () => {
    globalThis.setTimeout = real;
  };
}
