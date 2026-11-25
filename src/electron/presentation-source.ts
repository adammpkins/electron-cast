// Which presentation URLs this library can serve, decided the way Chromium's Cast provider decides what a source is.
// electron-cast launches receiver apps; it does not mirror a tab or remote a media element. Chrome routes sources that
// name a Cast Streaming app, and `remote-playback:` sources, to code electron-cast does not have, so they must never be
// launched as ordinary apps. Pure module: no Electron imports.
import { parsePresentationUrl, type PresentationUrl } from "./presentation-envelope.ts";

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
  /** Anything else (invalid, unknown scheme, a plain web page, DIAL). */
  | "other";

const LEGACY_PREFIX = "https://google.com/cast#";

/** `base::UnescapeURLComponent` with the rules `ParseLegacyCastUrl` uses, close enough for app ids. */
function unescape(value: string): string {
  const spaced = value.replace(/\+/g, " ");
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/**
 * The app ids `CastMediaSource::FromMediaSource` reads from a Cast presentation URL, in order: the path of a `cast:`
 * URL (`ParseCastUrl`), or every `__castAppId__` of the legacy `https://google.com/cast#...` form with its `(caps)`
 * suffix cut off (`ParseLegacyCastUrl`, which lets one URL list several apps). Null when the URL is neither form or
 * names no app.
 */
export function castUrlAppIds(url: string): string[] | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === "cast:") {
    // GURL::GetPath of `cast:ID?query` is `ID`
    const id = unescape(parsed.pathname);
    return id === "" ? null : [id];
  }
  // IsLegacyCastPresentationUrl: a case-insensitive prefix of the canonical spec
  if (!parsed.href.toLowerCase().startsWith(LEGACY_PREFIX)) return null;
  const ids: string[] = [];
  for (const pair of parsed.hash.slice(1).split("/")) {
    const eq = pair.indexOf("=");
    if (eq === -1 || pair.slice(0, eq) !== "__castAppId__") continue;
    const value = unescape(pair.slice(eq + 1));
    const paren = value.indexOf("(");
    const id = paren === -1 ? value : value.slice(0, paren);
    if (id !== "") ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * `CastMediaSource::ContainsStreamingApp`: some app of the URL is a Cast Streaming app. The comparison is exact, as
 * `CastMediaSource::ContainsApp` is. A URL listing a streaming app next to ordinary ones is a mirroring source as a
 * whole, because Chrome decides per source and not per app.
 */
export function containsStreamingApp(url: string): boolean {
  const ids = castUrlAppIds(url);
  if (ids !== null && ids.some((id) => CAST_STREAMING_APP_IDS.includes(id))) return true;
  // electron-cast's own reading of the URL must not reach a streaming app either (it splits `ID(caps)` in a `cast:` path)
  const own = parsePresentationUrl(url);
  return own !== null && CAST_STREAMING_APP_IDS.includes(own.appId);
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
  if (castUrlAppIds(url) === null) return "other";
  return containsStreamingApp(url) ? "mirroring" : "cast_app";
}

/** The URL a request is served from, with its parsed fields. */
export interface LaunchableUrl {
  url: string;
  parsed: PresentationUrl;
}

/** The result of looking through a request's URLs for the one to serve. */
export type SourceChoice =
  | ({ kind: "launch" } & LaunchableUrl)
  /** Every valid source needs mirroring or remoting: there is nothing to cast to, as for a source no sink serves. */
  | { kind: "no_sink" }
  /** No URL is one electron-cast understands. */
  | { kind: "unsupported" };

/**
 * Picks the URL to launch. Chrome takes the sources of a request as a set and serves the first, in order, that the
 * chosen sink supports (`QueryResultManager`, `MediaRouterUI`), and a page is told a screen is available when any
 * source has one. With no mirroring or remoting here, that is the first plain Cast app URL: a mirroring or
 * `remote-playback:` entry never blocks an ordinary one next to it.
 */
export function chooseSource(urls: readonly string[]): SourceChoice {
  let unservable = false;
  for (const url of urls) {
    const kind = classifyPresentationUrl(url);
    if (kind === "mirroring" || kind === "remote_playback") {
      unservable = true;
      continue;
    }
    if (kind !== "cast_app") continue;
    const parsed = parsePresentationUrl(url);
    if (parsed !== null) return { kind: "launch", url, parsed };
  }
  return unservable ? { kind: "no_sink" } : { kind: "unsupported" };
}
