/**
 * Installs a page-side stand-in for the Presentation API (`PresentationRequest`, `PresentationConnection`,
 * `PresentationAvailability` and `navigator.presentation`) backed by the IPC bridge the preload script
 * published at `globalThis[bridgeKey]`, so Google's own Cast sender script (clank.js) can run unmodified
 * in Electron. Returns `true` when the stand-in was installed, `false` when the bridge is missing (in
 * which case nothing is changed).
 *
 * Electron runs this function in the page's main world through `contextBridge.executeInMainWorld`, which
 * serializes it to source; the body must therefore stay self-contained: no imports, no module-level
 * helpers or state, and every host global reached through `globalThis`. Type annotations are stripped and
 * leave no runtime references behind.
 */
export function installPresentationStandIn(bridgeKey: string): boolean {
  const g: any = globalThis;
  const bridge: any = g[bridgeKey];
  if (!bridge || typeof bridge.call !== "function") return false;

  const ET: any = g.EventTarget;
  const EV: any = g.Event;
  const ME: any = g.MessageEvent;
  const DE: any = g.DOMException;
  const URLC: any = g.URL;
  const ST: any = g.setTimeout;
  const uuid = (): string => g.crypto.randomUUID();

  const MAX_QUEUED_MESSAGES = 1000;
  const connections = new Map<string, any>();
  const watches = new Map<string, any>();
  let pendingStart = false;

  // A queued message may be delivered only once the connection is "connected" AND a message handler
  // exists (an onmessage value or an addEventListener("message") listener).
  function messageReady(conn: any): boolean {
    return conn.state === "connected"
      && (typeof conn.__h_message === "function" || conn.__msgListeners > 0);
  }

  function maybeFlush(conn: any): void {
    if (conn.__flushScheduled || !messageReady(conn)) return;
    conn.__flushScheduled = true;
    ST(() => {
      conn.__flushScheduled = false;
      while (conn.__queue.length > 0 && messageReady(conn)) {
        const data = conn.__queue.shift();
        conn.dispatchEvent(new ME("message", { data }));
      }
    }, 0);
  }

  // Defines the on<name> getter/setter pairs (the setter stores a function or null) and wraps
  // dispatchEvent so the stored handler is invoked in addition to addEventListener listeners.
  const wireEvents = (proto: any, names: string[], onHandlerSet?: (instance: any) => void): void => {
    for (const name of names) {
      const slot = "__h_" + name;
      Object.defineProperty(proto, "on" + name, {
        configurable: true,
        enumerable: true,
        get(this: any) { return this[slot] ?? null; },
        set(this: any, value: any) {
          this[slot] = typeof value === "function" ? value : null;
          if (typeof onHandlerSet === "function") onHandlerSet(this);
        },
      });
    }
    const nativeDispatch = proto.dispatchEvent;
    proto.dispatchEvent = function (this: any, event: any) {
      const handled = nativeDispatch.call(this, event);
      const handler = this["__h_" + event.type];
      if (typeof handler === "function") handler.call(this, event);
      return handled;
    };
  };

  class PresentationAvailability extends ET {
    __value: boolean;
    constructor(value: boolean) {
      super();
      this.__value = !!value;
    }
  }
  Object.defineProperty(PresentationAvailability.prototype, "value", {
    configurable: true,
    enumerable: true,
    get(this: any) { return this.__value; },
  });
  wireEvents(PresentationAvailability.prototype, ["change"]);

  class PresentationConnection extends ET {
    connectionId: string;
    id: string;
    url: string;
    state: string;
    binaryType: string;
    __queue: string[];
    __flushScheduled: boolean;
    __msgListeners: number;
    __h_message: any;
    constructor(connectionId: string, state: string) {
      super();
      this.connectionId = connectionId;
      this.id = "";
      this.url = "";
      this.state = state;
      this.binaryType = "arraybuffer";
      this.__queue = [];
      this.__flushScheduled = false;
      this.__msgListeners = 0;
      this.__h_message = null;
    }
    send(data: any): void {
      if (this.state !== "connected") throw new DE("The connection is not open.", "InvalidStateError");
      if (typeof data !== "string") throw new TypeError("send() accepts strings only; binary data is not supported.");
      bridge.send(this.connectionId, data);
    }
    close(): void { this.__end("closed"); }
    terminate(): void { this.__end("terminated"); }
    __end(state: string): void {
      if (this.state === "closed" || this.state === "terminated") return;
      this.state = state;
      bridge.call(state === "closed" ? "close" : "terminate", { connectionId: this.connectionId });
      connections.delete(this.connectionId);
      this.dispatchEvent(new EV(state === "closed" ? "close" : "terminate"));
    }
  }
  wireEvents(PresentationConnection.prototype, ["message", "close", "terminate", "connect"], (conn) => maybeFlush(conn));
  const nativeAdd = PresentationConnection.prototype.addEventListener;
  const nativeRemove = PresentationConnection.prototype.removeEventListener;
  PresentationConnection.prototype.addEventListener = function (this: any, type: any, listener: any, options: any) {
    if (type === "message") {
      this.__msgListeners += 1;
      maybeFlush(this);
    }
    return nativeAdd.call(this, type, listener, options);
  };
  PresentationConnection.prototype.removeEventListener = function (this: any, type: any, listener: any, options: any) {
    if (type === "message" && this.__msgListeners > 0) this.__msgListeners -= 1;
    return nativeRemove.call(this, type, listener, options);
  };

  function settleConnection(conn: any, connectionId: string, result: any): any {
    if (result && result.ok) {
      const value = result.value || {};
      conn.id = value.id ?? "";
      conn.url = value.url ?? "";
      conn.state = "connected";
      conn.dispatchEvent(new EV("connect"));
      maybeFlush(conn);
      return conn;
    }
    connections.delete(connectionId);
    throw new DE((result && result.description) ?? "", (result && result.code) ?? "OperationError");
  }

  class PresentationRequest extends ET {
    urls: string[];
    constructor(urls: any) {
      super();
      const list: string[] = Array.isArray(urls) ? urls.slice() : [urls];
      if (list.length === 0) {
        throw new DE("PresentationRequest requires at least one url.", "NotSupportedError");
      }
      for (const u of list) {
        try {
          new URLC(String(u));
        } catch {
          throw new DE("Invalid URL: " + String(u), "SyntaxError");
        }
      }
      this.urls = Object.freeze(list) as string[];
    }
    start(): Promise<any> {
      const nav = g.navigator;
      const ua = nav ? nav.userActivation : undefined;
      if (ua && ua.isActive === false) {
        // Blink's PresentationRequest::start() throws kInvalidAccessError with this message
        return Promise.reject(new DE("PresentationRequest::start() requires user gesture.", "InvalidAccessError"));
      }
      if (pendingStart) {
        return Promise.reject(new DE("A call to start() is already in progress.", "OperationError"));
      }
      pendingStart = true;
      const connectionId = uuid();
      const conn = new PresentationConnection(connectionId, "connecting");
      connections.set(connectionId, conn);
      return Promise.resolve(bridge.call("start", { connectionId, urls: [...this.urls] }))
        .then((result: any) => settleConnection(conn, connectionId, result))
        .finally(() => {
          pendingStart = false;
        });
    }
    reconnect(presentationId: any): Promise<any> {
      const connectionId = uuid();
      const conn = new PresentationConnection(connectionId, "connecting");
      connections.set(connectionId, conn);
      return Promise.resolve(bridge.call("reconnect", { connectionId, urls: [...this.urls], presentationId }))
        .then((result: any) => settleConnection(conn, connectionId, result));
    }
    getAvailability(): Promise<any> {
      const watchId = uuid();
      const avail = new PresentationAvailability(false);
      watches.set(watchId, avail);
      return Promise.resolve(bridge.call("getAvailability", { watchId, urls: [...this.urls] }))
        .then((result: any) => {
          avail.__value = !!(result && result.ok && result.value && result.value.available);
          return avail;
        });
    }
  }
  wireEvents(PresentationRequest.prototype, ["connectionavailable"]);

  bridge.onEvent((e: any) => {
    if (!e || typeof e !== "object") return;
    if (e.type === "availability") {
      const avail = watches.get(e.watchId);
      if (!avail) return;
      const next = !!e.value;
      if (next !== avail.__value) {
        avail.__value = next;
        avail.dispatchEvent(new EV("change"));
      }
      return;
    }
    if (e.type === "message") {
      const conn = connections.get(e.connectionId);
      if (!conn) return;
      conn.__queue.push(e.data);
      if (conn.__queue.length > MAX_QUEUED_MESSAGES) conn.__queue.shift();
      maybeFlush(conn);
      return;
    }
    if (e.type === "statechange") {
      const conn = connections.get(e.connectionId);
      if (!conn) return;
      const terminated = e.state === "terminated";
      conn.state = terminated ? "terminated" : "closed";
      connections.delete(e.connectionId);
      const ev = new EV(terminated ? "terminate" : "close");
      ev.reason = e.reason ?? null;
      ev.message = e.message ?? null;
      conn.dispatchEvent(ev);
      return;
    }
    if (e.type === "connectionavailable") {
      const conn = new PresentationConnection(e.connectionId, "connected");
      conn.id = e.id ?? "";
      conn.url = e.url ?? "";
      connections.set(e.connectionId, conn);
      const pres = g.navigator ? g.navigator.presentation : null;
      const req = pres ? pres.defaultRequest : null;
      if (req instanceof PresentationRequest) {
        const ev = new EV("connectionavailable");
        ev.connection = conn;
        req.dispatchEvent(ev);
      }
    }
  });

  const pres: any = { defaultRequest: null, receiver: null };
  if (g.navigator) {
    Object.defineProperty(g.navigator, "presentation", {
      configurable: true,
      enumerable: true,
      get() { return pres; },
    });
  }
  Object.defineProperty(g, "PresentationRequest", { value: PresentationRequest, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(g, "PresentationConnection", { value: PresentationConnection, writable: true, configurable: true, enumerable: true });
  Object.defineProperty(g, "PresentationAvailability", { value: PresentationAvailability, writable: true, configurable: true, enumerable: true });
  if (!g.chrome) g.chrome = {};

  return true;
}
