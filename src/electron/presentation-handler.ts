// Main-process presentation handler: plays the part of Chrome's Media Router for Google's clank.js Cast
// sender. The page talks to it in Chromium's private JSON envelope over a connection; the handler drives
// CastSessionService through service.handle(sender, method, params) and translates with the codec in
// presentation-envelope.ts.
import { randomBytes } from "node:crypto";
import type { BridgeEvent, InitializeResult, SessionSnapshot } from "../polyfill/bridge-types.ts";
import type { CastSessionService } from "./session-service.ts";
import { launchFieldsOf } from "./launch-fields.ts";
import type { DialService } from "../dial/index.ts";
import { DialRouteError, DialRouteProvider } from "../dial/route-provider.ts";
import type { CastDevice } from "../discovery/index.ts";
import {
  MEDIA_NAMESPACE,
  envelope,
  isMediaRequest,
  parseEnvelope,
  receiverLabel,
  receiverMediaType,
  toMediaEntry,
  toReceiver,
  toSession,
} from "./presentation-envelope.ts";
import type { ParsedEnvelope } from "./presentation-envelope.ts";
import { chooseSource } from "./presentation-source.ts";

/**
 * Why a connection closed, as the page's close event reports it: blink's `PresentationConnectionCloseReason`
 * (third_party/blink/public/mojom/presentation/presentation.mojom) as `PresentationConnectionCloseReason` names it in
 * script (presentation_connection.cc `ConnectionCloseReasonToEnum`): CONNECTION_ERROR is `error`, CLOSED `closed`,
 * WENT_AWAY `wentaway`.
 */
export type CloseReason = "error" | "closed" | "wentaway";

export interface PresentationRequestInfo { urls: string[]; origin: string; senderId: number }

export interface PresentationConnectionHandle {
  readonly id: string;
  readonly url: string;
  /** Page -> handler: one JSON envelope string. Ignored once the connection is closed. */
  send(message: string): void;
  /** The page closed the connection: leaveSession, then onclose("closed"). */
  close(): void;
  /** The page terminated the connection: stopSession, then onclose("terminated"). */
  terminate(): void;
  /** Handler -> page. While null, messages are queued; assigning a function flushes the queue in order. */
  onmessage: ((message: string) => void) | null;
  /**
   * Called once, when the connection closes for any reason. `closeReason` is the reason a "closed" connection reports
   * (`closed` when absent); a terminated connection has none.
   */
  onclose: ((reason: "closed" | "terminated", closeReason?: CloseReason) => void) | null;
}

/** An error thrown by the handler; `name` is a DOMException name the page can map onto. */
export class PresentationError extends Error {
  /** The bridge code behind it (`timeout`, `cancel`, ...), for callers that are not a page. */
  readonly bridgeCode: string | undefined;
  constructor(name: string, message: string, bridgeCode?: string) {
    super(message);
    this.name = name;
    this.bridgeCode = bridgeCode;
  }
}

/** A live getAvailability watch of one sender. */
interface Watch { close(): void }

/** Per-sender handler state: its connections keyed by clientId, and its availability watches. */
interface SenderState {
  conns: Map<string, Conn>;
  watches: Map<number, Watch>;
}

/**
 * The pending-media table is bounded as Chromium's is: `CastSessionClientImpl::kMaxPendingMediaRequests` is 1024
 * (chrome/browser/media/router/providers/cast/cast_session_client_impl.h), and a full table drops its older half.
 */
const MAX_PENDING_MEDIA = 1024;
/** Request ids wrap back to 1 past this value. */
const REQUEST_ID_MAX = 2 ** 31;
const CAST_SESSION_PREFIX = "cast-session_";
/** `MediaRouterBase::CreatePresentationId`: every presentation id the Media Router makes starts with this. */
const DIAL_PRESENTATION_PREFIX = "mr_";

/** One presentation connection between the handler and a page. */
class Conn implements PresentationConnectionHandle {
  readonly id: string;
  readonly url: string;
  readonly senderId: number;
  readonly origin: string;
  readonly clientId: string;
  /** Media request ids handed out to the receiver, mapped back to the page's sequence numbers. */
  readonly pendingMedia = new Map<number, number>();
  sessionId: string | null;
  /** The DIAL route this connection is on; null on a Cast session. */
  dialRouteId: string | null = null;
  /** The latest session snapshot seen for this connection (namespaces, receiver). */
  snapshot: SessionSnapshot | null;
  onclose: ((reason: "closed" | "terminated", closeReason?: CloseReason) => void) | null = null;
  private readonly owner: CastPresentationHandler;
  private queue: string[] = [];
  private msgHandler: ((message: string) => void) | null = null;
  private isClosed = false;

  constructor(
    owner: CastPresentationHandler,
    id: string,
    url: string,
    senderId: number,
    origin: string,
    clientId: string,
    sessionId: string | null,
    snapshot: SessionSnapshot | null,
  ) {
    this.owner = owner;
    this.id = id;
    this.url = url;
    this.senderId = senderId;
    this.origin = origin;
    this.clientId = clientId;
    this.sessionId = sessionId;
    this.snapshot = snapshot;
  }

  get onmessage(): ((message: string) => void) | null {
    return this.msgHandler;
  }

  set onmessage(fn: ((message: string) => void) | null) {
    this.msgHandler = fn;
    if (fn !== null && !this.isClosed) {
      const queued = this.queue;
      this.queue = [];
      for (const message of queued) fn(message);
    }
  }

  get closed(): boolean {
    return this.isClosed;
  }

  send(message: string): void {
    if (this.isClosed) return;
    this.owner.dispatch(this, message);
  }

  close(): void {
    this.owner.pageClosed(this);
  }

  terminate(): void {
    this.owner.pageTerminated(this);
  }

  /** Handler -> page: deliver directly, or queue until onmessage is assigned. */
  deliver(message: string): void {
    if (this.isClosed) return;
    if (this.msgHandler !== null) this.msgHandler(message);
    else this.queue.push(message);
  }

  /** Close once: no more sends or deliveries, the queue is dropped, onclose fires. */
  end(reason: "closed" | "terminated", closeReason?: CloseReason): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.queue.length = 0;
    const cb = this.onclose;
    if (cb !== null) cb(reason, reason === "closed" ? (closeReason ?? "closed") : undefined);
  }
}

/** Drives CastSessionService on behalf of pages speaking the presentation envelope. */
export class CastPresentationHandler {
  private readonly service: Pick<CastSessionService, "handle" | "observeAppAvailability">;
  private readonly dial: DialService | undefined;
  private readonly dialRoutesChanged: (() => void) | undefined;
  private readonly token: string;
  private readonly senders = new Map<number, SenderState>();
  private nextRequestId: number;
  private watchSeq = 0;

  /**
   * `dial` serves the `cast-dial:` sources of a request (its provider must use the same `token`; the service's `dial`
   * option must be the same DIAL sinks, for availability and the picker). `dialRoutesChanged` is called when the pages
   * holding a DIAL route change.
   */
  constructor(opts: {
    service: Pick<CastSessionService, "handle" | "observeAppAvailability">;
    token?: string;
    dial?: DialService;
    dialRoutesChanged?: () => void;
  }) {
    this.service = opts.service;
    this.dial = opts.dial;
    this.dialRoutesChanged = opts.dialRoutesChanged;
    this.token = opts.token ?? randomBytes(16).toString("hex");
    this.nextRequestId = 1 + Math.floor(Math.random() * (2 ** 30 - 1));
    if (this.dial !== undefined) {
      this.dial.provider.on("messages", (routeId, messages) => {
        for (const conn of this.dialConns(routeId)) for (const m of messages) conn.deliver(m);
      });
      this.dial.provider.on("terminated", (routeId) => {
        for (const conn of this.dialConns(routeId)) conn.end("terminated");
        this.dialRoutesChanged?.();
      });
    }
  }

  /** The open connections on a DIAL route. */
  private dialConns(routeId: string): Conn[] {
    const out: Conn[] = [];
    for (const state of this.senders.values()) {
      for (const conn of state.conns.values()) if (!conn.closed && conn.dialRouteId === routeId) out.push(conn);
    }
    return out;
  }

  /** The senders that hold a DIAL route with an open connection. */
  dialMembers(routeId: string): number[] {
    return [...new Set(this.dialConns(routeId).map((c) => c.senderId))];
  }

  /** The route's pages let go of it; the app keeps running on the device (nothing in Chrome stops it either). */
  detachDialRoute(routeId: string): void {
    for (const conn of this.dialConns(routeId)) conn.end("closed");
    this.dialRoutesChanged?.();
  }

  /** The sources of a request this handler can serve (`cast-dial:` ones only when it has DIAL). */
  private choose(urls: string[]): ReturnType<typeof chooseSource> {
    return chooseSource(urls, { dial: this.dial !== undefined });
  }

  /**
   * Is the app available on some receiver? As in Chrome, a Cast sink counts once it has said over its open channel that
   * it has the app (`PresentationMediaSinksObserver` on `CastAppDiscoveryServiceImpl`), and a DIAL sink once its DIAL
   * server has said so for the page's origin; a request with both kinds of source is available when either is (Blink
   * ORs the sources of a request). `onchange` follows each change until `signal` aborts. Resolves false for
   * unparseable URLs and disallowed origins.
   */
  async getAvailability(req: PresentationRequestInfo & { onchange(value: boolean): void; signal: AbortSignal }): Promise<boolean> {
    // Mirroring and remote-playback sources have no sink here, so they are unavailable (see presentation-source.ts)
    const choice = this.choose(req.urls);
    if (choice.kind !== "launch" && choice.kind !== "dial") return false;
    const cast = choice.kind === "launch" ? choice.parsed : null;
    const signal = req.signal;
    if (signal.aborted) return false;
    const state = this.senderState(req.senderId);
    const watchId = ++this.watchSeq;
    const observation = this.service.observeAppAvailability(
      this.senderOf(req.senderId, req.origin),
      {
        appIds: cast === null ? [] : [cast.appId],
        capabilities: cast?.capabilities ?? [],
        ...(choice.dial === undefined ? {} : { dialApp: choice.dial.app }),
      },
      (value) => req.onchange(value),
    );
    state.watches.set(watchId, observation);
    signal.addEventListener("abort", () => {
      state.watches.delete(watchId);
      observation.close();
    }, { once: true });
    return observation.available;
  }

  /** Launches the app and resolves with a connection carrying receiver_action then new_session. */
  async startPresentation(req: PresentationRequestInfo & { deviceId?: string }): Promise<PresentationConnectionHandle> {
    const choice = this.choose(req.urls);
    // PresentationServiceImpl::StartPresentation: "No screens found." (NotFoundError) when nothing can serve the request
    if (choice.kind === "no_sink") throw new PresentationError("NotFoundError", "No screens found.");
    if (choice.kind === "unsupported") throw new PresentationError("NotSupportedError", `Unsupported presentation URL: ${(req.urls[0] ?? "")}`);
    const parsed = choice.kind === "launch" ? choice.parsed : null;
    const castUrl = choice.kind === "launch" ? choice.url : "";
    const dialUrl = choice.dial?.url ?? null;
    const sender = this.senderOf(req.senderId, req.origin);
    // With a deviceId the app's own UI already chose the sink (Chrome's dialog), so there is no picker
    // The sinks offered are those that have the app (Chrome: the source's sinks from CastAppDiscoveryServiceImpl); with
    // a DIAL source the picker also offers the DIAL sinks that have its app, and the user's choice decides the source.
    const request = {
      appId: parsed?.appId ?? null,
      capabilities: parsed?.capabilities ?? [],
      appAvailability: true,
      timeoutMs: parsed?.launchTimeout ?? 60000,
      // supportedAppTypes, appParams and invisibleSender of the URL, once the URL parser reports them (see LaunchFields)
      ...launchFieldsOf(parsed),
      ...(req.deviceId === undefined ? {} : { deviceId: req.deviceId }),
    };
    const res = choice.dial !== undefined
      ? await this.service.handle(sender, "requestSink", { ...request, dialApp: choice.dial.app })
      : await this.service.handle(sender, req.deviceId === undefined ? "requestSession" : "requestSessionOnDevice", request);
    if (!res.ok) {
      if (res.code === "cancel") throw new PresentationError("AbortError", res.description ?? "The user cancelled the request", res.code);
      if (res.code === "receiver_unavailable") throw new PresentationError("NotFoundError", res.description ?? "No receivers are available", res.code);
      throw new PresentationError("OperationError", res.description ?? res.code, res.code);
    }
    const chosen = (res.value as { dialSink?: CastDevice } | null)?.dialSink;
    if (dialUrl !== null && chosen !== undefined) return this.startDial(req, dialUrl, chosen);
    if (parsed === null) throw new PresentationError("OperationError", "No receiver was chosen");
    const s = res.value as SessionSnapshot;
    const clientId = parsed.clientId ?? randomBytes(16).toString("hex");
    const state = this.senderState(req.senderId);
    const previous = state.conns.get(clientId);
    if (previous !== undefined) {
      state.conns.delete(clientId);
      previous.end("closed");
    }
    const conn = new Conn(this, `${CAST_SESSION_PREFIX}${s.sessionId}`, castUrl, req.senderId, req.origin, clientId, s.sessionId, s);
    state.conns.set(clientId, conn);
    const label = receiverLabel(s.receiver.label, this.token);
    conn.deliver(envelope("receiver_action", { receiver: toReceiver(s.receiver, label), action: "cast" }, clientId));
    conn.deliver(envelope("new_session", toSession(s, label), clientId));
    if (s.namespaces.some((n) => n.name === MEDIA_NAMESPACE)) {
      // Like Chromium, the request id is not recorded: the reply arrives as an unsolicited MEDIA_STATUS.
      void this.service.handle(sender, "sendMessage", {
        sessionId: s.sessionId,
        namespace: MEDIA_NAMESPACE,
        message: JSON.stringify({ type: "GET_STATUS", requestId: this.freshRequestId() }),
      });
    }
    return conn;
  }

  /** Rejoins an existing session; the connection carries new_session only. */
  async reconnectPresentation(req: PresentationRequestInfo & { presentationId: string }): Promise<PresentationConnectionHandle> {
    const choice = this.choose(req.urls);
    if (choice.kind === "no_sink") throw new PresentationError("NotFoundError", "No matching route");
    if (choice.kind === "unsupported") throw new PresentationError("NotSupportedError", `Unsupported presentation URL: ${(req.urls[0] ?? "")}`);
    if (choice.dial !== undefined && req.presentationId.startsWith(DIAL_PRESENTATION_PREFIX)) return this.joinDial(req, choice.dial.url);
    if (choice.kind !== "launch") throw new PresentationError("NotFoundError", `Unknown presentation id: ${req.presentationId}`);
    const { parsed } = choice;
    const castUrl = choice.url;
    const sender = this.senderOf(req.senderId, req.origin);
    const presentationId = req.presentationId;
    let snapshot: SessionSnapshot;
    if (presentationId === "auto-join") {
      const res = await this.service.handle(sender, "initialize", {
        appId: parsed.appId,
        capabilities: [],
        autoJoinPolicy: parsed.autoJoinPolicy,
      });
      if (!res.ok) throw new PresentationError("NotFoundError", res.description ?? "No matching route");
      const sessions = (res.value as InitializeResult).sessions;
      if (sessions.length === 0) throw new PresentationError("NotFoundError", "No matching route");
      snapshot = sessions[0]!;
    } else if (presentationId.startsWith(CAST_SESSION_PREFIX)) {
      const sessionId = presentationId.slice(CAST_SESSION_PREFIX.length);
      // Like Chrome, also finds a session this run did not start (one still playing from before an app restart).
      const res = await this.service.handle(sender, "joinRunningSession", { sessionId, appId: parsed.appId });
      if (!res.ok) throw new PresentationError("NotFoundError", res.description ?? "No matching route");
      const s = res.value as SessionSnapshot;
      if (s.appId !== parsed.appId) {
        void this.service.handle(sender, "leaveSession", { sessionId: s.sessionId });
        throw new PresentationError("NotFoundError", "The session's app does not match the request URL");
      }
      snapshot = s;
    } else {
      throw new PresentationError("NotFoundError", `Unknown presentation id: ${presentationId}`);
    }
    const clientId = parsed.clientId ?? randomBytes(16).toString("hex");
    const state = this.senderState(req.senderId);
    const previous = state.conns.get(clientId);
    if (previous !== undefined) {
      state.conns.delete(clientId);
      previous.end("closed");
    }
    const conn = new Conn(this, presentationId, castUrl, req.senderId, req.origin, clientId, snapshot.sessionId, snapshot);
    state.conns.set(clientId, conn);
    const label = receiverLabel(snapshot.receiver.label, this.token);
    conn.deliver(envelope("new_session", toSession(snapshot, label), clientId));
    return conn;
  }

  /** Creates the DIAL route on the chosen sink; the connection carries receiver_action, then new_session. */
  private async startDial(req: PresentationRequestInfo, source: string, sink: CastDevice): Promise<PresentationConnectionHandle> {
    const dial = this.dial!;
    let created: ReturnType<DialRouteProvider["createRoute"]>;
    try {
      created = dial.provider.createRoute(source, sink.id, DialRouteProvider.newPresentationId(), req.origin);
    } catch (err) {
      // Chrome maps any failed route creation to PresentationErrorType::UNKNOWN, which Blink raises as OperationError.
      throw new PresentationError("OperationError", err instanceof DialRouteError ? `${err.code}: ${err.message}` : String(err));
    }
    const { route, messages } = created;
    const conn = this.attachDial(req, route.presentationId, source, route.id, route.clientId);
    for (const m of messages) conn.deliver(m);
    return conn;
  }

  /** `DialMediaRouteProvider::JoinRoute`: the same presentation id, source and origin; no message follows. */
  private async joinDial(req: PresentationRequestInfo & { presentationId: string }, source: string): Promise<PresentationConnectionHandle> {
    const route = this.dial!.provider.joinRoute(req.presentationId, source, req.origin);
    if (route === null) throw new PresentationError("NotFoundError", "No matching route");
    return this.attachDial(req, route.presentationId, source, route.id, route.clientId);
  }

  private attachDial(req: PresentationRequestInfo, presentationId: string, source: string, routeId: string, clientId: string): Conn {
    const state = this.senderState(req.senderId);
    const previous = state.conns.get(clientId);
    if (previous !== undefined) {
      state.conns.delete(clientId);
      previous.end("closed");
    }
    const conn = new Conn(this, presentationId, source, req.senderId, req.origin, clientId, null, null);
    conn.dialRouteId = routeId;
    state.conns.set(clientId, conn);
    this.dialRoutesChanged?.();
    return conn;
  }

  /** A service event for one of our senders (wired to the service's emit option). */
  onServiceEvent(senderId: number, event: BridgeEvent): void {
    const state = this.senders.get(senderId);
    if (state === undefined) return;
    switch (event.type) {
      case "receiverAvailability":
        // chrome.cast's availability (initialize); a page's PresentationRequest has its own (observeAppAvailability)
        return;
      case "sessionUpdated": {
        for (const conn of [...state.conns.values()]) {
          if (conn.closed || conn.sessionId !== event.session.sessionId) continue;
          conn.snapshot = event.session;
          const label = receiverLabel(event.session.receiver.label, this.token);
          conn.deliver(envelope("update_session", toSession(event.session, label), conn.clientId));
        }
        return;
      }
      case "receiverAction": {
        for (const conn of [...state.conns.values()]) {
          if (conn.closed || conn.sessionId !== event.sessionId) continue;
          const snap = conn.snapshot;
          if (snap === null) continue;
          const label = receiverLabel(snap.receiver.label, this.token);
          conn.deliver(envelope("receiver_action", { receiver: toReceiver(snap.receiver, label), action: "stop" }, conn.clientId));
        }
        return;
      }
      case "sessionEnded": {
        for (const conn of [...state.conns.values()]) {
          if (conn.closed || conn.sessionId !== event.sessionId) continue;
          this.endSession(conn, event.status);
        }
        return;
      }
      case "message": {
        for (const conn of [...state.conns.values()]) {
          if (conn.closed || conn.sessionId !== event.sessionId) continue;
          if (event.namespace === MEDIA_NAMESPACE) this.deliverMediaReply(conn, event.message);
          else conn.deliver(envelope("app_message", {
            sessionId: event.sessionId,
            namespaceName: event.namespace,
            message: event.message,
          }, conn.clientId));
        }
        return;
      }
    }
  }

  /** The sender went away: close its connections (no messages, no service calls) and drop its watches. */
  senderGone(senderId: number): void {
    const state = this.senders.get(senderId);
    if (state === undefined) return;
    this.senders.delete(senderId);
    // Blink closes the connection of a destroyed or frozen frame with WENT_AWAY (PresentationConnection::CloseConnection)
    for (const conn of state.conns.values()) conn.end("closed", "wentaway");
    for (const watch of state.watches.values()) watch.close();
    state.watches.clear();
    this.dialRoutesChanged?.();
  }

  /** The next fresh media request id: incremented per use, wrapping back to 1 past 2^31. */
  private freshRequestId(): number {
    const id = this.nextRequestId;
    this.nextRequestId = id >= REQUEST_ID_MAX ? 1 : id + 1;
    return id;
  }

  private senderOf(senderId: number, origin: string): { id: number; origin: string } {
    return { id: senderId, origin };
  }

  private senderState(senderId: number): SenderState {
    let state = this.senders.get(senderId);
    if (state === undefined) {
      state = { conns: new Map(), watches: new Map() };
      this.senders.set(senderId, state);
    }
    return state;
  }

  /** End a connection the way a receiver-ended session does: a final message, then onclose. */
  private endSession(conn: Conn, status: "stopped" | "disconnected"): void {
    if (conn.closed) return;
    const type = status === "stopped" ? "remove_session" : "disconnect_session";
    const reason = status === "stopped" ? "terminated" : "closed";
    if (conn.sessionId !== null) conn.deliver(envelope(type, conn.sessionId, conn.clientId));
    conn.end(reason);
  }

  /** A media-namespace reply from the receiver, mapped back onto the page's sequence numbers. */
  private deliverMediaReply(conn: Conn, raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return;
    const payload = data as Record<string, unknown>;
    if (Array.isArray(payload.status)) {
      payload.status = payload.status.map((entry) => toMediaEntry(entry as Record<string, unknown>, conn.sessionId as string));
    }
    let sequenceNumber: number | undefined;
    const requestId = payload.requestId;
    if (typeof requestId === "number") {
      sequenceNumber = conn.pendingMedia.get(requestId);
      if (sequenceNumber !== undefined) conn.pendingMedia.delete(requestId);
    }
    // A payload without a status array is only forwarded when it answers a pending request.
    if (!Array.isArray(payload.status) && sequenceNumber === undefined) return;
    conn.deliver(envelope("v2_message", payload, conn.clientId, sequenceNumber));
  }

  /** One inbound envelope from the page (already checked that the connection is open). */
  /** @internal Called by Conn. */
  dispatch(conn: Conn, raw: string): void {
    if (conn.dialRouteId !== null) {
      // The DIAL provider has its own message rules (no clientId check), so the Cast codec is bypassed.
      this.dial?.provider.sendRouteMessage(conn.dialRouteId, raw);
      return;
    }
    const env = parseEnvelope(raw);
    if (env === null) return;
    if (env.clientId !== conn.clientId) return;
    switch (env.type) {
      case "client_connect":
        return;
      case "app_message":
        void this.handleAppMessage(conn, env);
        return;
      case "v2_message":
        void this.handleV2Message(conn, env);
        return;
      case "leave_session":
        void this.handleLeave(conn, env);
        return;
      default:
        return;
    }
  }

  private async handleAppMessage(conn: Conn, env: ParsedEnvelope): Promise<void> {
    const m = env.message as { sessionId: string; namespaceName: string; message: unknown };
    if (conn.sessionId === null || m.sessionId !== conn.sessionId) return;
    const snap = conn.snapshot;
    if (snap === null || !snap.namespaces.some((n) => n.name === m.namespaceName)) {
      conn.deliver(envelope("error", {
        code: "invalid_parameter",
        description: `Invalid namespace: ${m.namespaceName}`,
        details: null,
      }, conn.clientId, env.sequenceNumber));
      return;
    }
    const payload = typeof m.message === "string" ? m.message : JSON.stringify(m.message);
    const res = await this.service.handle(this.senderOf(conn.senderId, conn.origin), "sendMessage", {
      sessionId: m.sessionId,
      namespace: m.namespaceName,
      message: payload,
    });
    if (res.ok) {
      conn.deliver(envelope("app_message", null, conn.clientId, env.sequenceNumber));
    } else if (res.code === "session_error") {
      // Chromium's AppActivity::SendAppMessageToReceiver answers a missing session this way; a failed channel
      // write gets neither an ack nor an error there.
      conn.deliver(envelope("error", {
        code: "session_error",
        description: `Invalid session ID: ${m.sessionId}`,
        details: null,
      }, conn.clientId, env.sequenceNumber));
    }
  }

  private async handleV2Message(conn: Conn, env: ParsedEnvelope): Promise<void> {
    const m = env.message as Record<string, unknown>;
    if (conn.sessionId === null || m.sessionId !== conn.sessionId) return;
    const type = m.type as string;
    const seq = env.sequenceNumber;
    const sender = this.senderOf(conn.senderId, conn.origin);
    if (type === "SET_VOLUME") {
      const volume = m.volume as { level?: unknown; muted?: unknown } | null | undefined;
      let failed: { code: string; description?: string } | null = null;
      if (volume !== null && typeof volume === "object") {
        if (typeof volume.level === "number") {
          const r = await this.service.handle(sender, "setReceiverVolume", { sessionId: m.sessionId as string, level: volume.level });
          if (!r.ok) failed = r;
        }
        if (failed === null && typeof volume.muted === "boolean") {
          const r = await this.service.handle(sender, "setReceiverMuted", { sessionId: m.sessionId as string, muted: volume.muted });
          if (!r.ok) failed = r;
        }
      }
      if (failed !== null) {
        // Chromium's SendResultResponse never reports the real cause.
        conn.deliver(envelope("error", { code: "internal_error", description: "unknown error", details: null }, conn.clientId, seq));
      } else {
        conn.deliver(envelope("v2_message", null, conn.clientId, seq));
      }
      return;
    }
    if (type === "STOP") {
      const res = await this.service.handle(sender, "stopSession", { sessionId: m.sessionId as string });
      if (!res.ok) {
        conn.deliver(envelope("error", { code: "internal_error", description: "unknown error", details: null }, conn.clientId, seq));
        return;
      }
      conn.deliver(envelope("v2_message", null, conn.clientId, seq));
      // The service does not tell the caller its own stop ended the session; push it here.
      this.endSession(conn, "stopped");
      return;
    }
    if (isMediaRequest(type)) {
      const requestId = this.freshRequestId();
      const body: Record<string, unknown> = { ...m, type: receiverMediaType(type), requestId };
      if (typeof seq === "number") {
        // CastSessionClientImpl::HandleV2ProtocolMessage: a full table loses its oldest half before the new entry,
        // which keeps the cost of deleting amortized O(1)
        if (conn.pendingMedia.size >= MAX_PENDING_MEDIA) {
          const drop = [...conn.pendingMedia.keys()].slice(0, Math.floor(conn.pendingMedia.size / 2));
          for (const id of drop) conn.pendingMedia.delete(id);
        }
        conn.pendingMedia.set(requestId, seq);
      }
      const res = await this.service.handle(sender, "sendMessage", {
        sessionId: m.sessionId as string,
        namespace: MEDIA_NAMESPACE,
        message: JSON.stringify(body),
      });
      // A request that could not be sent gets no reply, as in Chromium (SendMediaRequestToReceiver returns no id).
      if (!res.ok) conn.pendingMedia.delete(requestId);
      return;
    }
    // Anything else is dropped without a reply, as Chromium's HandleV2ProtocolMessage does (it only logs).
  }

  private async handleLeave(conn: Conn, env: ParsedEnvelope): Promise<void> {
    // Acknowledge before doing the work, like Chromium.
    conn.deliver(envelope("leave_session", null, conn.clientId, env.sequenceNumber));
    // Leave only this connection's own session, whatever id the page named.
    const sessionId = conn.sessionId;
    if (sessionId !== null) {
      await this.service.handle(this.senderOf(conn.senderId, conn.origin), "leaveSession", { sessionId });
    }
    // CastActivity::HandleLeaveSession closes the leaving clients' connections with CLOSED
    conn.end("closed", "closed");
  }

  /** @internal Called by Conn. */
  pageClosed(conn: Conn): void {
    if (conn.closed) return;
    if (conn.dialRouteId !== null) {
      // `DialMediaRouteProvider::DetachRoute` is NOTIMPLEMENTED: the route and the app keep running.
      conn.end("closed");
      this.dialRoutesChanged?.();
      return;
    }
    if (conn.sessionId !== null) {
      void this.service.handle(this.senderOf(conn.senderId, conn.origin), "leaveSession", { sessionId: conn.sessionId });
    }
    conn.end("closed");
  }

  /** @internal Called by Conn. */
  pageTerminated(conn: Conn): void {
    if (conn.closed) return;
    if (conn.dialRouteId !== null) {
      // The provider reports the termination to every connection of the route, this one included; a route that is
      // already gone is reported here instead.
      void this.dial?.provider.terminateRoute(conn.dialRouteId).catch(() => undefined).then(() => conn.end("terminated"));
      return;
    }
    if (conn.sessionId !== null) {
      void this.service.handle(this.senderOf(conn.senderId, conn.origin), "stopSession", { sessionId: conn.sessionId });
    }
    conn.end("terminated");
  }
}
