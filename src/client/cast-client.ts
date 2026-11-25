import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import tls from "node:tls";
import type { TLSSocket } from "node:tls";
import { decodeCastMessage, encodeCastMessage, frame, FrameDecoder, PayloadType } from "../protocol/index.ts";
import type { CastMessage } from "../protocol/index.ts";
import { NS, PLATFORM_RECEIVER_ID } from "./namespaces.ts";
import { CastAuthError, CastConnectionError, CastLaunchError, CastRequestError, CastTimeoutError } from "./errors.ts";
import { chromeSenderIdentity, connectFields, VIRTUAL_CONNECTION_INVISIBLE, VIRTUAL_CONNECTION_STRONG } from "./sender-info.ts";
import type { SenderIdentity } from "./sender-info.ts";
import { authenticateChallengeReply, createAuthChallenge } from "./auth/cast-auth.ts";
import type { DeviceAuthOptions, DeviceAuthResult } from "./auth/cast-auth.ts";
import type { ReceiverApplication, ReceiverStatus, ReceiverVolume } from "./types.ts";

/** Options for {@link CastClient}. */
export interface CastClientOptions {
  host: string;
  port?: number;
  senderId?: string;
  connectTimeoutMs?: number;
  /**
   * How long GET_APP_AVAILABILITY, STOP, SET_VOLUME and GET_STATUS wait for their reply. Default 5000, Chrome's
   * `kRequestTimeout` (cast_message_handler.h). Chrome sends GET_STATUS without waiting for the answer; this client
   * waits for it, so it gets the same bound.
   */
  requestTimeoutMs?: number;
  /** How long a LAUNCH waits for the receiver. Default 60000, Chrome's `CastMediaSource` `kDefaultLaunchTimeout`. */
  launchTimeoutMs?: number;
  /** Idle time before a PING is sent. Default 5000. */
  heartbeatIntervalMs?: number;
  /** Idle time before the connection is taken as dead. Default 10000. */
  heartbeatTimeoutMs?: number;
  /**
   * What CONNECT and LAUNCH tell the receiver about the sender (user agent, browser version, locale, platform). The
   * defaults are what Chrome on this machine sends; override for tests.
   */
  sender?: Partial<SenderIdentity>;
  tls?: Omit<tls.ConnectionOptions, "host" | "port">;
  connectPayload?: Record<string, unknown>;
  /**
   * Verify the device is a genuine Google-certified Cast device before use, as Chrome does (default true). A device
   * that fails makes {@link CastClient.connect} reject with a {@link CastAuthError}. Set false to talk to
   * uncertified receivers such as open-source ones.
   */
  verifyDevice?: boolean;
  /** How long to wait for the device's authentication reply after the TLS handshake. Default 10000. */
  authTimeoutMs?: number;
  /** Trust roots and clock overrides for device authentication; for tests and private Cast deployments. */
  deviceAuth?: DeviceAuthOptions;
}

/** Events emitted by {@link CastClient}. */
export interface CastClientEvents {
  message: [msg: { namespace: string; sourceId: string; destinationId: string; data: string | Buffer }];
  /**
   * A message the caller's requests put on the channel (`send`, `request`, `launch`, `stop`, `setVolume`, `getStatus`, a
   * closed transport), as `CastMessageHandler::Observer::OnMessageSent` reports the ones `SendCastMessageToSocket` sends. The
   * handshake, device authentication, virtual connection requests and keep-alive are not reported, as in Chrome.
   */
  messageSent: [msg: { namespace: string; sourceId: string; destinationId: string; data: string | Buffer }];
  receiverStatus: [status: ReceiverStatus];
  transportClosed: [transportId: string];
  close: [error?: Error];
}

interface PendingRequest {
  namespace: string;
  destinationId: string;
  timer: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface LaunchWaiter {
  appId: string;
  requestId: number;
  onStatus: ((status: LaunchStatus) => void) | undefined;
  timer: NodeJS.Timeout;
  resolve: (app: ReceiverApplication) => void;
  reject: (err: unknown) => void;
}

/**
 * The two `LAUNCH_STATUS` values a receiver sends while its user decides on a cast request
 * (`GetLaunchSessionResponse`: `USER_PENDING_AUTHORIZATION`, `USER_ALLOWED`). Any other status fails the launch.
 */
export type LaunchStatus = "pending_authorization" | "allowed";

/** What a LAUNCH asks for beyond the app id; Chrome takes these from the Cast presentation URL. */
export interface LaunchOptions {
  /** LAUNCH `supportedAppTypes`; empty or absent sends `["WEB"]`, as `CastMediaSource` defaults. */
  supportedAppTypes?: readonly string[];
  /** LAUNCH `appParams`, already parsed from the URL's JSON; `undefined` leaves the field out. */
  appParams?: unknown;
  /** Replaces `launchTimeoutMs` for this launch; capped at two minutes (`kLaunchMaxTimeout`). */
  timeoutMs?: number;
  /**
   * Called when the receiver reports that the user must approve the cast (`pending_authorization`, LAUNCH_STATUS
   * USER_PENDING_AUTHORIZATION) and when they have (`allowed`, USER_ALLOWED). The launch timeout is not extended.
   */
  onStatus?: (status: LaunchStatus) => void;
}

/** cast_message_handler.h `kRequestTimeout`. */
const REQUEST_TIMEOUT_MS = 5000;
/** cast_media_source.h `kDefaultLaunchTimeout`. */
const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;
/** cast_message_handler.cc `kLaunchMaxTimeout`. */
const MAX_LAUNCH_TIMEOUT_MS = 120_000;
/** cast_message_util.h `kPlatformSenderId`, the source of keep-alive messages. */
const PLATFORM_SENDER_ID = "sender-0";

type ClientState = "idle" | "connecting" | "connected" | "closed";

const ERROR_REPLY_TYPES = new Set(["INVALID_REQUEST", "LOAD_FAILED", "LOAD_CANCELLED", "INVALID_PLAYER_STATE"]);

function isErrorResponse(type: string): boolean {
  return ERROR_REPLY_TYPES.has(type) || type.endsWith("_ERROR");
}

function buildMessage(sourceId: string, namespace: string, destinationId: string, payload: string | Uint8Array | object): CastMessage {
  const msg: CastMessage = {
    protocolVersion: 0,
    sourceId,
    destinationId,
    namespace,
    payloadType: payload instanceof Uint8Array ? PayloadType.BINARY : PayloadType.STRING,
  };
  if (typeof payload === "string") msg.payloadUtf8 = payload;
  else if (payload instanceof Uint8Array) msg.payloadBinary = Buffer.from(payload);
  else msg.payloadUtf8 = JSON.stringify(payload);
  return msg;
}

/** A single-use Cast v2 client: one TLS connection to one receiver. */
export class CastClient extends EventEmitter<CastClientEvents> {
  /** The sender id this client uses as its sourceId. */
  readonly senderId: string;

  private readonly options: CastClientOptions;
  private socket: TLSSocket | null = null;
  private decoder = new FrameDecoder();
  private state: ClientState = "idle";
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private launchWaiters: LaunchWaiter[] = [];
  private transports = new Set<string>();
  private pingTimer: NodeJS.Timeout | null = null;
  private livenessTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private authNonce: Buffer | null = null;
  private authPeerCert: Buffer | null = null;
  private authResult: DeviceAuthResult | undefined;
  private authFinish: ((err?: Error) => void) | null = null;
  private readonly identity: SenderIdentity;

  constructor(options: CastClientOptions) {
    super();
    this.options = options;
    this.senderId = options.senderId ?? "sender-" + randomBytes(4).toString("hex");
    this.identity = { ...chromeSenderIdentity(), ...options.sender };
  }

  /** True while connected to the receiver. */
  get connected(): boolean {
    return this.state === "connected";
  }

  /** What device authentication established; undefined when it did not run (verifyDevice false). */
  get deviceAuth(): DeviceAuthResult | undefined {
    return this.authResult;
  }

  /** Open the TLS connection, authenticate the device (unless disabled) and send CONNECT to the platform receiver. */
  connect(): Promise<void> {
    if (this.state !== "idle") {
      return Promise.reject(new CastConnectionError(`cannot connect: client is ${this.state}`));
    }
    this.state = "connecting";
    const host = this.options.host;
    const port = this.options.port ?? 8009;
    const socket = tls.connect({ host, port, rejectUnauthorized: false, ...this.options.tls });
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (this.connectTimer !== null) {
          clearTimeout(this.connectTimer);
          this.connectTimer = null;
        }
        if (err === undefined) {
          this.state = "connected";
          this.startHeartbeat();
          this.write(buildMessage(this.senderId, NS.CONNECTION, PLATFORM_RECEIVER_ID, { type: "CONNECT", ...connectFields(this.identity, VIRTUAL_CONNECTION_STRONG), ...this.options.connectPayload }));
          resolve();
        } else {
          this.state = "closed";
          this.socket = null;
          socket.destroy();
          reject(err);
        }
      };

      const connectTimeoutMs = this.options.connectTimeoutMs ?? 10000;
      this.connectTimer = setTimeout(() => {
        settle(new CastTimeoutError(`TLS handshake did not complete within ${connectTimeoutMs} ms`));
      }, connectTimeoutMs);

      socket.on("secureConnect", () => {
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        if (this.options.verifyDevice === false) {
          settle();
          return;
        }
        const peer = socket.getPeerCertificate(false) as { raw?: Buffer };
        if (peer.raw === undefined || peer.raw.length === 0) {
          settle(new CastAuthError("no_tls_certificate", "the device presented no TLS certificate", { host }));
          return;
        }
        const challenge = createAuthChallenge();
        this.authNonce = challenge.nonce;
        this.authPeerCert = peer.raw;
        this.authFinish = settle;
        // The TLS handshake timer is replaced by one for the authentication reply.
        if (this.connectTimer !== null) clearTimeout(this.connectTimer);
        const authTimeoutMs = this.options.authTimeoutMs ?? 10000;
        this.connectTimer = setTimeout(() => {
          settle(new CastAuthError("timeout", `no authentication reply within ${authTimeoutMs} ms`, { host }));
        }, authTimeoutMs);
        this.write(buildMessage("sender-0", NS.DEVICE_AUTH, PLATFORM_RECEIVER_ID, challenge.payload));
      });
      socket.on("error", (err: Error) => {
        if (this.state === "connecting") {
          settle(new CastConnectionError(`failed to connect to ${host}:${port}: ${err.message}`, { cause: err }));
        } else if (this.state === "connected") {
          this.fail(new CastConnectionError(`socket error: ${err.message}`, { cause: err }));
        }
      });
      socket.on("close", () => {
        if (this.state === "connecting") {
          settle(new CastConnectionError("connection closed during TLS handshake"));
        } else if (this.state === "connected") {
          this.fail(new CastConnectionError("connection closed by remote end"));
        }
      });
    });
  }

  /** Close gracefully: goodbye CLOSE messages, then end the socket. Idempotent. */
  close(): void {
    if (this.state !== "connected") return;
    this.state = "closed";
    this.stopTimers();
    for (const id of [...this.transports]) {
      this.sendJson(NS.CONNECTION, id, { type: "CLOSE" });
    }
    this.transports.clear();
    this.sendJson(NS.CONNECTION, PLATFORM_RECEIVER_ID, { type: "CLOSE" });
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) socket.end();
    const err = new CastConnectionError("client closed");
    this.rejectAllPending(err);
    this.rejectAllLaunches(err);
    this.emit("close");
  }

  /** Send a raw message; throws {@link CastConnectionError} when not connected. */
  send(namespace: string, destinationId: string, payload: string | Uint8Array | object): void {
    if (this.state !== "connected") throw new CastConnectionError("not connected");
    this.writeObserved(buildMessage(this.senderId, namespace, destinationId, payload));
  }

  /** Send a request and wait for the matching reply. */
  request<T = Record<string, unknown>>(
    namespace: string,
    destinationId: string,
    payload: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (this.state !== "connected") {
      return Promise.reject(new CastConnectionError("not connected"));
    }
    const requestId = this.nextRequestId++;
    const timeoutMs = options?.timeoutMs ?? this.options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    return new Promise<T>((resolve, reject) => {
      const entry: PendingRequest = {
        namespace,
        destinationId,
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          reject(new CastTimeoutError(`request ${requestId} on ${namespace} timed out after ${timeoutMs} ms`));
        }, timeoutMs),
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      this.pending.set(requestId, entry);
      this.writeObserved(buildMessage(this.senderId, namespace, destinationId, { ...payload, requestId }));
    });
  }

  /** Ask the receiver for its current status. */
  getStatus(): Promise<ReceiverStatus> {
    return this.request<Record<string, unknown>>(NS.RECEIVER, PLATFORM_RECEIVER_ID, { type: "GET_STATUS" }).then((reply) =>
      this.normalizeStatus(reply.status),
    );
  }

  /**
   * Launch an app and wait until it appears in a RECEIVER_STATUS. The LAUNCH carries what Chrome's
   * `CreateLaunchRequest` (cast_message_util.cc) sends: `language`, `supportedAppTypes` and, when given, `appParams`.
   */
  launch(appId: string, options: LaunchOptions = {}): Promise<ReceiverApplication> {
    if (this.state !== "connected") {
      return Promise.reject(new CastConnectionError("not connected"));
    }
    const requestId = this.nextRequestId++;
    // CastMessageHandler::LaunchSession caps the launch timeout at kLaunchMaxTimeout (2 minutes)
    const timeoutMs = Math.min(options.timeoutMs ?? this.options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS, MAX_LAUNCH_TIMEOUT_MS);
    const payload: Record<string, unknown> = {
      type: "LAUNCH",
      requestId,
      appId,
      language: this.identity.locale,
      supportedAppTypes: options.supportedAppTypes !== undefined && options.supportedAppTypes.length > 0 ? [...options.supportedAppTypes] : ["WEB"],
    };
    if (options.appParams !== undefined) payload.appParams = options.appParams;
    return new Promise<ReceiverApplication>((resolve, reject) => {
      const waiter: LaunchWaiter = {
        appId,
        requestId,
        onStatus: options.onStatus,
        // The timer is started once: USER_PENDING_AUTHORIZATION does not restart it (PendingRequests::AddLaunchRequest)
        timer: setTimeout(() => {
          this.removeLaunchWaiter(waiter);
          reject(new CastTimeoutError(`launch of ${appId} timed out after ${timeoutMs} ms`));
        }, timeoutMs),
        resolve,
        reject,
      };
      this.launchWaiters.push(waiter);
      this.writeObserved(buildMessage(this.senderId, NS.RECEIVER, PLATFORM_RECEIVER_ID, payload));
    });
  }

  /** Stop a session; resolves with the new status. */
  stop(sessionId: string): Promise<ReceiverStatus> {
    return this.request<Record<string, unknown>>(NS.RECEIVER, PLATFORM_RECEIVER_ID, { type: "STOP", sessionId }).then((reply) =>
      this.normalizeStatus(reply.status),
    );
  }

  /** Set the volume by level or muted flag; resolves with the new status. */
  setVolume(volume: { level: number } | { muted: boolean }): Promise<ReceiverStatus> {
    return this.request<Record<string, unknown>>(NS.RECEIVER, PLATFORM_RECEIVER_ID, { type: "SET_VOLUME", volume }).then((reply) =>
      this.normalizeStatus(reply.status),
    );
  }

  /** Ask which of the given app ids are available on the receiver. */
  async getAppAvailability(appIds: string[]): Promise<Record<string, boolean>> {
    const reply = await this.request<Record<string, unknown>>(NS.RECEIVER, PLATFORM_RECEIVER_ID, {
      type: "GET_APP_AVAILABILITY",
      appId: appIds,
    });
    const availability = (reply.availability ?? {}) as Record<string, unknown>;
    const out: Record<string, boolean> = {};
    for (const id of appIds) out[id] = availability[id] === "APP_AVAILABLE";
    return out;
  }

  /**
   * Open a virtual connection to a transport (idempotent). It is a strong one unless the page's source says
   * `invisibleSender=true` (`CastMediaSource::connection_type`, used by `CastActivityManager::EnsureConnection`).
   */
  connectTransport(transportId: string, options?: { invisible?: boolean }): void {
    if (this.state !== "connected") return;
    if (this.transports.has(transportId)) return;
    this.transports.add(transportId);
    const connType = options?.invisible === true ? VIRTUAL_CONNECTION_INVISIBLE : VIRTUAL_CONNECTION_STRONG;
    this.sendJson(NS.CONNECTION, transportId, { type: "CONNECT", ...connectFields(this.identity, connType), ...this.options.connectPayload });
  }

  /** Close a virtual connection to a transport. */
  closeTransport(transportId: string): void {
    if (this.state !== "connected") return;
    this.transports.delete(transportId);
    this.writeObserved(buildMessage(this.senderId, NS.CONNECTION, transportId, { type: "CLOSE" }));
  }

  private onData(chunk: Buffer): void {
    if (this.state === "connecting" && this.authFinish !== null) {
      this.onAuthData(chunk);
      return;
    }
    if (this.state !== "connected") return;
    let bodies: Buffer[];
    try {
      bodies = this.decoder.push(chunk);
    } catch (err) {
      this.fail(new CastConnectionError(`protocol error: ${describe(err)}`, { cause: err instanceof Error ? err : undefined }));
      return;
    }
    for (const body of bodies) {
      let msg: CastMessage;
      try {
        msg = decodeCastMessage(body);
      } catch (err) {
        this.fail(new CastConnectionError(`protocol error: ${describe(err)}`, { cause: err instanceof Error ? err : undefined }));
        return;
      }
      // KeepAliveHandler::HandleMessage: every received message, not every chunk of bytes, restarts both timers
      this.resetTimers();
      this.handleMessage(msg);
      if (this.state !== "connected") return;
    }
  }

  /** Frames received while the device is still being authenticated: only its deviceauth reply is acceptable. */
  private onAuthData(chunk: Buffer): void {
    const finish = this.authFinish as (err?: Error) => void;
    const host = this.options.host;
    let bodies: Buffer[];
    try {
      bodies = this.decoder.push(chunk);
    } catch (err) {
      finish(new CastAuthError("malformed_reply", `protocol error: ${describe(err)}`, { host }));
      return;
    }
    for (const body of bodies) {
      let msg: CastMessage;
      try {
        msg = decodeCastMessage(body);
      } catch (err) {
        finish(new CastAuthError("malformed_reply", `protocol error: ${describe(err)}`, { host }));
        return;
      }
      if (msg.namespace !== NS.DEVICE_AUTH) continue;
      try {
        this.authResult = authenticateChallengeReply(
          { payloadType: msg.payloadType, payloadBinary: msg.payloadBinary },
          this.authPeerCert as Buffer,
          this.authNonce as Buffer,
          this.options.deviceAuth,
        );
      } catch (err) {
        if (err instanceof CastAuthError) finish(new CastAuthError(err.reason, err.message.replace(/^Cast device authentication failed: /, ""), { host }));
        else finish(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.authFinish = null;
      finish();
      return;
    }
  }

  private handleMessage(msg: CastMessage): void {
    if (msg.namespace === NS.HEARTBEAT) {
      // KeepAliveHandler::HandleMessage: a payload that contains "PING" is a ping, anything else is taken as a PONG
      if (msg.payloadUtf8?.includes("PING") === true) this.sendKeepAlive("PONG");
      return;
    }
    if (msg.namespace === NS.CONNECTION) {
      if (this.jsonType(msg) === "CLOSE") {
        if (msg.sourceId === PLATFORM_RECEIVER_ID) {
          this.fail(new CastConnectionError("closed by receiver"));
          return;
        }
        if (this.transports.delete(msg.sourceId)) this.emit("transportClosed", msg.sourceId);
      }
      return;
    }

    const data: string | Buffer =
      msg.payloadType === PayloadType.STRING ? (msg.payloadUtf8 ?? "") : (msg.payloadBinary ?? Buffer.alloc(0));
    this.emit("message", { namespace: msg.namespace, sourceId: msg.sourceId, destinationId: msg.destinationId, data });

    if (msg.payloadType !== PayloadType.STRING || msg.payloadUtf8 === undefined) return;
    let reply: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(msg.payloadUtf8);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) reply = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (reply === undefined) return;

    this.matchPending(msg, reply);
    if (msg.namespace !== NS.RECEIVER) return;
    const type = typeof reply.type === "string" ? reply.type : "";
    if (type === "RECEIVER_STATUS") {
      const status = this.normalizeStatus(reply.status);
      this.emit("receiverStatus", status);
      this.settleLaunches(status);
    } else if (type === "LAUNCH_STATUS") {
      this.handleLaunchStatus(reply);
    } else if (type === "LAUNCH_ERROR" || type === "INVALID_REQUEST") {
      this.rejectLaunches(reply);
    }
  }

  private matchPending(msg: CastMessage, reply: Record<string, unknown>): void {
    const requestId = reply.requestId;
    if (typeof requestId !== "number") return;
    const entry = this.pending.get(requestId);
    if (entry === undefined) return;
    if (entry.namespace !== msg.namespace || entry.destinationId !== msg.sourceId) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    const type = typeof reply.type === "string" ? reply.type : "";
    if (isErrorResponse(type)) entry.reject(new CastRequestError(reply));
    else entry.resolve(reply);
  }

  private settleLaunches(status: ReceiverStatus): void {
    for (const waiter of [...this.launchWaiters]) {
      const app = status.applications.find((a) => a.appId === waiter.appId);
      if (app !== undefined) {
        this.removeLaunchWaiter(waiter);
        waiter.resolve(app);
      }
    }
  }

  /**
   * cast_message_util.cc `GetLaunchSessionResponse`: USER_PENDING_AUTHORIZATION and USER_ALLOWED keep the launch open
   * (`HandleLaunchSessionResponseMiddleStages`); any other status is an empty response, which fails the launch.
   */
  private handleLaunchStatus(reply: Record<string, unknown>): void {
    const requestId = reply.requestId;
    if (typeof requestId !== "number") return;
    const status = reply.status;
    for (const waiter of [...this.launchWaiters]) {
      if (waiter.requestId !== requestId) continue;
      if (status === "USER_PENDING_AUTHORIZATION") waiter.onStatus?.("pending_authorization");
      else if (status === "USER_ALLOWED") waiter.onStatus?.("allowed");
      else {
        this.removeLaunchWaiter(waiter);
        waiter.reject(new CastLaunchError(reply, "error", "Failed to launch session. "));
      }
    }
  }

  private rejectLaunches(reply: Record<string, unknown>): void {
    const requestId = reply.requestId;
    if (typeof requestId !== "number") return;
    for (const waiter of [...this.launchWaiters]) {
      if (waiter.requestId !== requestId) continue;
      this.removeLaunchWaiter(waiter);
      waiter.reject(launchErrorOf(reply));
    }
  }

  private removeLaunchWaiter(waiter: LaunchWaiter): void {
    const i = this.launchWaiters.indexOf(waiter);
    if (i !== -1) this.launchWaiters.splice(i, 1);
    clearTimeout(waiter.timer);
  }

  private normalizeStatus(status: unknown): ReceiverStatus {
    const s = (status !== null && typeof status === "object" ? status : {}) as Record<string, unknown>;
    return {
      ...s,
      applications: Array.isArray(s.applications) ? (s.applications as ReceiverApplication[]) : [],
      volume: s.volume !== null && typeof s.volume === "object" ? (s.volume as ReceiverVolume) : {},
    };
  }

  private jsonType(msg: CastMessage): string | undefined {
    if (msg.payloadType !== PayloadType.STRING || msg.payloadUtf8 === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(msg.payloadUtf8);
      if (parsed !== null && typeof parsed === "object") {
        const t = (parsed as Record<string, unknown>).type;
        if (typeof t === "string") return t;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /**
   * KeepAliveHandler::Start. Both timers are one-shot (base::RetainingOneShotTimer): the ping timer fires once after
   * a quiet interval and is started again by the next message received, not by itself.
   */
  private startHeartbeat(): void {
    this.stopTimers();
    this.pingTimer = setTimeout(() => this.sendKeepAlive("PING"), this.options.heartbeatIntervalMs ?? 5000);
    this.startLiveness();
  }

  private startLiveness(): void {
    if (this.livenessTimer !== null) clearTimeout(this.livenessTimer);
    const timeoutMs = this.options.heartbeatTimeoutMs ?? 10000;
    this.livenessTimer = setTimeout(() => {
      this.fail(new CastConnectionError(`no traffic from receiver for ${timeoutMs} ms (heartbeat timeout)`));
    }, timeoutMs);
  }

  /** KeepAliveHandler::ResetTimers, run for every message received. */
  private resetTimers(): void {
    if (this.pingTimer === null) return;
    clearTimeout(this.pingTimer);
    this.pingTimer = setTimeout(() => this.sendKeepAlive("PING"), this.options.heartbeatIntervalMs ?? 5000);
    this.startLiveness();
  }

  /**
   * KeepAliveHandler::SendKeepAliveMessage: from sender-0 to receiver-0. A write that fails closes the channel
   * (CAST_SOCKET_ERROR); one that completes restarts the liveness timer only.
   */
  private sendKeepAlive(type: "PING" | "PONG"): void {
    this.write(buildMessage(PLATFORM_SENDER_ID, NS.HEARTBEAT, PLATFORM_RECEIVER_ID, { type }), (err) => {
      if (this.state !== "connected") return;
      if (err !== undefined && err !== null) {
        this.fail(new CastConnectionError(`socket error: failed to send ${type}: ${err.message}`, { cause: err }));
        return;
      }
      this.startLiveness();
    });
  }

  private stopTimers(): void {
    if (this.pingTimer !== null) {
      clearTimeout(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.livenessTimer !== null) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  /** Fail the client: destroy the socket, reject pending work, emit close once. */
  private fail(err: CastConnectionError): void {
    if (this.state !== "connected") return;
    this.state = "closed";
    this.stopTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) socket.destroy();
    this.rejectAllPending(err);
    this.rejectAllLaunches(err);
    this.emit("close", err);
  }

  private rejectAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  private rejectAllLaunches(err: Error): void {
    for (const waiter of this.launchWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.launchWaiters = [];
  }

  private sendJson(namespace: string, destinationId: string, payload: Record<string, unknown>): void {
    this.write(buildMessage(this.senderId, namespace, destinationId, payload));
  }

  /** `CastMessageHandler::SendCastMessageToSocket`: the write, then the observers of the message sent. */
  private writeObserved(msg: CastMessage): void {
    this.write(msg);
    if (this.listenerCount("messageSent") === 0) return;
    const data = msg.payloadType === PayloadType.STRING ? (msg.payloadUtf8 ?? "") : (msg.payloadBinary ?? Buffer.alloc(0));
    this.emit("messageSent", { namespace: msg.namespace, sourceId: msg.sourceId, destinationId: msg.destinationId, data });
  }

  private write(msg: CastMessage, done?: (err?: Error | null) => void): void {
    const socket = this.socket;
    if (socket !== null) socket.write(frame(encodeCastMessage(msg)), done);
  }
}

/**
 * cast_message_util.cc `GetLaunchSessionResponse` for a LAUNCH_ERROR (or INVALID_REQUEST, which is not a launch
 * response and so is an unknown failure), with the message `CastActivityManager::HandleLaunchSessionResponse` gives.
 */
function launchErrorOf(reply: Record<string, unknown>): CastLaunchError {
  if (reply.type === "LAUNCH_ERROR") {
    // cast_message_util.h kUserNotAllowedError, kNotificationDisabledError
    if (reply.extendedError === "USER_NOT_ALLOWED") {
      return new CastLaunchError(reply, "user_not_allowed", "Failed to launch session as the user declined the cast request.");
    }
    if (reply.extendedError === "USER_NOTIFICATIONS_DISABLED") {
      return new CastLaunchError(reply, "notification_disabled", "Failed to launch session as the notifications are disabled on the receiver device.");
    }
    return new CastLaunchError(reply, "error", "Failed to launch session. " + (typeof reply.error === "string" ? reply.error : ""));
  }
  return new CastLaunchError(reply, "error", "Failed to launch session. ");
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


