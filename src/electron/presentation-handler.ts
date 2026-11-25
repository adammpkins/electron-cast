// Main-process presentation handler: plays the part of Chrome's Media Router for Google's clank.js Cast
// sender. The page talks to it in Chromium's private JSON envelope over a connection; the handler drives
// CastSessionService through service.handle(sender, method, params) and translates with the codec in
// presentation-envelope.ts.
import { randomBytes } from "node:crypto";
import type { BridgeEvent, InitializeResult, SessionSnapshot } from "../polyfill/bridge-types.ts";
import type { CastSessionService } from "./session-service.ts";
import {
  MEDIA_NAMESPACE,
  envelope,
  isMediaRequest,
  parseEnvelope,
  parsePresentationUrl,
  receiverLabel,
  receiverMediaType,
  toMediaEntry,
  toReceiver,
  toSession,
} from "./presentation-envelope.ts";
import type { ParsedEnvelope } from "./presentation-envelope.ts";

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
  /** Called once, when the connection closes for any reason. */
  onclose: ((reason: "closed" | "terminated") => void) | null;
}

/** An error thrown by the handler; `name` is a DOMException name the page can map onto. */
export class PresentationError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

/** A live getAvailability watch of one sender. */
interface Watch { onchange: (value: boolean) => void }

/** Per-sender handler state: its connections keyed by clientId, and its availability watches. */
interface SenderState {
  conns: Map<string, Conn>;
  watches: Map<number, Watch>;
}

/** The pending-media table is bounded like Chromium's (kMaxPendingMediaRequests, best known value). */
const MAX_PENDING_MEDIA = 100;
/** Request ids wrap back to 1 past this value. */
const REQUEST_ID_MAX = 2 ** 31;
const CAST_SESSION_PREFIX = "cast-session_";

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
  /** The latest session snapshot seen for this connection (namespaces, receiver). */
  snapshot: SessionSnapshot | null;
  onclose: ((reason: "closed" | "terminated") => void) | null = null;
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
  end(reason: "closed" | "terminated"): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.queue.length = 0;
    const cb = this.onclose;
    if (cb !== null) cb(reason);
  }
}

/** Drives CastSessionService on behalf of pages speaking the presentation envelope. */
export class CastPresentationHandler {
  private readonly service: Pick<CastSessionService, "handle">;
  private readonly token: string;
  private readonly senders = new Map<number, SenderState>();
  private nextRequestId: number;
  private watchSeq = 0;

  constructor(opts: { service: Pick<CastSessionService, "handle">; token?: string }) {
    this.service = opts.service;
    this.token = opts.token ?? randomBytes(16).toString("hex");
    this.nextRequestId = 1 + Math.floor(Math.random() * (2 ** 30 - 1));
  }

  /** Is the app available on some receiver? Resolves false for unparseable URLs and failed calls. */
  async getAvailability(req: PresentationRequestInfo & { onchange(value: boolean): void; signal: AbortSignal }): Promise<boolean> {
    const parsed = parsePresentationUrl((req.urls[0] ?? ""));
    if (parsed === null) return false;
    const state = this.senderState(req.senderId);
    const watchId = ++this.watchSeq;
    state.watches.set(watchId, { onchange: req.onchange });
    const signal = req.signal;
    if (signal.aborted) {
      state.watches.delete(watchId);
    } else {
      signal.addEventListener("abort", () => {
        state.watches.delete(watchId);
      }, { once: true });
    }
    const res = await this.service.handle(this.senderOf(req.senderId, req.origin), "initialize", {
      appId: parsed.appId,
      capabilities: parsed.capabilities,
      autoJoinPolicy: "page_scoped",
    });
    if (!res.ok) return false;
    return (res.value as InitializeResult).available;
  }

  /** Launches the app and resolves with a connection carrying receiver_action then new_session. */
  async startPresentation(req: PresentationRequestInfo): Promise<PresentationConnectionHandle> {
    const parsed = parsePresentationUrl((req.urls[0] ?? ""));
    if (parsed === null) throw new PresentationError("NotSupportedError", `Unsupported presentation URL: ${(req.urls[0] ?? "")}`);
    const sender = this.senderOf(req.senderId, req.origin);
    const res = await this.service.handle(sender, "requestSession", {
      appId: parsed.appId,
      capabilities: [],
      timeoutMs: parsed.launchTimeout ?? 60000,
    });
    if (!res.ok) {
      if (res.code === "cancel") throw new PresentationError("AbortError", res.description ?? "The user cancelled the request");
      if (res.code === "receiver_unavailable") throw new PresentationError("NotFoundError", res.description ?? "No receivers are available");
      throw new PresentationError("OperationError", res.description ?? res.code);
    }
    const s = res.value as SessionSnapshot;
    const clientId = parsed.clientId ?? randomBytes(16).toString("hex");
    const state = this.senderState(req.senderId);
    const previous = state.conns.get(clientId);
    if (previous !== undefined) {
      state.conns.delete(clientId);
      previous.end("closed");
    }
    const conn = new Conn(this, `${CAST_SESSION_PREFIX}${s.sessionId}`, (req.urls[0] ?? ""), req.senderId, req.origin, clientId, s.sessionId, s);
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
    const parsed = parsePresentationUrl((req.urls[0] ?? ""));
    if (parsed === null) throw new PresentationError("NotSupportedError", `Unsupported presentation URL: ${(req.urls[0] ?? "")}`);
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
    const conn = new Conn(this, presentationId, (req.urls[0] ?? ""), req.senderId, req.origin, clientId, snapshot.sessionId, snapshot);
    state.conns.set(clientId, conn);
    const label = receiverLabel(snapshot.receiver.label, this.token);
    conn.deliver(envelope("new_session", toSession(snapshot, label), clientId));
    return conn;
  }

  /** A service event for one of our senders (wired to the service's emit option). */
  onServiceEvent(senderId: number, event: BridgeEvent): void {
    const state = this.senders.get(senderId);
    if (state === undefined) return;
    switch (event.type) {
      case "receiverAvailability": {
        for (const watch of state.watches.values()) watch.onchange(event.available);
        return;
      }
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
    for (const conn of state.conns.values()) conn.end("closed");
    state.watches.clear();
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
        conn.pendingMedia.set(requestId, seq);
        while (conn.pendingMedia.size > MAX_PENDING_MEDIA) {
          const oldest = conn.pendingMedia.keys().next().value;
          if (oldest === undefined) break;
          conn.pendingMedia.delete(oldest);
        }
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
    conn.end("closed");
  }

  /** @internal Called by Conn. */
  pageClosed(conn: Conn): void {
    if (conn.closed) return;
    if (conn.sessionId !== null) {
      void this.service.handle(this.senderOf(conn.senderId, conn.origin), "leaveSession", { sessionId: conn.sessionId });
    }
    conn.end("closed");
  }

  /** @internal Called by Conn. */
  pageTerminated(conn: Conn): void {
    if (conn.closed) return;
    if (conn.sessionId !== null) {
      void this.service.handle(this.senderOf(conn.senderId, conn.origin), "stopSession", { sessionId: conn.sessionId });
    }
    conn.end("terminated");
  }
}
