import type { BridgeEvent, BridgeResult, SessionSnapshot, VolumeSnapshot } from "../polyfill/bridge-types.ts";
import type { WiredDisplaySink } from "./wired-display/displays.ts";
import type { CastDevice } from "../discovery/index.ts";
import type { ReceiverApplication, ReceiverStatus, ReceiverVolume } from "../client/index.ts";
import { CastTimeoutError } from "../client/index.ts";
import {
  ObservedMap, createPickerContext, createSinksObservers, type DevicePickerContext, type MediaRoute,
} from "./manager-api.ts";

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
  /**
   * Set when the page's request could also be shown on a display (its URLs mix a Cast app URL and a standard presentation
   * source) and displays exist: Chrome's dialog lists both kinds of sink. Answer `{ display: <sink id> }` to pick one.
   */
  displays?: readonly WiredDisplaySink[];
}

/** A display chosen in a picker that also lists displays (see {@link CastRequestInfo.displays}). */
export interface DisplayChoice {
  /** The id of one of `request.displays`. */
  display: string;
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
  selectDevice(devices: CastDevice[], request: CastRequestInfo, picker: DevicePickerContext): Promise<DeviceChoice>;
  allowOrigin?(origin: string): boolean;
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
  /**
   * Senders whose page navigated away (a reload, say) while a member. Like Chrome's Media Router, the session outlives
   * the page: it stays open on the device so the sender's next page can rejoin it. Parked senders get no events.
   */
  parked: Set<number>;
  lastVolume: ReceiverVolume;
  lastSnapshot: SessionSnapshot | null;
  /** Set while a stopSession is in flight; onClientStatus skips this sender when it ends the session. */
  stoppingBy?: number;
}

interface PendingRequest {
  discard: { value: boolean };
  cancelled: { value: boolean };
  /** The live picker context while the picker is open. */
  picker?: { close(): void };
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
/** The caller id of a stop that comes from the main process, not from a page. */
const MAIN_CALLER = -1;

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
  private readonly sessions = new ObservedMap<string, SessionRecord>((kind, rec) => this.notifySession(kind, rec));
  private readonly sessionListeners = new Set<() => void>();
  private readonly sinks;
  private readonly clients = new Map<string, ClientEntry>();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly deviceListener = (): void => this.onDevicesChanged();
  private disposed = false;

  constructor(options: CastSessionServiceOptions) {
    this.options = options;
    this.sinks = createSinksObservers(options.devices);
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
          return this.handleJoinSession(sender, params, true);
        case "joinRunningSession":
          return await this.handleJoinRunningSession(sender, params);
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
    this.forgetSender(senderId);
    for (const rec of [...this.sessions.values()]) {
      if (!rec.members.has(senderId) && !rec.parked.has(senderId)) continue;
      this.leave(rec, senderId);
    }
  }

  /**
   * The sender's page navigated (a reload or a new page): cancel its pending request and drop its bookkeeping, but
   * keep its sessions open on the device, parked, so the next page can rejoin them (auto-join or joinSession) as it
   * would in Chrome. A parked session ends as usual if the receiver app stops or the device drops; senderGone ends
   * the sender's share of it for good.
   */
  senderNavigated(senderId: number): void {
    this.forgetSender(senderId);
    for (const rec of this.sessions.values()) {
      if (!rec.members.delete(senderId)) continue;
      rec.parked.add(senderId);
      this.notifySession("updated", rec);
    }
  }

  private forgetSender(senderId: number): void {
    const pending = this.pendingRequests.get(senderId);
    if (pending !== undefined) {
      pending.cancelled.value = true;
      pending.picker?.close();
    }
    this.pendingRequests.delete(senderId);
    this.senders.delete(senderId);
  }

  /** Unsubscribe, close every client and clear all state. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.sinks.dispose();
    const d = this.options.devices;
    d.off("deviceUp", this.deviceListener);
    d.off("deviceDown", this.deviceListener);
    d.off("deviceChanged", this.deviceListener);
    for (const pending of this.pendingRequests.values()) pending.picker?.close();
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
    this.senders.set(sender.id, { appId: p.appId, capabilities: p.capabilities, lastAvailable: available });
    const joined: SessionSnapshot[] = [];
    for (const rec of this.sessions.values()) {
      if (rec.appId !== p.appId || rec.origin !== sender.origin) continue;
      // tab_and_origin_scoped: this sender (the same tab) is a member, or was one before its page navigated
      const sameTab = rec.members.has(sender.id) || rec.parked.has(sender.id);
      if (p.autoJoinPolicy === "origin_scoped" || (p.autoJoinPolicy === "tab_and_origin_scoped" && sameTab)) {
        rec.parked.delete(sender.id);
        rec.members.add(sender.id);
        this.notifySession("updated", rec);
        joined.push(this.snapshotOf(rec));
      }
    }
    return good({ available, sessions: joined });
  }

  private async handleRequestSession(sender: SenderInfo, params: unknown): Promise<BridgeResult> {
    const p = parseRequestSession(params);
    if (p === null) return bad("invalid_parameter");
    if (this.pendingRequests.has(sender.id)) return bad("invalid_parameter");
    const discard = { value: false };
    const cancelled = { value: false };
    const pending: PendingRequest = { discard, cancelled };
    this.pendingRequests.set(sender.id, pending);
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
      // The picker gets live device updates until it answers; closing aborts its signal.
      const pick = createPickerContext(this.sinks, (d) => deviceMatches(d, p.capabilities));
      pending.picker = pick;
      try {
        choice = await this.options.selectDevice(eligible, request, pick.context);
      } catch (err) {
        return bad("session_error", describe(err));
      } finally {
        pick.close();
      }
      if (choice === null) return bad("cancel");
      if (choice === "stop") {
        const rec = request.session !== undefined ? this.sessions.get(request.session.sessionId) : undefined;
        if (rec === undefined) return bad("cancel");
        // Like Chrome, tell the caller's receiver action listeners about the stop before the session ends.
        this.emitTo(sender.id, { type: "receiverAction", sessionId: rec.app.sessionId, action: "stop" });
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

  /**
   * `checkOrigin` is joinSession's own rule (mode "chromecast", which is frozen and has no
   * Chromium counterpart). Joining by id, as Chrome's Presentation API path does, has none: AppActivity::CanJoinSession checks only
   * the app and that the client is not connected yet.
   */
  private handleJoinSession(sender: SenderInfo, params: unknown, checkOrigin: boolean): BridgeResult {
    const p = parseSessionId(params);
    if (p === null) return bad("invalid_parameter");
    const rec = this.sessions.get(p.sessionId);
    if (rec === undefined || (checkOrigin && rec.origin !== sender.origin)) return bad("session_error");
    rec.parked.delete(sender.id);
    rec.members.add(sender.id);
    this.notifySession("updated", rec);
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
    // A lookup may never await this; openSession still sees the rejection.
    entry.ready.catch(() => {});
    this.clients.set(device.id, entry);
    return entry;
  }

  /**
   * Join a session by its id, as Chrome's Media Router does for `reconnect("cast-session_<id>")`. A session this
   * service already holds is joined without an origin check, like one found on a device. Otherwise the id is looked up
   * in the receiver status of
   * every known device: Chrome's CastSessionTracker learns the sessions running on all sinks and
   * CastActivityManager::AddNonLocalActivity makes them joinable by id (and only by id: auto-join skips them, and no
   * origin is checked). `appId`, when given, must be the session's app (CastActivity::CanJoinSession). Unlike Chrome
   * the lookup runs when asked instead of tracking every device all the time.
   */
  private async handleJoinRunningSession(sender: SenderInfo, params: unknown): Promise<BridgeResult> {
    const p = parseSessionId(params);
    if (p === null) return bad("invalid_parameter");
    const appId = isRecord(params) && typeof params.appId === "string" ? params.appId : undefined;
    const known = this.sessions.get(p.sessionId);
    if (known !== undefined) {
      if (appId !== undefined && known.appId !== appId) return bad("session_error");
      return this.handleJoinSession(sender, params, false);
    }
    const found = await this.findRunningSession(p.sessionId);
    if (found === undefined) return bad("session_error");
    const { entry, app, volume } = found;
    try {
      if (this.disposed || (appId !== undefined && app.appId !== appId)) return bad("session_error");
      // Another join of the same session finished while this one looked.
      if (this.sessions.has(app.sessionId)) return this.handleJoinSession(sender, params, false);
      entry.client.connectTransport(app.transportId);
      const rec: SessionRecord = {
        device: entry.device,
        client: entry.client,
        app,
        origin: sender.origin,
        appId: app.appId,
        members: new Set([sender.id]),
        parked: new Set(),
        lastVolume: volume,
        lastSnapshot: null,
      };
      rec.lastSnapshot = this.snapshotOf(rec);
      this.sessions.set(app.sessionId, rec);
      return good(rec.lastSnapshot);
    } finally {
      entry.opening -= 1;
      if (!this.sessions.has(app.sessionId)) this.cleanupIdle(entry.device.id, entry.client);
    }
  }

  /**
   * Ask every known device what it runs and resolve with the one running `sessionId`. The winner's `opening` count
   * stays raised for the caller to release; a device that cannot be reached or runs something else is let go.
   */
  private findRunningSession(sessionId: string): Promise<{ entry: ClientEntry; app: ReceiverApplication; volume: ReceiverVolume } | undefined> {
    const devices = this.options.devices.devices();
    return new Promise((resolve) => {
      let pending = devices.length;
      let won = false;
      if (pending === 0) resolve(undefined);
      for (const device of devices) {
        const entry = this.clientFor(device);
        entry.opening += 1;
        void (async () => {
          let app: ReceiverApplication | undefined;
          let volume: ReceiverVolume | undefined;
          try {
            await entry.ready;
            const status = await entry.client.getStatus();
            app = status.applications.find((a) => a.sessionId === sessionId);
            volume = status.volume;
          } catch {
            // unreachable: not this device
          }
          if (app !== undefined && volume !== undefined && !won) {
            won = true;
            resolve({ entry, app, volume });
            return;
          }
          entry.opening -= 1;
          this.cleanupIdle(device.id, entry.client);
          pending -= 1;
          if (pending === 0 && !won) resolve(undefined);
        })();
      }
    });
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
        parked: new Set(),
        lastVolume: status.volume,
        lastSnapshot: null,
      };
      const snapshot = this.snapshotOf(rec);
      rec.lastSnapshot = snapshot;
      this.sessions.set(app.sessionId, rec);
      registered = true;
      return snapshot;
    } finally {
      entry.opening -= 1;
      if (!registered) this.cleanupIdle(device.id, client);
    }
  }

  /** Remove a sender from a session; when it was the last one, tear the session down. */
  private leave(rec: SessionRecord, senderId: number): void {
    rec.members.delete(senderId);
    rec.parked.delete(senderId);
    if (rec.members.size === 0 && rec.parked.size === 0) {
      rec.client.closeTransport(rec.app.transportId);
      this.sessions.delete(rec.app.sessionId);
      this.cleanupIdle(rec.device.id, rec.client);
    } else {
      this.notifySession("updated", rec);
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
        this.notifySession("updated", rec);
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

  // Main-process API (see manager-api.ts). Control goes through the paths the pages use, so pages see the same events.

  /** Every live session, parked ones included. */
  mediaRoutes(): MediaRoute[] {
    return [...this.sessions.values()].map((rec) => this.routeOf(rec));
  }

  /** Be told when a session starts, changes (status, volume, pages) or ends; returns the unsubscribe function. */
  observeSessions(listener: () => void): () => void {
    this.sessionListeners.add(listener);
    return () => void this.sessionListeners.delete(listener);
  }

  /** Stop a session on the device for every page, as if a member had called stopSession. */
  async terminateSession(sessionId: string): Promise<BridgeResult> {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) return bad("session_error", "unknown session");
    // No page is the caller, so every member is told sessionEnded.
    return this.stopSessionRecord(rec, MAIN_CALLER, false);
  }

  async setSessionVolume(sessionId: string, volume: { level: number } | { muted: boolean }): Promise<BridgeResult> {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) return bad("session_error", "unknown session");
    try {
      await rec.client.setVolume(volume);
    } catch (err) {
      return bad("session_error", describe(err));
    }
    return good(undefined);
  }

  /** Detach every page from the session and close its transport; the receiver app keeps running. */
  detachSession(sessionId: string): BridgeResult {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) return bad("session_error", "unknown session");
    for (const member of rec.members) {
      this.emitTo(member, { type: "sessionEnded", sessionId, status: "disconnected" });
    }
    rec.members.clear();
    rec.parked.clear();
    rec.client.closeTransport(rec.app.transportId);
    this.sessions.delete(sessionId);
    this.cleanupIdle(rec.device.id, rec.client);
    return good(undefined);
  }

  /** Tell the route observers something changed (the arguments only fit the ObservedMap callback). */
  private notifySession(_kind: "started" | "updated" | "ended", _rec: SessionRecord): void {
    if (this.disposed) return;
    for (const listener of [...this.sessionListeners]) {
      try {
        listener();
      } catch (err) {
        console.error("electron-cast: a session listener failed", err);
      }
    }
  }

  private routeOf(rec: SessionRecord): MediaRoute {
    return {
      id: rec.app.sessionId,
      mediaSource: `cast:${rec.appId}`,
      sinkId: rec.device.id,
      description: rec.app.statusText || rec.app.displayName,
      appId: rec.appId,
      displayName: rec.app.displayName,
      origin: rec.origin,
      volume: { level: rec.lastVolume.level ?? null, muted: rec.lastVolume.muted ?? null },
      members: [...rec.members],
      parkedSenders: [...rec.parked],
      parked: rec.members.size === 0,
    };
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
