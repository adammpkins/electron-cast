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
import { classifyLaunchFailure, type RouterIssues } from "../electron/issues.ts";
import { desktopMediaSource, mirroringSourceFor, sinkSupportsSource, tabMediaSource, type MirroringSource, type MirroringType } from "./routing.ts";

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
  /** `MediaRoute::presentation_id`: what the route id carries after the prefix. */
  presentationId: string;
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
  /**
   * `SwitchToFlingingIfPossible` (components/media_router/browser/mirroring_to_flinging_switcher.cc): called for the page a
   * route now mirrors after its source tab switched (`MirroringActivity::DidGetTabSourceId` posts it). It runs in a later
   * task, as Chrome's `PostTask` does.
   */
  switchToFlingingIfPossible?(webContentsId: number): void;
  /** The app's command line (`app.commandLine`), for Chrome's `--disable-cast-letterboxing`. */
  commandLine?: { hasSwitch(name: string): boolean };
  log?(level: "info" | "error", message: string): void;
  /** Where Chrome raises its issues for a mirroring route (`CastActivityManager`, `MediaRouterUI`); none without it. */
  issues?: RouterIssues;
  /**
   * `GetCastMirroringPlayoutDelay`: the `--cast-mirroring-target-playout-delay` switch, used for a route that does not
   * ask for a delay of its own (`MirroringActivity::StartSession`).
   */
  defaultTargetPlayoutDelayMs?: number;
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
  /**
   * `MediaRouterDebuggerImpl::most_recent_mirroring_stats_`: Chrome keeps one copy, the latest push of any session, and it
   * outlives the session. Live routes keep their own here; this is the last copy of the route that ended most recently,
   * until another route pushes newer statistics.
   */
  private lastEnded: { routeId: string; stats: MirroringStats } | undefined;
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
    const mediaSourceId = this.mediaSourceFor(options);
    const source = mirroringSourceFor(mediaSourceId)!;
    if (options.targetPlayoutDelayMs !== undefined) source.targetPlayoutDelayMs = options.targetPlayoutDelayMs;
    return this.launchRoute(sinkId, source, options.webContentsId, { castMode: options.castMode, withAudio: options.withAudio === true });
  }

  /**
   * `CastActivityManager::DoLaunchSession` for a source a page supplied (a Cast Streaming URL of the Presentation API,
   * `IsSiteInitiatedMirroringSource`): the activity mirrors the page's own tab and the route's source stays the URL.
   * Whether the page's origin may do this is the caller's check (`kPresentationApiAllowlist`). No dialog is involved, so
   * `MediaRouterUI`'s issues (route timeout, user declined, desktop audio) are not raised; the provider's are.
   */
  async startSiteInitiatedMirroring(sinkId: string, source: MirroringSource): Promise<MirroringRoute> {
    if (this.disposed) throw new MirroringRouteError("cancelled", "the manager is disposed");
    if (source.type !== "tab" || source.tabId === undefined) throw new TypeError("a site-initiated source mirrors a tab");
    return this.launchRoute(sinkId, source, source.tabId);
  }

  /** `ui` is set when the route was requested from the dialog (`MediaRouterUI::CreateRoute`), as the app's own UI does. */
  private async launchRoute(sinkId: string, source: MirroringSource, tabId: number | undefined, ui?: { castMode: MirroringCastMode; withAudio: boolean }): Promise<MirroringRoute> {
    const options = { webContentsId: tabId };
    const mediaSourceId = source.id;
    const issues = this.options.issues;
    const device = this.options.findDevice(sinkId);
    if (device === undefined) throw new MirroringRouteError("sink_not_found", `no sink ${sinkId}`);
    // `MirroringActivity::StartSession`: the URL's `target_playout_delay()` wins; only without one does the feature or
    // command line (`GetCastMirroringPlayoutDelay`) apply
    if (source.targetPlayoutDelayMs === undefined && this.options.defaultTargetPlayoutDelayMs !== undefined) {
      source.targetPlayoutDelayMs = this.options.defaultTargetPlayoutDelayMs;
    }
    // A sink is offered for a source only when it can run one of its apps (the sinks query of `CastMediaSource`).
    if (!sinkSupportsSource(source, device.capabilities)) {
      throw new MirroringRouteError("unable_to_cast", `${device.name} cannot receive this mirroring source`);
    }
    // `MediaRouterUI::CreateRoute`, once the route can be made: the dialog's earlier issues go.
    if (ui !== undefined) issues?.routeRequested();
    for (const entry of [...this.entries.values()]) {
      if (entry.route.sinkId === sinkId) entry.activity.stopMirroring();
    }
    // `CastActivityManager::DoLaunchSession`: "If there is a route from this frame already, stop it."
    if (source.type === "tab") this.terminateRoutesOfTab(options.webContentsId!);
    const presentationId = `mr_${randomUUID()}`;
    const routeId = `${ROUTE_ID_PREFIX}${presentationId}/${sinkId}/${mediaSourceId}`;
    // `CastActivityManager::LaunchSession` -> `MaybeShowIssueAtLaunch`
    if (ui !== undefined) issues?.desktopAudioNotSupportedAtLaunch(ui.castMode, ui.withAudio, sinkId);
    const launched: { failure?: ReturnType<typeof classifyLaunchFailure> } = {};
    const log = (level: "info" | "error", message: string): void => this.options.log?.(level, `[${sinkId}] ${message}`);
    const entry = { stats: undefined } as unknown as Entry;
    const client = this.options.createClient(device);
    const activity = new MirroringActivity({
      sink: device,
      source,
      webContentsId: source.type === "tab" ? options.webContentsId : undefined,
      client,
      createService: this.options.createService,
      commandLine: this.options.commandLine,
      log,
      ...(issues === undefined ? {} : {
        onLaunchStatus: (status) => {
          if (status === "pending_authorization") issues.pendingUserAuth({ id: sinkId, name: device.name });
          else issues.userAllowed(sinkId);
        },
        onLaunchFailed: (err) => {
          // the provider's issue first (HandleLaunchSessionResponseFailures), then the dialog's (OnRouteResponseReceived)
          const launchFailure = (launched.failure = classifyLaunchFailure(err));
          issues.launchFailed(launchFailure, sinkId, routeId, err instanceof Error ? err.message : String(err));
          if (ui === undefined) return;
          if (launchFailure === "timed_out") issues.uiRouteTimeout(ui.castMode, sinkId, "");
          else if (launchFailure === "user_not_allowed") issues.uiUserNotAllowed({ id: sinkId, name: device.name });
          else if (launchFailure === "notification_disabled") issues.uiNotificationDisabled({ id: sinkId, name: device.name });
        },
      }),
      shouldFetchMirroringStats: () => this.fetchMirroringStats,
      onMirroringStats: (stats) => {
        if (this.entries.get(routeId) !== entry) return;
        // `NotifyGetMirroringStats`: dropped while statistics are off, observers included.
        if (!this.fetchMirroringStats) return;
        entry.stats = stats;
        this.lastEnded = undefined;
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
          if (entry.stats !== undefined) this.lastEnded = { routeId, stats: entry.stats };
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
        // `DidGetTabSourceId`: once the source moved, the new page may have a default request to switch to
        const flinging = this.options.switchToFlingingIfPossible;
        if (flinging !== undefined) queueMicrotask(() => flinging(tab));
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
      if (err instanceof MirroringRouteError) throw err;
      // RouteRequestResultCode of a launch the receiver or the clock ended
      const f = launched.failure;
      const code = f === "timed_out" || f === "user_not_allowed" || f === "notification_disabled" ? f : "unknown_error";
      throw new MirroringRouteError(code, err instanceof Error ? err.message : String(err));
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
   * `MediaRouterDebuggerImpl::GetMirroringStats`: the latest statistics of the route (Chrome keeps the most recent push
   * of any session; here each route has its own). Never fails, as Chrome's has no error path: empty while statistics are
   * off, before the first fetch, when they were off at the start, and for a route id it does not know. A route that
   * ended keeps its last statistics, as Chrome's copy outlives the session, until another route pushes newer ones.
   */
  getMirroringStats(routeId: string): MirroringStats {
    if (!this.fetchMirroringStats) return {};
    const stats = this.entries.get(routeId)?.stats ?? (this.lastEnded?.routeId === routeId ? this.lastEnded.stats : undefined);
    return structuredClone(stats ?? {});
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
  stopMirroringRoutesOfTab(webContentsId: number): Promise<void> {
    const settled: Promise<void>[] = [];
    for (const entry of [...this.entries.values()]) {
      if (entry.activity.webContentsId !== webContentsId) continue;
      entry.activity.stopMirroring();
      settled.push(entry.activity.stopSettled);
    }
    return Promise.all(settled).then(() => {});
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of [...this.entries.values()]) entry.activity.stopMirroring();
    this.entries.clear();
    this.lastEnded = undefined;
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

  private routeOf(routeId: string, type: MirroringType, activity: MirroringActivity): MirroringRoute {
    return {
      id: routeId,
      mediaSource: activity.source.id,
      sinkId: activity.sink.id,
      presentationId: routeId.slice(ROUTE_ID_PREFIX.length).split("/")[0]!,
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
