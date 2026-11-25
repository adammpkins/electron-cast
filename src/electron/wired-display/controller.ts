// The controller side of a wired display presentation: what a page's `PresentationRequest.start()`, `reconnect()` and
// connection do when the sink is a display, after ControllerPresentationServiceDelegateImpl
// (components/media_router/browser/presentation/controller_presentation_service_delegate_impl.cc) and the Blink
// ControllerPresentationConnection (third_party/blink/renderer/modules/presentation/presentation_connection.cc).
import { PresentationError } from "../presentation-handler.ts";
import type { PresentationConnectionHandle } from "../presentation-handler.ts";
import type { ControllerEnd, ControllerPort, PresentationMessage } from "./local-presentation.ts";
import { isWiredDisplaySource } from "./displays.ts";
import { WiredDisplayError, type WiredDisplayProvider } from "./provider.ts";

/** A connection handle that starts out connecting: `onconnect` fires when the receiver page is ready. */
export interface LocalConnectionHandle extends Omit<PresentationConnectionHandle, "send" | "onmessage"> {
  /** Text or bytes (`PresentationConnectionMessage`); the Cast connections of the same page carry text only. */
  send(message: PresentationMessage): void;
  onmessage: ((message: PresentationMessage) => void) | null;
  /** True until the receiver page has taken the connection (Blink's CONNECTING). */
  readonly connecting: boolean;
  onconnect: (() => void) | null;
}

class LocalControllerConnection implements LocalConnectionHandle, ControllerEnd {
  readonly id: string;
  readonly url: string;
  onclose: ((reason: "closed" | "terminated") => void) | null = null;
  onconnect: (() => void) | null = null;
  port: ControllerPort | null = null;
  private state: "connecting" | "connected" | "ended" = "connecting";
  private queue: PresentationMessage[] = [];
  private msgHandler: ((message: PresentationMessage) => void) | null = null;
  private readonly owner: WiredDisplayControllers;
  private readonly senderId: number;

  constructor(owner: WiredDisplayControllers, senderId: number, id: string, url: string) {
    this.owner = owner;
    this.senderId = senderId;
    this.id = id;
    this.url = url;
  }

  get connecting(): boolean {
    return this.state === "connecting";
  }

  get onmessage(): ((message: PresentationMessage) => void) | null {
    return this.msgHandler;
  }

  set onmessage(fn: ((message: PresentationMessage) => void) | null) {
    this.msgHandler = fn;
    if (fn !== null && this.state !== "ended") {
      const queued = this.queue;
      this.queue = [];
      for (const m of queued) fn(m);
    }
  }

  /** `PresentationConnection::send`: only a connected connection sends (CanSendMessage). */
  send(message: PresentationMessage): void {
    if (this.state === "connected") this.port?.send(message);
  }

  /** `PresentationConnection::close()`: the receiver's connection closes; the presentation lives on. */
  close(): void {
    if (this.state === "ended") return;
    this.port?.close();
    this.owner.forget(this);
    this.finish("closed");
  }

  /** `PresentationConnection::terminate()`: only when connected; the state changes once the window has closed. */
  terminate(): void {
    if (this.state !== "connected") return;
    try {
      this.owner.provider.terminateRoute(this.id);
    } catch {
      // ROUTE_NOT_FOUND: already gone, and its termination was reported
    }
  }

  // ControllerEnd
  connected(): void {
    if (this.state !== "connecting") return;
    this.state = "connected";
    this.onconnect?.();
  }

  message(data: PresentationMessage): void {
    if (this.state !== "connected") return;
    if (this.msgHandler !== null) this.msgHandler(data);
    else this.queue.push(data);
  }

  closed(): void {
    this.owner.forget(this);
    this.finish("closed");
  }

  terminated(): void {
    this.owner.forget(this);
    this.finish("terminated");
  }

  /** The page's frame is gone: nothing is told (Chrome only unregisters the controller). */
  detach(): void {
    if (this.state === "ended") return;
    this.state = "ended";
    this.queue.length = 0;
  }

  private finish(reason: "closed" | "terminated"): void {
    if (this.state === "ended") return;
    this.state = "ended";
    this.queue.length = 0;
    this.onclose?.(reason);
  }

  get frameKey(): number {
    return this.senderId;
  }
}

/** Starts, reconnects and tracks the controller connections to wired display presentations. */
export class WiredDisplayControllers {
  readonly provider: WiredDisplayProvider;
  private readonly bySender = new Map<number, Set<LocalControllerConnection>>();

  constructor(provider: WiredDisplayProvider) {
    this.provider = provider;
  }

  /** The first URL of a request this provider serves (`IsValidStandardPresentationSource`), or null. */
  static sourceOf(urls: readonly string[]): string | null {
    return urls.find((u) => isWiredDisplaySource(u)) ?? null;
  }

  /**
   * A start() on the chosen display: the route is created (and its window shown), and the connection is returned
   * connecting, as Blink returns it; it connects once the receiver page has used `navigator.presentation`.
   */
  start(req: { urls: readonly string[]; origin: string; senderId: number }, sinkId: string): LocalConnectionHandle {
    const source = WiredDisplayControllers.sourceOf(req.urls);
    if (source === null) throw new PresentationError("NotSupportedError", "No presentation URL can be shown on a display");
    const presentationId = this.provider.createPresentationId();
    let route;
    try {
      route = this.provider.createRoute(source, sinkId, req.origin, presentationId);
    } catch (err) {
      if (err instanceof WiredDisplayError) throw new PresentationError("OperationError", err.message);
      throw err;
    }
    return this.attach(req.senderId, { id: presentationId, url: source }, route);
  }

  /**
   * `ControllerPresentationServiceDelegateImpl::ReconnectPresentation`: a local presentation is joined again from any
   * frame when one of the request's URLs is the route's source; otherwise the provider's JoinRoute answers unknown error.
   */
  reconnect(req: { urls: readonly string[]; senderId: number }, presentationId: string): LocalConnectionHandle {
    const route = this.provider.local.getRoute(presentationId);
    if (!this.provider.local.isLocalPresentation(presentationId) || route === null) {
      throw new PresentationError("NotFoundError", "Join should be handled by the presentation manager");
    }
    const wanted = normalize(route.mediaSource);
    if (!req.urls.some((u) => normalize(u) === wanted)) {
      throw new PresentationError("NotFoundError", "No presentation with this URL and id");
    }
    return this.attach(req.senderId, { id: presentationId, url: route.mediaSource }, route);
  }

  private attach(senderId: number, info: { id: string; url: string }, route: { id: string; mediaSource: string; sinkId: string }): LocalConnectionHandle {
    const conn = new LocalControllerConnection(this, senderId, info.id, info.url);
    const port = this.provider.local.registerController(info, senderId, conn, route);
    if (port === null) throw new PresentationError("NotFoundError", "The presentation has another origin");
    conn.port = port;
    let set = this.bySender.get(senderId);
    if (set === undefined) {
      set = new Set();
      this.bySender.set(senderId, set);
    }
    set.add(conn);
    return conn;
  }

  /** @internal Called by connections when they end. */
  forget(conn: LocalControllerConnection): void {
    this.bySender.get(conn.frameKey)?.delete(conn);
    // A closed connection no longer waits for the receiver (CloseConnection -> UnregisterLocalPresentationController)
    this.provider.local.unregisterController(conn.id, conn.frameKey);
  }

  /**
   * The page's frame went away or navigated (`PresentationFrame::Reset`): its controllers are unregistered and nothing
   * more. The receiver window stays, and so does its connection (Chrome sets no disconnect handler there).
   */
  senderGone(senderId: number): void {
    const set = this.bySender.get(senderId);
    this.bySender.delete(senderId);
    if (set === undefined) return;
    for (const conn of set) {
      this.provider.local.unregisterController(conn.id, senderId);
      conn.detach();
    }
  }
}

function normalize(url: string): string {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}
