// Which displays are sinks, and which presentation URLs they serve, decided the way Chromium's
// WiredDisplayMediaRouteProvider decides (chrome/browser/media/router/providers/wired_display/
// wired_display_media_route_provider.cc). Pure module: no Electron imports.

/** The part of an Electron `Rectangle` used here. */
export interface RectLike { x: number; y: number; width: number; height: number }

/** The part of an Electron `Display` used here (`display::Display`). */
export interface DisplayLike { id: number; bounds: RectLike }

/** `media_router::MediaSink` of the wired display provider (`SinkIconType::WIRED_DISPLAY`, `MediaRouteProviderId::WIRED_DISPLAY`). */
export interface WiredDisplaySink {
  /** `WiredDisplayMediaRouteProvider::GetSinkIdForDisplay`: `wired_display_<display id>`. */
  id: string;
  providerId: "wired_display";
  /** `IDS_MEDIA_ROUTER_WIRED_DISPLAY_SINK_NAME`: `Display <n>`, n counting from 1 in {@link availableDisplays} order. */
  name: string;
  /** Chrome's MediaSink has none; kept empty so the shape matches the Cast and DIAL sinks. */
  description: string;
  iconType: "wired_display";
  /** The display behind the sink. */
  display: DisplayLike;
}

/** `GetSinkIdForDisplay`. */
export function sinkIdForDisplay(display: DisplayLike): string {
  return `wired_display_${display.id}`;
}

/** `CompareDisplays`: the primary display first, then top to bottom, then left to right. */
function compareDisplays(primaryId: number, a: DisplayLike, b: DisplayLike): number {
  if (b.id === primaryId) return a.id === primaryId ? 0 : 1;
  if (a.id === primaryId) return -1;
  if (a.bounds.y !== b.bounds.y) return a.bounds.y < b.bounds.y ? -1 : 1;
  if (a.bounds.x !== b.bounds.x) return a.bounds.x < b.bounds.x ? -1 : 1;
  return 0;
}

function sameBounds(a: RectLike, b: RectLike): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * `GetAvailableDisplays`: none when there is one display (the user must not present to the only screen), else all
 * displays, sorted, without those that mirror the primary display (same bounds), and none when only the primary is left.
 * The display the controller's window is on is not removed here: Chrome hides that sink in `MediaRouterUI`, not in the
 * provider, so a page's availability still counts it.
 */
export function availableDisplays(all: readonly DisplayLike[], primary: DisplayLike): DisplayLike[] {
  if (all.length <= 1) return [];
  const sorted = [...all].sort((a, b) => compareDisplays(primary.id, a, b));
  const kept = sorted.filter((d) => d.id === primary.id || !sameBounds(d.bounds, primary.bounds));
  return kept.length === 1 ? [] : kept;
}

/** `CreateSinkForDisplay` for every available display. */
export function wiredDisplaySinks(all: readonly DisplayLike[], primary: DisplayLike): WiredDisplaySink[] {
  return availableDisplays(all, primary).map((display, i) => ({
    id: sinkIdForDisplay(display),
    providerId: "wired_display" as const,
    name: `Display ${i + 1}`,
    description: "",
    iconType: "wired_display" as const,
    display: { id: display.id, bounds: { ...display.bounds } },
  }));
}

/** `kLegacyCastPresentationUrlPrefix` (components/media_router/common/media_source.h). */
const LEGACY_CAST_PREFIX = "https://google.com/cast#__castAppId__=";

/** `net::IsLocalhost`: a loopback IP literal, `localhost` or `*.localhost` (net/base/url_util.cc), a trailing dot ignored. */
function isLocalhost(url: URL): boolean {
  let host = url.hostname;
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (/^127(\.\d{1,3}){3}$/.test(host) || host === "::1") return true;
  if (host.endsWith(".")) host = host.slice(0, -1);
  host = host.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * `IsValidStandardPresentationSource` (components/media_router/common/media_source.cc): the only sources the provider
 * serves. An https URL that is not the legacy Cast form, or an http URL on localhost. Everything else (file:, cast:,
 * invalid URLs) is ignored, so a page asking about it is told no display is available.
 */
export function isWiredDisplaySource(source: string): boolean {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return !url.href.toLowerCase().startsWith(LEGACY_CAST_PREFIX.toLowerCase());
  if (url.protocol === "http:") return isLocalhost(url);
  return false;
}

/** `WiredDisplayMediaRouteProvider::GetRouteDescription`: `IDS_MEDIA_ROUTER_PRESENTATION_ROUTE_DESCRIPTION`, `Presenting (<host>)`. */
export function routeDescription(mediaSource: string): string {
  let host = "";
  try {
    host = new URL(mediaSource).hostname;
  } catch {
    // an invalid URL has an empty origin host
  }
  return `Presenting (${host})`;
}
