/**
 * One mirroring route, ported from Chromium `chrome/browser/media/router/providers/cast/mirroring_activity.cc`
 * (`MirroringActivity`) and the launch path of `cast_activity_manager.cc` (`DoLaunchSession`,
 * `HandleLaunchSessionResponse`, `OnActivityStopped` -> `TerminateSession`).
 *
 * The boundaries are Chrome's so that the engine behind them can be replaced by the real Mirroring Service:
 *   MirroringActivity  <->  CastMessageChannel  <->  MirroringService
 * `MirroringService` is `mirroring::mojom::MirroringServiceHost`'s `Start` plus the channel it is handed; here it is
 * whatever {@link MirroringServiceFactory} returns (the library's engine, in a utility process or in-process).
 */
import type { CastDevice } from "../discovery/index.ts";
import type { ReceiverApplication, ReceiverStatus } from "../client/index.ts";
import { CAST_REMOTING_NAMESPACE, CAST_WEBRTC_NAMESPACE } from "./protocol/constants.ts";
import { chooseAppId, mirroringNamespace, routeDescription, scrubbedLogMessage, sessionTypeFor, type MirroringSource } from "./routing.ts";
import type { MirroringError, SessionParameters } from "./session-host.ts";
import type { MirroringStats } from "./stats/statistics.ts";

/** The slice of a Cast client the activity uses (a subset of the session service's `CastClientLike`). */
export interface MirroringClient {
  /** The id the client puts in the source of every message it sends (`CastMessageHandler::source_id`). */
  readonly senderId: string;
  connect(): Promise<void>;
  close(): void;
  send(namespace: string, destinationId: string, payload: string): void;
  launch(appId: string): Promise<ReceiverApplication>;
  stop(sessionId: string): Promise<ReceiverStatus>;
  connectTransport(transportId: string): void;
  closeTransport(transportId: string): void;
  on(event: "message", listener: (msg: { namespace: string; sourceId: string; destinationId: string; data: string | Buffer }) => void): unknown;
  on(event: "receiverStatus", listener: (status: ReceiverStatus) => void): unknown;
  on(event: "close", listener: (error?: Error) => void): unknown;
}

/**
 * `ShouldForceLetterboxing` (mirroring_activity.cc): a Nest Hub is always sent letterboxed video, whatever its ANSWER
 * says about scaling, unless the app was started with `--disable-cast-letterboxing`. Chrome marks it for removal
 * (crbug.com/41363512).
 */
export function shouldForceLetterboxing(modelName: string, commandLine?: { hasSwitch(name: string): boolean }): boolean {
  if (commandLine?.hasSwitch("disable-cast-letterboxing") === true) return false;
  return modelName.includes("Nest Hub");
}

/** `mirroring::mojom::SessionObserver`. */
export interface MirroringSessionObserver {
  didStart?(): void;
  didStop?(): void;
  onError?(error: MirroringError, message: string): void;
  logInfo?(message: string): void;
}

/** `mirroring::mojom::CastMessageChannel`: the service sends app messages to the receiver through this. */
export interface CastMessageChannel {
  send(namespace: string, jsonFormatData: string): void;
}

/** The running service as the activity sees it (`MirroringServiceHost` plus its inbound `CastMessageChannel`). */
export interface MirroringService {
  /** `CastMessageChannel::OnMessage`: a receiver message for the service. */
  onMessage(namespace: string, jsonFormatData: string): void;
  /** Stops capture and streaming; the service never calls `didStop` for a stop the activity asked for. */
  stop(): void;
  /**
   * `CastMirroringServiceHost::SwitchMirroringSourceTab` then `MirroringService::SwitchMirroringSourceTab`: capture
   * continues from another tab in the same session. Throws when the tab cannot be captured. A service without it
   * cannot switch.
   */
  switchMirroringSourceTab?(webContentsId: number): void;
  /**
   * `CastMirroringServiceHost::Pause` / `Resume`: stop and restart the video capture device. The callback runs once the
   * request has been made (Chrome posts it to the IO thread and runs it right after). A service without them
   * cannot freeze.
   */
  pause?(onPaused: () => void): void;
  resume?(onResumed: () => void): void;
  /** `MirroringServiceHost::GetMirroringStats`: the latest statistics; undefined when the service cannot say. */
  getMirroringStats?(): Promise<MirroringStats | undefined>;
}

/** `kRtcpReportInterval`: how often the activity fetches the statistics, the interval at which the receiver reports. */
export const RTCP_REPORT_INTERVAL_MS = 500;

/** `MirroringServiceHost::Start`. */
export type MirroringServiceFactory = (
  params: SessionParameters,
  observer: MirroringSessionObserver,
  channel: CastMessageChannel,
  source: MirroringSource,
) => MirroringService;

export interface MirroringActivityOptions {
  sink: CastDevice;
  source: MirroringSource;
  client: MirroringClient;
  createService: MirroringServiceFactory;
  /** `on_stop_`: called once when the activity ends for any reason. The owner removes it. */
  onStop(): void;
  /** A change of route state (description, launching to mirroring, freezing). */
  onChange(): void;
  /** For a tab route: `webContents.id` of the page being mirrored (`frame_tree_node_id_`). */
  webContentsId?: number;
  /**
   * `source_changed_callback_`: the route now mirrors another tab (`DidGetTabSourceId`). The owner keeps one route per
   * tab (`CastActivityManager::OnSourceChanged`).
   */
  onSourceChanged?(oldWebContentsId: number, webContentsId: number): void;
  /** `kPauseDelay` of `MirroringMediaControllerHostImpl`, for tests. */
  freezeDelayMs?: number;
  /** The app's command line, where `--disable-cast-letterboxing` is looked for. */
  commandLine?: { hasSwitch(name: string): boolean };
  log?(level: "info" | "error", message: string): void;
  /**
   * `MediaRouterDebugger::ShouldFetchMirroringStats`, asked when the session starts: whether the receiver's RTCP event
   * log is collected and analyzed, and the statistics fetched every 500 ms.
   */
  shouldFetchMirroringStats?(): boolean;
  /** `MediaRouterDebugger::OnMirroringStats`: each set of statistics fetched. */
  onMirroringStats?(stats: MirroringStats): void;
  /** Timers for the fetch loop; default `setTimeout`. */
  setTimeout?(cb: () => void, ms: number): () => void;
}

export type MirroringActivityState = "launching" | "mirroring" | "stopped";

/** `kPauseDelay` (mirroring_media_controller_host_impl.cc): a second request within it is ignored. */
export const FREEZE_DELAY_MS = 500;

export class MirroringActivity {
  readonly sink: CastDevice;
  readonly source: MirroringSource;
  readonly sourceId: string;
  /** The Cast session; present once the launch is answered (`CastActivity::session_id`). */
  app: ReceiverApplication | undefined;
  state: MirroringActivityState = "launching";
  private readonly client: MirroringClient;
  private readonly createService: MirroringServiceFactory;
  private readonly onStop: () => void;
  private readonly onChange: () => void;
  private readonly commandLine: { hasSwitch(name: string): boolean } | undefined;
  private readonly log: (level: "info" | "error", message: string) => void;
  private readonly shouldFetchMirroringStats: () => boolean;
  private readonly onMirroringStats: ((stats: MirroringStats) => void) | undefined;
  private readonly setTimer: (cb: () => void, ms: number) => () => void;
  private service: MirroringService | undefined;
  private stopping = false;
  private tabId: number | undefined;
  private readonly onSourceChanged: ((oldId: number, newId: number) => void) | undefined;
  private readonly freezeDelayMs: number;
  private freezeTimer: ReturnType<typeof setTimeout> | undefined;
  /** `media_status_->can_play_pause` and `play_state == PAUSED`, as `MirroringMediaControllerHostImpl` reads them. */
  private mirroringStarted = false;
  private paused = false;
  private fetchStatsOnStart = false;
  private cancelFetch: (() => void) | undefined;
  /** `most_recent_mirroring_stats_`. */
  mostRecentMirroringStats: MirroringStats | undefined;

  constructor(options: MirroringActivityOptions) {
    this.sink = options.sink;
    this.source = options.source;
    this.client = options.client;
    this.createService = options.createService;
    this.onStop = options.onStop;
    this.onChange = options.onChange;
    this.tabId = options.webContentsId;
    this.onSourceChanged = options.onSourceChanged;
    this.freezeDelayMs = options.freezeDelayMs ?? FREEZE_DELAY_MS;
    this.commandLine = options.commandLine;
    // One id for what is sent and what is accepted, as in Chrome: both are `message_handler_->source_id()`. A receiver
    // addresses its replies to the source id of the message it answers, so a second id would drop every ANSWER.
    this.sourceId = options.client.senderId;
    this.log = options.log ?? (() => {});
    this.shouldFetchMirroringStats = options.shouldFetchMirroringStats ?? (() => false);
    this.onMirroringStats = options.onMirroringStats;
    this.setTimer =
      options.setTimeout ??
      ((cb, ms) => {
        const t = setTimeout(cb, ms);
        t.unref();
        return () => clearTimeout(t);
      });
    this.client.on("message", (msg) => this.onAppMessage(msg));
    this.client.on("receiverStatus", (status) => this.onReceiverStatus(status));
    this.client.on("close", () => this.stopMirroring());
  }

  /** `MirroringActivity::frame_tree_node_id`: the page a tab route mirrors now. */
  get webContentsId(): number | undefined {
    return this.tabId;
  }

  /** `MirroringMediaControllerHost::CanFreeze`: the service can pause capture and a mirroring offer has been made. */
  get canFreeze(): boolean {
    return this.state === "mirroring" && this.mirroringStarted && this.service?.pause !== undefined;
  }

  /** `MirroringMediaControllerHost::IsFrozen`. */
  get isFrozen(): boolean {
    return this.canFreeze && this.paused;
  }

  /** `GetRouteDescription` for a mirroring route. */
  get description(): string {
    return routeDescription(this.source.type);
  }

  /**
   * `DoLaunchSession` then `OnSessionSet` then `StartSession`: launch the streaming app the sink can run, open the
   * virtual connection to its transport, and start the service with the session type the sink and source allow.
   */
  async start(): Promise<void> {
    const appId = chooseAppId(this.source, this.sink.capabilities);
    this.log("info", "Sent a Launch Session request.");
    await this.client.connect();
    let app: ReceiverApplication;
    try {
      app = await this.client.launch(appId);
    } catch (err) {
      this.stopMirroring();
      throw err;
    }
    if (this.state === "stopped") {
      // Terminated while the launch was in flight: stop what it started.
      void this.client.stop(app.sessionId).catch(() => {});
      throw new Error("mirroring was cancelled");
    }
    this.app = app;
    this.client.connectTransport(app.transportId);
    this.startSession(app.transportId);
    this.state = "mirroring";
    this.onChange();
  }

  /** `MirroringActivity::StartSession`. */
  private startSession(destinationId: string): void {
    const sessionType = sessionTypeFor(this.source, this.sink.capabilities);
    if (sessionType === undefined) {
      // Neither audio nor video: nothing to mirror.
      this.stopMirroring();
      return;
    }
    this.fetchStatsOnStart = this.shouldFetchMirroringStats();
    const observer: MirroringSessionObserver = {
      didStart: () => {
        this.log("info", "mirroring started");
        // `OnRemotingStateChanged(false)` at the end of `NegotiateMirroring` sets `can_play_pause`; the session reports
        // it here once its first offer is answered, as capture exists only from then on.
        if (!this.mirroringStarted) {
          this.mirroringStarted = true;
          this.onChange();
        }
        if (this.fetchStatsOnStart) this.scheduleFetchMirroringStats();
      },
      didStop: () => this.stopMirroring(),
      onError: (error, message) => {
        this.log("error", `Mirroring will stop. MirroringService.SessionError: ${error}: ${message}`);
        this.stopMirroring();
      },
      logInfo: (message) => this.log("info", message),
    };
    const channel: CastMessageChannel = { send: (namespace, json) => this.onServiceMessage(namespace, json) };
    const params: SessionParameters = {
      type: sessionType,
      receiverAddress: this.sink.addresses[0] ?? this.sink.host,
      sourceId: this.sourceId,
      destinationId,
      targetPlayoutDelayMs: this.source.targetPlayoutDelayMs,
      enableRtcpReporting: this.fetchStatsOnStart,
      forceLetterboxing: shouldForceLetterboxing(this.sink.model, this.commandLine),
    };
    this.service = this.createService(params, observer, channel, this.source);
  }

  /**
   * `CastMirroringServiceHost::SwitchMirroringSourceTab` and then, when the service has reported the change,
   * `MirroringActivity::DidGetTabSourceId`: capture moves to another page without ending the session. The route keeps
   * its id and media source, as in Chrome; what changes is the page it is bound to. A tab that is already the source
   * is a no-op here (Chrome restarts the capture for it and then ignores the unchanged id).
   */
  switchMirroringSourceTab(webContentsId: number): void {
    if (this.state !== "mirroring" || this.service === undefined) throw new Error("the route is not mirroring");
    if (this.source.type !== "tab" || this.tabId === undefined) throw new Error("only a tab route can switch its source tab");
    if (this.service.switchMirroringSourceTab === undefined) throw new Error("the mirroring service cannot switch tabs");
    if (webContentsId === this.tabId) return;
    this.service.switchMirroringSourceTab(webContentsId);
    const old = this.tabId;
    this.tabId = webContentsId;
    // A new capturer is sending frames: the state is PLAYING again (`DidGetTabSourceId`).
    this.paused = false;
    this.onSourceChanged?.(old, webContentsId);
    // The owner may have ended this route meanwhile.
    if ((this.state as MirroringActivityState) !== "stopped") this.onChange();
  }

  /**
   * `MirroringMediaControllerHostImpl::Freeze`: pause the stream on its last frame after `kPauseDelay`; a request made
   * while one is pending is ignored.
   */
  freeze(): void {
    if (this.freezeTimer !== undefined) return;
    this.freezeTimer = setTimeout(() => {
      this.freezeTimer = undefined;
      this.pause();
    }, this.freezeDelayMs);
    this.freezeTimer.unref?.();
  }

  /** `MirroringMediaControllerHostImpl::Unfreeze` (`MediaController::Play`): at once, no delay. */
  unfreeze(): void {
    this.resume();
  }

  /** `MirroringActivity::Pause`. */
  private pause(): void {
    const service = this.service;
    // Before capture exists there is no video capture host, and Chrome's request does nothing.
    if (!this.canFreeze || service?.pause === undefined) return;
    service.pause(() => this.setPaused(true));
  }

  /** `MirroringActivity::Play`. */
  private resume(): void {
    const service = this.service;
    if (!this.canFreeze || service?.resume === undefined) return;
    service.resume(() => this.setPaused(false));
  }

  /** `SetPlayState`. */
  private setPaused(paused: boolean): void {
    if (this.state === "stopped") return;
    this.paused = paused;
    this.onChange();
  }

  /** `ScheduleFetchMirroringStats`. */
  private scheduleFetchMirroringStats(): void {
    this.cancelFetch?.();
    this.cancelFetch = this.setTimer(() => this.fetchMirroringStats(), RTCP_REPORT_INTERVAL_MS);
  }

  /** `FetchMirroringStats`: ask the service, and schedule the next fetch without waiting for the answer. */
  private fetchMirroringStats(): void {
    const service = this.service;
    if (!this.fetchStatsOnStart || service === undefined || this.state === "stopped") return;
    void service.getMirroringStats?.().then(
      (stats) => {
        if (stats !== undefined && this.state !== "stopped") this.onStats(stats);
      },
      () => {},
    );
    this.scheduleFetchMirroringStats();
  }

  /** `OnMirroringStats`. */
  private onStats(stats: MirroringStats): void {
    this.mostRecentMirroringStats = stats;
    try {
      this.onMirroringStats?.(stats);
    } catch (err) {
      this.log("error", `a mirroring stats observer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** `HandleParseJsonResult`: a message from the service goes to the receiver, in the namespace its type implies. */
  private onServiceMessage(_namespace: string, json: string): void {
    const app = this.app;
    if (app === undefined || this.state === "stopped") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      this.log("error", `Failed to parse Cast client message:${(e as Error).message}`);
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.log("error", "Failed to parse Cast client message: Not a dictionary");
      return;
    }
    const dict = parsed as Record<string, unknown>;
    const namespace = mirroringNamespace(dict);
    if (namespace === CAST_WEBRTC_NAMESPACE) this.log("info", `WebRTC message received: ${scrubbedLogMessage(dict)}`);
    try {
      this.client.send(namespace, app.transportId, json);
    } catch (err) {
      this.log("error", `Failed to send Cast message in namespace: ${namespace}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * `MirroringActivity::OnAppMessage`: only the webrtc and remoting namespaces. Its source and destination checks are
   * the one deliberate difference: Chromium compares `message.destination_id()` with the session's destination id and
   * `message.source_id()` with the sender's own id (mirroring_activity.cc), the opposite of what a message from the
   * receiver carries. `AppActivity::OnAppMessage` (app_activity.cc) and its unit tests `OnAppMessage` and
   * `OnAppMessageAllClients` (app_activity_unittest.cc) treat `destination_id` as the sending client's id, or `*`
   * for all clients, so here the transport must be the source and this sender (or `*`) the destination. Messages that
   * fail the check are dropped with a log line, as Chrome's DVLOG(2) does.
   */
  private onAppMessage(msg: { namespace: string; sourceId: string; destinationId: string; data: string | Buffer }): void {
    const app = this.app;
    if (app === undefined || this.service === undefined || this.state === "stopped") return;
    if (msg.namespace !== CAST_WEBRTC_NAMESPACE && msg.namespace !== CAST_REMOTING_NAMESPACE) return;
    if (msg.sourceId !== app.transportId) {
      this.log("info", `Ignoring message unexpectedly sent by source_id "${msg.sourceId}" (expected "${app.transportId}")`);
      return;
    }
    if (msg.destinationId !== this.sourceId && msg.destinationId !== "*") {
      this.log("info", `Ignoring message intended for destination_id "${msg.destinationId}" (expected "${this.sourceId}")`);
      return;
    }
    if (typeof msg.data !== "string") {
      this.log("info", "Ignoring a binary app message");
      return;
    }
    if (msg.namespace === CAST_WEBRTC_NAMESPACE) this.log("info", `Relaying app message from receiver: ${msg.data.length > 0 ? scrubbedMessageText(msg.data) : ""}`);
    this.service.onMessage(msg.namespace, msg.data);
  }

  /** The receiver ended the app (the TV's own stop, another sender launching): the route ends. */
  private onReceiverStatus(status: ReceiverStatus): void {
    const app = this.app;
    if (app === undefined || this.state === "stopped") return;
    if (!status.applications.some((a) => a.sessionId === app.sessionId)) this.stopMirroring();
  }

  /**
   * `StopMirroring`: `on_stop_` runs once and the owner deletes the activity. `CastActivityManager::OnActivityStopped`
   * is `TerminateSession`, which stops the receiver's app, so the receiver goes back to its idle screen.
   */
  stopMirroring(): void {
    if (this.stopping) return;
    this.stopping = true;
    this.state = "stopped";
    if (this.freezeTimer !== undefined) clearTimeout(this.freezeTimer);
    this.freezeTimer = undefined;
    this.cancelFetch?.();
    this.cancelFetch = undefined;
    try {
      this.service?.stop();
    } catch (err) {
      this.log("error", `stopping the mirroring service failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.service = undefined;
    const app = this.app;
    if (app !== undefined) {
      try {
        this.client.closeTransport(app.transportId);
      } catch {
        // the connection may already be gone
      }
      void this.client.stop(app.sessionId).catch(() => {}).finally(() => this.client.close());
    } else {
      this.client.close();
    }
    this.onStop();
  }
}

function scrubbedMessageText(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return scrubbedLogMessage(parsed as Record<string, unknown>);
  } catch {
    // log it as received
  }
  return text;
}
