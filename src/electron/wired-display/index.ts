// Wired display support: extra screens as presentation sinks, with a window on the screen as the receiver. See
// docs/DESIGN.md ("Wired displays") for the mapping to Chrome's WiredDisplayMediaRouteProvider.
import { WiredDisplayControllers } from "./controller.ts";
import { WiredDisplayProvider, type ReceiverWindowFactory, type ScreenLike, type WiredDisplayRoute } from "./provider.ts";
import type { RectLike, WiredDisplaySink } from "./displays.ts";

export { WiredDisplayControllers, type LocalConnectionHandle } from "./controller.ts";
export {
  availableDisplays, isWiredDisplaySource, routeDescription, sinkIdForDisplay, wiredDisplaySinks,
  type DisplayLike, type RectLike, type WiredDisplaySink,
} from "./displays.ts";
export { MAX_BINARY_BYTES, type PresentationMessage } from "./local-presentation.ts";
export { createReceiverWindows, receiverPreloadSource } from "./electron-windows.ts";
export type {
  ReceiverBrowserWindowLike, ReceiverIpcMainLike, ReceiverSessionLike, ReceiverWebContentsLike, ReceiverWindows, ReceiverWindowsOptions,
} from "./electron-windows.ts";
export { LocalPresentationManager } from "./local-presentation.ts";
export type { ControllerEnd, ControllerPort, PresentationInfo, ReceiverEnd } from "./local-presentation.ts";
export {
  WiredDisplayError, WiredDisplayProvider,
  type ReceiverWindow, type ReceiverWindowFactory, type ReceiverWindowRequest, type ScreenLike, type WiredDisplayRoute,
} from "./provider.ts";

/** What a page asked for when the app is to choose a display. */
export interface WiredDisplayRequest {
  /** The request's presentation URLs. */
  urls: string[];
  /** Origin of the page that called `start()`. */
  origin: string;
  /** The page's sender id (its `webContents.id` for a main frame). */
  senderId: number;
  /**
   * Follow the list `selectDisplay` was given while its picker is open: `listener` gets the new list whenever a display is
   * added or removed or the page's window moves to another display (`MediaRouterUI` updates its sinks from
   * `WebContentsDisplayObserver` the same way). Returns the function that stops it. Not called for the list already given.
   */
  observeSinks(listener: (sinks: WiredDisplaySink[]) => void): () => void;
}

/** The part of Electron's `BrowserWindow` that finds the window of a page. */
export interface WindowLike {
  getBounds(): RectLike;
  isDestroyed?(): boolean;
  on(event: "move" | "resize", listener: () => void): unknown;
  removeListener(event: "move" | "resize", listener: () => void): unknown;
}

/** Wired display options of `createCastManager`. */
export interface WiredDisplayOptions {
  /** Electron's `screen`. */
  screen: ScreenLike;
  /**
   * Electron's `BrowserWindow` class (only `fromWebContents` is used), to find the display a page is on: that display is left
   * out of the picker, as Chrome's dialog leaves out the display it is on. Without it, and without `displayOf`, every display is offered.
   */
  BrowserWindow?: { fromWebContents(webContents: any): WindowLike | null };
  /** The receiver window factory, normally `createReceiverWindows({...}).factory`. */
  createReceiverWindow: ReceiverWindowFactory;
  /**
   * The picker of Chrome's cast dialog, for displays: resolves the id of the chosen sink, or null when the user cancels.
   * `sinks` leaves out the display the requesting window is on (see `displayOf`), as Chrome's dialog does. It is called
   * even when `sinks` is empty, as Chrome shows its dialog then too.
   */
  selectDisplay(sinks: WiredDisplaySink[], request: WiredDisplayRequest): Promise<string | null>;
  /**
   * Overrides how the display of a page's window is found (`WebContentsDisplayObserver::GetCurrentDisplay`). By default it is
   * `screen.getDisplayMatching(BrowserWindow.fromWebContents(wc).getBounds()).id`, from the `BrowserWindow` option. A page with
   * no window of its own (an app-created `webContents`, say) has no display, and then every display is offered.
   */
  displayOf?(webContents: unknown): number | undefined;
}

/**
 * The wired display part of {@link CastManager} (`manager.wiredDisplay`): sinks and routes as Chrome's provider reports
 * them. Kept apart from the Cast sinks of `registerMediaSinksObserver`, which are Cast devices.
 */
export interface WiredDisplayApi {
  /** The current sinks (`WiredDisplayMediaRouteProvider::GetSinks`). */
  getSinks(): WiredDisplaySink[];
  /** `MediaRouter::RegisterMediaSinksObserver` for a standard presentation source: the list now and at every change. */
  registerMediaSinksObserver(observer: { onSinksUpdated(sinks: WiredDisplaySink[]): void }): () => void;
  getRoutes(): WiredDisplayRoute[];
  registerMediaRoutesObserver(observer: { onRoutesUpdated(routes: WiredDisplayRoute[]): void }): () => void;
  /** `MediaRouter::TerminateRoute`: closes the receiver window. */
  terminateRoute(routeId: string): Promise<void>;
}

/** The pieces `createCastManager` wires in. */
export interface WiredDisplay {
  readonly provider: WiredDisplayProvider;
  readonly controllers: WiredDisplayControllers;
  readonly api: WiredDisplayApi;
  readonly selectDisplay: WiredDisplayOptions["selectDisplay"];
  /** The sinks a page's picker offers: all but the display its window is on. */
  sinksFor(webContents: unknown): WiredDisplaySink[];
  /** Like `WiredDisplayRequest.observeSinks`, for the page's webContents. */
  observeSinksFor(webContents: unknown, listener: (sinks: WiredDisplaySink[]) => void): () => void;
  dispose(): void;
}

export function createWiredDisplay(options: WiredDisplayOptions): WiredDisplay {
  const provider = new WiredDisplayProvider({ screen: options.screen, createReceiverWindow: options.createReceiverWindow });
  const controllers = new WiredDisplayControllers(provider);
  const windowOf = (webContents: unknown): WindowLike | null => {
    if (webContents === undefined || webContents === null || options.BrowserWindow === undefined) return null;
    try {
      const win = options.BrowserWindow.fromWebContents(webContents);
      return win !== null && win !== undefined && win.isDestroyed?.() !== true ? win : null;
    } catch {
      return null;
    }
  };
  const displayIdOf = (webContents: unknown): number | undefined => {
    if (options.displayOf !== undefined) return options.displayOf(webContents);
    const win = windowOf(webContents);
    if (win === null || options.screen.getDisplayMatching === undefined) return undefined;
    return options.screen.getDisplayMatching(win.getBounds()).id;
  };
  // MediaRouterUI::GetEnabledSinks hides the sink of the display the dialog is on
  const sinksFor = (webContents: unknown): WiredDisplaySink[] => {
    const exclude = displayIdOf(webContents);
    return provider.sinks().filter((s) => s.display.id !== exclude);
  };
  const observeSinksFor = (webContents: unknown, listener: (sinks: WiredDisplaySink[]) => void): (() => void) => {
    const keyOf = (sinks: WiredDisplaySink[]): string => sinks.map((s) => s.id).join(",");
    let last = keyOf(sinksFor(webContents));
    const check = (): void => {
      const sinks = sinksFor(webContents);
      const key = keyOf(sinks);
      if (key === last) return;
      last = key;
      listener(sinks);
    };
    const stopProvider = provider.observeSinks(check);
    const win = windowOf(webContents);
    win?.on("move", check);
    win?.on("resize", check);
    return () => {
      stopProvider();
      win?.removeListener("move", check);
      win?.removeListener("resize", check);
    };
  };
  const api: WiredDisplayApi = {
    getSinks: () => provider.sinks(),
    registerMediaSinksObserver(observer) {
      return provider.observeSinks((sinks) => {
        try {
          observer.onSinksUpdated(sinks);
        } catch (err) {
          console.error("electron-cast: a media sinks observer failed", err);
        }
      });
    },
    getRoutes: () => provider.routes(),
    registerMediaRoutesObserver(observer) {
      const listener = (routes: WiredDisplayRoute[]): void => {
        try {
          observer.onRoutesUpdated(routes);
        } catch (err) {
          console.error("electron-cast: a media routes observer failed", err);
        }
      };
      provider.on("routes", listener);
      listener(provider.routes());
      return () => void provider.off("routes", listener);
    },
    async terminateRoute(routeId) {
      provider.terminateRoute(routeId);
    },
  };
  return {
    provider,
    controllers,
    api,
    selectDisplay: options.selectDisplay,
    sinksFor,
    observeSinksFor,
    dispose: () => provider.dispose(),
  };
}
