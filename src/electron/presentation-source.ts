// Which presentation URLs this library can serve, decided the way Chromium's Media Router decides what a source is.
// electron-cast launches receiver apps over Cast and DIAL; it does not mirror a tab or remote a media element. Chrome
// routes sources that name a Cast Streaming app, and `remote-playback:` sources, to code electron-cast does not have,
// so they must never be launched as ordinary apps. Pure module: no Electron imports.
import { parsePresentationUrl, type PresentationUrl } from "./presentation-envelope.ts";
import { parseCastMediaSource } from "./cast-media-source.ts";
import { appNameFromDialSource, isDialSource } from "../dial/parse.ts";

/**
 * The Cast Streaming receiver apps, `openscreen::cast::GetCastStreamingAppIds()` (cast/common/public/
 * cast_streaming_app_ids.cc in the openscreen repository, which Chromium vendors): audio and video, then audio only.
 */
export const CAST_STREAMING_APP_IDS: readonly string[] = ["0F5096E8", "85CDB22F"];

/** What a presentation URL is to the Cast provider. */
export type PresentationSourceKind =
  /** A receiver app launched by id: the only kind electron-cast serves. */
  | "cast_app"
  /** Names a Cast Streaming app: Chrome routes it to a `MirroringActivity`. */
  | "mirroring"
  /** `remote-playback:`, made by `HTMLMediaElement.remote`: Chrome serves it by media remoting. */
  | "remote_playback"
  /** `cast-dial:` (`MediaSource::IsDialSource`): an app launched on a DIAL sink by the DIAL provider. */
  | "dial"
  /** Anything else (invalid, unknown scheme, a plain web page). */
  | "other";

/**
 * The app ids `CastMediaSource::GetAppIds` lists for a Cast presentation URL, in order (see cast-media-source.ts). Null
 * when the URL is neither Cast form or names no app.
 */
export function castUrlAppIds(url: string): string[] | null {
  return parseCastMediaSource(url)?.appInfos.map((i) => i.appId) ?? null;
}

/**
 * `CastMediaSource::ContainsStreamingApp`: some app of the URL is a Cast Streaming app. The comparison is exact, as
 * `CastMediaSource::ContainsApp` is. A URL listing a streaming app next to ordinary ones is a mirroring source as a
 * whole, because Chrome decides per source and not per app.
 */
export function containsStreamingApp(url: string): boolean {
  const ids = castUrlAppIds(url);
  return ids !== null && ids.some((id) => CAST_STREAMING_APP_IDS.includes(id));
}

/** Classifies one presentation URL as Chrome's Cast provider would. */
export function classifyPresentationUrl(url: string): PresentationSourceKind {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "other";
  }
  // MediaSource::IsRemotePlaybackSource
  if (parsed.protocol === "remote-playback:") return "remote_playback";
  if (isDialSource(url)) return "dial";
  if (castUrlAppIds(url) === null) return "other";
  return containsStreamingApp(url) ? "mirroring" : "cast_app";
}

/** The URL a request is served from, with its parsed fields. */
export interface LaunchableUrl {
  url: string;
  parsed: PresentationUrl;
  /**
   * Set when the URL names a Cast Streaming app and the page's origin may initiate mirroring: the source is served by a
   * mirroring route (`CastActivityManager::DoLaunchSession`, `ContainsStreamingApp`), not by launching an app.
   */
  mirroring?: true;
}

/** A `cast-dial:` URL with the app it names (`MediaSource::AppNameFromDialSource`). */
export interface DialSourceUrl {
  url: string;
  app: string;
}

/**
 * The result of looking through a request's URLs for the ones to serve. A request can have a source for each kind of
 * sink: `dial` is set when DIAL is on and the request has a `cast-dial:` URL, and the sink the user picks decides
 * which of the two is used.
 */
export type SourceChoice =
  | ({ kind: "launch"; dial?: DialSourceUrl } & LaunchableUrl)
  /** Only a DIAL source can be served. */
  | { kind: "dial"; dial: DialSourceUrl }
  /** Every valid source needs mirroring or remoting: there is nothing to cast to, as for a source no sink serves. */
  | { kind: "no_sink" }
  /** No URL is one electron-cast understands. */
  | { kind: "unsupported" };

/**
 * Picks the URLs to launch. Chrome takes the sources of a request as a set and serves the first, in order, that the
 * chosen sink supports (`QueryResultManager`, `MediaRouterUI`), and a page is told a screen is available when any
 * source has one. A Cast sink supports a Cast app source and a DIAL sink a `cast-dial:` one, so this is the first
 * plain Cast app URL and, with `dial` on, the first `cast-dial:` URL naming a valid app; a mirroring or
 * `remote-playback:` entry never blocks an ordinary one next to it. With `mirroring` on (the page's origin may start
 * mirroring) a Cast Streaming URL competes with the ordinary ones in URL order. With DIAL off a `cast-dial:` URL is one nothing
 * here understands.
 */
export function chooseSource(urls: readonly string[], options: { dial?: boolean; mirroring?: boolean } = {}): SourceChoice {
  let unservable = false;
  let cast: LaunchableUrl | undefined;
  let dial: DialSourceUrl | undefined;
  for (const url of urls) {
    const kind = classifyPresentationUrl(url);
    if (kind === "mirroring" && options.mirroring === true) {
      // site-initiated mirroring (`IsSiteInitiatedMirroringSource`) for an origin `GetOrigins` allows: a source like any
      // other, served in URL order
      if (cast === undefined) {
        const parsed = parsePresentationUrl(url);
        if (parsed !== null) cast = { url, parsed, mirroring: true };
        else unservable = true;
      }
      continue;
    }
    if (kind === "mirroring" || kind === "remote_playback") {
      unservable = true;
      continue;
    }
    if (kind === "dial") {
      const app = options.dial === true && dial === undefined ? appNameFromDialSource(url) : "";
      if (app !== "") dial = { url, app };
      continue;
    }
    if (kind !== "cast_app" || cast !== undefined) continue;
    const parsed = parsePresentationUrl(url);
    if (parsed !== null) cast = { url, parsed };
  }
  if (cast !== undefined) return { kind: "launch", ...cast, ...(dial === undefined ? {} : { dial }) };
  if (dial !== undefined) return { kind: "dial", dial };
  return unservable ? { kind: "no_sink" } : { kind: "unsupported" };
}
