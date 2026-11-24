import type { BridgeEvent, BridgeResult, SessionSnapshot, VolumeSnapshot } from "../polyfill/bridge-types.ts";
import type { CastDevice } from "../discovery/index.ts";
import type { ReceiverApplication, ReceiverStatus, ReceiverVolume } from "../client/index.ts";
import { CastTimeoutError } from "../client/index.ts";

/** Capability bit names in bit order: 1 video_out, 2 video_in, 4 audio_out, 8 audio_in, 32 multizone_group. */
export function capabilityNames(bits: number): string[] {
  const names: string[] = [];
  if (bits & 1) names.push("video_out");
  if (bits & 2) names.push("video_in");
  if (bits & 4) names.push("audio_out");
  if (bits & 8) names.push("audio_in");
  if (bits & 32) names.push("multizone_group");
  return names;
}

/** A source of known Cast devices and their change events. */
export interface DeviceSource {
  devices(): CastDevice[];
  on(event: "deviceUp" | "deviceDown" | "deviceChanged", listener: (device: CastDevice) => void): unknown;
  off(event: "deviceUp" | "deviceDown" | "deviceChanged", listener: (device: CastDevice) => void): unknown;
}

/** The subset of {@link CastClient} used by the session service. */
export interface CastClientLike {
  readonly connected: boolean;
  connect(): Promise<void>;
  close(): void;
  send(namespace: string, destinationId: string, payload: string): void;
  launch(appId: string): Promise<ReceiverApplication>;
  stop(sessionId: string): Promise<ReceiverStatus>;
  setVolume(volume: { level: number } | { muted: boolean }): Promise<ReceiverStatus>;
  getStatus(): Promise<ReceiverStatus>;
  connectTransport(transportId: string): void;
  closeTransport(transportId: string): void;
  on(event: "message", listener: (msg: ClientMessage) => void): unknown;
  on(event: "receiverStatus", listener: (status: ReceiverStatus) => void): unknown;
  on(event: "transportClosed", listener: (transportId: string) => void): unknown;
  on(event: "close", listener: (error?: Error) => void): unknown;
}

/** An inbound app message delivered by a client. */
export interface ClientMessage {
  namespace: string;
  sourceId: string;
  destinationId: string;
  data: string | Buffer;
}

/** Identity of a page (frame) talking to the service. */
export interface SenderInfo { id: number; origin: string }

/** What the picker is told about a requestSession call. */
export interface CastRequestInfo {
  appId: string;
  capabilities: string[];
  origin: string;
  senderId: number;
  /** The sender's current session for this app, if it has one; the key is absent when it does not. */
  session?: { sessionId: string; deviceId: string };
}

/** A session worth rejoining later: enough to find it again and to check it is still the same one. */
export interface SavedSession { deviceId: string; sessionId: string; appId: string; origin: string }

/**
 * Where the service keeps the session it started last, so a later run can rejoin it. `set(null)` means the
 * session is over. A session that is merely left (the page or the app went away) stays saved.
 */
export interface SessionStore {
  get(): SavedSession | null | Promise<SavedSession | null>;
  set(session: SavedSession | null): void;
}

/** The picker's answer: a device to cast to, `null` (cancel) or `"stop"` (stop the sender's current session). */
export type DeviceChoice = CastDevice | null | "stop";

/** Dependencies and callbacks of {@link CastSessionService}. */
export interface CastSessionServiceOptions {
  devices: DeviceSource;
  createClient(device: CastDevice): CastClientLike;
  /**
   * Ask the user which device to cast to. Resolves a device, `null` (cancel) or
   * `"stop"` (stop `request.session`, the sender's current session, if it has one).
   */
  selectDevice(devices: CastDevice[], request: CastRequestInfo): Promise<DeviceChoice>;
  allowOrigin?(origin: string): boolean;
  /**
   * When given, a sender that initializes for the saved session's app and origin rejoins that session if its
   * device still runs it, and learns about it through its sessionListener.
   */
  sessionStore?: SessionStore;
  emit(senderId: number, event: BridgeEvent): void;
}

interface SenderRecord {
  appId: string;
  capabilities: string[];
  lastAvailable: boolean;
}

interface SessionRecord {
  device: CastDevice;
  client: CastClientLike;
  app: ReceiverApplication;
  origin: string;
  appId: string;
  members: Set<number>;
  lastVolume: ReceiverVolume;
  lastSnapshot: SessionSnapshot | null;
  /** Set while a stopSession is in flight; onClientStatus skips this sender when it ends the session. */
  stoppingBy?: number;
}

interface ClientEntry {
  client: CastClientLike;
  device: CastDevice;
  /** Connect promise, created once; every openSession awaits it. */
  ready: Promise<void>;
  /** Number of in-flight openSession calls; cleanupIdle never closes while > 0. */
  opening: number;
}

const CAPABILITY_BITS: Record<string, number> = {
  video_out: 1,
  video_in: 2,
  audio_out: 4,
  audio_in: 8,
  multizone_group: 32,
};

const DEFAULT_TIMEOUT_MS = 60000;
/** How long a restore waits for discovery to find the saved session's device. */
const RESTORE_DISCOVERY_TIMEOUT_MS = 15000;

/** A request that must be reported as a specific chrome.cast error code. */
class MappedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The request bound expired while the client was still working; clean up silently. */
class Discarded extends Error {}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bad(code: string, description?: string): BridgeResult {
  return description === undefined ? { ok: false, code } : { ok: false, code, description };
}

function good<T>(value: T): BridgeResult<T> {
  return { ok: true, value };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseInitialize(params: unknown): { appId: string; capabilities: string[]; autoJoinPolicy: string } | null {
  if (!isRecord(params)) return null;
  const { appId, capabilities, autoJoinPolicy } = params;
  if (typeof appId !== "string" || !isStringArray(capabilities) || typeof autoJoinPolicy !== "string") return null;
  return { appId, capabilities, autoJoinPolicy };
}

function parseRequestSession(params: unknown): { appId: string; capabilities: string[]; timeoutMs: number } | null {
  if (!isRecord(params)) return null;
  const { appId, capabilities, timeoutMs } = params;
  if (typeof appId !== "string" || !isStringArray(capabilities)) return null;
  const timeout = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return null;
  return { appId, capabilities, timeoutMs: timeout };
}

function parseSessionId(params: unknown): { sessionId: string } | null {
  if (!isRecord(params) || typeof params.sessionId !== "string") return null;
  return { sessionId: params.sessionId };
}

function parseSendMessage(params: unknown): { sessionId: string; namespace: string; message: string } | null {
  if (!isRecord(params)) return null;
  const { sessionId, namespace, message } = params;
  if (typeof sessionId !== "string" || typeof namespace !== "string" || typeof message !== "string") return null;
  return { sessionId, namespace, message };
}

function parseSetVolume(params: unknown): { sessionId: string; level: number } | null {
  if (!isRecord(params)) return null;
  const { sessionId, level } = params;
  if (typeof sessionId !== "string" || typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
    return null;
  }
  return { sessionId, level };
}

function parseSetMuted(params: unknown): { sessionId: string; muted: boolean } | null {
  if (!isRecord(params)) return null;
  const { sessionId, muted } = params;
  if (typeof sessionId !== "string" || typeof muted !== "boolean") return null;
  return { sessionId, muted };
}

/** True when every requested capability bit is set on the device (unknown names are ignored). */
function deviceMatches(device: CastDevice, capabilities: string[]): boolean {
  for (const cap of capabilities) {
    const bit = CAPABILITY_BITS[cap];
    if (bit !== undefined && (device.capabilities & bit) === 0) return false;
  }
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!sameValue(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!sameValue(ao[k], bo[k])) return false;
  }
  return true;
}

/**
 * Main-process cast session manager: tracks initialized senders, one client per
 * device and the sessions pages hold; pushes BridgeEvents back via options.emit.
 */
export class CastSessionService {
  private readonly options: CastSessionServiceOptions;
  private readonly senders = new Map<number, SenderRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly clients = new Map<string, ClientEntry>();
  private readonly pendingRequests = new Map<number, { discard: { value: boolean }; cancelled: { value: boolean } }>();
  private readonly deviceListener = (): void => this.onDevicesChanged();
  private disposed = false;
  /** The session the store currently holds, so only its end clears the store. */
  private savedSessionId: string | undefined;

  constructor(options: CastSessionServiceOptions) {
    this.options = options;
    options.devices.on("deviceUp", this.deviceListener);
    options.devices.on("deviceDown", this.deviceListener);
    options.devices.on("deviceChanged", this.deviceListener);
  }

  /** Handle one bridge call; never throws or rejects. */
  async handle(sender: SenderInfo, method: string, params: unknown): Promise<BridgeResult> {
    try {
      const allow = this.options.allowOrigin;
      if (allow !== undefined && !allow(sender.origin)) {
        return bad("extension_missing", "Casting is not allowed for this origin");
      }
      switch (method) {
        case "initialize":
          return this.handleInitialize(sender, params);
        case "requestSession":
          return await this.handleRequestSession(sender, params);
        case "joinSession":
          return this.handleJoinSession(sender, params);
        case "sendMessage":
          return this.handleSendMessage(sender, params);
        case "stopSession":
          return await this.handleStopSession(sender, params);
        case "leaveSession":
          return this.handleLeaveSession(sender, params);
        case "setReceiverVolume":
          return await this.handleSetVolume(sender, params);
        case "setReceiverMuted":
          return await this.handleSetMuted(sender, params);
        default:
          return bad("invalid_parameter", `unknown method: ${method}`);
      }
    } catch (err) {
      return bad("session_error", describe(err));
    }
  }

  /** Detach a sender that went away: cancel its pending request, leave its sessions, drop its bookkeeping. */
  senderGone(senderId: number): void {
    const pending = this.pendingRequests.get(senderId);
    if (pending !== undefined) pending.cancelled.value = true;
    this.pendingRequests.delete(senderId);
    this.senders.delete(senderId);
    for (const rec of [...this.sessions.values()]) {
      if (!rec.members.has(senderId)) continue;
      this.leave(rec, senderId);
    }
  }

  /** Unsubscribe, close every client and clear all state. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const d = this.options.devices;
    d.off("deviceUp", this.deviceListener);
    d.off("deviceDown", this.deviceListener);
    d.off("deviceChanged", this.deviceListener);
    const entries = [...this.clients.values()];
    this.clients.clear();
    for (const entry of entries) entry.client.close();
    this.sessions.clear();
    this.senders.clear();
    this.pendingRequests.clear();
  }

  private handleInitialize(sender: SenderInfo, params: unknown): BridgeResult {
    const p = parseInitialize(params);
    if (p === null) return bad("invalid_parameter");
    const available = this.options.devices.devices().some((d) => deviceMatches(d, p.capabilities));
    const record: SenderRecord = { appId: p.appId, capabilities: p.capabilities, lastAvailable: available };
    this.senders.set(sender.id, record);
    const joined: SessionSnapshot[] = [];
    for (const rec of this.sessions.values()) {
      if (rec.appId !== p.appId || rec.origin !== sender.origin) continue;
      if (p.autoJoinPolicy === "origin_scoped") {
        rec.members.add(sender.id);
        joined.push(this.snapshotOf(rec));
      } else if (p.autoJoinPolicy === "tab_and_origin_scoped" && rec.members.has(sender.id)) {
        joined.push(this.snapshotOf(rec));
      }
    }
    // A page_scoped sender never joins a session it did not start.
    if (joined.length === 0 && p.autoJoinPolicy !== "page_scoped") void this.restoreSession(sender, record);
    return good({ available, sessions: joined });
  }

  /** Rejoin the saved session for a sender that just initialized, if its device still runs it. */
  private async restoreSession(sender: SenderInfo, record: SenderRecord): Promise<void> {
    const store = this.options.sessionStore;
    if (store === undefined) return;
    // The sender re-initialized, went away or asked for a session itself while this was in flight.
    const superseded = (): boolean =>
      this.disposed || this.senders.get(sender.id) !== record || this.pendingRequests.has(sender.id) || this.currentSessionFor(sender.id, record.appId) !== undefined;
    let entry: ClientEntry | undefined;
    let registered = false;
    try {
      const saved = await store.get();
      if (!saved || saved.appId !== record.appId || saved.origin !== sender.origin) return;
      const device = await this.waitForDevice(saved.deviceId);
      if (device === undefined || superseded() || this.sessions.has(saved.sessionId)) return;
      entry = this.clientFor(device);
      entry.opening += 1;
      await entry.ready;
      const status = await entry.client.getStatus();
      if (superseded() || this.sessions.has(saved.sessionId)) return;
      const app = status.applications.find((a) => a.sessionId === saved.sessionId && a.appId === saved.appId);
      if (app === undefined) {
        store.set(null);
        return;
      }
      entry.client.connectTransport(app.transportId);
      const rec: SessionRecord = {
        device,
        client: entry.client,
        app,
        origin: saved.origin,
        appId: saved.appId,
        members: new Set([sender.id]),
        lastVolume: status.volume,
        lastSnapshot: null,
      };
      rec.lastSnapshot = this.snapshotOf(rec);
      this.sessions.set(app.sessionId, rec);
      this.savedSessionId = app.sessionId;
      registered = true;
      this.emitTo(sender.id, { type: "sessionJoined", session: rec.lastSnapshot });
    } catch {
      // The device could not be reached: the session stays saved for the next initialize.
    } finally {
      if (entry !== undefined) {
        entry.opening -= 1;
        if (!registered) this.cleanupIdle(entry.device.id, entry.client);
      }
    }
  }

  /** The device with this id, waiting for discovery to find it when it is not known yet. */
  private waitForDevice(deviceId: string): Promise<CastDevice | undefined> {
    const devices = this.options.devices;
    const known = devices.devices().find((d) => d.id === deviceId);
    if (known !== undefined) return Promise.resolve(known);
    return new Promise((resolve) => {
      const finish = (device?: CastDevice): void => {
        clearTimeout(timer);
        devices.off("deviceUp", onUp);
        resolve(device);
      };
      const onUp = (device: CastDevice): void => {
        if (device.id === deviceId) finish(device);
      };
      const timer = setTimeout(finish, RESTORE_DISCOVERY_TIMEOUT_MS);
      timer.unref();
      devices.on("deviceUp", onUp);
    });
  }

  private remember(rec: SessionRecord): void {
    this.savedSessionId = rec.app.sessionId;
    this.options.sessionStore?.set({ deviceId: rec.device.id, sessionId: rec.app.sessionId, appId: rec.appId, origin: rec.origin });
  }

  /** The session is over on the device (not merely left), so there is nothing to rejoin. */
  private forget(sessionId: string): void {
    if (this.savedSessionId !== sessionId) return;
    this.savedSessionId = undefined;
    this.options.sessionStore?.set(null);
  }

  /** The device's client entry, created and connecting on first use. */
  private clientFor(device: CastDevice): ClientEntry {
    const existing = this.clients.get(device.id);
    if (existing !== undefined) return existing;
    const client = this.options.createClient(device);
    this.bindClient(client, device);
    const entry: ClientEntry = {
      client,
      device,
      ready: client.connect().catch((err: unknown) => {
        // Remove the entry and close the client once so the next request starts fresh.
        this.dropClient(device.id, client);
        throw err;
      }),
      opening: 0,
    };
    // A restore may never await this; openSession still sees the rejection.
    entry.ready.catch(() => {});
    this.clients.set(device.id, entry);
    return entry;
  }

  private async handleRequestSession(sender: SenderInfo, params: unknown): Promise<BridgeResult> {
    const p = parseRequestSession(params);
    if (p === null) return bad("invalid_parameter");
    if (this.pendingRequests.has(sender.id)) return bad("invalid_parameter");
    const discard = { value: false };
    const cancelled = { value: false };
    this.pendingRequests.set(sender.id, { discard, cancelled });
    try {
      const eligible = this.options.devices.devices().filter((d) => deviceMatches(d, p.capabilities));
      if (eligible.length === 0) return bad("receiver_unavailable");
      const request: CastRequestInfo = {
        appId: p.appId,
        capabilities: p.capabilities,
        origin: sender.origin,
        senderId: sender.id,
      };
      const current = this.currentSessionFor(sender.id, p.appId);
      if (current !== undefined) {
        request.session = { sessionId: current.app.sessionId, deviceId: current.device.id };
      }
      let choice: DeviceChoice;
      try {
        choice = await this.options.selectDevice(eligible, request);
      } catch (err) {
        return bad("session_error", describe(err));
      }
      if (choice === null) return bad("cancel");
      if (choice === "stop") {
        const rec = request.session !== undefined ? this.sessions.get(request.session.sessionId) : undefined;
        if (rec === undefined) return bad("cancel");
        const stopped = await this.stopSessionRecord(rec, sender.id, true);
        return stopped.ok ? bad("cancel") : stopped;
      }
      if (request.session !== undefined && choice.id === request.session.deviceId) {
        const rec = this.sessions.get(request.session.sessionId);
        if (rec !== undefined) return good(this.snapshotOf(rec));
      }
      // The bound starts after the picker resolves; picker time does not count.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          discard.value = true;
          reject(new Discarded());
        }, p.timeoutMs);
      });
      try {
        const snapshot = await Promise.race([this.openSession(choice, p.appId, sender, discard, cancelled), bound]);
        return good(snapshot);
      } catch (err) {
        if (err instanceof Discarded) return bad("timeout", "timed out");
        if (err instanceof MappedError) return bad(err.code, err.message);
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      this.pendingRequests.delete(sender.id);
    }
  }

  private handleJoinSession(sender: SenderInfo, params: unknown): BridgeResult {
    const p = parseSessionId(params);
    if (p === null) return bad("invalid_parameter");
    const rec = this.sessions.get(p.sessionId);
    if (rec === undefined || rec.origin !== sender.origin) return bad("session_error");
    rec.members.add(sender.id);
    return good(this.snapshotOf(rec));
  }

  private handleSendMessage(sender: SenderInfo, params: unknown): BridgeResult {
    const p = parseSendMessage(params);
    if (p === null) return bad("invalid_parameter");
    const rec = this.sessions.get(p.sessionId);
    if (rec === undefined || !rec.members.has(sender.id)) return bad("session_error");
    try {
      rec.client.send(p.namespace, rec.app.transportId, p.message);
    } catch (err) {
      return bad("channel_error", describe(err));
    }
    return good(undefined);
  }

  private async handleStopSession(sender: SenderInfo, params: unknown): Promise<BridgeResult> {
    const p = parseSessionId(params);
    if (p === null) return bad("invalid_parameter");
    const rec = this.sessions.get(p.sessionId);
    if (rec === undefined || !rec.members.has(sender.id)) return bad("session_error");
    return this.stopSessionRecord(rec, sender.id, false);
  }

  /**
   * Stop a session on the device and tear it down. `stoppingBy` keeps an echoed
   * receiverStatus from notifying the caller; the other members learn from that echo
   * or from the sessionEnded emitted here. When `tellCaller` is set (a picker "stop"),
   * the caller gets sessionEnded too, because it did not call stop itself.
   */
  private async stopSessionRecord(rec: SessionRecord, caller: number, tellCaller: boolean): Promise<BridgeResult> {
    rec.stoppingBy = caller;
    try {
      await rec.client.stop(rec.app.sessionId);
    } catch (err) {
      rec.stoppingBy = undefined;
      return bad("session_error", describe(err));
    }
    this.forget(rec.app.sessionId);
    // An echoed receiverStatus may have already ended the session (and notified the others).
    const current = this.sessions.get(rec.app.sessionId);
    if (current !== undefined) {
      this.sessions.delete(rec.app.sessionId);
      for (const member of current.members) {
        if (!tellCaller && member === caller) continue;
        this.emitTo(member, { type: "sessionEnded", sessionId: rec.app.sessionId, status: "stopped" });
      }
    } else if (tellCaller) {
      this.emitTo(caller, { type: "sessionEnded", sessionId: rec.app.sessionId, status: "stopped" });
    }
    this.cleanupIdle(rec.device.id, rec.client);
    return good(undefined);
  }

  /** The sender's current session for the app, if it has one (the first one found). */
  private currentSessionFor(senderId: number, appId: string): SessionRecord | undefined {
    for (const rec of this.sessions.values()) {
      if (rec.appId === appId && rec.members.has(senderId)) return rec;
    }
    return undefined;
  }

  private handleLeaveSession(sender: SenderInfo, params: unknown): BridgeResult {
    const p = parseSessionId(params);
    if (p === null) return bad("invalid_parameter");
    const rec = this.sessions.get(p.sessionId);
    if (rec === undefined || !rec.members.has(sender.id)) return bad("session_error");
    this.leave(rec, sender.id);
    return good(undefined);
  }

  private async handleSetVolume(sender: SenderInfo, params: unknown): Promise<BridgeResult> {
    const p = parseSetVolume(params);
    if (p === null) return bad("invalid_parameter");
    const rec = this.sessions.get(p.sessionId);
    if (rec === undefined || !rec.members.has(sender.id)) return bad("session_error");
    try {
      await rec.client.setVolume({ level: p.level });
    } catch (err) {
      return bad("session_error", describe(err));
    }
    return good(undefined);
  }

  private async handleSetMuted(sender: SenderInfo, params: unknown): Promise<BridgeResult> {
    const p = parseSetMuted(params);
    if (p === null) return bad("invalid_parameter");
    const rec = this.sessions.get(p.sessionId);
    if (rec === undefined || !rec.members.has(sender.id)) return bad("session_error");
    try {
      await rec.client.setVolume({ muted: p.muted });
    } catch (err) {
      return bad("session_error", describe(err));
    }
    return good(undefined);
  }

  /** Connect (or reuse) the device's client, launch the app and register the session. */
  private async openSession(
    device: CastDevice,
    appId: string,
    sender: SenderInfo,
    discard: { value: boolean },
    cancelled: { value: boolean },
  ): Promise<SessionSnapshot> {
    const entry = this.clientFor(device);
    const client = entry.client;
    entry.opening += 1;
    let registered = false;
    try {
      try {
        await entry.ready;
      } catch (err) {
        if (err instanceof CastTimeoutError) throw new MappedError("timeout", err.message);
        throw new MappedError("receiver_unavailable", describe(err));
      }
      if (discard.value) throw new Discarded();
      if (cancelled.value) throw new MappedError("cancel", "cancelled");
      let app: ReceiverApplication;
      try {
        app = await client.launch(appId);
      } catch (err) {
        if (err instanceof CastTimeoutError) throw new MappedError("timeout", err.message);
        throw new MappedError("session_error", describe(err));
      }
      if (discard.value) {
        client.closeTransport(app.transportId);
        throw new Discarded();
      }
      if (cancelled.value) {
        client.closeTransport(app.transportId);
        throw new MappedError("cancel", "cancelled");
      }
      client.connectTransport(app.transportId);
      let status: ReceiverStatus;
      try {
        status = await client.getStatus();
      } catch (err) {
        client.closeTransport(app.transportId);
        throw new MappedError("session_error", describe(err));
      }
      if (discard.value) {
        client.closeTransport(app.transportId);
        throw new Discarded();
      }
      if (cancelled.value) {
        client.closeTransport(app.transportId);
        throw new MappedError("cancel", "cancelled");
      }
      const rec: SessionRecord = {
        device,
        client,
        app,
        origin: sender.origin,
        appId,
        members: new Set([sender.id]),
        lastVolume: status.volume,
        lastSnapshot: null,
      };
      const snapshot = this.snapshotOf(rec);
      rec.lastSnapshot = snapshot;
      this.sessions.set(app.sessionId, rec);
      registered = true;
      this.remember(rec);
      return snapshot;
    } finally {
      entry.opening -= 1;
      if (!registered) this.cleanupIdle(device.id, client);
    }
  }

  /** Remove a sender from a session; when it was the last one, tear the session down. */
  private leave(rec: SessionRecord, senderId: number): void {
    rec.members.delete(senderId);
    if (rec.members.size === 0) {
      rec.client.closeTransport(rec.app.transportId);
      this.sessions.delete(rec.app.sessionId);
      this.cleanupIdle(rec.device.id, rec.client);
    }
  }

  /** Subscribe to a freshly created client's events. */
  private bindClient(client: CastClientLike, device: CastDevice): void {
    client.on("message", (msg) => this.onClientMessage(client, msg));
    client.on("receiverStatus", (status) => this.onClientStatus(client, device, status));
    client.on("transportClosed", (transportId) => this.onTransportClosed(client, transportId));
    client.on("close", () => this.onClientClose(client, device.id));
  }

  private onClientMessage(client: CastClientLike, msg: ClientMessage): void {
    if (typeof msg.data !== "string") return;
    for (const rec of this.sessions.values()) {
      if (rec.client !== client || rec.app.transportId !== msg.sourceId) continue;
      for (const member of rec.members) {
        this.emitTo(member, {
          type: "message",
          sessionId: rec.app.sessionId,
          namespace: msg.namespace,
          message: msg.data,
        });
      }
    }
  }

  private onClientStatus(client: CastClientLike, device: CastDevice, status: ReceiverStatus): void {
    for (const rec of [...this.sessions.values()]) {
      if (rec.client !== client) continue;
      const app = status.applications.find((a) => a.sessionId === rec.app.sessionId);
      if (app === undefined) {
        this.sessions.delete(rec.app.sessionId);
        this.forget(rec.app.sessionId);
        for (const member of rec.members) {
          if (rec.stoppingBy !== undefined && member === rec.stoppingBy) continue;
          this.emitTo(member, { type: "sessionEnded", sessionId: rec.app.sessionId, status: "stopped" });
        }
        continue;
      }
      rec.app = app;
      rec.lastVolume = status.volume;
      const snapshot = this.snapshotOf(rec);
      if (!sameValue(snapshot, rec.lastSnapshot)) {
        rec.lastSnapshot = snapshot;
        for (const member of rec.members) {
          this.emitTo(member, { type: "sessionUpdated", session: snapshot });
        }
      }
    }
    this.cleanupIdle(device.id, client);
  }

  private onTransportClosed(client: CastClientLike, transportId: string): void {
    for (const rec of [...this.sessions.values()]) {
      if (rec.client !== client || rec.app.transportId !== transportId) continue;
      this.sessions.delete(rec.app.sessionId);
      this.forget(rec.app.sessionId);
      for (const member of rec.members) {
        this.emitTo(member, { type: "sessionEnded", sessionId: rec.app.sessionId, status: "disconnected" });
      }
    }
  }

  private onClientClose(client: CastClientLike, deviceId: string): void {
    const entry = this.clients.get(deviceId);
    if (entry !== undefined && entry.client === client) this.clients.delete(deviceId);
    for (const rec of [...this.sessions.values()]) {
      if (rec.client !== client) continue;
      this.sessions.delete(rec.app.sessionId);
      for (const member of rec.members) {
        this.emitTo(member, { type: "sessionEnded", sessionId: rec.app.sessionId, status: "disconnected" });
      }
    }
  }

  /** Re-check availability for every initialized sender; emit only on change. */
  private onDevicesChanged(): void {
    if (this.disposed) return;
    const devices = this.options.devices.devices();
    for (const [id, rec] of this.senders) {
      const available = devices.some((d) => deviceMatches(d, rec.capabilities));
      if (available !== rec.lastAvailable) {
        rec.lastAvailable = available;
        this.emitTo(id, { type: "receiverAvailability", available });
      }
    }
  }

  /** Close the client when no session uses it any more and no openSession is in flight. */
  private cleanupIdle(deviceId: string, client: CastClientLike): void {
    const entry = this.clients.get(deviceId);
    if (entry !== undefined && entry.client === client && entry.opening > 0) return;
    for (const rec of this.sessions.values()) {
      if (rec.client === client) return;
    }
    this.dropClient(deviceId, client);
  }

  /** Forget a client and close it; a no-op unless it is still the registered entry for the device. */
  private dropClient(deviceId: string, client: CastClientLike): void {
    const entry = this.clients.get(deviceId);
    if (entry === undefined || entry.client !== client) return;
    this.clients.delete(deviceId);
    client.close();
  }

  private snapshotOf(rec: SessionRecord): SessionSnapshot {
    const app = rec.app;
    const volume: VolumeSnapshot = {
      level: rec.lastVolume.level ?? null,
      muted: rec.lastVolume.muted ?? null,
    };
    if (rec.lastVolume.controlType !== undefined) volume.controlType = rec.lastVolume.controlType;
    if (rec.lastVolume.stepInterval !== undefined) volume.stepInterval = rec.lastVolume.stepInterval;
    return {
      sessionId: app.sessionId,
      appId: app.appId,
      displayName: app.displayName,
      appImages: app.iconUrl ? [{ url: app.iconUrl }] : [],
      statusText: app.statusText ?? null,
      namespaces: app.namespaces,
      transportId: app.transportId,
      receiver: {
        label: rec.device.id,
        friendlyName: rec.device.name,
        capabilities: capabilityNames(rec.device.capabilities),
        volume,
        isActiveInput: null,
      },
    };
  }

  private emitTo(senderId: number, event: BridgeEvent): void {
    if (this.disposed) return;
    this.options.emit(senderId, event);
  }
}
