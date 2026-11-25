// The wired display media route provider, after WiredDisplayMediaRouteProvider
// (chrome/browser/media/router/providers/wired_display/wired_display_media_route_provider.{h,cc}): every extra screen is
// a sink, a presentation on it is a local route whose receiver is a window on that screen. Pure: the screen and the
// window are passed in (see electron-windows.ts for the Electron ones).
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { LocalPresentationManager } from "./local-presentation.ts";
import type { PresentationInfo, ReceiverConnectionCallback } from "./local-presentation.ts";
import {
  availableDisplays,
  routeDescription,
  sinkIdForDisplay,
  wiredDisplaySinks,
  type DisplayLike,
  type RectLike,
  type WiredDisplaySink,
} from "./displays.ts";

/** The part of Electron's `screen` used here (`display::Screen` and its `DisplayObserver`). */
export interface ScreenLike {
  getAllDisplays(): DisplayLike[];
  getPrimaryDisplay(): DisplayLike;
  /** `screen.getDisplayMatching(rect)`: the display a window is mostly on. Needed to find the display of a page's window. */
  getDisplayMatching?(rect: RectLike): DisplayLike;
  on(event: "display-added" | "display-removed" | "display-metrics-changed", listener: (...args: any[]) => void): unknown;
  removeListener(event: "display-added" | "display-removed" | "display-metrics-changed", listener: (...args: any[]) => void): unknown;
}

/** `WiredDisplayPresentationReceiver` (wired_display_presentation_receiver.h). */
export interface ReceiverWindow {
  /** Loads the URL in the receiver window and shows it fullscreen on its display. */
  start(presentationId: string, url: string): void;
  /** Closes the receiver window; its `onTerminated` follows. */
  terminate(): void;
  /** Leaves fullscreen and shows the window windowed (the display it was on is gone). */
  exitFullscreen(): void;
}

/** What a receiver window needs from the provider (the arguments of `WiredDisplayPresentationReceiverFactory::Create`). */
export interface ReceiverWindowRequest {
  /** The bounds of the display. */
  bounds: RectLike;
  /** `termination_callback`: the receiver is gone (window closed, page navigated away, or terminated). Runs once. */
  onTerminated(): void;
  /** `title_change_callback`. */
  onTitle(title: string): void;
  /** The receiver page registers itself here when it first uses `navigator.presentation` (`ReceiverPresentationServiceDelegateImpl`). */
  receiverCreated(info: PresentationInfo, callback: ReceiverConnectionCallback): void;
  /** The receiver page is gone (`ReceiverPresentationServiceDelegateImpl::Reset`). */
  receiverReset(presentationId: string): void;
}

export type ReceiverWindowFactory = (request: ReceiverWindowRequest) => ReceiverWindow;

/** `media_router::MediaRoute` of a wired display route. The route id is the presentation id. */
export interface WiredDisplayRoute {
  id: string;
  providerId: "wired_display";
  /** The presentation URL. */
  mediaSource: string;
  sinkId: string;
  /** `Presenting (<host>)`. */
  description: string;
  origin: string;
  /** `set_local_presentation(true)`: connections never leave the process. */
  isLocalPresentation: true;
  /** The receiver page's title, as last reported (`Presentation::UpdatePresentationTitle`). */
  title: string;
}

/** `RouteRequestResultCode` names the provider answers with. */
export type WiredDisplayErrorCode = "SINK_NOT_FOUND" | "ROUTE_NOT_FOUND";

export class WiredDisplayError extends Error {
  readonly code: WiredDisplayErrorCode;
  constructor(code: WiredDisplayErrorCode, message: string) {
    super(message);
    this.name = "WiredDisplayError";
    this.code = code;
  }
}

interface Presentation {
  route: WiredDisplayRoute;
  receiver: ReceiverWindow | null;
}

export interface WiredDisplayProviderOptions {
  screen: ScreenLike;
  createReceiverWindow: ReceiverWindowFactory;
  /** Default: `mr_<random uuid>` (`MediaRouterBase::CreatePresentationId`). */
  createPresentationId?: () => string;
}

export class WiredDisplayProvider extends EventEmitter<{ sinks: [WiredDisplaySink[]]; routes: [WiredDisplayRoute[]] }> {
  /** The local presentations: where controller and receiver connections meet. */
  readonly local: LocalPresentationManager;
  private readonly screen: ScreenLike;
  private readonly createReceiverWindow: ReceiverWindowFactory;
  private readonly newId: () => string;
  private readonly presentations = new Map<string, Presentation>();
  private sinkObservers = 0;
  private lastSinks = "";
  private observing = false;

  constructor(options: WiredDisplayProviderOptions) {
    super();
    this.screen = options.screen;
    this.createReceiverWindow = options.createReceiverWindow;
    this.newId = options.createPresentationId ?? (() => `mr_${randomUUID()}`);
    this.local = new LocalPresentationManager({
      terminateRequested: (id) => {
        // A receiver connection's terminate(): the window closes, which ends the presentation.
        this.presentations.get(id)?.receiver?.terminate();
      },
    });
  }

  /** `MediaRouterBase::CreatePresentationId`. */
  createPresentationId(): string {
    return this.newId();
  }

  /** `GetSinks`. */
  sinks(): WiredDisplaySink[] {
    return wiredDisplaySinks(this.screen.getAllDisplays(), this.screen.getPrimaryDisplay());
  }

  /**
   * `StartObservingMediaSinks`: the listener gets the list now and at every change. Displays are watched while any
   * listener exists. Returns the function that stops it (`StopObservingMediaSinks`).
   */
  observeSinks(listener: (sinks: WiredDisplaySink[]) => void): () => void {
    this.sinkObservers += 1;
    this.observe();
    const wrapped = (sinks: WiredDisplaySink[]): void => listener(sinks);
    this.on("sinks", wrapped);
    listener(this.sinks());
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      this.off("sinks", wrapped);
      this.sinkObservers -= 1;
      if (this.sinkObservers === 0) this.unobserve();
    };
  }

  private readonly onAdded = (): void => this.notifySinks();
  private readonly onMetrics = (): void => this.notifySinks();
  /** `OnDisplaysRemoved`: a presentation on a removed display leaves fullscreen; it is not terminated. */
  private readonly onRemoved = (_event: unknown, removed: DisplayLike): void => {
    const sinkId = sinkIdForDisplay(removed);
    for (const p of this.presentations.values()) {
      if (p.route.sinkId === sinkId) {
        p.receiver?.exitFullscreen();
        break;
      }
    }
    this.notifySinks();
  };

  private observe(): void {
    if (this.observing) return;
    this.observing = true;
    this.lastSinks = JSON.stringify(this.sinks());
    this.screen.on("display-added", this.onAdded);
    this.screen.on("display-removed", this.onRemoved);
    this.screen.on("display-metrics-changed", this.onMetrics);
  }

  private unobserve(): void {
    if (!this.observing) return;
    this.observing = false;
    this.screen.removeListener("display-added", this.onAdded);
    this.screen.removeListener("display-removed", this.onRemoved);
    this.screen.removeListener("display-metrics-changed", this.onMetrics);
  }

  private notifySinks(): void {
    const sinks = this.sinks();
    const key = JSON.stringify(sinks);
    if (key === this.lastSinks) return;
    this.lastSinks = key;
    this.emit("sinks", sinks);
  }

  /** `StartObservingMediaRoutes` / `OnRoutesUpdated`. */
  routes(): WiredDisplayRoute[] {
    return [...this.presentations.values()].map((p) => ({ ...p.route }));
  }

  private notifyRoutes(): void {
    this.emit("routes", this.routes());
  }

  /**
   * `CreateRoute`: a window on the sink's display loads `mediaSource`. A presentation already on that display is
   * terminated first. The route id is the presentation id.
   */
  createRoute(mediaSource: string, sinkId: string, origin: string, presentationId = this.newId()): WiredDisplayRoute {
    const display = this.screen.getAllDisplays().find((d) => sinkIdForDisplay(d) === sinkId);
    if (display === undefined) throw new WiredDisplayError("SINK_NOT_FOUND", "Display not found");
    this.terminatePresentationsOn(sinkId);
    const route: WiredDisplayRoute = {
      id: presentationId,
      providerId: "wired_display",
      mediaSource,
      sinkId,
      description: routeDescription(mediaSource),
      origin,
      isLocalPresentation: true,
      title: "",
    };
    const presentation: Presentation = { route, receiver: null };
    this.presentations.set(presentationId, presentation);
    let started = false;
    let terminatedEarly = false;
    presentation.receiver = this.createReceiverWindow({
      bounds: { ...display.bounds },
      onTerminated: () => {
        if (!started) terminatedEarly = true;
        else this.removePresentation(presentationId);
      },
      onTitle: (title) => {
        if (route.title === title) return;
        route.title = title;
        this.notifyRoutes();
      },
      receiverCreated: (info, callback) => this.local.receiverCreated(info, callback),
      receiverReset: (id) => this.local.receiverTerminated(id),
    });
    started = true;
    if (terminatedEarly) {
      this.removePresentation(presentationId);
    } else {
      presentation.receiver.start(presentationId, mediaSource);
    }
    this.notifyRoutes();
    return { ...route };
  }

  /** `TerminateRoute`. The presentation leaves the list when its window has closed. */
  terminateRoute(routeId: string): void {
    const p = this.presentations.get(routeId);
    if (p === undefined) throw new WiredDisplayError("ROUTE_NOT_FOUND", "Presentation not found");
    p.receiver?.terminate();
  }

  /** `RemovePresentationById`: the receiver is gone, so every controller connection becomes TERMINATED. */
  private removePresentation(presentationId: string): void {
    if (!this.presentations.delete(presentationId)) return;
    this.local.terminate(presentationId);
    this.notifyRoutes();
  }

  /** `TerminatePresentationsOnDisplay`. */
  private terminatePresentationsOn(sinkId: string): void {
    // Collected first: terminating can remove the presentation from the map
    const victims = [...this.presentations.values()].filter((p) => p.route.sinkId === sinkId);
    for (const p of victims) p.receiver?.terminate();
  }

  /** Is a presentation URL one this provider serves for `sinkId`'s display? Used by displays that are in `availableDisplays`. */
  hasDisplays(): boolean {
    return availableDisplays(this.screen.getAllDisplays(), this.screen.getPrimaryDisplay()).length > 0;
  }

  /** Terminates every presentation and stops watching the screen. */
  dispose(): void {
    this.unobserve();
    this.sinkObservers = 0;
    for (const p of [...this.presentations.values()]) p.receiver?.terminate();
    this.removeAllListeners();
  }
}
