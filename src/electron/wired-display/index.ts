// Wired display support: extra screens as presentation sinks, with a window on the screen as the receiver. See
// docs/DESIGN.md ("Wired displays") for the mapping to Chrome's WiredDisplayMediaRouteProvider.
import { WiredDisplayControllers } from "./controller.ts";
import { WiredDisplayProvider, type ReceiverWindowFactory, type ScreenLike, type WiredDisplayRoute } from "./provider.ts";
import type { WiredDisplaySink } from "./displays.ts";

export { WiredDisplayControllers, type LocalConnectionHandle } from "./controller.ts";
export {
  availableDisplays, isWiredDisplaySource, routeDescription, sinkIdForDisplay, wiredDisplaySinks,
  type DisplayLike, type RectLike, type WiredDisplaySink,
} from "./displays.ts";
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
}

/** Wired display options of `createCastManager`. */
export interface WiredDisplayOptions {
  /** Electron's `screen`. */
  screen: ScreenLike;
  /** The receiver window factory, normally `createReceiverWindows({...}).factory`. */
  createReceiverWindow: ReceiverWindowFactory;
  /**
   * The picker of Chrome's cast dialog, for displays: resolves the id of the chosen sink, or null when the user cancels.
   * `sinks` leaves out the display the requesting window is on (see `displayOf`), as Chrome's dialog does. It is called
   * even when `sinks` is empty, as Chrome shows its dialog then too.
   */
  selectDisplay(sinks: WiredDisplaySink[], request: WiredDisplayRequest): Promise<string | null>;
  /**
   * The id of the display a page's window is on (`WebContentsDisplayObserver::GetCurrentDisplay`), e.g.
   * `(wc) => screen.getDisplayMatching(BrowserWindow.fromWebContents(wc).getBounds()).id`. Without it every display is
   * offered.
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
  readonly displayOf: WiredDisplayOptions["displayOf"];
  dispose(): void;
}

export function createWiredDisplay(options: WiredDisplayOptions): WiredDisplay {
  const provider = new WiredDisplayProvider({ screen: options.screen, createReceiverWindow: options.createReceiverWindow });
  const controllers = new WiredDisplayControllers(provider);
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
    displayOf: options.displayOf,
    dispose: () => provider.dispose(),
  };
}
