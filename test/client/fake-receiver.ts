import tls from "node:tls";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { encodeCastMessage, decodeCastMessage, frame, FrameDecoder, PayloadType, type CastMessage } from "../../src/protocol/index.ts";

export const NS_CONNECTION = "urn:x-cast:com.google.cast.tp.connection";
export const NS_HEARTBEAT = "urn:x-cast:com.google.cast.tp.heartbeat";
export const NS_RECEIVER = "urn:x-cast:com.google.cast.receiver";

const fx = (f: string) => readFileSync(new URL(`../fixtures/tls/${f}`, import.meta.url));

export interface FakeApp {
  appId: string;
  displayName: string;
  sessionId: string;
  transportId: string;
  statusText: string;
  namespaces: { name: string }[];
  isIdleScreen: boolean;
}

export interface Received extends CastMessage {
  json?: Record<string, unknown>;
}

/**
 * A minimal Cast receiver over TLS for tests. Speaks the real wire format using the library's own codec.
 * Behaviour can be tuned per test with the flags and `onMessage` hook.
 */
export class FakeReceiver {
  readonly received: Received[] = [];
  apps: FakeApp[] = [];
  volume = { level: 0.5, muted: false, controlType: "attenuation", stepInterval: 0.05 };
  autoPong = true;
  autoReply = true;
  launchError: string | null = null;
  /** Return true to suppress the default handling of a message. */
  onMessage: ((msg: Received) => boolean | void) | null = null;
  connections = 0;
  private server: tls.Server;
  private sockets = new Set<tls.TLSSocket>();
  private nextSession = 1;

  constructor() {
    this.server = tls.createServer({ key: fx("key.pem"), cert: fx("cert.pem") }, (socket) => this.accept(socket));
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Drop every client connection without a TLS close_notify. */
  kill(): void {
    for (const s of this.sockets) s.destroy();
  }

  send(msg: Omit<CastMessage, "protocolVersion" | "payloadType"> & { payloadType?: CastMessage["payloadType"] }): void {
    const full: CastMessage = { protocolVersion: 0, payloadType: PayloadType.STRING, ...msg } as CastMessage;
    for (const s of this.sockets) s.write(frame(encodeCastMessage(full)));
  }

  sendJson(namespace: string, sourceId: string, destinationId: string, payload: unknown): void {
    this.send({ namespace, sourceId, destinationId, payloadUtf8: JSON.stringify(payload) });
  }

  /** Write raw bytes to every client socket (for protocol-error tests). */
  writeRaw(bytes: Uint8Array): void {
    for (const s of this.sockets) s.write(bytes);
  }

  status(requestId = 0): Record<string, unknown> {
    return {
      type: "RECEIVER_STATUS",
      requestId,
      status: { applications: this.apps.map((a) => ({ ...a })), volume: { ...this.volume } },
    };
  }

  waitFor(pred: (m: Received) => boolean, timeoutMs = 2000): Promise<Received> {
    const found = this.received.find(pred);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("FakeReceiver.waitFor timed out")), timeoutMs);
      const check = setInterval(() => {
        const m = this.received.find(pred);
        if (m) {
          clearTimeout(t);
          clearInterval(check);
          resolve(m);
        }
      }, 5);
    });
  }

  private accept(socket: tls.TLSSocket): void {
    this.connections++;
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = new FrameDecoder();
    socket.on("data", (chunk: Buffer) => {
      for (const body of decoder.push(chunk)) {
        const msg: Received = decodeCastMessage(body);
        if (msg.payloadUtf8 !== undefined) {
          try {
            msg.json = JSON.parse(msg.payloadUtf8);
          } catch {}
        }
        this.received.push(msg);
        if (this.onMessage?.(msg)) continue;
        this.handle(msg);
      }
    });
  }

  private handle(msg: Received): void {
    const type = msg.json?.type;
    const requestId = msg.json?.requestId as number | undefined;
    const reply = (payload: unknown) => this.sendJson(msg.namespace, msg.destinationId, msg.sourceId, payload);
    if (msg.namespace === NS_HEARTBEAT && type === "PING" && this.autoPong) return reply({ type: "PONG" });
    if (msg.namespace !== NS_RECEIVER || !this.autoReply) return;
    if (type === "GET_STATUS") return reply(this.status(requestId));
    if (type === "LAUNCH") {
      if (this.launchError) return reply({ type: "LAUNCH_ERROR", requestId, reason: this.launchError });
      const appId = msg.json?.appId as string;
      const n = this.nextSession++;
      this.apps = [{
        appId,
        displayName: `App ${appId}`,
        sessionId: `session-${n}`,
        transportId: `transport-${n}`,
        statusText: "Ready",
        namespaces: [{ name: "urn:x-cast:com.example.test" }],
        isIdleScreen: false,
      }];
      return reply(this.status(requestId));
    }
    if (type === "STOP") {
      this.apps = this.apps.filter((a) => a.sessionId !== msg.json?.sessionId);
      return reply(this.status(requestId));
    }
    if (type === "SET_VOLUME") {
      Object.assign(this.volume, (msg.json?.volume ?? {}) as object);
      return reply(this.status(requestId));
    }
    if (type === "GET_APP_AVAILABILITY") {
      const ids = (msg.json?.appId ?? []) as string[];
      return reply({
        type: "GET_APP_AVAILABILITY",
        requestId,
        availability: Object.fromEntries(ids.map((id) => [id, id === "BADAPP00" ? "APP_UNAVAILABLE" : "APP_AVAILABLE"])),
      });
    }
    reply({ type: "INVALID_REQUEST", requestId, reason: "INVALID_COMMAND" });
  }
}
