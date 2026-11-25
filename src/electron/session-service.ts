import type { BridgeEvent, BridgeResult, SessionSnapshot, VolumeSnapshot } from "../polyfill/bridge-types.ts";
import type { CastDevice } from "../discovery/index.ts";
import type { ReceiverApplication, ReceiverStatus, ReceiverVolume } from "../client/index.ts";
import { CastTimeoutError } from "../client/index.ts";
import {
  ObservedMap, createPickerContext, createSinksObservers, type DevicePickerContext, type MediaRoute,
} from "./manager-api.ts";
import { CastSinkService, type ChannelParams, type CastSinkOptions } from "./sink-service.ts";
import { CastSessionTracker, type TrackedSession } from "./session-tracker.ts";

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

/** CastAppDiscoveryServiceImpl kRefreshThreshold: how long an "unavailable" answer stands. */
export const APP_AVAILABILITY_REFRESH_MS = 60_000;

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
  /** `GET_APP_AVAILABILITY`; a client without it is taken to have every app. */
  getAppAvailability?(appIds: string[]): Promise<Record<string, boolean>>;
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

/** The picker's answer: a device to cast to, `null` (cancel) or `"stop"` (stop the sender's current session). */
export type DeviceChoice = CastDevice | null | "stop";

/** Dependencies and callbacks of {@link CastSessionService}. */
export interface CastSessionServiceOptions {
  devices: DeviceSource;
  /**
   * Make a client for a device. `params` carries the connect and liveness timeouts Chrome would use for this attempt
   * (10 s; longer after failures only when `sinks.dynamicTimeoutDeltaMs` is set).
   */
  createClient(device: CastDevice, params: ChannelParams): CastClientLike;
  /**
   * Ask the user which device to cast to. Resolves a device, `null` (cancel) or
   * `"stop"` (stop `request.session`, the sender's current session, if it has one).
   */
  selectDevice(devices: CastDevice[], request: CastRequestInfo, picker: DevicePickerContext): Promise<DeviceChoice>;
  allowOrigin?(origin: string): boolean;
  emit(senderId: number, event: BridgeEvent): void;
  /** How channels to the devices are opened and retried; the defaults are Chrome's (see {@link CastSinkOptions}). */
  sinks?: CastSinkOptions;
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
  private readonly messageListeners = new Set<(sessionId: string, namespace: string, data: string) => void>();
  private readonly sinks;
  /** The devices with an open channel; the only devices the service offers or casts to. */
  private readonly sinkService: CastSinkService;
  private readonly tracker = new CastSessionTracker();
  private lastRoutesKey = "";
  /** Devices a page's launch is in flight on, with how many: the session it starts is the page's, not a non-local one. */
  private readonly launching = new Map<string, number>();
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private readonly deviceListener = (): void => this.onDevicesChanged();
  /** device id -> app id -> the answer and when it came (Chrome's CastAppAvailabilityTracker keeps the time too) */
  private readonly appAvailability = new Map<string, Map<string, { available: boolean; at: number }>>();
  /** Bumped when a device goes or comes back, so an answer that was in flight across it is dropped. */
  private readonly appAvailabilityGeneration = new Map<string, number>();
  private readonly appAvailabilityPending = new Map<string, Promise<boolean>>();
  private disposed = false;

  constructor(options: CastSessionServiceOptions) {
    this.options = options;
    this.sinkService = new CastSinkService({
      ...options.sinks,
      source: options.devices,
      createClient: options.createClient,
      isClientInUse: (client) => [...this.sessions.values()].some((rec) => rec.client === client),
    });
    this.sinks = createSinksObservers(this.sinkService);
    this.sinkService.on("deviceUp", this.deviceListener);
    this.sinkService.on("deviceDown", this.deviceListener);
    this.sinkService.on("deviceChanged", this.deviceListener);
    this.sinkService.on("channelOpened", ({ device, client }) => {
      // The tracker goes first so that, when a status ends a session, it no longer lists it by the time this one reports.
      this.tracker.attach(device.id, client);
      this.bindClient(client, device);
    });
    this.sinkService.on("channelOpened", ({ device }) => this.onSinkAddedOrUpdated(device));
    this.sinkService.on("sinkRemoved", (device) => {
      this.tracker.removeSink(device.id);
      this.onSinkRemoved(device);
    });
    this.tracker.on("sessionAddedOrUpdated", () => this.onTrackerChanged());
    this.tracker.on("sessionRemoved", () => this.onTrackerChanged());
  }

  /** The devices that can be cast to: those with an open, authenticated channel (as Chrome lists sinks). */
  devices(): CastDevice[] {
    return this.sinkService.devices();
  }

  /** The devices as a {@link DeviceSource}: what `devices()` lists, with the events of that list changing. */
  deviceSource(): DeviceSource {
    return this.sinkService;
  }

  /** Open channels to the discovered devices that have none now, without Chrome's random delay. */
  discoverSinksNow(): void {
    this.sinkService.discoverSinksNow();
  }

  /** Resolves when no channel is being opened and none is scheduled to be; for tests. */
  settled(options?: { retries?: boolean }): Promise<void> {
    return this.sinkService.settled(options);
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
        case "requestSessionOnDevice":
          // main only: the app's own UI chose the device (see the manager's startCasting)
          return await this.handleRequestSession(sender, params, isRecord(params) && typeof params.deviceId === "string" ? params.deviceId : "");
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
    for (const pending of this.pendingRequests.values()) pending.picker?.close();
    this.sessions.clear();
    this.tracker.dispose();
    this.sinkService.dispose();
    this.senders.clear();
    this.pendingRequests.clear();
  }

  /**
   * `CastAppDiscoveryServiceImpl::OnSinkAddedOrUpdated`, which `MediaSinkServiceBase::AddOrUpdateSink` calls as soon as
   * the channel opens (not after the 3 s report): answers in flight about an earlier channel are dropped.
   */
  private onSinkAddedOrUpdated(device: CastDevice): void {
    this.appAvailabilityGeneration.set(device.id, (this.appAvailabilityGeneration.get(device.id) ?? 0) + 1);
  }

  /** `CastAppDiscoveryServiceImpl::OnSinkRemoved` -> `CastAppAvailabilityTracker::RemoveResultsForSink`. */
  private onSinkRemoved(device: CastDevice): void {
    this.appAvailability.delete(device.id);
    this.appAvailabilityGeneration.set(device.id, (this.appAvailabilityGeneration.get(device.id) ?? 0) + 1);
  }

  /**
   * What the device said about the app (`GET_APP_AVAILABILITY`), or undefined when it has to be asked: never asked, no
   * answer last time, or "unavailable" longer than `APP_AVAILABILITY_REFRESH_MS` ago. This is
   * CastAppDiscoveryServiceImpl::ShouldRefreshAppAvailability: kAvailable is kept, kUnavailable is asked again after
   * kRefreshThreshold, kUnknown always.
   */
  cachedAppAvailability(device: CastDevice, appId: string): boolean | undefined {
    const entry = this.appAvailability.get(device.id)?.get(appId);
    if (entry === undefined) return undefined;
    if (!entry.available && Date.now() - entry.at > APP_AVAILABILITY_REFRESH_MS) return undefined;
    return entry.available;
  }

  /**
   * Ask the device whether it has the app (`GET_APP_AVAILABILITY`) unless a still-valid answer is cached. An error or
   * no answer is not cached (Chrome's kUnknown): this resolves false, and the next call asks again. Callers that ask on
   * every change (sinks observers) must pace themselves; see createSinksObservers.
   */
  checkAppAvailability(device: CastDevice, appId: string): Promise<boolean> {
    const known = this.cachedAppAvailability(device, appId);
    if (known !== undefined) return Promise.resolve(known);
    const generation = this.appAvailabilityGeneration.get(device.id) ?? 0;
    const key = `${device.id}\n${generation}\n${appId}`;
    const inFlight = this.appAvailabilityPending.get(key);
    if (inFlight !== undefined) return inFlight;
    const run = (async (): Promise<boolean> => {
      // Asked over the device's kept-open channel (Chrome: the sink's CastSocket); no channel now is kUnknown
      const client = this.sinkService.clientOf(device.id);
      try {
        if (client === undefined) return false;
        const ask = client.getAppAvailability;
        const available = ask === undefined ? true : (await ask.call(client, [appId]))[appId] === true;
        // the device's channel was replaced or the sink went while it was being asked: this answer is about the old one
        if ((this.appAvailabilityGeneration.get(device.id) ?? 0) === generation) {
          let apps = this.appAvailability.get(device.id);
          if (apps === undefined) this.appAvailability.set(device.id, (apps = new Map()));
          apps.set(appId, { available, at: Date.now() });
        }
        return available;
      } catch {
        return false;
      } finally {
        this.appAvailabilityPending.delete(key);
      }
    })();
    this.appAvailabilityPending.set(key, run);
    return run;
  }

  private handleInitialize(sender: SenderInfo, params: unknown): BridgeResult {
    const p = parseInitialize(params);
    if (p === null) return bad("invalid_parameter");
    const available = this.sinkService.devices().some((d) => deviceMatches(d, p.capabilities));
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

  /** With `presetDeviceId` the picker is skipped: that device is the choice (and must still be eligible). */
  private async handleRequestSession(sender: SenderInfo, params: unknown, presetDeviceId?: string): Promise<BridgeResult> {
    const p = parseRequestSession(params);
    if (p === null) return bad("invalid_parameter");
    if (this.pendingRequests.has(sender.id)) return bad("invalid_parameter");
    const discard = { value: false };
    const cancelled = { value: false };
    const pending: PendingRequest = { discard, cancelled };
    this.pendingRequests.set(sender.id, pending);
    try {
      const eligible = this.sinkService.devices().filter((d) => deviceMatches(d, p.capabilities));
      if (eligible.length === 0) {
        // Say why the devices found are not offered, when they failed to open (Chrome shows no sink and logs the error)
        const why = this.sinkService.openErrors();
        return bad("receiver_unavailable", why.length > 0 ? `no device could be reached: ${why.join("; ")}` : undefined);
      }
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
      if (presetDeviceId !== undefined) {
        choice = eligible.find((d) => d.id === presetDeviceId) ?? null;
        if (choice === null) return bad("receiver_unavailable");
      } else {
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
      // Chrome's CastActivityManager::LaunchSession launches anew even on a sink that has a route (the receiver's status
      // update then removes the old one), so only the page's own picker reuses the sender's session
      if (presetDeviceId === undefined && request.session !== undefined && choice.id === request.session.deviceId) {
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
      this.tracker.applyStatus(rec.device.id, rec.client, await rec.client.stop(rec.app.sessionId));
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
      this.tracker.applyStatus(rec.device.id, rec.client, await rec.client.setVolume({ level: p.level }));
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
      this.tracker.applyStatus(rec.device.id, rec.client, await rec.client.setVolume({ muted: p.muted }));
    } catch (err) {
      return bad("session_error", describe(err));
    }
    return good(undefined);
  }

  /**
   * Join a session by its id, as Chrome's Media Router does for `reconnect("cast-session_<id>")`. A session this
   * service already holds is joined without an origin check, like one found on a device. Otherwise the id is looked up
   * in the session tracker, which knows what every device with an open channel runs: Chrome's CastActivityManager adds
   * a non-local activity for each session its CastSessionTracker learns (AddNonLocalActivity) and
   * FindActivityForSessionJoin finds it by id alone; auto-join skips it and no origin is checked. `appId`, when given,
   * must be the session's app (CastActivity::CanJoinSession). Joining makes the route local, as in Chrome.
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
    const tracked = this.tracker.sessionById(p.sessionId);
    if (tracked === undefined || this.disposed || (appId !== undefined && tracked.appId !== appId)) return bad("session_error");
    const client = this.sinkService.clientOf(tracked.sinkId);
    const device = this.sinkService.sinkOf(tracked.sinkId);
    if (client === undefined || device === undefined) return bad("session_error");
    client.connectTransport(tracked.app.transportId);
    const rec: SessionRecord = {
      device,
      client,
      app: tracked.app,
      origin: sender.origin,
      appId: tracked.appId,
      members: new Set([sender.id]),
      parked: new Set(),
      lastVolume: tracked.volume,
      lastSnapshot: null,
    };
    rec.lastSnapshot = this.snapshotOf(rec);
    this.sessions.set(tracked.sessionId, rec);
    return good(rec.lastSnapshot);
  }

  /** Launch the app on the device's open channel and register the session. */
  private async openSession(
    device: CastDevice,
    appId: string,
    sender: SenderInfo,
    discard: { value: boolean },
    cancelled: { value: boolean },
  ): Promise<SessionSnapshot> {
    // Casting needs a channel that is open now; a device that is not a sink (or whose channel dropped) is unavailable.
    const client = this.sinkService.clientOf(device.id);
    if (client === undefined) throw new MappedError("receiver_unavailable", "no open channel to the device");
    if (discard.value) throw new Discarded();
    if (cancelled.value) throw new MappedError("cancel", "cancelled");
    this.launching.set(device.id, (this.launching.get(device.id) ?? 0) + 1);
    try {
      return await this.launchOn(device, client, appId, sender, discard, cancelled);
    } finally {
      const left = (this.launching.get(device.id) ?? 1) - 1;
      if (left > 0) this.launching.set(device.id, left);
      else this.launching.delete(device.id);
      // A launch that ended without a session leaves the device's own session listed again
      if (left === 0) this.onTrackerChanged();
    }
  }

  private async launchOn(
    device: CastDevice,
    client: CastClientLike,
    appId: string,
    sender: SenderInfo,
    discard: { value: boolean },
    cancelled: { value: boolean },
  ): Promise<SessionSnapshot> {
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
      this.tracker.applyStatus(device.id, client, status);
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
    return snapshot;
  }

  /** Remove a sender from a session; when it was the last one, tear the session down. */
  private leave(rec: SessionRecord, senderId: number): void {
    rec.members.delete(senderId);
    rec.parked.delete(senderId);
    if (rec.members.size === 0 && rec.parked.size === 0) {
      rec.client.closeTransport(rec.app.transportId);
      this.sessions.delete(rec.app.sessionId);
    } else {
      this.notifySession("updated", rec);
    }
  }

  /** Subscribe to a freshly opened channel's events. */
  private bindClient(client: CastClientLike, _device: CastDevice): void {
    client.on("message", (msg) => this.onClientMessage(client, msg));
    client.on("receiverStatus", (status) => this.onClientStatus(client, status));
    client.on("transportClosed", (transportId) => this.onTransportClosed(client, transportId));
    client.on("close", () => this.onClientClose(client));
  }

  private onClientMessage(client: CastClientLike, msg: ClientMessage): void {
    if (typeof msg.data !== "string") return;
    for (const rec of this.sessions.values()) {
      if (rec.client !== client || rec.app.transportId !== msg.sourceId) continue;
      for (const l of [...this.messageListeners]) l(rec.app.sessionId, msg.namespace, msg.data);
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

  private onClientStatus(client: CastClientLike, status: ReceiverStatus): void {
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

  private onClientClose(client: CastClientLike): void {
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
    const devices = this.sinkService.devices();
    for (const [id, rec] of this.senders) {
      const available = devices.some((d) => deviceMatches(d, rec.capabilities));
      if (available !== rec.lastAvailable) {
        rec.lastAvailable = available;
        this.emitTo(id, { type: "receiverAvailability", available });
      }
    }
  }

  // Main-process API (see manager-api.ts). Control goes through the paths the pages use, so pages see the same events.

  /**
   * Every live session, parked ones included, then the sessions the devices run that this service does not hold
   * (started elsewhere, or let go of here), as Chrome's non-local routes.
   */
  mediaRoutes(): MediaRoute[] {
    const local = [...this.sessions.values()].map((rec) => this.routeOf(rec));
    return [...local, ...this.nonLocalSessions().map((s) => this.nonLocalRouteOf(s))];
  }

  /** The tracked sessions no page of this service holds (Chrome: activities with `is_local` false). */
  private nonLocalSessions(): TrackedSession[] {
    return this.tracker.sessions().filter((s) => !this.sessions.has(s.sessionId) && !this.launching.has(s.sinkId));
  }

  /** Be told when a session starts, changes (status, volume, pages) or ends; returns the unsubscribe function. */
  observeSessions(listener: () => void): () => void {
    this.sessionListeners.add(listener);
    return () => void this.sessionListeners.delete(listener);
  }

  /**
   * Stop a session on the device for every page, as if a member had called stopSession. A session this service does not
   * hold is stopped on its device as it is (Chrome's TerminateSession works on non-local activities too).
   */
  async terminateSession(sessionId: string): Promise<BridgeResult> {
    const rec = this.sessions.get(sessionId);
    // No page is the caller, so every member is told sessionEnded.
    if (rec !== undefined) return this.stopSessionRecord(rec, MAIN_CALLER, false);
    const tracked = this.nonLocalSessions().find((s) => s.sessionId === sessionId);
    if (tracked === undefined) return bad("session_error", "unknown session");
    // With no open channel the stop cannot be sent: Chrome's `CastMessageHandler::StopSession` finds no socket and
    // reports a failure, which `HandleStopSessionResponse` turns into this message while the route stays.
    const client = this.sinkService.clientOf(tracked.sinkId);
    if (client === undefined) return bad("session_error", "StopSession response is not OK. Failed to terminate route.");
    try {
      this.tracker.applyStatus(tracked.sinkId, client, await client.stop(sessionId));
    } catch (err) {
      return bad("session_error", describe(err));
    }
    return good(undefined);
  }

  async setSessionVolume(sessionId: string, volume: { level: number } | { muted: boolean }): Promise<BridgeResult> {
    const rec = this.sessions.get(sessionId);
    const tracked = rec === undefined ? this.nonLocalSessions().find((s) => s.sessionId === sessionId) : undefined;
    const client = rec?.client ?? (tracked === undefined ? undefined : this.sinkService.clientOf(tracked.sinkId));
    const sinkId = rec?.device.id ?? tracked?.sinkId;
    if (client === undefined || sinkId === undefined) return bad("session_error", "unknown session");
    try {
      this.tracker.applyStatus(sinkId, client, await client.setVolume(volume));
    } catch (err) {
      return bad("session_error", describe(err));
    }
    return good(undefined);
  }

  /** Receivers send a session's messages to main as well as to its pages; for the media controller (see media-controller.ts). */
  observeSessionMessages(listener: (sessionId: string, namespace: string, data: string) => void): () => void {
    this.messageListeners.add(listener);
    return () => void this.messageListeners.delete(listener);
  }

  /** Send a message to a session's receiver app from main, with no page involved. */
  sendSessionMessage(sessionId: string, namespace: string, message: string): BridgeResult {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) return bad("session_error", "unknown session");
    try {
      rec.client.send(namespace, rec.app.transportId, message);
    } catch (err) {
      return bad("channel_error", describe(err));
    }
    return good(undefined);
  }

  /** The volume the receiver last reported for a session (Chrome: `receiver.volume` of the CastSession). */
  sessionVolume(sessionId: string): ReceiverVolume | undefined {
    return this.sessions.get(sessionId)?.lastVolume;
  }

  /**
   * Detach every page from the session and close its transport; the receiver app keeps running (and is then listed as a
   * non-local route). A route no page holds has nothing to detach.
   */
  detachSession(sessionId: string): BridgeResult {
    const rec = this.sessions.get(sessionId);
    if (rec === undefined) {
      return this.nonLocalSessions().some((s) => s.sessionId === sessionId) ? good(undefined) : bad("session_error", "unknown session");
    }
    for (const member of rec.members) {
      this.emitTo(member, { type: "sessionEnded", sessionId, status: "disconnected" });
    }
    rec.members.clear();
    rec.parked.clear();
    rec.client.closeTransport(rec.app.transportId);
    this.sessions.delete(sessionId);
    return good(undefined);
  }

  /** Tell the route observers something changed (the arguments only fit the ObservedMap callback). */
  private notifySession(_kind: "started" | "updated" | "ended", _rec: SessionRecord): void {
    if (this.disposed) return;
    if (_kind === "ended") this.sinkService.releaseUnused();
    this.lastRoutesKey = JSON.stringify(this.mediaRoutes());
    this.fireSessionListeners();
  }

  /** The tracker learned something; route observers hear of it only if the routes they see differ now. */
  private onTrackerChanged(): void {
    if (this.disposed) return;
    const key = JSON.stringify(this.mediaRoutes());
    if (key === this.lastRoutesKey) return;
    this.lastRoutesKey = key;
    this.fireSessionListeners();
  }

  private fireSessionListeners(): void {
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
      sinkName: rec.device.name,
      description: rec.app.statusText || rec.app.displayName,
      isLocal: true,
      appId: rec.appId,
      displayName: rec.app.displayName,
      origin: rec.origin,
      volume: { level: rec.lastVolume.level ?? null, muted: rec.lastVolume.muted ?? null },
      members: [...rec.members],
      parkedSenders: [...rec.parked],
      parked: rec.members.size === 0,
    };
  }

  /** Chrome's `AddNonLocalActivity`: the route has no page, and its description is the session's (`GetRouteDescription`). */
  private nonLocalRouteOf(session: TrackedSession): MediaRoute {
    return {
      id: session.sessionId,
      mediaSource: `cast:${session.appId}`,
      sinkId: session.sinkId,
      sinkName: this.sinkService.sinkOf(session.sinkId)?.name ?? "",
      description: session.statusText || session.displayName,
      isLocal: false,
      appId: session.appId,
      displayName: session.displayName,
      origin: "",
      volume: { level: session.volume.level ?? null, muted: session.volume.muted ?? null },
      members: [],
      parkedSenders: [],
      parked: false,
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
