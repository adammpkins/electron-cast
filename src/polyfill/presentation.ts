import type { BridgeEvent, BridgeResult, CastBridge, InitializeResult, SessionSnapshot } from "./bridge-types.ts";

/**
 * Installs a Presentation API (`PresentationRequest`, `navigator.presentation`) on the page's global object that
 * answers `cast:` URLs through the electron-cast bridge at `globalThis[bridgeKey]`. Electron ships the API without
 * anything behind it; with this in place Google's own Cast SDK (`cast_sender.js`, which the page loads itself)
 * finds a working browser and defines `chrome.cast` on top, so the page runs Google's code instead of a copy of it.
 * Returns `false`, changing nothing, when the bridge is missing.
 *
 * The SDK talks to the browser's media router in JSON envelopes over the PresentationConnection:
 * `{ type, message, sequenceNumber, clientId }`. A reply carries the request's `sequenceNumber`; its type is
 * `"error"` when the request failed. This plays the router's side of that exchange.
 *
 * Runs in the page's main world through `contextBridge.executeInMainWorld`, which serializes it to source: the
 * body must stay self-contained (no imports, no module-level helpers or state).
 */
export function installPresentation(bridgeKey: string): boolean {
  const g: any = globalThis;
  const rawBridge: any = g[bridgeKey];
  if (!rawBridge || typeof rawBridge.call !== "function") return false;
  const bridge: CastBridge = rawBridge;

  interface CastTarget { url: string; appId: string; capabilities: string[]; autoJoinPolicy: string; timeoutMs: number }
  interface Link { connection: CastConnection; session: SessionSnapshot; clientId: string; chosenByUser: boolean }

  const SESSION_ID_PREFIX = "cast-session_";
  const links = new Map<string, Link>();
  /** Sessions the main process joined for this page that no connection has been handed out for yet. */
  const joinable: SessionSnapshot[] = [];
  const targets = new WeakMap<object, CastTarget | null>();
  let defaultRequest: CastRequest | null = null;
  let initialized: { key: string; done: Promise<void> } | undefined;

  function fire(target: any, name: string, props: object = {}): void {
    const event = Object.assign(new Event(name), props);
    try {
      target[`on${name}`]?.(event);
    } catch (err) {
      console.error(err);
    }
    target.dispatchEvent(event);
  }

  function unavailable(): any {
    return Object.assign(new EventTarget(), { value: false, onchange: null });
  }
  const availability = unavailable();
  const neverAvailable = unavailable();

  function setAvailable(value: boolean): void {
    if (availability.value === value) return;
    availability.value = value;
    fire(availability, "change");
  }

  function parse(url: unknown): CastTarget | null {
    const match = /^cast:([^?]+)\??(.*)$/.exec(String(url));
    if (!match) return null;
    const query = new URLSearchParams(match[2]);
    return {
      url: String(url),
      appId: match[1]!,
      capabilities: query.get("capabilities")?.split(",") ?? [],
      autoJoinPolicy: query.get("autoJoinPolicy") ?? "tab_and_origin_scoped",
      timeoutMs: Number(query.get("launchTimeout")) || 60000,
    };
  }

  /** Register the page's app with the main process; the SDK builds a request per call, so do it once per app. */
  function initialize(target: CastTarget): Promise<void> {
    const { appId, capabilities, autoJoinPolicy } = target;
    const key = JSON.stringify([appId, capabilities, autoJoinPolicy]);
    if (initialized?.key === key) return initialized.done;
    const attempt = { key, done: bridge.call("initialize", { appId, capabilities, autoJoinPolicy }).then((res: BridgeResult) => {
      if (!res.ok) {
        if (initialized === attempt) initialized = undefined;
        setAvailable(false);
        return;
      }
      const value = res.value as InitializeResult;
      joinable.push(...value.sessions);
      setAvailable(value.available);
    }) };
    initialized = attempt;
    return attempt.done;
  }

  function connect(url: string, session: SessionSnapshot, chosenByUser: boolean): CastConnection {
    const existing = links.get(session.sessionId);
    if (existing) return existing.connection;
    // The SDK follows one session at a time, as Chrome keeps one cast route per page: a new session replaces the
    // old one, and the old connection has to end before the page is handed the new one.
    for (const other of links.values()) {
      void bridge.call(chosenByUser ? "stopSession" : "leaveSession", { sessionId: other.session.sessionId });
      end(other, chosenByUser ? "terminated" : "closed");
    }
    const link = { session, clientId: "", chosenByUser } as Link;
    link.connection = new CastConnection(url, link);
    links.set(session.sessionId, link);
    return link.connection;
  }

  function end(link: Link, state: "closed" | "terminated"): void {
    if (link.connection.state !== "connected") return;
    links.delete(link.session.sessionId);
    link.connection.state = state;
    if (state === "terminated") fire(link.connection, "terminate");
    else fire(link.connection, "close", { reason: "closed", message: "" });
  }

  /** The session the way the SDK's `new_session` and `update_session` messages carry it. */
  function describe(session: SessionSnapshot): object {
    return { ...session, media: [], status: "connected", receiver: describeReceiver(session) };
  }

  function describeReceiver(session: SessionSnapshot): object {
    return { receiverType: "cast", ...session.receiver };
  }

  function deliver(link: Link, type: string, message: unknown, sequenceNumber = -1): void {
    const envelope = { type, message, sequenceNumber, timeoutMillis: 0, clientId: link.clientId };
    fire(link.connection, "message", { data: JSON.stringify(envelope) });
  }

  class CastConnection extends EventTarget {
    readonly id: string;
    readonly url: string;
    state = "connected";
    binaryType = "arraybuffer";
    onconnect = null;
    onclose = null;
    onterminate = null;
    onmessage = null;
    #link: Link;

    constructor(url: string, link: Link) {
      super();
      this.url = url;
      this.id = SESSION_ID_PREFIX + link.session.sessionId;
      this.#link = link;
    }

    send(data: string): void {
      if (this.state !== "connected") throw new DOMException("The connection is not open", "InvalidStateError");
      const link = this.#link;
      const { type, message, sequenceNumber, clientId } = JSON.parse(data);
      // Requests name their session, which is not always this connection's: a page may stop the session it just
      // replaced over the new connection.
      const sessionId: string = (type === "leave_session" ? message : message?.sessionId) ?? link.session.sessionId;
      const reply = (res: BridgeResult, ended?: "closed" | "terminated"): void => {
        if (!res.ok) return deliver(link, "error", { code: res.code, description: res.description ?? null, details: null }, sequenceNumber);
        deliver(link, type, null, sequenceNumber);
        const over = ended && links.get(sessionId);
        if (over) end(over, ended);
      };
      const unsupported = (): void => reply({ ok: false, code: "session_error", description: `${message?.type ?? type} is not supported` });

      switch (type) {
        case "client_connect":
          link.clientId = clientId;
          if (link.chosenByUser) deliver(link, "receiver_action", { receiver: describeReceiver(link.session), action: "cast" });
          deliver(link, "new_session", describe(link.session));
          return;
        case "app_message": {
          const payload = typeof message.message === "string" ? message.message : JSON.stringify(message.message);
          void bridge.call("sendMessage", { sessionId, namespace: message.namespaceName, message: payload }).then((res) => reply(res));
          return;
        }
        case "v2_message":
          if (message.type === "SET_VOLUME") {
            const { level, muted } = message.volume ?? {};
            const call = typeof level === "number"
              ? bridge.call("setReceiverVolume", { sessionId, level })
              : bridge.call("setReceiverMuted", { sessionId, muted: !!muted });
            void call.then((res) => reply(res));
          } else if (message.type === "STOP") {
            void bridge.call("stopSession", { sessionId }).then((res) => reply(res, "terminated"));
          } else unsupported();
          return;
        case "leave_session":
          void bridge.call("leaveSession", { sessionId }).then((res) => reply(res, "closed"));
          return;
        default:
          unsupported();
      }
    }

    close(): void {
      if (this.state !== "connected") return;
      void bridge.call("leaveSession", { sessionId: this.#link.session.sessionId });
      end(this.#link, "closed");
    }

    terminate(): void {
      if (this.state !== "connected") return;
      void bridge.call("stopSession", { sessionId: this.#link.session.sessionId }).then((res) => {
        if (res.ok) end(this.#link, "terminated");
      });
    }
  }

  class CastRequest extends EventTarget {
    onconnectionavailable = null;

    constructor(urls: string | string[]) {
      super();
      targets.set(this, [urls].flat().map(parse).find((target) => target !== null) ?? null);
    }

    async getAvailability(): Promise<EventTarget> {
      const target = targets.get(this);
      if (!target) return neverAvailable;
      await initialize(target);
      return availability;
    }

    async start(): Promise<CastConnection> {
      const target = targets.get(this);
      if (!target) throw new DOMException("No cast: URL to present", "NotFoundError");
      await initialize(target);
      const { appId, capabilities, timeoutMs, url } = target;
      const res = await bridge.call("requestSession", { appId, capabilities, timeoutMs });
      if (res.ok) return connect(url, res.value as SessionSnapshot, true);
      const names: Record<string, string> = { cancel: "NotAllowedError", receiver_unavailable: "NotFoundError" };
      throw new DOMException(res.description ?? res.code, names[res.code] ?? "OperationError");
    }

    async reconnect(id: string): Promise<CastConnection> {
      const target = targets.get(this);
      if (target) {
        await initialize(target);
        const sessionId = String(id).startsWith(SESSION_ID_PREFIX) ? String(id).slice(SESSION_ID_PREFIX.length) : null;
        if (id === "auto-join") {
          const session = joinable.shift();
          if (session) return connect(target.url, session, false);
        } else if (sessionId !== null) {
          const res = links.has(sessionId) ? null : await bridge.call("joinSession", { sessionId });
          const session = links.get(sessionId)?.session ?? (res?.ok ? res.value as SessionSnapshot : null);
          if (session) return connect(target.url, session, false);
        }
      }
      throw new DOMException("No presentation to reconnect to", "NotFoundError");
    }
  }

  bridge.onEvent((event: BridgeEvent) => {
    switch (event.type) {
      case "receiverAvailability":
        setAvailable(event.available);
        return;
      case "sessionJoined": {
        const target = defaultRequest && targets.get(defaultRequest);
        if (target) fire(defaultRequest, "connectionavailable", { connection: connect(target.url, event.session, false) });
        else joinable.push(event.session);
        return;
      }
      case "sessionUpdated": {
        const link = links.get(event.session.sessionId);
        if (!link) return;
        link.session = event.session;
        deliver(link, "update_session", describe(event.session));
        return;
      }
      case "sessionEnded": {
        const link = links.get(event.sessionId);
        if (link) end(link, event.status === "stopped" ? "terminated" : "closed");
        return;
      }
      case "message": {
        const link = links.get(event.sessionId);
        if (link) deliver(link, "app_message", { sessionId: event.sessionId, namespaceName: event.namespace, message: event.message });
        return;
      }
    }
  });

  const presentation = {
    receiver: null,
    get defaultRequest() {
      return defaultRequest;
    },
    set defaultRequest(request: CastRequest | null) {
      defaultRequest = request;
    },
  };
  // Google's loader gives up without a `chrome` object.
  g.chrome ??= {};
  g.PresentationRequest = CastRequest;
  g.PresentationConnection = CastConnection;
  Object.defineProperty(Object.getPrototypeOf(g.navigator), "presentation", { configurable: true, enumerable: true, get: () => presentation });
  return true;
}
