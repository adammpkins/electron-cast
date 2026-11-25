/**
 * What Chrome tells a receiver about the sender, in CONNECT and LAUNCH. Chrome fills these from the browser
 * (embedder_support::GetUserAgent, version_info::GetVersionNumber, the application locale; see
 * chrome/browser/media/router/providers/cast/chrome_cast_message_handler.cc); here they come from the running
 * Electron/Node process, which is the nearest thing to "the browser".
 */
export interface SenderIdentity {
  /** `embedder_support::GetUserAgent()`. */
  userAgent: string;
  /** `version_info::GetVersionNumber()`, for example `138.0.7204.100`. */
  browserVersion: string;
  /** `g_browser_process->GetApplicationLocale()`, sent as LAUNCH `language`. */
  locale: string;
  /**
   * cast_message_util.cc `GetVirtualConnectPlatformValue()`: the Platform enum of metrics_proto/cast_logs.proto
   * (Windows 3, macOS 4, ChromeOS 5, Linux 6, anything else 0).
   */
  platform: number;
}

/**
 * Chrome's desktop "unified platform" token, embedder_support/user_agent_utils.cc `GetUnifiedPlatform()`. The reduced
 * user agent (`Chrome/<major>.0.0.0`) carries it on every desktop OS.
 */
function unifiedPlatform(platform: NodeJS.Platform): string {
  if (platform === "win32") return "Windows NT 10.0; Win64; x64";
  if (platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  return "X11; Linux x86_64";
}

/** `GetVirtualConnectPlatformValue()`. */
function platformValue(platform: NodeJS.Platform): number {
  if (platform === "win32") return 3;
  if (platform === "darwin") return 4;
  if (platform === "linux") return 6;
  return 0;
}

/** The identity a Chrome on this machine would send. Plain Node has no Chrome version; it sends an empty one. */
export function chromeSenderIdentity(
  platform: NodeJS.Platform = process.platform,
  chromeVersion: string = process.versions.chrome ?? "",
  locale: string = defaultLocale(),
): SenderIdentity {
  const major = chromeVersion.split(".")[0] ?? "";
  // user_agent_utils.cc BuildUserAgentFromOSAndProduct
  const userAgent = `Mozilla/5.0 (${unifiedPlatform(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major === "" ? "0" : major}.0.0.0 Safari/537.36`;
  return { userAgent, browserVersion: chromeVersion, locale, platform: platformValue(platform) };
}

function defaultLocale(): string {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "en-US";
  }
}

/** cast_message_util.cc `VirtualConnectionType`: `kStrong` is 0, `kInvisible` is 2 (`kWeak` is unused). */
export const VIRTUAL_CONNECTION_STRONG = 0;
export const VIRTUAL_CONNECTION_INVISIBLE = 2;

/** `kVirtualConnectSdkType`. */
const SDK_TYPE = 2;
/** `kVirtualConnectTypeLocal` (CONNECTION_TYPE_LOCAL), the only connection type Chrome uses. */
const CONNECTION_TYPE_LOCAL = 1;

/**
 * The fields of CONNECT, cast_message_util.cc `CreateVirtualConnectionRequest`. `systemVersion` is what sits in the
 * first pair of parentheses of the user agent, and is left out when there is none.
 */
export function connectFields(identity: SenderIdentity, connType: number): Record<string, unknown> {
  let systemVersion = "";
  const start = identity.userAgent.indexOf("(");
  if (start !== -1) {
    const end = identity.userAgent.indexOf(")", start + 1);
    if (end !== -1) systemVersion = identity.userAgent.slice(start + 1, end);
  }
  const senderInfo: Record<string, unknown> = {
    sdkType: SDK_TYPE,
    version: identity.browserVersion,
    browserVersion: identity.browserVersion,
    platform: identity.platform,
    connectionType: CONNECTION_TYPE_LOCAL,
  };
  if (systemVersion !== "") senderInfo.systemVersion = systemVersion;
  return { userAgent: identity.userAgent, connType, origin: {}, senderInfo };
}

/** `GetConnectionType`: the platform receiver gets a strong connection (LAUNCH is refused on an invisible one), any other an invisible one. */
export function connectionTypeFor(destinationId: string): number {
  return destinationId === "receiver-0" ? VIRTUAL_CONNECTION_STRONG : VIRTUAL_CONNECTION_INVISIBLE;
}
