// The main-process API of the cast manager, modelled on Chrome's Media Router (see docs/MAIN-API.md for the mapping):
// sinks (devices) and routes (sessions) are observed through observers, a route is terminated or detached, and
// volume goes through a route controller. It is kept apart from main.ts and session-service.ts, which only expose
// the narrow hooks used here.
import type { CastDevice } from "../discovery/index.ts";
import type { BridgeResult } from "../polyfill/bridge-types.ts";
import type { DeviceSource } from "./session-service.ts";
import type { MirroringCastMode, StartMirroringOptions } from "../mirroring/mirroring-manager.ts";
import { desktopMediaSource, mirroringSourceFor, sinkSupportsSource, tabMediaSource } from "../mirroring/routing.ts";

/** Chrome's `SinkIconType` values that apply to Cast devices. */
export type SinkIconType = "cast" | "cast_audio" | "cast_audio_group";

/** A device a route can be created on (Chrome: `media_router::MediaSink`). */
export interface MediaSink {
  id: string;
  name: string;
  /** The device model. electron-cast's own: Chrome's MediaSink has none (the model is `CastSinkExtraData::model_name`). */
  description: string;
  iconType: SinkIconType;
  /** The discovered device behind the sink. */
  device: CastDevice;
}

/** What a sinks observer wants sinks for (Chrome: the observer's `MediaSource`); omit it for every device. */
export interface MediaSinksQuery {
  /** Only sinks with all of these capabilities (`video_out`, `audio_out`, ...), like `requestSession`'s. */
  capabilities?: string[];
  /**
   * Only sinks that can receive this kind of mirroring, as Chrome lists them for TAB_MIRROR and DESKTOP_MIRROR: a sink
   * is listed when it can run one of the streaming apps the source names (audio and video, or audio only).
   */
  castMode?: MirroringCastMode;
  /** With `castMode: "desktop_mirror"`: whether the capture includes audio (a screen without audio needs video_out). */
  withAudio?: boolean;
}

/** Chrome: `MediaSinksObserver`. */
export interface MediaSinksObserver {
  /** The full current list, on registration and then each time it changes. */
  onSinksUpdated(sinks: MediaSink[]): void;
}

/** A live session on a sink (Chrome: `media_router::MediaRoute`; a session is what Chrome's Cast provider routes to). */
export interface MediaRoute {
  /** The session id (Chrome: `media_route_id`). */
  id: string;
  /** `cast:<appId>`, the Cast source URN's scheme and app id (Chrome: `media_source`). */
  mediaSource: string;
  sinkId: string;
  /** The app's status text, else its name (Chrome: `description`). */
  description: string;
  // Fields below are electron-cast's: Chrome's route knows its page through the extension or the Presentation API.
  appId: string;
  displayName: string;
  /** Origin of the page that started the session. */
  origin: string;
  /** Receiver volume as last reported; `null` until the device reports one. */
  volume: { level: number | null; muted: boolean | null };
  /** `webContents.id` of every page currently attached. */
  members: number[];
  /** `webContents.id` of pages that navigated away and may rejoin; they get no events meanwhile. */
  parkedSenders: number[];
  /** True when no page is attached: the route lives on in the device only. */
  parked: boolean;
}

/** Chrome: `MediaRoutesObserver`. */
export interface MediaRoutesObserver {
  /** The full current list, on registration and then each time a route starts, ends or changes. */
  onRoutesUpdated(routes: MediaRoute[]): void;
}

/** Chrome: `media_router::mojom::MediaController`, here only the volume half (`SetMute`, `SetVolume`). */
export interface MediaRouteController {
  setMute(muted: boolean): Promise<void>;
  /** 0 to 1. */
  setVolume(level: number): Promise<void>;
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
  /** The current routes (what `MediaRoutesObserver` last got), parked ones included. */
  getRoutes(): MediaRoute[];
  /** `MediaRouter::TerminateRoute`: stops the receiver app; pages get `sessionEnded` as if the device had. */
  terminateRoute(routeId: string): Promise<void>;
  /** electron-cast's own (Chrome's Cast provider leaves `DetachRoute` unimplemented): every page lets go of the route and its transport closes; the app keeps running. */
  detachRoute(routeId: string): void;
  /** `MediaRouter::GetMediaController` / `mojom::MediaController`: volume and mute go to the receiver, so pages see `sessionUpdated`. */
  getRouteController(routeId: string): MediaRouteController;
  /**
   * `MediaRouterUI::StartCasting` for `TAB_MIRROR` and `DESKTOP_MIRROR`: mirror a window's page (`webContentsId`) or a
   * `desktopCapturer` source (`desktopSourceId`) to the sink. Resolves with the route once the receiver's streaming app
   * runs; end it with `terminateRoute`. Needs the `mirroring` option of `createCastManager`.
   */
  startCasting(sinkId: string, options: StartMirroringOptions): Promise<MediaRoute>;
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
export interface SessionHost {
  mediaRoutes(): MediaRoute[];
  observeSessions(listener: () => void): () => void;
  terminateSession(sessionId: string): Promise<BridgeResult>;
  setSessionVolume(sessionId: string, volume: { level: number } | { muted: boolean }): Promise<BridgeResult>;
  detachSession(sessionId: string): BridgeResult;
  /** Mirroring routes; present when the manager was given the `mirroring` option. */
  startCasting?(sinkId: string, options: StartMirroringOptions): Promise<MediaRoute>;
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

/** The sink for a discovered device. */
export function toMediaSink(device: CastDevice): MediaSink {
  // GetCastSinkIconType (media_sink_util.cc): video_out first, then a multizone group, else audio.
  const iconType: SinkIconType = (device.capabilities & 1) !== 0 ? "cast" : (device.capabilities & 32) !== 0 ? "cast_audio_group" : "cast_audio";
  return { id: device.id, name: device.name, description: device.model, iconType, device: { ...device } };
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
export function createSinksObservers(source: DeviceSource): {
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
      const mirrorSource =
        query?.castMode === undefined
          ? undefined
          : mirroringSourceFor(query.castMode === "tab_mirror" ? tabMediaSource(-1) : desktopMediaSource("any", query.withAudio === true));
      const matches = (d: CastDevice): boolean =>
        (eligible?.(d) ?? true) && (caps === undefined || capsMatch(d, caps)) && (mirrorSource === undefined || sinkSupportsSource(mirrorSource, d.capabilities));
      const current = (): MediaSink[] => source.devices().filter(matches).map(toMediaSink);
      let last = "";
      const check = (): void => {
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
        entries.delete(check);
        signal?.removeEventListener("abort", unregister);
        detach();
      };
      if (signal?.aborted) return () => {};
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

const CAPABILITY_BITS: Record<string, number> = { video_out: 1, video_in: 2, audio_out: 4, audio_in: 8, multizone_group: 32 };

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

/** Wire the device source and the session host into the {@link CastManagerApi}. */
export function createManagerApi(
  sinks: ReturnType<typeof createSinksObservers>,
  host: SessionHost,
): CastManagerApi & { dispose(): void } {
  const routeObservers = new ObserverSet<MediaRoute>(() => host.mediaRoutes());
  const unobserve = host.observeSessions(() => routeObservers.notify());

  const need = (routeId: string): void => {
    if (!host.mediaRoutes().some((r) => r.id === routeId)) {
      throw new MediaRouteError("route_not_found", `no route ${routeId}`);
    }
  };

  return {
    registerMediaSinksObserver: (observer, query) => sinks.register(observer, query),
    registerMediaRoutesObserver: (observer) => routeObservers.add((routes) => observer.onRoutesUpdated(routes)),
    getRoutes: () => host.mediaRoutes(),
    async terminateRoute(routeId) {
      need(routeId);
      must(await host.terminateSession(routeId));
    },
    detachRoute(routeId) {
      need(routeId);
      must(host.detachSession(routeId));
    },
    async startCasting(sinkId, options) {
      if (host.startCasting === undefined) throw new MediaRouteError("unable_to_cast", "mirroring is not enabled: pass the mirroring option to createCastManager");
      return host.startCasting(sinkId, options);
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
    dispose() {
      unobserve();
      routeObservers.clear();
      sinks.dispose();
    },
  };
}
