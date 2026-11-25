// The main-process API of the cast manager, modelled on Chrome's Media Router (see docs/MAIN-API.md for the mapping):
// sinks (devices) and routes (sessions) are observed through observers, a route is terminated or detached, and
// volume goes through a route controller. It is kept apart from main.ts and session-service.ts, which only expose
// the narrow hooks used here.
import type { CastDevice } from "../discovery/index.ts";
import type { BridgeResult } from "../polyfill/bridge-types.ts";
import { APP_AVAILABILITY_REFRESH_MS, type DeviceSource } from "./session-service.ts";
import { parsePresentationUrl } from "./presentation-envelope.ts";
import { appNameFromDialSource, isDialSource } from "../dial/parse.ts";
import type { DefaultPresentationRequests, PresentationObserver, PresentationRequest } from "./default-presentation.ts";
import type { MirroringCastMode } from "../mirroring/mirroring-manager.ts";
import type { MirroringStats } from "../mirroring/stats/statistics.ts";
import { desktopMediaSource, mirroringSourceFor, sinkSupportsSource, tabMediaSource } from "../mirroring/routing.ts";

import type { IssuesObserver, RouterIssues } from "./issues.ts";
import type { LogEntry, LogObserver } from "./logger.ts";

export type { PresentationObserver, PresentationRequest } from "./default-presentation.ts";
export type { Issue, IssueInfo, IssueSeverity, IssuesObserver } from "./issues.ts";
export type { LogCategory, LogEntry, LogObserver, LogSeverity } from "./logger.ts";
import { castIconType, sortSinks } from "./sink-order.ts";
import { sinkSupportsApp } from "./cast-media-source.ts";
import { createMediaControllers, type MediaController, type MediaControllerHost, type MediaStatusObserver } from "./media-controller.ts";

/** Chrome's `SinkIconType` values that apply to Cast and DIAL devices (a DIAL sink is `generic`). */
export type SinkIconType = "cast" | "cast_audio" | "cast_audio_group" | "generic";

/** A device a route can be created on (Chrome: `media_router::MediaSink`). */
export interface MediaSink {
  id: string;
  /** Chrome: `MediaSink::provider_id`. A DIAL sink's id is `dial:<uuid>`. */
  providerId: "cast" | "dial";
  name: string;
  /** The device model. electron-cast's own: Chrome's MediaSink has none (the model is `CastSinkExtraData::model_name`). */
  description: string;
  iconType: SinkIconType;
  /** The discovered device behind the sink; a DIAL sink's has `dial` set. */
  device: CastDevice;
}

/** What a sinks observer wants sinks for (Chrome: the observer's `MediaSource`); omit it for every device. */
export interface MediaSinksQuery {
  /** Only sinks with all of these capabilities (`video_out`, `audio_out`, ...), like `requestSession`'s. */
  capabilities?: string[];
  /**
   * Only sinks that can run one of these presentation URLs (Chrome: a `MediaSinksObserver` per URL's `MediaSource`, as
   * the Cast dialog sets them from the page's default request). A Cast sink matches a Cast app URL whose app it said it
   * has; a DIAL sink matches a `cast-dial:` URL whose app its DIAL server said it has, and while the observer is
   * registered the DIAL sinks are asked about those apps (`DialMediaRouteProvider::StartObservingMediaSinks`). Other
   * URLs match no sink. Combines with `capabilities`.
   */
  presentationUrls?: string[];
  /**
   * The origin of the page the URLs are for (Chrome: the default request's `frame_origin`, which the dialog's observers
   * carry). A DIAL app that Chrome offers to some origins only (`DialMediaRouteProvider::GetOrigins`) matches only for
   * one of them; with no origin, only apps open to every origin match.
   */
  origin?: string;
  /**
   * Only sinks that can receive this kind of mirroring, as Chrome lists them for TAB_MIRROR and DESKTOP_MIRROR: a sink
   * is listed when it can run one of the streaming apps the source names (audio and video, or audio only).
   */
  castMode?: MirroringCastMode;
  /** With `castMode: "desktop_mirror"`: whether the capture includes audio (a screen without audio needs video_out). */
  withAudio?: boolean;
}

/** Chrome: `MediaCastMode`, the Cast dialog's modes: `PRESENTATION`, `TAB_MIRROR` and `DESKTOP_MIRROR`. */
export type MediaCastMode = "presentation" | MirroringCastMode;

/**
 * `startCasting` options, one shape per cast mode. `webContentsId` means different things: for `presentation` it is the
 * window whose default presentation request is cast; for `tab_mirror` it is the page that is mirrored.
 */
export type StartCastingOptions =
  | {
      /** Default. Cast the window's default presentation request (`MediaCastMode::PRESENTATION`). */
      castMode?: "presentation";
      /** The window whose default request is used. */
      webContentsId: number;
    }
  | StartMirroringCastingOptions;

/** The mirroring shapes of {@link StartCastingOptions}. */
export type StartMirroringCastingOptions =
  | {
      /** Mirror a page (`MediaCastMode::TAB_MIRROR`; `MediaSource::ForTab`). */
      castMode: "tab_mirror";
      /** The page to mirror. */
      webContentsId: number;
      /** `streamingTargetPlayoutDelayMillis`. */
      targetPlayoutDelayMs?: number;
    }
  | {
      /** Mirror a screen or window (`MediaCastMode::DESKTOP_MIRROR`). */
      castMode: "desktop_mirror";
      /** The `desktopCapturer` source id (`screen:0:0`, `window:...`), Chrome's desktop media id. */
      desktopSourceId: string;
      /** Also capture system audio where the OS allows it (`IsDesktopSourceWithAudio`). */
      withAudio?: boolean;
      /** `streamingTargetPlayoutDelayMillis`. */
      targetPlayoutDelayMs?: number;
    };

/** Chrome: `MediaSinksObserver`. */
export interface MediaSinksObserver {
  /** The full current list, on registration and then each time it changes. */
  onSinksUpdated(sinks: MediaSink[]): void;
}

/** A live session on a sink (Chrome: `media_router::MediaRoute`; a session is what Chrome's Cast provider routes to). */
export interface MediaRoute {
  /** The session id (Chrome: `media_route_id`); a DIAL route's is Chrome's `urn:x-org.chromium:media:route:...`. */
  id: string;
  /** Which provider routes it. Chrome: `MediaRoute::provider_id`. */
  providerId: "cast" | "dial";
  /** `cast:<appId>`, the Cast source URN's scheme and app id; `cast-dial:<app>?...` for DIAL (Chrome: `media_source`). */
  mediaSource: string;
  sinkId: string;
  /** The device's name (Chrome: `media_sink_name`, set with `set_media_sink_name`). */
  sinkName: string;
  /** The app's status text, else its name (Chrome: `description`). */
  description: string;
  /**
   * False for a session this service does not hold: one started elsewhere (a phone, say) or one every page here let go
   * of while the app kept running. Chrome: `is_local`, false for the routes `AddNonLocalActivity` makes. Joining one by
   * its id makes it local.
   */
  isLocal: boolean;
  // Fields below are electron-cast's: Chrome's route knows its page through the extension or the Presentation API.
  appId: string;
  displayName: string;
  /** Origin of the page that started the session; empty on a route that is not local. */
  origin: string;
  /** Receiver volume as last reported; `null` until the device reports one. */
  volume: { level: number | null; muted: boolean | null };
  /** `webContents.id` of every page currently attached. */
  members: number[];
  /** `webContents.id` of pages that navigated away and may rejoin; they get no events meanwhile. */
  parkedSenders: number[];
  /** True when no page is attached to a local route: the route lives on in the device only. Always false when `isLocal` is false. */
  parked: boolean;
  /**
   * Mirroring routes only (Chrome: `UIMediaSink::freeze_info`, from `MirroringMediaControllerHost::CanFreeze` and
   * `IsFrozen`): whether the route's video can be frozen on its last frame, and whether it is.
   */
  freezeInfo?: { canFreeze: boolean; isFrozen: boolean };
}

/** Chrome: `MediaRoutesObserver`. */
export interface MediaRoutesObserver {
  /** The full current list, on registration and then each time a route starts, ends or changes. */
  onRoutesUpdated(routes: MediaRoute[]): void;
}

/** The volume half of `media_router::mojom::MediaController` (`SetMute`, `SetVolume`); see {@link MediaController} for all of it. */
export interface MediaRouteController {
  setMute(muted: boolean): Promise<void>;
  /** 0 to 1. */
  setVolume(level: number): Promise<void>;
}

/** `mojom::CastSessionState` (`CastMediaRouteProvider::GetState`): one session a Cast sink runs. */
export interface CastSessionState {
  sinkId: string;
  appId: string;
  /** The Cast session id; for a mirroring route, which this library lists under its route id, that id. */
  sessionId: string;
  /** `CastSession::GetRouteDescription`. */
  routeDescription: string;
}

/** `mojom::CastProviderState`. */
export interface CastProviderState {
  sessionState: CastSessionState[];
}

/** What a failed route call rejects with; `code` is a bridge code or `"route_not_found"`. */
export class MediaRouteError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "MediaRouteError";
    this.code = code;
  }
}

/** The main-process API added to {@link CastManager}. Each method says which `MediaRouter` method it mirrors. */
export interface CastManagerApi {
  /** `MediaRouter::RegisterMediaSinksObserver`. Returns the unregister function. */
  registerMediaSinksObserver(observer: MediaSinksObserver, query?: MediaSinksQuery): () => void;
  /** `MediaRouter::RegisterMediaRoutesObserver`. Returns the unregister function. */
  registerMediaRoutesObserver(observer: MediaRoutesObserver): () => void;
  /**
   * `IssueManager::RegisterObserver`: told of the top issue (the oldest one still up) now, if there is one, and each time it
   * changes: `onIssue` for a new one, `onIssuesCleared` when none is left. Issues are per sink (`issue.info.sinkId`), and
   * go away by themselves after 1 minute (a notification) or 5 minutes (a warning). Returns the unregister function.
   */
  registerIssuesObserver(observer: IssuesObserver): () => void;
  /** `MediaRouterUI::ClearIssue` (`IssueManager::ClearIssue`): the app's UI dismisses an issue. A gone id does nothing. */
  clearIssue(issueId: number): void;
  /** `MediaRouter::ClearTopIssueForSink`: clears the top issue when it is about this sink. */
  clearTopIssueForSink(sinkId: string): void;
  /**
   * `LoggerImpl::GetLogsAsValue`, the log of `chrome://media-router-internals`: the last 1000 entries of discovery, route and
   * mirroring events (and `UI` ones), oldest first. A debugging aid; Chrome gives pages no access to it and neither does this library.
   */
  getLogs(): LogEntry[];
  /** `LoggerImpl::AddObserver`: told of each entry as it is written. Returns the remove function. */
  registerLogObserver(observer: LogObserver): () => void;
  /**
   * `CastMediaRouteProvider::GetState`, the "Cast" tab of `chrome://media-router-internals`: the session each Cast sink runs.
   * `null` when the media router is off (Chrome: no activity manager).
   */
  getCastProviderState(): CastProviderState | null;
  /** The current routes (what `MediaRoutesObserver` last got), parked ones included. */
  getRoutes(): MediaRoute[];
  /** `MediaRouter::TerminateRoute`: stops the receiver app; pages get `sessionEnded` as if the device had. */
  terminateRoute(routeId: string): Promise<void>;
  /** electron-cast's own (Chrome's Cast provider leaves `DetachRoute` unimplemented): every page lets go of the route and its transport closes; the app keeps running. */
  detachRoute(routeId: string): void;
  /**
   * `WebContentsPresentationManager::HasDefaultPresentationRequest` for the window with this `webContents.id`: has its
   * page set `navigator.presentation.defaultRequest`?
   */
  hasDefaultPresentationRequest(webContentsId: number): boolean;
  /**
   * `WebContentsPresentationManager::GetDefaultPresentationRequest`: the request, or `null` where Chrome has it an error
   * to ask without one. Only the window's main frame can have one.
   */
  getDefaultPresentationRequest(webContentsId: number): PresentationRequest | null;
  /**
   * `WebContentsPresentationManager::AddObserver`: told when the window's default request is set, replaced or cleared
   * (as `null`: the page set `defaultRequest` to null or no URLs, navigated, or the window was destroyed). Like Chrome's,
   * it is not called on registration; read the current request first. Returns the unregister function.
   */
  addPresentationObserver(webContentsId: number, observer: PresentationObserver): () => void;
  /**
   * `MediaRouterUI::StartCasting(sink_id, MediaCastMode::PRESENTATION)` on the window's default request:
   * `MediaRouter::CreateRoute`, then `WebContentsPresentationManager::OnPresentationResponse`, which hands the page a
   * `PresentationConnection` through `connectionavailable` on its default request. No user gesture: the app's own UI is
   * the gesture, as with Chrome's Cast dialog. Resolves with the new route; rejects with `MediaRouteError` carrying
   * Chrome's `RouteRequestResultCode` in lower case (`timed_out`, `sink_not_found`, `invalid_origin`, `cancelled`,
   * `redundant_request`, `unknown_error`), or `unable_to_cast` where Chrome's `CreateRouteParameters` finds no
   * source for the sink (no default request, or the sink cannot run its URLs).
   *
   * With `castMode: "tab_mirror"` or `"desktop_mirror"` it is `StartCasting` for `TAB_MIRROR` and `DESKTOP_MIRROR`:
   * mirror a page (`webContentsId`) or a `desktopCapturer` source (`desktopSourceId`) to the sink. Resolves with the
   * route once the receiver's streaming app runs; end it with `terminateRoute`. Needs the `mirroring` option of
   * `createCastManager`, else it rejects with `unable_to_cast`.
   */
  startCasting(sinkId: string, options: StartCastingOptions): Promise<MediaRoute>;
  /** `MediaRouter::GetMediaController` /`mojom::MediaController`: volume and mute go to the receiver, so pages see `sessionUpdated`. */
  getRouteController(routeId: string): MediaRouteController;
  /**
   * `MediaRouter::GetMediaController`: play, pause, seek, skip and volume on the route's media, and the media status as
   * `CastMediaController` reports it to the observer (now if the receiver volume is known, then on each change). Call
   * `close()` on the controller to stop the reports.
   */
  getMediaController(routeId: string, observer?: MediaStatusObserver): MediaController;
  /**
   * `CastMirroringServiceHost::SwitchMirroringSourceTab`, which Chrome runs from the "Share this tab instead" control
   * of its tab-sharing UI: a `tab_mirror` route carries on mirroring `webContentsId` in the same session, with the
   * same route id and no renegotiation. The new page is muted locally and the old one is unmuted (if the library
   * muted it); another mirroring route of the new page is terminated, since a page has one route
   * (`CastActivityManager::OnSourceChanged`). Throws `route_not_found`, or `unable_to_cast` for a desktop route, a
   * route that is still launching, or a page that cannot be captured. The route observers hear of the change.
   */
  switchMirroringSourceTab(routeId: string, webContentsId: number): void;
  /**
   * `MediaRouterUI::FreezeRoute`: pause a mirroring route's video on its last frame (the audio goes on). Takes effect
   * after 500 ms, and a second call within that time is ignored (`MirroringMediaControllerHostImpl::kPauseDelay`).
   * Does nothing while `freezeInfo.canFreeze` is false, or for a route that is not a mirroring route.
   */
  freezeRoute(routeId: string): void;
  /** `MediaRouterUI::UnfreezeRoute`: resume a frozen route at once. */
  unfreezeRoute(routeId: string): void;
  /**
   * Mirroring statistics, a debugging aid like Chrome's `chrome://media-router-internals` "Mirroring stats" (the
   * `MediaRouterDebugger`: `GetMirroringStats`, `EnableRtcpReports`, `ShouldFetchMirroringStats`, `AddObserver`).
   * Chrome gives pages no access to them and neither does this library. Off by default and read when a session
   * starts: call `setMirroringStatsEnabled(true)` before `startCasting`. Then the route's latest statistics are in
   * `getMirroringStats`, refreshed every 500 ms, with Chrome's names and units (`ENQUEUE_FPS`,
   * `AVG_NETWORK_LATENCY_MS`, `NETWORK_LATENCY_MS_HISTO`, ...) under `audio` and `video`. Chrome guarantees no
   * structure: it is for logs. Never throws (Chrome's `MediaRouterDebuggerImpl::GetMirroringStats` has no error path):
   * `{}` while statistics are off, before the first fetch and for an unknown route; a route that ended keeps its last
   * statistics, as Chrome's copy outlives the session, until another route pushes newer ones.
   */
  getMirroringStats(routeId: string): MirroringStats;
  /** `MediaRouterDebugger::EnableRtcpReports` / `DisableRtcpReports`: applies to sessions that start afterwards. */
  setMirroringStatsEnabled(enabled: boolean): void;
  /** `MediaRouterDebugger::ShouldFetchMirroringStats`. */
  isMirroringStatsEnabled(): boolean;
  /** `MediaRouterDebugger::AddObserver` (`OnMirroringStatsUpdated`), with the route id. Returns the remove function. */
  registerMirroringStatsObserver(observer: (routeId: string, stats: MirroringStats) => void): () => void;
}

/**
 * Third argument of `selectDevice`. Like Chrome's dialog, which registers a sinks observer while it is open, the
 * picker hears of sinks that appear (mDNS often takes seconds) until it answers. Old two-argument pickers ignore it.
 */
export interface DevicePickerContext {
  /** Aborted when the request no longer waits for a choice (answered, cancelled, page gone, manager disposed). */
  readonly signal: AbortSignal;
  /**
   * Like `CastManagerApi.registerMediaSinksObserver`, restricted to the devices that can serve this request. The
   * observer is also dropped when `signal` aborts.
   */
  registerMediaSinksObserver(observer: MediaSinksObserver): () => void;
}

/** What the session service exposes to the API (a narrow slice of it). */
export interface SessionHost extends Omit<MediaControllerHost, "hasRoute"> {
  mediaRoutes(): MediaRoute[];
  observeSessions(listener: () => void): () => void;
  terminateSession(sessionId: string): Promise<BridgeResult>;
  detachSession(sessionId: string): BridgeResult;
  /** Mirroring routes; present when the manager was given the `mirroring` option. */
  startCasting?(sinkId: string, options: StartMirroringCastingOptions): Promise<MediaRoute>;
  switchMirroringSourceTab?(routeId: string, webContentsId: number): void;
  /** False when the route is not a mirroring route. */
  freezeRoute?(routeId: string): boolean;
  unfreezeRoute?(routeId: string): boolean;
  /** Mirroring statistics (see `CastManagerApi.getMirroringStats`); present with `startCasting`. */
  mirroringStats?: {
    get(routeId: string): MirroringStats;
    setEnabled(enabled: boolean): void;
    isEnabled(): boolean;
    observe(observer: (routeId: string, stats: MirroringStats) => void): () => void;
  };
}

/** A Map that reports new and removed keys, so the service needs no per-site notification. */
export class ObservedMap<K, V> extends Map<K, V> {
  private readonly notify: (kind: "started" | "ended", value: V) => void;
  constructor(notify: (kind: "started" | "ended", value: V) => void) {
    super();
    this.notify = notify;
  }
  override set(key: K, value: V): this {
    const isNew = !this.has(key);
    super.set(key, value);
    if (isNew) this.notify("started", value);
    return this;
  }
  override delete(key: K): boolean {
    const value = this.get(key);
    const had = super.delete(key);
    if (had) this.notify("ended", value as V);
    return had;
  }
}

/** The first of the presentation URLs this device can run (Chrome: `GetSourceForCastModeAndSink`), or null. */
export function presentationUrlForDevice(
  device: CastDevice,
  urls: readonly string[],
  /** When given, the app must also be known to be available on the device (`GET_APP_AVAILABILITY`). */
  appAvailable?: (device: CastDevice, appId: string) => boolean | undefined,
  /** When given, a DIAL sink matches a `cast-dial:` URL whose app it has. */
  dialAvailable?: (device: CastDevice, appName: string) => boolean,
): string | null {
  // A DIAL sink runs the cast-dial: sources whose app it has (DialMediaRouteProvider), never a Cast app URL
  if (device.dial !== undefined) {
    if (dialAvailable === undefined) return null;
    for (const url of urls) {
      const app = isDialSource(url) ? appNameFromDialSource(url) : "";
      if (app !== "" && dialAvailable(device, app)) return url;
    }
    return null;
  }
  for (const url of urls) {
    const parsed = parsePresentationUrl(url);
    // CastAppAvailabilityTracker::GetAvailableSinks: some app of the URL is available and the sink has all its capabilities
    if (parsed !== null && parsed.appInfos.some((i) => sinkSupportsApp(device.capabilities, i)
      && (appAvailable === undefined || appAvailable(device, i.appId) === true))) return url;
  }
  return null;
}

/** How a sinks observer learns which devices have an app (Chrome: CastAppDiscoveryService, and the DIAL sink service). */
export interface AppAvailability {
  cached(device: CastDevice, appId: string): boolean | undefined;
  check(device: CastDevice, appId: string): Promise<boolean>;
  /**
   * DIAL sinks: whether `device` has `appName` for a page at `origin`, and `monitor`, which makes the DIAL sink service
   * find out until the returned function is called (null when the origin may not see the app).
   */
  dial?: {
    available(device: CastDevice, appName: string, origin: string): boolean;
    monitor(appName: string, origin: string): (() => void) | null;
  };
}

/** The sink for a discovered device. */
export function toMediaSink(device: CastDevice): MediaSink {
  // A DIAL sink is `SinkIconType::GENERIC` (dial_media_sink_service_impl.cc).
  if (device.dial !== undefined) {
    return { id: device.id, providerId: "dial", name: device.name, description: device.model, iconType: "generic", device: { ...device } };
  }
  // GetCastSinkIconType (media_sink_util.cc): video_out first, then a multizone group, else audio.
  const iconType: SinkIconType = castIconType(device.capabilities);
  return { id: device.id, providerId: "cast", name: device.name, description: device.model, iconType, device: { ...device } };
}

/** Two device sources as one: the devices of both, and the events of both. */
export function combineSources(a: DeviceSource, b: DeviceSource): DeviceSource {
  return {
    devices: () => [...a.devices(), ...b.devices()],
    on(event, listener) {
      a.on(event, listener);
      b.on(event, listener);
    },
    off(event, listener) {
      a.off(event, listener);
      b.off(event, listener);
    },
  };
}

/**
 * Keeps observers of a changing list. Each gets the list on registration and after every change; a throwing observer
 * is logged and does not stop the others.
 */
class ObserverSet<T> {
  private readonly observers = new Set<(items: T[]) => void>();
  private readonly list: () => T[];
  constructor(list: () => T[]) {
    this.list = list;
  }
  add(call: (items: T[]) => void): () => void {
    this.observers.add(call);
    this.deliver(call, this.list());
    return () => void this.observers.delete(call);
  }
  notify(): void {
    const items = this.list();
    for (const o of [...this.observers]) this.deliver(o, items);
  }
  clear(): void {
    this.observers.clear();
  }
  private deliver(call: (items: T[]) => void, items: T[]): void {
    try {
      call(items);
    } catch (err) {
      console.error("electron-cast: a media router observer failed", err);
    }
  }
}

/**
 * Sinks observation over a device source: `registerMediaSinksObserver` plus the source subscription, which is made
 * while at least one observer is registered. A change that leaves the (filtered) list as it was is not reported.
 */
export function createSinksObservers(source: DeviceSource, availability?: AppAvailability): {
  register(observer: MediaSinksObserver, query?: MediaSinksQuery, signal?: AbortSignal, eligible?: (d: CastDevice) => boolean): () => void;
  dispose(): void;
} {
  const events = ["deviceUp", "deviceDown", "deviceChanged"] as const;
  const entries = new Set<() => void>();
  const onChange = (): void => {
    for (const e of [...entries]) e();
  };
  const attach = (): void => {
    if (entries.size === 1) for (const e of events) source.on(e, onChange);
  };
  const detach = (): void => {
    if (entries.size === 0) for (const e of events) source.off(e, onChange);
  };
  return {
    register(observer, query, signal, eligible) {
      const caps = query?.capabilities;
      const urls = query?.presentationUrls;
      const origin = query?.origin ?? "";
      const dial = availability?.dial;
      const dialAvailable = dial === undefined ? undefined : (d: CastDevice, app: string): boolean => dial.available(d, app, origin);
      // Chrome's sinks query for a TAB_MIRROR or DESKTOP_MIRROR source: a Cast sink that can run one of its streaming apps
      const mirrorSource =
        query?.castMode === undefined
          ? undefined
          : mirroringSourceFor(query.castMode === "tab_mirror" ? tabMediaSource(-1) : desktopMediaSource("any", query.withAudio === true));
      const matches = (d: CastDevice): boolean => (eligible?.(d) ?? true) && (caps === undefined || capsMatch(d, caps))
        && (urls === undefined || presentationUrlForDevice(d, urls, availability?.cached.bind(availability), dialAvailable) !== null)
        && (mirrorSource === undefined || (d.dial === undefined && sinkSupportsSource(mirrorSource, d.capabilities)));
      // DialMediaRouteProvider::StartObservingMediaSinks: the DIAL sinks are asked about each cast-dial: app while the
      // observer is registered
      const dialApps = urls === undefined || dial === undefined ? [] : [...new Set(urls.map((u) => (isDialSource(u) ? appNameFromDialSource(u) : "")))].filter((a) => a !== "");
      const releases: (() => void)[] = [];
      let active = true;
      // Chrome offers a sink for a presentation source only once the device has said the app is available: ask for the
      // ones not yet known and look again when the answer arrives
      // An app that could not be answered is not asked again at every change of the list, only once its refresh threshold
      // has passed (a device that does not answer would otherwise be retried each time anything changes)
      const asked = new Map<string, number>();
      const ask = (): void => {
        if (urls === undefined || availability === undefined) return;
        const now = Date.now();
        for (const d of source.devices()) {
          if (d.dial !== undefined || (eligible?.(d) ?? true) === false || (caps !== undefined && !capsMatch(d, caps))) continue;
          for (const url of urls) {
            const parsed = parsePresentationUrl(url);
            if (parsed === null) continue;
            for (const info of parsed.appInfos) {
              if (!sinkSupportsApp(d.capabilities, info) || availability.cached(d, info.appId) !== undefined) continue;
              const key = `${d.id}\n${info.appId}`;
              const before = asked.get(key);
              if (before !== undefined && now - before <= APP_AVAILABILITY_REFRESH_MS) continue;
              asked.set(key, now);
              void availability.check(d, info.appId).then(() => { if (active) check(); });
            }
          }
        }
      };
      // the list the app sees is sorted as the dialog sorts it (MediaRouterUI::OnSinksUpdated)
      const current = (): MediaSink[] => sortSinks(source.devices().filter(matches).map(toMediaSink));
      let last = "";
      const check = (): void => {
        ask();
        const sinks = current();
        const key = JSON.stringify(sinks);
        if (key === last) return;
        last = key;
        try {
          observer.onSinksUpdated(sinks);
        } catch (err) {
          console.error("electron-cast: a media sinks observer failed", err);
        }
      };
      const unregister = (): void => {
        active = false;
        for (const release of releases.splice(0)) release();
        entries.delete(check);
        signal?.removeEventListener("abort", unregister);
        detach();
      };
      if (signal?.aborted) return () => {};
      for (const app of dialApps) {
        const release = dial?.monitor(app, origin);
        if (release) releases.push(release);
      }
      entries.add(check);
      attach();
      signal?.addEventListener("abort", unregister, { once: true });
      check();
      return unregister;
    },
    dispose() {
      entries.clear();
      detach();
    },
  };
}

const CAPABILITY_BITS: Record<string, number> = { video_out: 1, video_in: 2, audio_out: 4, audio_in: 8, dev_mode: 16, multizone_group: 32 };

/** True when every named capability is set on the device (unknown names are ignored, as in the session service). */
function capsMatch(device: CastDevice, capabilities: string[]): boolean {
  for (const cap of capabilities) {
    const bit = CAPABILITY_BITS[cap];
    if (bit !== undefined && (device.capabilities & bit) === 0) return false;
  }
  return true;
}

/** A picker context for one pending request; `close()` aborts its signal and drops its observers. */
export function createPickerContext(
  sinks: ReturnType<typeof createSinksObservers>,
  eligible: (device: CastDevice) => boolean,
): { context: DevicePickerContext; close(): void } {
  const ac = new AbortController();
  const context: DevicePickerContext = {
    signal: ac.signal,
    registerMediaSinksObserver: (observer) => sinks.register(observer, undefined, ac.signal, eligible),
  };
  return { context, close: () => ac.abort() };
}

function must(result: BridgeResult): void {
  if (!result.ok) throw new MediaRouteError(result.code, result.description);
}

/** What the API needs for issues and the log; main.ts makes them (a test may leave them out: no issues are raised then). */
export interface ApiDiagnostics {
  issues: RouterIssues;
  logger: { getLogs(): LogEntry[]; addObserver(observer: LogObserver): () => void };
  /** False when the media router is off (`--disable-features=MediaRouter`). */
  enabled: boolean;
  /**
   * `MediaRouteStarter::GetScreenCapturePermission`: whether the OS lets the app capture the screen. Chrome asks on macOS
   * only; `undefined` means it is not asked (every other platform).
   */
  screenCapturePermission?: () => boolean;
}

/** Wire the device source and the session host into the {@link CastManagerApi}. */
export function createManagerApi(
  sinks: ReturnType<typeof createSinksObservers>,
  host: SessionHost,
  presentation: {
    requests: DefaultPresentationRequests;
    start(webContentsId: number, sinkId: string): Promise<MediaRoute>;
  },
  diagnostics?: ApiDiagnostics,
): CastManagerApi & { dispose(): void } {
  const routeObservers = new ObserverSet<MediaRoute>(() => host.mediaRoutes());
  const unobserve = host.observeSessions(() => routeObservers.notify());

  const controllers = createMediaControllers(
    // DialMediaRouteProvider::BindMediaController is NOTIMPLEMENTED and answers false: a DIAL route has no controller
    { ...host, hasRoute: (id) => host.mediaRoutes().some((r) => r.id === id && r.providerId !== "dial") },
    (code, message) => new MediaRouteError(code, message),
  );
  const need = (routeId: string): void => {
    if (!host.mediaRoutes().some((r) => r.id === routeId)) {
      throw new MediaRouteError("route_not_found", `no route ${routeId}`);
    }
  };

  return {
    registerMediaSinksObserver: (observer, query) => sinks.register(observer, query),
    registerMediaRoutesObserver: (observer) => routeObservers.add((routes) => observer.onRoutesUpdated(routes)),
    registerIssuesObserver(observer) {
      if (observer === null || typeof observer !== "object") throw new TypeError("observer must be an object");
      return diagnostics?.issues.manager.registerObserver(observer) ?? (() => {});
    },
    clearIssue(issueId) {
      if (typeof issueId !== "number") throw new TypeError("issueId must be a number");
      diagnostics?.issues.manager.clearIssue(issueId);
    },
    clearTopIssueForSink(sinkId) {
      if (typeof sinkId !== "string") throw new TypeError("sinkId must be a string");
      diagnostics?.issues.manager.clearTopIssueForSink(sinkId);
    },
    getLogs: () => diagnostics?.logger.getLogs() ?? [],
    registerLogObserver(observer) {
      if (typeof observer !== "function") throw new TypeError("observer must be a function");
      return diagnostics?.logger.addObserver(observer) ?? (() => {});
    },
    getCastProviderState() {
      if (diagnostics?.enabled === false) return null;
      return {
        sessionState: host.mediaRoutes()
          .filter((r) => r.providerId === "cast" && r.appId !== "")
          .map((r) => ({ sinkId: r.sinkId, appId: r.appId, sessionId: r.id, routeDescription: r.description })),
      };
    },
    getRoutes: () => host.mediaRoutes(),
    async terminateRoute(routeId) {
      need(routeId);
      must(await host.terminateSession(routeId));
    },
    detachRoute(routeId) {
      need(routeId);
      must(host.detachSession(routeId));
    },
    hasDefaultPresentationRequest: (id) => presentation.requests.has(id),
    getDefaultPresentationRequest: (id) => presentation.requests.get(id),
    addPresentationObserver: (id, observer) => presentation.requests.observe(id, observer),
    async startCasting(sinkId, options) {
      // MediaRouterUI::StartCasting dispatches on the cast mode: PRESENTATION casts the window's default request, the
      // mirroring modes start a mirroring route
      const mode = (options as { castMode?: unknown } | null | undefined)?.castMode;
      if (mode === "tab_mirror" || mode === "desktop_mirror") {
        validateStartCasting(sinkId, options);
        try {
          if (host.startCasting === undefined) throw new MediaRouteError("unable_to_cast", "mirroring is not enabled: pass the mirroring option to createCastManager");
          // MediaRouterUI::CreateRoute: after `CreateRouteParameters`, a desktop capture needs the OS permission (macOS)
          if (mode === "desktop_mirror" && diagnostics?.screenCapturePermission?.() === false) {
            diagnostics.issues.uiScreenPermission(sinkId);
            throw new MediaRouteError("unable_to_cast", "the screen capture permission is not granted");
          }
          return await host.startCasting(sinkId, options as StartMirroringCastingOptions);
        } catch (err) {
          if (err instanceof MediaRouteError && err.code === "unable_to_cast") diagnostics?.issues.uiUnableToCast(mode, sinkId);
          throw err;
        }
      }
      const o = options as { webContentsId?: unknown } | null | undefined;
      if (typeof sinkId !== "string") throw new TypeError("sinkId must be a string");
      if (typeof o?.webContentsId !== "number") throw new TypeError("options.webContentsId must be a number");
      if (mode !== undefined && mode !== "presentation") throw new RangeError(`unsupported cast mode: ${String(mode)}`);
      try {
        return await presentation.start(o.webContentsId, sinkId);
      } catch (err) {
        if (err instanceof MediaRouteError && err.code === "unable_to_cast") diagnostics?.issues.uiUnableToCast("presentation", sinkId);
        throw err;
      }
    },
    switchMirroringSourceTab(routeId, webContentsId) {
      if (typeof webContentsId !== "number") throw new TypeError("webContentsId must be a number");
      if (!Number.isInteger(webContentsId) || webContentsId < 0) throw new RangeError("webContentsId must be a non-negative integer");
      need(routeId);
      if (host.switchMirroringSourceTab === undefined) throw new MediaRouteError("unable_to_cast", "mirroring is not enabled: pass the mirroring option to createCastManager");
      host.switchMirroringSourceTab(routeId, webContentsId);
    },
    freezeRoute(routeId) {
      need(routeId);
      host.freezeRoute?.(routeId);
    },
    unfreezeRoute(routeId) {
      need(routeId);
      host.unfreezeRoute?.(routeId);
    },
    // `MediaRouterDebuggerImpl::GetMirroringStats` has no error path: an ended or unknown route reads as {}.
    getMirroringStats(routeId) {
      return host.mirroringStats?.get(routeId) ?? {};
    },
    setMirroringStatsEnabled(enabled) {
      if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
      if (host.mirroringStats === undefined) throw new MediaRouteError("unable_to_cast", "mirroring is not enabled: pass the mirroring option to createCastManager");
      host.mirroringStats.setEnabled(enabled);
    },
    isMirroringStatsEnabled() {
      return host.mirroringStats?.isEnabled() ?? false;
    },
    registerMirroringStatsObserver(observer) {
      if (typeof observer !== "function") throw new TypeError("observer must be a function");
      return host.mirroringStats?.observe(observer) ?? (() => {});
    },
    getRouteController(routeId) {
      need(routeId);
      return {
        async setMute(muted) {
          if (typeof muted !== "boolean") throw new TypeError("muted must be a boolean");
          need(routeId);
          must(await host.setSessionVolume(routeId, { muted }));
        },
        async setVolume(level) {
          if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
            throw new RangeError("volume level must be a number from 0 to 1");
          }
          need(routeId);
          must(await host.setSessionVolume(routeId, { level }));
        },
      };
    },
    getMediaController: (routeId, observer) => controllers.get(routeId, observer),
    dispose() {
      controllers.dispose();
      unobserve();
      routeObservers.clear();
      sinks.dispose();
    },
  };
}

/** Argument checks for `startCasting`, as the presentation `startCasting` makes them: TypeError for a wrong type, RangeError for a wrong value. */
export function validateStartCasting(sinkId: unknown, options: unknown): void {
  if (typeof sinkId !== "string" || sinkId === "") throw new TypeError("sinkId must be a non-empty string");
  if (typeof options !== "object" || options === null) throw new TypeError("options must be an object");
  const o = options as Record<string, unknown>;
  if (o.castMode !== "tab_mirror" && o.castMode !== "desktop_mirror") throw new RangeError(`unsupported cast mode: ${String(o.castMode)}`);
  if (o.castMode === "tab_mirror") {
    if (typeof o.webContentsId !== "number") throw new TypeError("options.webContentsId must be a number");
    if (!Number.isInteger(o.webContentsId) || o.webContentsId < 0) throw new RangeError("options.webContentsId must be a non-negative integer");
  } else if (typeof o.desktopSourceId !== "string") {
    throw new TypeError("options.desktopSourceId must be a string");
  } else if (!/^(screen|window):/.test(o.desktopSourceId)) {
    throw new RangeError("options.desktopSourceId must be a desktopCapturer source id (screen:... or window:...)");
  }
  if (o.withAudio !== undefined && typeof o.withAudio !== "boolean") throw new TypeError("options.withAudio must be a boolean");
  if (o.targetPlayoutDelayMs !== undefined) {
    if (typeof o.targetPlayoutDelayMs !== "number") throw new TypeError("options.targetPlayoutDelayMs must be a number");
    if (!Number.isFinite(o.targetPlayoutDelayMs) || o.targetPlayoutDelayMs <= 0) throw new RangeError("options.targetPlayoutDelayMs must be a positive number of milliseconds");
  }
}
