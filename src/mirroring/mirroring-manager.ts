/**
 * Starts, lists and stops mirroring routes: the part of Chromium's `CastActivityManager` that handles mirroring
 * (`LaunchSession` with a streaming source, `TerminateSession`, `OnActivityStopped`, `NotifyAllOnRoutesUpdated`).
 * One activity per sink: a new route on a sink first ends the one already there (`pending_activity_removal_` in
 * `CastActivityManager::LaunchSession`).
 */
import { randomUUID } from "node:crypto";
import type { CastDevice } from "../discovery/index.ts";
import { MirroringActivity, type MirroringClient, type MirroringServiceFactory } from "./mirroring-activity.ts";
import { desktopMediaSource, mirroringSourceFor, sinkSupportsSource, tabMediaSource, type MirroringType } from "./routing.ts";

/** `MediaCastMode` values this library implements besides the Presentation API. */
export type MirroringCastMode = "tab_mirror" | "desktop_mirror";

export interface StartMirroringOptions {
  castMode: MirroringCastMode;
  /** For `tab_mirror`: the `webContents.id` of the page to mirror (the tab id of `MediaSource::ForTab`). */
  webContentsId?: number;
  /**
   * For `desktop_mirror`: the `desktopCapturer` source id (`screen:0:0`, `window:...`), what Chrome calls the
   * desktop media id.
   */
  desktopSourceId?: string;
  /** For `desktop_mirror`: also capture system audio where the OS allows it (`IsDesktopSourceWithAudio`). */
  withAudio?: boolean;
  /** `streamingTargetPlayoutDelayMillis`. */
  targetPlayoutDelayMs?: number;
}

/** A mirroring route (`media_router::MediaRoute` for a mirroring activity). */
export interface MirroringRoute {
  /** `MediaRoute::GetMediaRouteId`. */
  id: string;
  /** The source URN (`media_source`). */
  mediaSource: string;
  sinkId: string;
  /** "Casting tab" or "Casting screen". */
  description: string;
  castMode: MirroringCastMode;
  appId: string;
  displayName: string;
  /** The Cast session id once the app is launched; "" while launching. */
  sessionId: string;
  /** True while the launch is in flight (`MediaRoute::is_connecting`). */
  isConnecting: boolean;
  webContentsId?: number;
  /**
   * `MirroringMediaControllerHost::CanFreeze` / `IsFrozen` (`UIMediaSink::freeze_info`): whether the route can be
   * frozen on its last frame, and whether it is.
   */
  freezeInfo: { canFreeze: boolean; isFrozen: boolean };
}

export class MirroringRouteError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "MirroringRouteError";
    this.code = code;
  }
}

export interface MirroringManagerOptions {
  findDevice(sinkId: string): CastDevice | undefined;
  /** A fresh Cast client for the device; the manager connects it and closes it when the route ends. */
  createClient(device: CastDevice): MirroringClient;
  createService: MirroringServiceFactory;
  /**
   * End the other kinds of route (Presentation API / Cast SDK sessions) that the page launched. Chrome keeps one route per
   * frame in `routes_by_frame_` for every kind of route, so a page that becomes a mirroring source loses them.
   */
  terminateRoutesOfPage?(webContentsId: number): void;
  log?(level: "info" | "error", message: string): void;
}

interface Entry {
  route: MirroringRoute;
  activity: MirroringActivity;
}

/** `MediaRoute::kRouteIdPrefix`. */
const ROUTE_ID_PREFIX = "urn:x-org.chromium:media:route:";

export class MirroringManager {
  private readonly options: MirroringManagerOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private disposed = false;

  constructor(options: MirroringManagerOptions) {
    this.options = options;
  }

  routes(): MirroringRoute[] {
    return [...this.entries.values()].map((e) => ({ ...e.route }));
  }

  /** The listener is called whenever a route starts, changes or ends. Returns the unregister function. */
  observe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch (err) {
        console.error("electron-cast: a mirroring observer failed", err);
      }
    }
  }

  /**
   * `MediaRouterUI::StartCasting` for `TAB_MIRROR` and `DESKTOP_MIRROR`, then `CastActivityManager::LaunchSession`.
   * Resolves with the route once the receiver app is launched and the service started.
   */
  async startMirroring(sinkId: string, options: StartMirroringOptions): Promise<MirroringRoute> {
    if (this.disposed) throw new MirroringRouteError("cancelled", "the manager is disposed");
    const device = this.options.findDevice(sinkId);
    if (device === undefined) throw new MirroringRouteError("sink_not_found", `no sink ${sinkId}`);
    const mediaSourceId = this.mediaSourceFor(options);
    const source = mirroringSourceFor(mediaSourceId)!;
    if (options.targetPlayoutDelayMs !== undefined) source.targetPlayoutDelayMs = options.targetPlayoutDelayMs;
    // A sink is offered for a source only when it can run one of its apps (the sinks query of `CastMediaSource`).
    if (!sinkSupportsSource(source, device.capabilities)) {
      throw new MirroringRouteError("unable_to_cast", `${device.name} cannot receive this mirroring source`);
    }
    for (const entry of [...this.entries.values()]) {
      if (entry.route.sinkId === sinkId) entry.activity.stopMirroring();
    }
    // `CastActivityManager::DoLaunchSession`: "If there is a route from this frame already, stop it."
    if (source.type === "tab") this.terminateRoutesOfTab(options.webContentsId!);
    const presentationId = `mr_${randomUUID()}`;
    const routeId = `${ROUTE_ID_PREFIX}${presentationId}/${sinkId}/${mediaSourceId}`;
    const log = (level: "info" | "error", message: string): void => this.options.log?.(level, `[${sinkId}] ${message}`);
    const entry = {} as Entry;
    const client = this.options.createClient(device);
    const activity = new MirroringActivity({
      sink: device,
      source,
      webContentsId: source.type === "tab" ? options.webContentsId : undefined,
      client,
      createService: this.options.createService,
      log,
      onStop: () => {
        if (this.entries.get(routeId) === entry) {
          this.entries.delete(routeId);
          this.notify();
        }
      },
      onChange: () => {
        if (this.entries.get(routeId) !== entry) return;
        entry.route = this.routeOf(routeId, source.type, activity);
        this.notify();
      },
      onSourceChanged: (_old, tab) => {
        // `CastActivityManager::OnSourceChanged`: no two routes may have the same source tab, so the one already
        // casting the new tab is terminated.
        for (const other of [...this.entries.values()]) {
          if (other !== entry && other.activity.webContentsId === tab) other.activity.stopMirroring();
        }
        this.options.terminateRoutesOfPage?.(tab);
      },
    });
    entry.activity = activity;
    entry.route = this.routeOf(routeId, source.type, activity);
    this.entries.set(routeId, entry);
    this.notify();
    try {
      await activity.start();
    } catch (err) {
      activity.stopMirroring();
      throw err instanceof MirroringRouteError ? err : new MirroringRouteError("unknown_error", err instanceof Error ? err.message : String(err));
    }
    if (activity.state === "stopped") throw new MirroringRouteError("unable_to_cast", "mirroring stopped while starting");
    return { ...entry.route };
  }

  /** `CastActivityManager::TerminateSession`: stops the receiver's app and the capture. */
  terminate(routeId: string): boolean {
    const entry = this.entries.get(routeId);
    if (entry === undefined) return false;
    entry.activity.stopMirroring();
    return true;
  }

  /**
   * `CastMirroringServiceHost::SwitchMirroringSourceTab` as the Share-this-tab-instead control of Chrome's tab-sharing
   * UI calls it: the route carries on with `webContentsId` as its source, in the same session and with the same route
   * id (the receiver sees no new session and no renegotiation). Only tab routes switch: Chrome shows the control for
   * tab capture only, and its host checks the new source is a tab.
   */
  switchMirroringSourceTab(routeId: string, webContentsId: number): void {
    if (!Number.isInteger(webContentsId) || webContentsId < 0) throw new TypeError("webContentsId must be a non-negative integer");
    const entry = this.entries.get(routeId);
    if (entry === undefined) throw new MirroringRouteError("route_not_found", `no mirroring route ${routeId}`);
    if (entry.activity.source.type !== "tab") throw new MirroringRouteError("unable_to_cast", "only a tab route can switch its source tab");
    if (entry.activity.state !== "mirroring") throw new MirroringRouteError("unable_to_cast", "the route is not mirroring yet");
    try {
      entry.activity.switchMirroringSourceTab(webContentsId);
    } catch (err) {
      throw err instanceof MirroringRouteError ? err : new MirroringRouteError("unable_to_cast", err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * `MediaRouterUI::FreezeRoute`: pause the route's video on its last frame (audio goes on). Nothing happens for a route
   * that cannot freeze, as in Chrome. Returns false when the route is not a mirroring route.
   */
  freezeRoute(routeId: string): boolean {
    const entry = this.entries.get(routeId);
    if (entry === undefined) return false;
    entry.activity.freeze();
    return true;
  }

  /** `MediaRouterUI::UnfreezeRoute`. Returns false when the route is not a mirroring route. */
  unfreezeRoute(routeId: string): boolean {
    const entry = this.entries.get(routeId);
    if (entry === undefined) return false;
    entry.activity.unfreeze();
    return true;
  }

  /**
   * `CastActivityManager::DoLaunchSession`: a route launched from a frame ends the one that frame already has, of any
   * kind. Also what a Presentation API route's launch does to a mirroring route of the same page.
   */
  private terminateRoutesOfTab(webContentsId: number): void {
    this.stopMirroringRoutesOfTab(webContentsId);
    this.options.terminateRoutesOfPage?.(webContentsId);
  }

  /**
   * End the mirroring routes of a page, and only those: what a Cast session launched by the page does to them. It must
   * not call `terminateRoutesOfPage`, which would end the session that was just launched.
   */
  stopMirroringRoutesOfTab(webContentsId: number): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.activity.webContentsId === webContentsId) entry.activity.stopMirroring();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) entry.activity.stopMirroring();
    this.entries.clear();
    this.listeners.clear();
  }

  private mediaSourceFor(options: StartMirroringOptions): string {
    if (options.castMode === "tab_mirror") {
      if (!Number.isInteger(options.webContentsId)) throw new TypeError("tab_mirror needs webContentsId");
      return tabMediaSource(options.webContentsId!);
    }
    if (options.castMode === "desktop_mirror") {
      if (typeof options.desktopSourceId !== "string" || options.desktopSourceId === "") throw new TypeError("desktop_mirror needs desktopSourceId");
      return desktopMediaSource(options.desktopSourceId, options.withAudio === true);
    }
    throw new TypeError(`unknown castMode ${String(options.castMode)}`);
  }

  private routeOf(routeId: string, type: MirroringType, activity: MirroringActivity): MirroringRoute {
    return {
      id: routeId,
      mediaSource: activity.source.id,
      sinkId: activity.sink.id,
      description: activity.description,
      castMode: type === "tab" ? "tab_mirror" : "desktop_mirror",
      appId: activity.app?.appId ?? activity.source.appInfos[0]!.appId,
      displayName: activity.app?.displayName ?? "",
      sessionId: activity.app?.sessionId ?? "",
      isConnecting: activity.state === "launching",
      ...(activity.webContentsId !== undefined ? { webContentsId: activity.webContentsId } : {}),
      freezeInfo: { canFreeze: activity.canFreeze, isFrozen: activity.isFrozen },
    };
  }
}
