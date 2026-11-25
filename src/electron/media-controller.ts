// Main-process media control of a route, after Chrome's `media_router::mojom::MediaController` bound by
// `MediaRouter::GetMediaController`, which on a Cast route is `CastMediaController`
// (chrome/browser/media/router/providers/cast/cast_media_controller.cc), with the status it reports to a
// `mojom::MediaStatusObserver` (components/media_router/common/mojom/media_status.mojom). The status is built the way
// Chrome builds it: from the receiver's volume on every receiver status (`CastMediaController::SetSession`) and from
// every MEDIA_STATUS after `CastSessionTracker::HandleMediaStatusMessage` has merged it with the media it saved, both
// taken from the session tracker on the device's kept-open channel. As in Chrome (`CastActivityManager::
// BindMediaController` finds any activity, and `AddNonLocalActivity` makes an `AppActivity` for a session started
// elsewhere), a non-local route has a controller too. The device is reached only through {@link MediaControllerHost}.
import type { ReceiverVolume } from "../client/index.ts";
import type { BridgeResult } from "../polyfill/bridge-types.ts";
import { MEDIA_NAMESPACE } from "./presentation-envelope.ts";

/** `media_router::mojom::MediaStatus::PlayState`. */
export type MediaPlayState = "playing" | "paused" | "buffering";

/** `media_router::mojom::MediaImage`. */
export interface MediaImage {
  url: string;
  /** Null when the receiver gave no usable size. */
  size: { width: number; height: number } | null;
}

/** `media_router::mojom::MediaStatus`. Times are in seconds (the Cast protocol's unit; Chrome uses `TimeDelta`). */
export interface MediaStatus {
  title: string;
  secondaryTitle: string;
  canPlayPause: boolean;
  canMute: boolean;
  canSetVolume: boolean;
  canSeek: boolean;
  canSkipToNextTrack: boolean;
  canSkipToPreviousTrack: boolean;
  playState: MediaPlayState;
  isMuted: boolean;
  volume: number;
  /** 0 for media with no set length (a live stream). */
  duration: number;
  currentTime: number;
  images: MediaImage[];
}

/** `media_router::mojom::MediaStatusObserver`. */
export interface MediaStatusObserver {
  onMediaStatusUpdated(status: MediaStatus): void;
}

/**
 * `media_router::mojom::MediaController`. Like Chrome's, the commands are sent to the receiver and not confirmed: a
 * promise resolves once the message is written and rejects with {@link MediaRouteError} when the route is gone or the
 * channel failed. The receiver ignores what the media does not support.
 */
export interface MediaController {
  play(): Promise<void>;
  pause(): Promise<void>;
  /** The receiver's own mute, as `setMute` of the route controller. */
  setMute(muted: boolean): Promise<void>;
  /** 0 to 1; the receiver's volume, does not change the muted state. */
  setVolume(level: number): Promise<void>;
  /** Seconds from the start. */
  seek(timeSeconds: number): Promise<void>;
  nextTrack(): Promise<void>;
  previousTrack(): Promise<void>;
  /** Stops reporting to this controller's observer (Chrome: the mojo pipe closing). */
  close(): void;
}

/** What the controllers need of the device side of a session; the session service provides it. */
export interface MediaControllerHost {
  /** Is there a route with this id? */
  hasRoute(routeId: string): boolean;
  /** Send to the session's receiver app over the device's channel, local route or not. */
  sendSessionMessage(sessionId: string, namespace: string, message: string): BridgeResult;
  /** The volume the receiver last reported, if the session is known. */
  sessionVolume(sessionId: string): ReceiverVolume | undefined;
  setSessionVolume(sessionId: string, volume: { level: number } | { muted: boolean }): Promise<BridgeResult>;
  /** Told when a session starts, changes or ends. */
  observeSessions(listener: () => void): () => void;
  /** Every receiver status that describes the session, with its volume (`OnSessionAddedOrUpdated`). */
  observeSessionStatus(listener: (sessionId: string, volume: ReceiverVolume) => void): () => void;
  /** Every MEDIA_STATUS of a session, merged and backfilled by the session tracker (`OnMediaStatusUpdated`). */
  observeMediaStatus(listener: (sessionId: string, message: Record<string, unknown>) => void): () => void;
}

/** `kQueueNextJumpValue` and `kQueuePrevJumpValue`. */
const QUEUE_NEXT_JUMP = 1;
const QUEUE_PREV_JUMP = -1;

/**
 * Request ids of the controller's messages. They start far above what a page's Cast SDK counts up from, because the
 * receiver's replies reach the pages of the route too (one Cast sender id serves the whole device connection).
 */
let nextRequestId = 2 ** 30;

const defaultStatus = (): MediaStatus => ({
  title: "", secondaryTitle: "", canPlayPause: false, canMute: false, canSetVolume: false, canSeek: false,
  canSkipToNextTrack: false, canSkipToPreviousTrack: false, playState: "playing", isMuted: false, volume: 0,
  duration: 0, currentTime: 0, images: [],
});

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

/** `SetIfNonNegative`: the number when it is one and not negative. */
const nonNegative = (v: unknown): number | undefined => (typeof v === "number" && v >= 0 ? v : undefined);

/** `GetValidSize`: width and height both positive. */
function validSize(image: Json): { width: number; height: number } | null {
  const width = nonNegative(image.width);
  const height = nonNegative(image.height);
  return width !== undefined && height !== undefined && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;
}

/** The state `CastMediaController` keeps for one route: the status and the media session id. */
class RouteMedia {
  status: MediaStatus = defaultStatus();
  /** `media_session_id_`: -1 until a MEDIA_STATUS names one. */
  mediaSessionId = -1;
  readonly observers = new Set<MediaStatusObserver>();

  /** `CastMediaController::SetSession`: take the receiver volume. False when there is none to take. */
  setVolume(volume: ReceiverVolume | undefined): boolean {
    if (volume === undefined || (volume.level === undefined && volume.muted === undefined && volume.controlType === undefined)) return false;
    const level = nonNegative(volume.level);
    if (level !== undefined) this.status.volume = level;
    if (typeof volume.muted === "boolean") this.status.isMuted = volume.muted;
    if (typeof volume.controlType === "string") {
      this.status.canSetVolume = volume.controlType !== "fixed";
      this.status.canMute = this.status.canSetVolume;
    }
    return true;
  }

  /**
   * `CastMediaController::UpdateMediaStatus`, on a message the tracker has already merged with the saved media and
   * backfilled (`supportedMediaCommands` as names): the first entry of `status` is the one that counts.
   */
  setMediaStatus(message: Json): void {
    const list = message.status;
    if (!Array.isArray(list) || list.length === 0) return;
    const first: unknown = list[0];
    if (!isRecord(first)) return;
    const s = this.status;
    const id = first.mediaSessionId;
    if (typeof id === "number" && Number.isInteger(id) && id >= 0) this.mediaSessionId = id;
    const meta = isRecord(first.media) && isRecord(first.media.metadata) ? first.media.metadata : undefined;
    if (typeof meta?.title === "string") s.title = meta.title;
    if (typeof meta?.subtitle === "string") s.secondaryTitle = meta.subtitle;
    const currentTime = nonNegative(first.currentTime);
    if (currentTime !== undefined) s.currentTime = currentTime;
    const duration = isRecord(first.media) ? nonNegative(first.media.duration) : undefined;
    if (duration !== undefined) s.duration = duration;
    if (Array.isArray(meta?.images)) {
      s.images = [];
      for (const image of meta.images) {
        if (!isRecord(image) || typeof image.url !== "string") continue;
        let url: URL;
        try {
          url = new URL(image.url);
        } catch {
          continue;
        }
        // only https images are kept
        if (url.protocol === "https:") s.images.push({ url: url.href, size: validSize(image) });
      }
    }
    if (Array.isArray(first.supportedMediaCommands)) {
      const commands = first.supportedMediaCommands;
      // can_set_volume and can_mute come from the receiver volume instead
      s.canPlayPause = commands.includes("pause");
      s.canSeek = commands.includes("seek");
      s.canSkipToNextTrack = commands.includes("queue_next");
      s.canSkipToPreviousTrack = commands.includes("queue_prev");
    }
    if (first.playerState === "PLAYING") s.playState = "playing";
    else if (first.playerState === "PAUSED") s.playState = "paused";
    else if (first.playerState === "BUFFERING") s.playState = "buffering";
  }

  /** Tell every observer, each time, as `SetSession` and `SetMediaStatus` do: Chrome does not skip a repeated status. */
  notify(): void {
    for (const o of [...this.observers]) {
      try {
        o.onMediaStatusUpdated(structuredClone(this.status));
      } catch (err) {
        console.error("electron-cast: a media status observer failed", err);
      }
    }
  }
}

/** Builds the controllers; `fail` makes the caller's error type from a bridge failure or a missing route. */
export function createMediaControllers(
  host: MediaControllerHost,
  fail: (code: string, message?: string) => Error,
): { get(routeId: string, observer?: MediaStatusObserver): MediaController; dispose(): void } {
  const routes = new Map<string, { media: RouteMedia; handles: number }>();
  let unsubscribe: (() => void) | undefined;

  // AppActivity::SendMediaStatusToClients -> CastMediaController::SetMediaStatus: every MEDIA_STATUS is reported
  const onMediaStatus = (sessionId: string, message: Json): void => {
    const entry = routes.get(sessionId);
    if (entry === undefined || !host.hasRoute(sessionId)) return;
    entry.media.setMediaStatus(message);
    entry.media.notify();
  };
  // AppActivity::OnSessionUpdated -> CastMediaController::SetSession: every receiver status, when it has a volume
  const onSessionStatus = (sessionId: string, volume: ReceiverVolume): void => {
    const entry = routes.get(sessionId);
    if (entry === undefined || !host.hasRoute(sessionId)) return;
    if (entry.media.setVolume(volume)) entry.media.notify();
  };
  const onSessions = (): void => {
    for (const id of [...routes.keys()]) if (!host.hasRoute(id)) routes.delete(id);
    if (routes.size === 0) stopListening();
  };
  const listen = (): void => {
    if (unsubscribe !== undefined) return;
    const offs = [
      host.observeMediaStatus(onMediaStatus),
      host.observeSessionStatus(onSessionStatus),
      host.observeSessions(onSessions),
    ];
    unsubscribe = () => {
      for (const off of offs) off();
    };
  };
  function stopListening(): void {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  const must = (result: BridgeResult): void => {
    if (!result.ok) throw fail(result.code, result.description);
  };

  return {
    get(routeId, observer) {
      if (!host.hasRoute(routeId)) throw fail("route_not_found", `no route ${routeId}`);
      listen();
      let entry = routes.get(routeId);
      if (entry === undefined) {
        entry = { media: new RouteMedia(), handles: 0 };
        routes.set(routeId, entry);
      }
      const { media } = entry;
      const route = entry;
      route.handles++;
      // AppActivity::BindMediaController: add the observer, SetSession (which tells every observer when there is a
      // volume), then ask the receiver for the media status
      if (observer !== undefined) media.observers.add(observer);
      if (media.setVolume(host.sessionVolume(routeId))) media.notify();
      host.sendSessionMessage(routeId, MEDIA_NAMESPACE, JSON.stringify({ type: "GET_STATUS", requestId: nextRequestId++ }));

      const need = (): void => {
        if (!host.hasRoute(routeId)) throw fail("route_not_found", `no route ${routeId}`);
      };
      /** `CreateMediaRequest`: the body Chrome sends for a media command. */
      const mediaRequest = (type: string, extra: Json = {}): Promise<void> => {
        try {
          need();
          must(host.sendSessionMessage(routeId, MEDIA_NAMESPACE, JSON.stringify({
            mediaSessionId: media.mediaSessionId, sessionId: routeId, type, ...extra, requestId: nextRequestId++,
          })));
          return Promise.resolve();
        } catch (err) {
          return Promise.reject(err);
        }
      };
      let closed = false;
      return {
        play: () => mediaRequest("PLAY"),
        pause: () => mediaRequest("PAUSE"),
        seek(time) {
          if (typeof time !== "number" || !Number.isFinite(time) || time < 0) {
            return Promise.reject(new RangeError("seek time must be a number of seconds, 0 or more"));
          }
          return mediaRequest("SEEK", { currentTime: time });
        },
        // QUEUE_UPDATE with a jump, not QUEUE_NEXT: not all receiver apps support it (crbug.com/40689430)
        nextTrack: () => mediaRequest("QUEUE_UPDATE", { jump: QUEUE_NEXT_JUMP }),
        previousTrack: () => mediaRequest("QUEUE_UPDATE", { jump: QUEUE_PREV_JUMP }),
        async setMute(muted) {
          if (typeof muted !== "boolean") throw new TypeError("muted must be a boolean");
          need();
          must(await host.setSessionVolume(routeId, { muted }));
        },
        async setVolume(level) {
          if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
            throw new RangeError("volume level must be a number from 0 to 1");
          }
          need();
          must(await host.setSessionVolume(routeId, { level }));
        },
        close() {
          if (closed) return;
          closed = true;
          if (observer !== undefined) media.observers.delete(observer);
          if (--route.handles === 0) {
            routes.delete(routeId);
            if (routes.size === 0) stopListening();
          }
        },
      };
    },
    dispose() {
      routes.clear();
      stopListening();
    },
  };
}
