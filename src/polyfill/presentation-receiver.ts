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
    binaryType: string;
    constructor(connectionId: string, id: string, url: string) {
      super();
      this.__connectionId = connectionId;
      this.__id = id;
      this.__url = url;
      this.__state = "connected";
      this.binaryType = "arraybuffer";
    }
    send(data: any): void {
      if (this.__state !== "connected") throw new DE("The presentation connection is not connected.", "InvalidStateError");
      if (typeof data !== "string") throw new TypeError("send() accepts strings only; binary data is not supported.");
      bridge.send(this.__connectionId, data);
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
      connections.delete(this.__connectionId);
    }
    __didClose(reason: string): void {
      if (this.__state === "closed" || this.__state === "terminated") return;
      this.__state = "closed";
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
      if (conn.__state === "connected") conn.dispatchEvent(new ME("message", { data: e.data }));
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

  // kModals in kPresentationReceiverSandboxFlags (content/public/browser/presentation_receiver_flags.h): no dialogs
  const quiet = (name: string, result: any): void => {
    Object.defineProperty(g, name, { value: () => result, writable: true, configurable: true, enumerable: true });
  };
  quiet("alert", undefined);
  quiet("confirm", false);
  quiet("prompt", null);
  quiet("print", undefined);
  return true;
}
