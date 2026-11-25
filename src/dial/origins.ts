// Which pages may see DIAL sinks for an app: `DialMediaRouteProvider::GetOrigins`
// (chrome/browser/media/router/providers/dial/dial_media_route_provider.cc) and `MediaSinksObserver::OnSinksUpdated`
// (components/media_router/browser/media_sinks_observer.cc), which hides the sinks from an observer whose origin is not
// in a non-empty list. Apps not in the table are open to every page.
const ALLOWLIST: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["youtube", [
    "https://music.youtube.com", "https://music-green-qa.youtube.com", "https://music-release-qa.youtube.com",
    "https://tv.youtube.com", "https://tv-green-qa.youtube.com", "https://tv-release-qa.youtube.com",
    "https://web-green-qa.youtube.com", "https://web-release-qa.youtube.com", "https://www.youtube.com",
  ]],
  ["netflix", ["https://www.netflix.com"]],
  ["pandora", ["https://www.pandora.com"]],
  ["radio", ["https://www.pandora.com"]],
  ["hulu", ["https://www.hulu.com"]],
  ["vimeo", ["https://www.vimeo.com"]],
  ["dailymotion", ["https://www.dailymotion.com"]],
  ["com.dailymotion", ["https://www.dailymotion.com"]],
];

/** The origins allowed for `appName` (matched case-insensitively, as DIAL devices do), or null for any origin. */
export function dialOriginsFor(appName: string): readonly string[] | null {
  const lower = appName.toLowerCase();
  for (const [name, origins] of ALLOWLIST) if (name === lower) return origins;
  return null;
}

/** True when a page at `origin` may see DIAL sinks for `appName`. */
export function dialOriginAllowed(appName: string, origin: string): boolean {
  const origins = dialOriginsFor(appName);
  return origins === null || origins.includes(origin);
}
