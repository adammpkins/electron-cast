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
  apps: ReceiverApplication[] = [];
  volume = { level: 0.5, muted: false, controlType: "attenuation", stepInterval: 0.05 };
  sent: { namespace: string; destinationId: string; payload: unknown }[] = [];
  transports = new Set<string>();
  calls: string[] = [];
  closed = false;
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

  async launch(appId: string): Promise<ReceiverApplication> {
    this.calls.push(`launch ${appId}`);
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
    return { ...app };
  }

  async stop(sessionId: string): Promise<ReceiverStatus> {
    this.calls.push(`stop ${sessionId}`);
    this.apps = this.apps.filter((a) => a.sessionId !== sessionId);
    return this.status();
  }

  async setVolume(v: { level: number } | { muted: boolean }): Promise<ReceiverStatus> {
    this.calls.push(`volume ${JSON.stringify(v)}`);
    Object.assign(this.volume, v);
    return this.status();
  }

  async getStatus(): Promise<ReceiverStatus> {
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
