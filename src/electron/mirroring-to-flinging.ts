// The rules that join mirroring and Cast sessions in Chromium's Media Router, as pure functions: switching a mirrored tab
// to a real Cast session ("flinging"), pages that start mirroring through the Presentation API (site-initiated
// mirroring), and the guard against silently escalating to desktop capture. Pure module: no Electron imports.
import { castUrlAppIds, classifyPresentationUrl } from "./presentation-source.ts";
import { parsePresentationUrl } from "./presentation-envelope.ts";
import { isDesktopMirroringSource, type CastAppInfo, type MirroringSource } from "../mirroring/routing.ts";
import type { CommandLineLike } from "../mirroring/encoding-support.ts";

/** `media_router::kAutoJoinPresentationId` (components/media_router/common/media_source.h). */
export const AUTO_JOIN_PRESENTATION_ID = "auto-join";

/**
 * `kPresentationApiAllowlist` (chrome/browser/media/router/providers/cast/cast_media_route_provider.cc): "List of origins
 * allowed to use a PresentationRequest to initiate mirroring."
 */
export const PRESENTATION_API_ALLOWLIST: readonly string[] = [
  "https://docs.google.com",
  "https://meet.google.com",
  "https://music.youtube.com",
];

/** The feature `kAllowAllSitesToInitiateMirroring` (chrome/browser/media/router/media_router_feature.cc), off by default. */
export const ALLOW_ALL_SITES_FEATURE = "AllowAllSitesToInitiateMirroring";

/** `--enable-features=A,B:params` / `--disable-features=...`: the feature names (a name in both lists is disabled). */
function featureOn(commandLine: CommandLineLike | undefined, feature: string, enabledByDefault: boolean): boolean {
  const names = (switchName: string): Set<string> => {
    const out = new Set<string>();
    if (commandLine === undefined || !commandLine.hasSwitch(switchName)) return out;
    for (const item of commandLine.getSwitchValue(switchName).split(",")) {
      const name = item.trim().split(/[:<]/)[0]!.replace(/^[*!]/, "");
      if (name !== "") out.add(name);
    }
    return out;
  };
  if (names("disable-features").has(feature)) return false;
  return names("enable-features").has(feature) || enabledByDefault;
}

/**
 * `GetOrigins` of `CastMediaRouteProvider` for a site-initiated mirroring source: an allowlisted origin, or any origin
 * when `kAllowAllSitesToInitiateMirroring` is on. For every other origin the sinks of the source are empty, so the page
 * sees the source unavailable and cannot start it. The origin is compared as `url::Origin::Create(GURL(origin))`
 * compares it: scheme, host and port.
 */
export function siteInitiatedMirroringAllowed(origin: string, commandLine?: CommandLineLike): boolean {
  if (featureOn(commandLine, ALLOW_ALL_SITES_FEATURE, false)) return true;
  let canonical: string;
  try {
    canonical = new URL(origin).origin;
  } catch {
    return false;
  }
  return PRESENTATION_API_ALLOWLIST.includes(canonical);
}

/**
 * `IsSiteInitiatedMirroringSource` (components/media_router/common/providers/cast/cast_media_source.cc): a Cast
 * Presentation URL (`cast:` or the legacy `https://google.com/cast#` form) that carries any Cast Streaming app id. Tab
 * and desktop URNs and `remote-playback:` sources are browser-initiated and are not it.
 */
export function isSiteInitiatedMirroringSource(url: string): boolean {
  return classifyPresentationUrl(url) === "mirroring";
}

/**
 * The mirroring source of a site-initiated request: `CastMediaSource` of the URL, which keeps the URL as its source id
 * and the URL's own apps as `app_infos`; `MirroringActivity::GetMirroringType` represents it as tab mirroring ("The
 * source having a valid Cast presentation URL indicates that it is site initiated mirroring, which we represent as tab
 * mirroring here"), and `CastActivityManager::DoLaunchSession` gives the activity the page's frame. The sinks offered
 * were already limited to the ones that have an app of the URL, so no capability is required here again.
 */
export function siteMirroringSource(
  url: string,
  webContentsId: number,
  /**
   * What `CastMediaSource` parses from the URL: `target_playout_delay` (`streamingTargetPlayoutDelayMillis`) and
   * `site_requested_audio_capture` (false only for `streamingCaptureAudio=0`). Named as the URL parser's fields
   * (`targetPlayoutDelayMillis`, `siteRequestedAudioCapture`) so that the caller passes the parsed source's values.
   */
  parsed: { targetPlayoutDelayMillis?: number; siteRequestedAudioCapture?: boolean } = {},
): MirroringSource | undefined {
  if (!isSiteInitiatedMirroringSource(url)) return undefined;
  const ids = castUrlAppIds(url) ?? [];
  const own = parsePresentationUrl(url);
  if (own !== null && ids.length === 0) ids.push(own.appId);
  if (ids.length === 0) return undefined;
  const appInfos: CastAppInfo[] = ids.map((appId) => ({ appId, requiredCapabilities: 0 }));
  return {
    id: url,
    type: "tab",
    appInfos,
    siteRequestedAudioCapture: parsed.siteRequestedAudioCapture ?? true,
    tabId: webContentsId,
    ...(parsed.targetPlayoutDelayMillis !== undefined && parsed.targetPlayoutDelayMillis > 0 ? { targetPlayoutDelayMs: parsed.targetPlayoutDelayMillis } : {}),
  };
}

/** A route as `IsDesktopCaptureEscalation` reads it. */
export interface JoinableRoute {
  /** `MediaRoute::presentation_id`. */
  presentationId: string;
  /** `MediaRoute::media_source` id. */
  mediaSource: string;
}

/**
 * `MediaRouterDesktop::IsDesktopCaptureEscalation` (chrome/browser/media/router/mojo/media_router_desktop.cc): joining a
 * route as a desktop mirroring source is refused unless the route being joined is itself desktop mirroring, and
 * auto-join (and an id that names no route) is refused outright, "to prevent silent escalation from non-desktop to
 * desktop capture without user consent". `JoinRoute` answers `USER_NOT_ALLOWED`, "Cannot switch to desktop capture
 * without user consent". A page cannot name a desktop source (Blink drops presentation URLs of an unknown scheme), so
 * this guards the join paths of the main process.
 */
export function isDesktopCaptureEscalation(newSource: string, presentationId: string, routes: readonly JoinableRoute[]): boolean {
  if (!isDesktopMirroringSource(newSource)) return false;
  if (presentationId === AUTO_JOIN_PRESENTATION_ID) return true;
  const route = routes.find((r) => r.presentationId === presentationId);
  if (route !== undefined) return !isDesktopMirroringSource(route.mediaSource);
  return true;
}

/** The text `MediaRouterDesktop::JoinRoute` gives a refused escalation. */
export const DESKTOP_ESCALATION_MESSAGE = "Cannot switch to desktop capture without user consent";

/**
 * Whether `CastActivityManager::JoinSession` may fling for an auto-join that found no app activity: the source's
 * `default_action_policy` must not be `kCastThisTab` (`StringToEnum<DefaultActionPolicy>` falls back to
 * `kCreateSession` for any other string).
 */
export function mayFling(defaultActionPolicy: string): boolean {
  return defaultActionPolicy !== "cast_this_tab";
}
