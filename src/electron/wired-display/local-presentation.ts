// The in-process half of Chrome's local presentations: how a controller page's PresentationConnection and the
// receiver window's are joined without any network, after LocalPresentationManager
// (components/media_router/browser/presentation/local_presentation_manager.{h,cc}). Chrome passes a pair of Mojo
// pipes (blink::mojom::PresentationConnection) to both sides; here a link carries the same notifications.
// Pure module: no Electron imports.

/**
 * `blink::mojom::PresentationConnectionMessage`: a union of `message` (text) and `data` (bytes). Bytes are copied on the
 * way across, as Blink copies them into a Vector, so the two pages never share a buffer.
 */
export type PresentationMessage = string | Uint8Array;

/**
 * Largest binary message taken from a page over IPC. Blink allows up to 4 GiB (`wtf_size_t`); an Electron IPC message is
 * a structured clone through the main process, so this caps what one page can make it hold.
 */
export const MAX_BINARY_BYTES = 64 * 1024 * 1024;

/** The bytes of what a page sent over IPC (it arrives as a Uint8Array, or an ArrayBuffer), or null when it is not binary. */
export function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** How a message travels to a page: text as `data`, bytes as `bytes`. */
export function messageFields(data: PresentationMessage): { data: string } | { bytes: Uint8Array } {
  return typeof data === "string" ? { data } : { bytes: data };
}

const copyMessage = (data: PresentationMessage): PresentationMessage => (typeof data === "string" ? data : data.slice());

/** `blink::mojom::PresentationInfo`. */
export interface PresentationInfo { id: string; url: string }

/** What the controller's connection hears from the receiver (the controller side of `blink::mojom::PresentationConnection`). */
export interface ControllerEnd {
  /** `DidChangeState(CONNECTED)`, sent by `ReceiverPresentationConnection::Init`. */
  connected(): void;
  /** `OnMessage`. */
  message(data: PresentationMessage): void;
  /** `DidClose(CLOSED)`: the receiver's connection was closed. */
  closed(): void;
  /** `DidChangeState(TERMINATED)`: the receiver terminated the presentation, or its window went away. */
  terminated(): void;
}

/** One connection as the receiver page sees it (the receiver side of `blink::mojom::PresentationConnection`). */
export interface ReceiverEnd {
  readonly id: string;
  readonly url: string;
  /** The controller sent a message. */
  onmessage: ((data: PresentationMessage) => void) | null;
  /** The controller closed its connection (`DidClose(CLOSED)`). */
  onclose: (() => void) | null;
  send(data: PresentationMessage): void;
  /** `PresentationConnection::close()` on the receiver: tells the controller, keeps the presentation. */
  close(): void;
  /** `ReceiverPresentationConnection::TerminateInternal`: closes the receiver window. */
  terminate(): void;
}

/** What the controller's connection calls (the controller side's `target_connection_`). */
export interface ControllerPort {
  send(data: PresentationMessage): void;
  /** `PresentationConnection::DoClose`: the receiver's connection is closed and removed from its list. */
  close(): void;
}

/** The route a controller was registered with (`GetRoute`); a later reconnect checks its source URL. */
export interface LocalRoute { id: string; mediaSource: string; sinkId: string }

export type ReceiverConnectionCallback = (end: ReceiverEnd) => void;

/** The shared state of one connection's two ends. */
class Link {
  readonly info: PresentationInfo;
  readonly controller: ControllerEnd;
  open = true;
  receiver: ReceiverSide | null = null;
  readonly onTerminate: () => void;
  readonly onDetach: (link: Link) => void;

  constructor(info: PresentationInfo, controller: ControllerEnd, onTerminate: () => void, onDetach: (link: Link) => void) {
    this.info = info;
    this.controller = controller;
    this.onTerminate = onTerminate;
    this.onDetach = onDetach;
  }

  /** The presentation ended: the controller's state becomes TERMINATED. */
  end(): void {
    if (!this.open) return;
    this.open = false;
    this.controller.terminated();
  }
}

class ControllerSide implements ControllerPort {
  private readonly link: Link;
  constructor(link: Link) {
    this.link = link;
  }

  send(data: PresentationMessage): void {
    const rx = this.link.receiver;
    if (this.link.open && rx !== null) rx.onmessage?.(copyMessage(data));
  }

  close(): void {
    const link = this.link;
    if (!link.open) return;
    link.open = false;
    link.onDetach(link);
    link.receiver?.onclose?.();
  }
}

class ReceiverSide implements ReceiverEnd {
  onmessage: ((data: PresentationMessage) => void) | null = null;
  onclose: (() => void) | null = null;
  private readonly link: Link;
  constructor(link: Link) {
    this.link = link;
  }

  get id(): string {
    return this.link.info.id;
  }

  get url(): string {
    return this.link.info.url;
  }

  send(data: PresentationMessage): void {
    if (this.link.open) this.link.controller.message(copyMessage(data));
  }

  close(): void {
    const link = this.link;
    if (!link.open) return;
    link.open = false;
    link.onDetach(link);
    link.controller.closed();
  }

  terminate(): void {
    // Blink also tells this connection's controller at once; the window closing tells every controller
    // (ReceiverPresentationConnection::TerminateInternal), which ends in the same states.
    if (this.link.open) this.link.onTerminate();
  }
}

class LocalPresentation {
  readonly info: PresentationInfo;
  route: LocalRoute | null = null;
  receiverCallback: ReceiverConnectionCallback | null = null;
  /** Controllers registered before the receiver page was ready, by frame (`pending_controllers_`). */
  readonly pending = new Map<number, Link>();

  constructor(info: PresentationInfo) {
    this.info = info;
  }

  /** `LocalPresentation::IsValid`. */
  isValid(): boolean {
    return !(this.pending.size === 0 && this.receiverCallback === null);
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/** `LocalPresentationManager`. */
export class LocalPresentationManager {
  private readonly presentations = new Map<string, LocalPresentation>();
  /**
   * Every open link by presentation id. Chrome tells controllers of a termination through the route's state, not through
   * the manager, so this survives the receiver page's reset (which makes the manager forget the presentation).
   */
  private readonly linksById = new Map<string, Set<Link>>();
  /** Called when a receiver connection asks to terminate its presentation. */
  private readonly terminateRequested: (presentationId: string) => void;

  constructor(opts: { terminateRequested: (presentationId: string) => void }) {
    this.terminateRequested = opts.terminateRequested;
  }

  private getOrCreate(info: PresentationInfo): LocalPresentation {
    let p = this.presentations.get(info.id);
    if (p === undefined) {
      p = new LocalPresentation({ ...info });
      this.presentations.set(info.id, p);
    }
    return p;
  }

  /**
   * `RegisterLocalPresentationController`. A controller whose URL has another origin than the presentation's is
   * ignored (null). The link is delivered to the receiver at once when it is ready, else held until it is.
   */
  registerController(info: PresentationInfo, frameKey: number, controller: ControllerEnd, route: LocalRoute): ControllerPort | null {
    const p = this.getOrCreate(info);
    if (originOf(p.info.url) !== originOf(info.url)) return null;
    let all = this.linksById.get(info.id);
    if (all === undefined) {
      all = new Set();
      this.linksById.set(info.id, all);
    }
    const set = all;
    const link = new Link(p.info, controller, () => this.terminateRequested(info.id), (l) => set.delete(l));
    const port = new ControllerSide(link);
    set.add(link);
    p.route = route;
    if (p.receiverCallback !== null) {
      this.deliver(p, link);
    } else if (!p.pending.has(frameKey)) {
      // std::map::insert keeps an existing entry: a second controller of one frame waits for nothing
      p.pending.set(frameKey, link);
    }
    return port;
  }

  /** `UnregisterLocalPresentationController`: drops a controller that is still waiting; the presentation stays while it has a receiver. */
  unregisterController(presentationId: string, frameKey: number): void {
    const p = this.presentations.get(presentationId);
    if (p === undefined) return;
    const waiting = p.pending.get(frameKey);
    if (waiting !== undefined) this.linksById.get(presentationId)?.delete(waiting);
    p.pending.delete(frameKey);
    if (!p.isValid()) this.presentations.delete(presentationId);
  }

  /**
   * `OnLocalPresentationReceiverCreated`: the receiver page is ready (it touched `navigator.presentation`). Waiting
   * controllers are delivered to it. A second call for one presentation does nothing.
   */
  receiverCreated(info: PresentationInfo, callback: ReceiverConnectionCallback): void {
    const p = this.getOrCreate(info);
    if (originOf(p.info.url) !== originOf(info.url)) return;
    if (p.receiverCallback !== null) return;
    p.receiverCallback = callback;
    const waiting = [...p.pending.values()];
    p.pending.clear();
    for (const link of waiting) this.deliver(p, link);
  }

  private deliver(p: LocalPresentation, link: Link): void {
    const end = new ReceiverSide(link);
    link.receiver = end;
    p.receiverCallback?.(end);
    link.controller.connected();
  }

  /** `OnLocalPresentationReceiverTerminated`: the receiver page is gone; forget the presentation. */
  receiverTerminated(presentationId: string): void {
    this.presentations.delete(presentationId);
  }

  /** The presentation is over: every controller's connection becomes TERMINATED (`OnPresentationConnectionStateChanged`). */
  terminate(presentationId: string): void {
    this.presentations.delete(presentationId);
    const links = this.linksById.get(presentationId);
    this.linksById.delete(presentationId);
    if (links === undefined) return;
    for (const link of [...links]) link.end();
    links.clear();
  }

  isLocalPresentation(presentationId: string): boolean {
    return this.presentations.has(presentationId);
  }

  getRoute(presentationId: string): LocalRoute | null {
    return this.presentations.get(presentationId)?.route ?? null;
  }
}
