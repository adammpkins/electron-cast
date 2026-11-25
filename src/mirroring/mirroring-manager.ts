/**
 * Starts, lists and stops mirroring routes: the part of Chromium's `CastActivityManager` that handles mirroring
 * (`LaunchSession` with a streaming source, `TerminateSession`, `OnActivityStopped`, `NotifyAllOnRoutesUpdated`).
 * One activity per sink: a new route on a sink first ends the one already there (`pending_activity_removal_` in
 * `CastActivityManager::LaunchSession`).
 */
import { randomUUID } from "node:crypto";
import type { CastDevice } from "../discovery/index.ts";
import { MirroringActivity, type MirroringClient, type MirroringServiceFactory } from "./mirroring-activity.ts";
import type { MirroringStats } from "./stats/statistics.ts";
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
  log?(level: "info" | "error", message: string): void;
}

interface Entry {
  route: MirroringRoute;
  activity: MirroringActivity;
  stats: MirroringStats | undefined;
}

/** `MediaRouterDebugger::MirroringStatsObserver::OnMirroringStatsUpdated`, with the route the statistics are of. */
export type MirroringStatsListener = (routeId: string, stats: MirroringStats) => void;

/** `MediaRoute::kRouteIdPrefix`. */
const ROUTE_ID_PREFIX = "urn:x-org.chromium:media:route:";

export class MirroringManager {
  private readonly options: MirroringManagerOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private readonly statsListeners = new Set<MirroringStatsListener>();
  /** `MediaRouterDebugger` state: whether sessions that start next fetch their statistics. Off by default, as in Chrome. */
  private fetchMirroringStats = false;
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
    const presentationId = `mr_${randomUUID()}`;
    const routeId = `${ROUTE_ID_PREFIX}${presentationId}/${sinkId}/${mediaSourceId}`;
    const log = (level: "info" | "error", message: string): void => this.options.log?.(level, `[${sinkId}] ${message}`);
    const entry = { stats: undefined } as unknown as Entry;
    const client = this.options.createClient(device);
    const activity = new MirroringActivity({
      sink: device,
      source,
      client,
      createService: this.options.createService,
      log,
      shouldFetchMirroringStats: () => this.fetchMirroringStats,
      onMirroringStats: (stats) => {
        if (this.entries.get(routeId) !== entry) return;
        entry.stats = stats;
        for (const l of [...this.statsListeners]) {
          try {
            l(routeId, structuredClone(stats));
          } catch (err) {
            this.options.log?.("error", `a mirroring stats observer failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      },
      onStop: () => {
        if (this.entries.get(routeId) === entry) {
          this.entries.delete(routeId);
          this.notify();
        }
      },
      onChange: () => {
        if (this.entries.get(routeId) !== entry) return;
        entry.route = this.routeOf(routeId, source.type, options, activity);
        this.notify();
      },
    });
    entry.activity = activity;
    entry.route = this.routeOf(routeId, source.type, options, activity);
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

  /** `MediaRouterDebugger::EnableRtcpReports` / `DisableRtcpReports`: applies to sessions that start afterwards. */
  setMirroringStatsEnabled(enabled: boolean): void {
    this.fetchMirroringStats = enabled;
  }

  /** `MediaRouterDebugger::ShouldFetchMirroringStats`. */
  isMirroringStatsEnabled(): boolean {
    return this.fetchMirroringStats;
  }

  /**
   * `MediaRouterDebugger::GetMirroringStats`: the latest statistics of the route (Chrome keeps the most recent push of
   * any session; here each route has its own). Empty before the first fetch or when statistics were off at the start.
   */
  getMirroringStats(routeId: string): MirroringStats {
    return structuredClone(this.entries.get(routeId)?.stats ?? {});
  }

  /** `MediaRouterDebugger::AddObserver`. Returns the remove function. */
  observeMirroringStats(listener: MirroringStatsListener): () => void {
    this.statsListeners.add(listener);
    return () => void this.statsListeners.delete(listener);
  }

  /** `CastActivityManager::TerminateSession`: stops the receiver's app and the capture. */
  terminate(routeId: string): boolean {
    const entry = this.entries.get(routeId);
    if (entry === undefined) return false;
    entry.activity.stopMirroring();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) entry.activity.stopMirroring();
    this.entries.clear();
    this.listeners.clear();
    this.statsListeners.clear();
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

  private routeOf(routeId: string, type: MirroringType, options: StartMirroringOptions, activity: MirroringActivity): MirroringRoute {
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
      ...(options.webContentsId !== undefined && type === "tab" ? { webContentsId: options.webContentsId } : {}),
    };
  }
}
