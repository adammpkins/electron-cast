/**
 * Installs the receiver half of the Presentation API in a presentation receiver window: `navigator.presentation.receiver`
 * with its `connectionList` and `connectionavailable`, and the `PresentationConnection` a receiver page gets. It is
 * the counterpart of presentation-standin.ts (which stands in for the controller half) and follows Blink's
 * PresentationReceiver, PresentationConnectionList and ReceiverPresentationConnection
 * (third_party/blink/renderer/modules/presentation/). The bridge at `globalThis[bridgeKey]` is the receiver window's
 * own (see electron/wired-display/electron-windows.ts), not the controller stand-in's.
 *
 * Like the stand-in it runs in the page's main world through `contextBridge.executeInMainWorld`, so the body must stay
 * self-contained: no imports, no module-level helpers or state, every host global reached through `globalThis`.
 */
export function installPresentationReceiver(bridgeKey: string): boolean {
  const g: any = globalThis;
  const bridge: any = g[bridgeKey];
  if (!bridge || typeof bridge.call !== "function" || typeof bridge.send !== "function") return false;

  const ET: any = g.EventTarget;
  const EV: any = g.Event;
  const ME: any = g.MessageEvent;
  const DE: any = g.DOMException;
  const ST: any = g.setTimeout;

  // Blink's PresentationReceiver is created, and registers with the browser, the first time `navigator.presentation`
  // is used (Presentation::MaybeInitReceiver); controllers wait until then.
  let registered = false;
  const register = (): void => {
    if (registered) return;
    registered = true;
    Promise.resolve(bridge.call("register", {})).catch(() => {});
  };

  const wireEvents = (proto: any, names: string[]): void => {
    for (const name of names) {
      const slot = "__h_" + name;
      Object.defineProperty(proto, "on" + name, {
        configurable: true,
        enumerable: true,
        get(this: any) { return this[slot] ?? null; },
        set(this: any, value: any) { this[slot] = typeof value === "function" || (typeof value === "object" && value !== null) ? value : null; },
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

  const connections = new Map<string, any>();
  // Largest message of a local presentation (see MAX_MESSAGE_SIZE in electron/wired-display/local-presentation.ts)
  const MAX_MESSAGE_SIZE = 64 * 1024 * 1024;

  // PresentationConnection::send overloads (presentation_connection.cc): a string, an ArrayBuffer, an ArrayBufferView or a
  // Blob; anything else is converted to a string, as WebIDL resolves the DOMString overload. Cross-realm safe (no instanceof).
  const tagOf = (v: any): string => Object.prototype.toString.call(v);
  const copyView = (v: any): any => new g.Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  // Bytes from the bridge become what binaryType names: an ArrayBuffer, or a Blob (DidReceiveBinaryMessage)
  const binaryMessage = (conn: any, bytes: any): any => {
    const view = g.ArrayBuffer.isView(bytes) ? bytes : new g.Uint8Array(bytes);
    const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
    return conn.binaryType === "blob" ? new g.Blob([buffer]) : buffer;
  };
  const listState: { property: any; resolve: any; resolved: boolean; list: any } = { property: null, resolve: null, resolved: false, list: null };

  class PresentationConnectionAvailableEvent extends EV {
    __connection: any;
    constructor(type: string, init: any) {
      super(type);
      this.__connection = init ? init.connection : null;
    }
  }
  Object.defineProperty(PresentationConnectionAvailableEvent.prototype, "connection", {
    configurable: true,
    enumerable: true,
    get(this: any) { return this.__connection; },
  });

  class PresentationConnectionCloseEvent extends EV {
    __reason: string;
    __message: string;
    constructor(type: string, init: any) {
      super(type);
      this.__reason = init && init.reason ? init.reason : "closed";
      this.__message = init && init.message ? init.message : "";
    }
  }
  Object.defineProperty(PresentationConnectionCloseEvent.prototype, "reason", {
    configurable: true,
    enumerable: true,
    get(this: any) { return this.__reason; },
  });
  Object.defineProperty(PresentationConnectionCloseEvent.prototype, "message", {
    configurable: true,
    enumerable: true,
    get(this: any) { return this.__message; },
  });

  class PresentationConnection extends ET {
    __id: string;
    __url: string;
    __state: string;
    __connectionId: string;
    __binaryType: string;
    __out: any[];
    __reading: boolean;
    __gen: number;
    constructor(connectionId: string, id: string, url: string) {
      super();
      this.__connectionId = connectionId;
      this.__id = id;
      this.__url = url;
      this.__state = "connected";
      this.__binaryType = "arraybuffer";
      this.__out = [];
      this.__reading = false;
      this.__gen = 0;
    }
    send(data: any): void {
      if (this.__state !== "connected") throw new DE("The presentation connection is not connected.", "InvalidStateError");
      const size = (n: number): void => {
        if (true && n > MAX_MESSAGE_SIZE) {
          // presentation_connection.cc: send() throws a RangeError for a message past the supported size
          throw new g.RangeError("Message size exceeds the maximum supported size (" + MAX_MESSAGE_SIZE + ")");
        }
      };
      let item: any;
      if (typeof data === "string") {
        size(data.length);
        item = data;
      } else if (tagOf(data) === "[object ArrayBuffer]") {
        size(data.byteLength);
        // Copied now, not when its turn comes: a detached buffer is a TypeError at the call, as in Blink's bindings
        item = { bytes: new g.Uint8Array(data.slice(0)) };
      } else if (g.ArrayBuffer.isView(data)) {
        size(data.byteLength);
        item = { bytes: copyView(data) };
      } else if (tagOf(data) === "[object Blob]") {
        size(data.size);
        item = { blob: data };
      } else {
        item = String(data);
        size(item.length);
      }
      this.__out.push(item);
      this.__pump();
    }
    // HandleMessageQueue, as in the controller stand-in
    __pump(): void {
      while (this.__out.length > 0 && !this.__reading) {
        const item = this.__out[0];
        if (typeof item === "string") {
          this.__out.shift();
          bridge.send(this.__connectionId, item);
        } else if (item.bytes !== undefined) {
          this.__out.shift();
          bridge.send(this.__connectionId, item.bytes);
        } else {
          this.__reading = true;
          const gen = this.__gen;
          Promise.resolve(item.blob.arrayBuffer()).then((buffer: any) => buffer, () => null).then((buffer: any) => {
            if (gen !== this.__gen) return;
            this.__out.shift();
            this.__reading = false;
            if (buffer !== null) bridge.send(this.__connectionId, new g.Uint8Array(buffer));
            this.__pump();
          });
        }
      }
    }
    // TearDown
    __teardown(): void {
      this.__gen += 1;
      this.__out.length = 0;
      this.__reading = false;
    }
    // PresentationConnection::DoClose, then ReceiverPresentationConnection::DidClose removes it from the list
    close(): void {
      if (this.__state !== "connecting" && this.__state !== "connected") return;
      bridge.call("close", { connectionId: this.__connectionId });
      this.__didClose("closed");
    }
    // ReceiverPresentationConnection::TerminateInternal: the window closes; no event fires on this connection
    terminate(): void {
      if (this.__state !== "connected") return;
      bridge.call("terminate", { connectionId: this.__connectionId });
      this.__state = "terminated";
      this.__teardown();
      connections.delete(this.__connectionId);
    }
    __didClose(reason: string): void {
      if (this.__state === "closed" || this.__state === "terminated") return;
      this.__state = "closed";
      this.__teardown();
      connections.delete(this.__connectionId);
      ST(() => this.dispatchEvent(new PresentationConnectionCloseEvent("close", { reason })), 0);
      const list = listState.list;
      if (list) list.__remove(this);
    }
  }
  for (const key of ["id", "url", "state"]) {
    Object.defineProperty(PresentationConnection.prototype, key, {
      configurable: true,
      enumerable: true,
      get(this: any) { return this["__" + key]; },
    });
  }
  Object.defineProperty(PresentationConnection.prototype, "binaryType", {
    configurable: true,
    enumerable: true,
    get(this: any) { return this.__binaryType; },
    set(this: any, value: any) {
      const v = String(value);
      if (v === "blob" || v === "arraybuffer") this.__binaryType = v;
    },
  });
  wireEvents(PresentationConnection.prototype, ["message", "close", "terminate", "connect"]);

  class PresentationConnectionList extends ET {
    __items: any[];
    __frozen: any;
    constructor(token: any) {
      super();
      if (token !== listState) throw new TypeError("Illegal constructor");
      this.__items = [];
      this.__frozen = null;
    }
    __add(conn: any): void {
      this.__items.push(conn);
      this.__frozen = null;
    }
    __remove(conn: any): void {
      const i = this.__items.indexOf(conn);
      if (i < 0) return;
      this.__items.splice(i, 1);
      this.__frozen = null;
    }
  }
  // FrozenArray: the same array until the list changes
  Object.defineProperty(PresentationConnectionList.prototype, "connections", {
    configurable: true,
    enumerable: true,
    get(this: any) {
      if (this.__frozen === null) this.__frozen = Object.freeze(this.__items.slice());
      return this.__frozen;
    },
  });
  wireEvents(PresentationConnectionList.prototype, ["connectionavailable"]);
  const list: any = new PresentationConnectionList(listState);
  listState.list = list;

  class PresentationReceiver {
    constructor(token: any) {
      if (token !== listState) throw new TypeError("Illegal constructor");
    }
  }
  // [SameObject] Promise<PresentationConnectionList>: created on first use; settles when a connection exists
  Object.defineProperty(PresentationReceiver.prototype, "connectionList", {
    configurable: true,
    enumerable: true,
    get() {
      if (listState.property === null) {
        listState.property = new Promise((resolve: any) => { listState.resolve = resolve; });
      }
      if (!listState.resolved && list.__items.length > 0) {
        listState.resolved = true;
        listState.resolve(list);
      }
      return listState.property;
    },
  });
  const receiver: any = new PresentationReceiver(listState);

  // PresentationReceiver::OnReceiverConnectionAvailable
  bridge.onEvent((e: any) => {
    if (!e || typeof e !== "object") return;
    if (e.type === "connection") {
      const conn = new PresentationConnection(e.connectionId, e.id ?? "", e.url ?? "");
      connections.set(e.connectionId, conn);
      list.__add(conn);
      // DidChangeState(CONNECTED) enqueues the connect event
      ST(() => conn.dispatchEvent(new EV("connect")), 0);
      // Only a connectionList that has been asked for hears of it
      if (listState.property === null) return;
      if (!listState.resolved) {
        listState.resolved = true;
        listState.resolve(list);
      } else {
        list.dispatchEvent(new PresentationConnectionAvailableEvent("connectionavailable", { connection: conn }));
      }
      return;
    }
    const conn = connections.get(e.connectionId);
    if (!conn) return;
    if (e.type === "message") {
      if (conn.__state === "connected") conn.dispatchEvent(new ME("message", { data: e.bytes !== undefined ? binaryMessage(conn, e.bytes) : e.data }));
      return;
    }
    if (e.type === "closed") conn.__didClose("closed");
  });

  class Presentation {
    constructor(token: any) {
      if (token !== listState) throw new TypeError("Illegal constructor");
    }
  }
  Object.defineProperty(Presentation.prototype, "defaultRequest", { configurable: true, enumerable: true, get() { return null; } });
  Object.defineProperty(Presentation.prototype, "receiver", {
    configurable: true,
    enumerable: true,
    get() {
      register();
      return receiver;
    },
  });
  const presentation: any = new Presentation(listState);
  if (g.navigator) {
    Object.defineProperty(g.navigator, "presentation", {
      configurable: true,
      enumerable: true,
      get() {
        register();
        return presentation;
      },
    });
  }
  const expose = (name: string, value: any): void => {
    Object.defineProperty(g, name, { value, writable: true, configurable: true, enumerable: false });
  };
  expose("Presentation", Presentation);
  expose("PresentationReceiver", PresentationReceiver);
  expose("PresentationConnection", PresentationConnection);
  expose("PresentationConnectionList", PresentationConnectionList);
  expose("PresentationConnectionAvailableEvent", PresentationConnectionAvailableEvent);
  expose("PresentationConnectionCloseEvent", PresentationConnectionCloseEvent);

  // kModals in kPresentationReceiverSandboxFlags (content/public/browser/presentation_receiver_flags.h): no dialogs. The
  // receiver window's sandbox header (RECEIVER_SANDBOX in electron/wired-display/electron-windows.ts) is what removes them,
  // in every frame; this only makes the top window's own calls return what a sandboxed page gets, if a page ever runs
  // without that header.
  const quiet = (name: string, result: any): void => {
    Object.defineProperty(g, name, { value: () => result, writable: true, configurable: true, enumerable: true });
  };
  quiet("alert", undefined);
  quiet("confirm", false);
  quiet("prompt", null);
  quiet("print", undefined);
  return true;
}
