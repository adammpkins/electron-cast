/**
 * Mirroring sources and the rules that turn one plus a sink into a session, ported from Chromium:
 *  - `components/media_router/common/media_source.cc` (the tab and desktop source URNs),
 *  - `components/media_router/common/providers/cast/cast_media_source.cc` (`CastMediaSourceForTabMirroring`,
 *    `CastMediaSourceForDesktopMirroring`, `CastAppInfo::ForCastStreaming*`, `ProvidesStreamingAudioCapture`),
 *  - `chrome/browser/media/router/providers/cast/cast_activity_manager.cc` (`ChooseAppId`),
 *  - `chrome/browser/media/router/providers/cast/mirroring_activity.cc` (`StartSession`, `GetRouteDescription`,
 *    `GetMirroringNamespace`, `GetScrubbedLogMessage`),
 *  - `chrome/app/media_router_strings.grdp` (the route descriptions).
 */
import { isWiredDisplaySource } from "../electron/wired-display/displays.ts";
import { CAST_REMOTING_NAMESPACE, CAST_WEBRTC_NAMESPACE } from "./protocol/constants.ts";
import type { SessionType } from "./session-host.ts";

/**
 * `MirroringType` (mirroring_activity.h). `offscreen_tab` is `kOffscreenTab`, "Used for Presentation API 1UA mode": the
 * presentation URL is rendered in an offscreen tab and that tab is mirrored.
 */
export type MirroringType = "tab" | "desktop" | "offscreen_tab";

/** `kMaxCastPresentationUrlLength` (cast_media_source.cc): a longer URL is no Cast source. */
const MAX_CAST_PRESENTATION_URL_LENGTH = 64 * 1024;

/** `openscreen::cast::GetCastStreamingAudioVideoAppId` and `GetCastStreamingAudioOnlyAppId` (cast_streaming_app_ids.h). */
export const CAST_STREAMING_AUDIO_VIDEO_APP_ID = "0F5096E8";
export const CAST_STREAMING_AUDIO_ONLY_APP_ID = "85CDB22F";

/** `CastDeviceCapability` bits (`capabilityNames` in the session service uses the same). */
export const CAPABILITY_VIDEO_OUT = 1;
export const CAPABILITY_AUDIO_OUT = 4;

/** media_source.cc `kAnyTabMediaUrn`, `kTabMediaUrnFormat`, `kDesktopMediaUrnPrefix`, `kDesktopMediaUrnAudioParam`. */
const ANY_TAB_URN = "urn:x-org.chromium.media:source:tab:*";
const TAB_URN_PREFIX = "urn:x-org.chromium.media:source:tab:";
const DESKTOP_URN_PREFIX = "urn:x-org.chromium.media:source:desktop:";
const DESKTOP_AUDIO_PARAM = "?with_audio=true";

/** `MediaSource::ForTab`. */
export function tabMediaSource(tabId: number): string {
  return `${TAB_URN_PREFIX}${tabId}`;
}

/** `MediaSource::ForDesktop`. */
export function desktopMediaSource(desktopMediaId: string, withAudio: boolean): string {
  if (desktopMediaId === "") throw new TypeError("a desktop media id is required");
  return `${DESKTOP_URN_PREFIX}${desktopMediaId}${withAudio ? DESKTOP_AUDIO_PARAM : ""}`;
}

/** `MediaSource::IsTabMirroringSource` (`TabId()` is a number after the prefix). */
export function isTabMirroringSource(id: string): boolean {
  return id === ANY_TAB_URN || (id.startsWith(TAB_URN_PREFIX) && /^\d+$/.test(id.slice(TAB_URN_PREFIX.length)));
}

/** `MediaSource::IsDesktopMirroringSource` (`kUnchosenDesktopMediaUrn` is the prefix without the trailing colon). */
export function isDesktopMirroringSource(id: string): boolean {
  return id === DESKTOP_URN_PREFIX.slice(0, -1) || id.startsWith(DESKTOP_URN_PREFIX);
}

/** `MediaSource::IsDesktopSourceWithAudio`. */
export function isDesktopSourceWithAudio(id: string): boolean {
  return id.startsWith(DESKTOP_URN_PREFIX) && id.endsWith(DESKTOP_AUDIO_PARAM);
}

/** `MediaSource::DesktopStreamId`. */
export function desktopStreamId(id: string): string | undefined {
  if (!id.startsWith(DESKTOP_URN_PREFIX)) return undefined;
  const end = id.endsWith(DESKTOP_AUDIO_PARAM) ? id.length - DESKTOP_AUDIO_PARAM.length : id.length;
  return id.slice(DESKTOP_URN_PREFIX.length, end);
}

/** `CastAppInfo`: an app id and the capabilities a sink needs to run it. */
export interface CastAppInfo {
  appId: string;
  requiredCapabilities: number;
}

/** `CastAppInfo::ForCastStreaming` / `ForCastStreamingAudio`. */
const streamingApp = (): CastAppInfo => ({ appId: CAST_STREAMING_AUDIO_VIDEO_APP_ID, requiredCapabilities: CAPABILITY_VIDEO_OUT | CAPABILITY_AUDIO_OUT });
const streamingAudioApp = (): CastAppInfo => ({ appId: CAST_STREAMING_AUDIO_ONLY_APP_ID, requiredCapabilities: CAPABILITY_AUDIO_OUT });

/** A mirroring `CastMediaSource`. */
export interface MirroringSource {
  /** The source URN (`MediaSource::id`). */
  id: string;
  type: MirroringType;
  appInfos: CastAppInfo[];
  /** `site_requested_audio_capture_` (true unless the source says otherwise). */
  siteRequestedAudioCapture: boolean;
  /** `target_playout_delay`. */
  targetPlayoutDelayMs?: number;
  /**
   * A site-initiated source keeps its Cast URL as `id` (as `CastMediaSource` keeps the source id), so the page it
   * captures cannot be read from the id: this is the `webContents.id` of the tab (`frame_tree_node_id_` of the activity).
   * For an offscreen tab it is the `webContents.id` of that tab (`offscreen_tab_->web_contents()`), set once it is open.
   */
  tabId?: number;
}

/**
 * `CastMediaSourceForTabMirroring`: both streaming apps, audio and video first. `CastMediaSourceForDesktopMirroring`:
 * with audio both apps, without audio the audio-and-video app minus its audio requirement (a screen capture then
 * has a video stream only).
 */
export function mirroringSourceFor(sourceId: string): MirroringSource | undefined {
  if (isTabMirroringSource(sourceId)) {
    return { id: sourceId, type: "tab", appInfos: [streamingApp(), streamingAudioApp()], siteRequestedAudioCapture: true };
  }
  if (isDesktopMirroringSource(sourceId)) {
    const appInfos: CastAppInfo[] = [];
    if (isDesktopSourceWithAudio(sourceId)) {
      appInfos.push(streamingApp(), streamingAudioApp());
    } else {
      appInfos.push({ ...streamingApp(), requiredCapabilities: CAPABILITY_VIDEO_OUT });
    }
    return { id: sourceId, type: "desktop", appInfos, siteRequestedAudioCapture: true };
  }
  return undefined;
}

/**
 * Whether an URL is a source the Cast provider serves in 1-UA mode. `CastMediaSource::FromMediaSource`: a valid URL of
 * at most `kMaxCastPresentationUrlLength` that is neither `cast:` nor the legacy Cast form and whose scheme is http or
 * https ("Arbitrary https URLs are supported via 1-UA mode which uses tab mirroring"). The mirroring host then opens an
 * offscreen tab only for `IsValidPresentationUrl` (`CastMirroringServiceHostFactory::GetForOffscreenTab`), and the
 * controller refuses any other URL before it reaches a provider (`ControllerPresentationServiceDelegateImpl`): https,
 * or http on localhost. Together that is `IsValidStandardPresentationSource`.
 */
export function isOffscreenTabSource(url: string): boolean {
  return url.length <= MAX_CAST_PRESENTATION_URL_LENGTH && isWiredDisplaySource(url);
}

/**
 * `CastMediaSource::FromMediaSource` for such an URL: `CastMediaSourceForTabMirroring(source.id())`, so both streaming
 * apps with the URL as the source id; `MirroringActivity`'s `GetMirroringType` makes it `kOffscreenTab`. `frameId` is
 * the `webContents.id` of the page that started the presentation (`frame_tree_node_id` of `CreateRoute`); the tab that
 * is captured is opened later and put in `tabId`.
 */
export function offscreenTabSourceFor(url: string): MirroringSource | undefined {
  if (!isOffscreenTabSource(url)) return undefined;
  return { id: url, type: "offscreen_tab", appInfos: [streamingApp(), streamingAudioApp()], siteRequestedAudioCapture: true };
}

/** `CastActivityManager::ChooseAppId`: the first app the sink can run, else the first one. */
export function chooseAppId(source: MirroringSource, sinkCapabilities: number): string {
  for (const info of source.appInfos) {
    if ((sinkCapabilities & info.requiredCapabilities) === info.requiredCapabilities) return info.appId;
  }
  return source.appInfos[0]!.appId;
}

/** True when some app of the source can run on the sink, i.e. the sink is listed for this source. */
export function sinkSupportsSource(source: MirroringSource, sinkCapabilities: number): boolean {
  return source.appInfos.some((i) => (sinkCapabilities & i.requiredCapabilities) === i.requiredCapabilities);
}

/** `CastMediaSource::ProvidesStreamingAudioCapture`. */
export function providesStreamingAudioCapture(source: MirroringSource): boolean {
  if (!source.siteRequestedAudioCapture) return false;
  return source.appInfos.some((i) => (i.requiredCapabilities & CAPABILITY_AUDIO_OUT) !== 0);
}

/**
 * `MirroringActivity::StartSession`: audio when the sink has audio_out and the source provides audio, video when the
 * sink has video_out; neither means mirroring stops.
 */
export function sessionTypeFor(source: MirroringSource, sinkCapabilities: number): SessionType | undefined {
  const hasAudio = (sinkCapabilities & CAPABILITY_AUDIO_OUT) !== 0 && providesStreamingAudioCapture(source);
  const hasVideo = (sinkCapabilities & CAPABILITY_VIDEO_OUT) !== 0;
  if (!hasAudio && !hasVideo) return undefined;
  return hasAudio && hasVideo ? "audio_video" : hasAudio ? "audio_only" : "video_only";
}

/**
 * `MirroringActivity::GetRouteDescription` with `IDS_MEDIA_ROUTER_CASTING_TAB` / `_DESKTOP`, and for an offscreen tab
 * `IDS_MEDIA_ROUTER_PRESENTATION_ROUTE_DESCRIPTION` with the host of the source URL: `Presenting (<host>)`.
 */
export function routeDescription(type: MirroringType, sourceId = ""): string {
  if (type === "offscreen_tab") {
    let host = "";
    try {
      host = new URL(sourceId).hostname;
    } catch {
      // an invalid URL has an empty host
    }
    return `Presenting (${host})`;
  }
  return type === "tab" ? "Casting tab" : "Casting screen";
}

/** `GetMirroringNamespace`: RPC messages go to the remoting namespace, everything else to webrtc. */
export function mirroringNamespace(message: Record<string, unknown>): string {
  return message.type === "RPC" ? CAST_REMOTING_NAMESPACE : CAST_WEBRTC_NAMESPACE;
}

/** `GetScrubbedLogMessage`: the OFFER's per-stream key material is replaced before a message is logged. */
export function scrubbedLogMessage(message: Record<string, unknown>): string {
  const copy = structuredClone(message);
  const offer = copy.offer as { supportedStreams?: unknown } | undefined;
  const streams = offer?.supportedStreams;
  if (Array.isArray(streams)) {
    for (const item of streams) {
      if (typeof item !== "object" || item === null) continue;
      const dict = item as Record<string, unknown>;
      for (const key of ["aesKey", "aesIvMask"]) if (typeof dict[key] === "string") dict[key] = "[REDACTED]";
    }
  }
  return JSON.stringify(copy);
}
