/**
 * Chrome's 1-UA mode for a Cast sink: an ordinary https presentation URL is rendered by this user agent, in an offscreen
 * tab, and the tab is mirrored to the sink. This module is the Presentation API side of it, ported from Chromium:
 *  - `chrome/browser/media/router/providers/cast/cast_activity_manager.cc` (`LaunchSession`: every Cast route is made
 *    with `set_local_presentation(true)`),
 *  - `chrome/browser/media/router/presentation/controller_presentation_service_delegate_impl.cc`
 *    (`PresentationFrame::ConnectToPresentation`: a local route's connection is registered with the
 *    `LocalPresentationManager`; `ReconnectPresentation`, `CloseConnection`, `Terminate`),
 *  - `chrome/browser/media/router/presentation/receiver_presentation_service_delegate_impl.cc` (the offscreen tab's
 *    side: `OnLocalPresentationReceiverCreated` once the page uses `navigator.presentation.receiver`),
 *  - `components/media_router/browser/presentation/local_presentation_manager.cc`.
 *
 * The route and the capture are the mirroring manager's (`MirroringManager.startOffscreenPresentation`); the tab is the
 * receiver host's (`createReceiverHost`). See docs/DESIGN.md ("Presentation URLs on a Cast device").
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MirroringManager, MirroringRoute } from "../mirroring/mirroring-manager.ts";
import type { OffscreenTabHandle, OffscreenTabOpener } from "../mirroring/offscreen-tab.ts";
import { getCaptureResolutionConstraint, type PrimaryScreenLike } from "../mirroring/mirror-settings.ts";
import { LocalControllers, type LocalConnectionHandle } from "./wired-display/controller.ts";
import { LocalPresentationManager } from "./wired-display/local-presentation.ts";
import { createReceiverHost, type OffscreenReceiverRequest, type ReceiverHost, type ReceiverIpcMainLike, type ReceiverWindowsOptions } from "./wired-display/electron-windows.ts";

/** The Electron pieces an offscreen tab is made of. */
export interface OffscreenTabElectron {
  BrowserWindow: ReceiverWindowsOptions["BrowserWindow"];
  ipcMain: ReceiverIpcMainLike;
  /** IPC channel prefix of the tab's receiver bridge; it must differ from a wired display's on the same `ipcMain`. */
  channel: string;
  /** Sizes the tab (`GetCaptureResolutionConstraint`); 1920x1080 without it. */
  screen?: PrimaryScreenLike;
  /** Where the generated receiver preload is written; default a new private folder under the system's temporary one. */
  preloadDir?: string;
}

/**
 * The local presentations whose receiver is an offscreen tab, and the tabs. One per cast manager; the wired display
 * provider has its own (the ids are the Media Router's and never collide).
 */
export class OffscreenPresentations {
  readonly local: LocalPresentationManager;
  readonly controllers: LocalControllers;
  /** `CastMirroringServiceHostFactory::GetForOffscreenTab`, for the mirroring manager. */
  readonly openOffscreenTab: OffscreenTabOpener;
  /** Presentation id -> route id, for the routes that are up. */
  private readonly routeIds = new Map<string, string>();
  /** Presentation id -> the open tab. */
  private readonly tabs = new Map<string, OffscreenTabHandle>();
  private mirroring: MirroringManager | undefined;
  private host: ReceiverHost | undefined;

  constructor(open: OffscreenTabElectron | ((request: OffscreenReceiverRequest) => OffscreenTabHandle), log?: (message: string) => void) {
    const terminateRoute = (presentationId: string): void => {
      const routeId = this.routeIds.get(presentationId);
      if (routeId === undefined) throw new Error("ROUTE_NOT_FOUND");
      void this.mirroring?.terminate(routeId);
    };
    this.local = new LocalPresentationManager({
      // A receiver connection's terminate(): `ReceiverPresentationConnection::TerminateInternal` closes the receiver's
      // page (`OffscreenTab::CloseContents` destroys the tab), and the tab going away stops the mirroring session
      // (`CastMirroringServiceHost::WebContentsDestroyed`), which ends the route. This holds while the route is still
      // launching, too.
      terminateRequested: (id) => this.tabs.get(id)?.destroy(),
    });
    // `MediaRouter::TerminateRoute` from a controller's terminate()
    this.controllers = new LocalControllers(this.local, terminateRoute);
    const openTab = typeof open === "function"
      ? open
      : (request: OffscreenReceiverRequest): OffscreenTabHandle => {
          // Made at the first presentation: it writes the preload and takes an IPC channel
          this.host ??= createReceiverHost({
            BrowserWindow: open.BrowserWindow,
            ipcMain: open.ipcMain,
            channel: open.channel,
            preloadDir: open.preloadDir ?? mkdtempSync(join(tmpdir(), "electron-cast-receiver-")),
          });
          return this.host.openOffscreenTab(request);
        };
    const screen = typeof open === "function" ? undefined : open.screen;
    this.openOffscreenTab = (request) => {
      const tab = openTab({
        url: request.url,
        presentationId: request.presentationId,
        size: getCaptureResolutionConstraint(screen),
        onDestroyed: () => {
          if (this.tabs.get(request.presentationId) === tab) this.tabs.delete(request.presentationId);
          request.onDestroyed();
        },
        receiverCreated: (info, callback) => this.local.receiverCreated(info, callback),
        receiverReset: (id) => this.local.receiverTerminated(id),
        ...(log === undefined ? {} : { log }),
      });
      this.tabs.set(request.presentationId, tab);
      return tab;
    };
  }

  /** The manager whose routes these are; its route list is watched so that an ended route ends its connections. */
  attach(mirroring: MirroringManager): void {
    this.mirroring = mirroring;
    mirroring.observe(() => {
      const live = new Set(mirroring.routes().map((r) => r.id));
      for (const [presentationId, routeId] of [...this.routeIds]) {
        if (live.has(routeId)) continue;
        this.routeIds.delete(presentationId);
        // `CastActivityManager::RemoveActivity`: `OnPresentationConnectionStateChanged(route_id, TERMINATED)`
        this.local.terminate(presentationId);
      }
    });
  }

  /**
   * `MediaRouter::CreateRoute` for the URL on a Cast sink and, when the route is up, the page's connection
   * (`PresentationFrame::ConnectToPresentation` -> `RegisterLocalPresentationController`). The connection is connecting
   * until the page in the tab has used `navigator.presentation.receiver`, as on a wired display.
   */
  async start(request: { senderId: number; frameWebContentsId: number; url: string; sinkId: string }): Promise<LocalConnectionHandle> {
    const mirroring = this.mirroring;
    if (mirroring === undefined) throw new Error("mirroring is off");
    const route: MirroringRoute = await mirroring.startOffscreenPresentation(request.sinkId, { url: request.url, frameWebContentsId: request.frameWebContentsId });
    // The route may have ended between the launch's answer and here (the tab closed itself)
    if (!mirroring.routes().some((r) => r.id === route.id)) throw new Error("the presentation ended while it started");
    this.routeIds.set(route.presentationId, route.id);
    return this.controllers.attach(request.senderId, { id: route.presentationId, url: request.url }, { id: route.id, mediaSource: request.url, sinkId: route.sinkId });
  }

  dispose(): void {
    this.host?.dispose();
    this.host = undefined;
    this.routeIds.clear();
    this.tabs.clear();
  }
}
