// Pure parsing for DIAL: the SSDP response, the UPnP device description, the app info document and `cast-dial:`
// sources. Each function says which Chromium function it follows (paths are relative to the Chromium source root).
import { childrenNamed, parseXml, type XmlElement } from "./xml.ts";

/** `kCastDialPresentationUrlScheme` (components/media_router/common/media_source.h). */
export const DIAL_SCHEME = "cast-dial";

/** What an SSDP answer names: `DialDeviceData` (chrome/browser/media/router/discovery/dial/dial_device_data.h). */
export interface DialDeviceData {
  /** The USN header. */
  deviceId: string;
  /** Assigned by the registry; unique for its lifetime. Empty until then. */
  label: string;
  /** The address the answer came from. */
  ipAddress: string;
  descriptionUrl: string;
  /** Epoch milliseconds of the answer. */
  responseTime: number;
  /** Seconds from the CACHE-CONTROL max-age directive, capped; null when absent. */
  maxAge: number | null;
  configId: number | null;
}

export interface ParsedDialDeviceDescription {
  uniqueId: string;
  friendlyName: string;
  modelName: string;
  deviceType: string;
  appUrl: string;
}

export type DialAppState = "unknown" | "running" | "stopped";

/** `ParsedDialAppInfo` (parsed_dial_app_info.h). */
export interface ParsedDialAppInfo {
  dialVersion: string;
  name: string;
  allowStop: boolean;
  state: DialAppState;
  href: string;
  extraData: Record<string, string>;
}

/** `DialAppInfoResultCode` as the SDK sees it in an error message (dial_internal_message_util.cc, DialAppInfoErrorToString). */
export type DialAppInfoResultCode = "ok" | "network_error" | "parsing_error" | "http_error";

/** `DialAppInfoResult` (dial_app_discovery_service.h). */
export interface DialAppInfoResult {
  appInfo: ParsedDialAppInfo | null;
  resultCode: DialAppInfoResultCode;
  errorMessage: string;
  httpErrorCode?: number;
}

/** Highest max-age honoured (`kSsdpMaxMaxAge`, dial_service_impl.cc). */
export const SSDP_MAX_MAX_AGE = 3600;
/** `kSsdpMaxConfigId` is `(2 << 24) - 1` (dial_service_impl.cc). */
const SSDP_MAX_CONFIG_ID = (2 << 24) - 1;

/**
 * Not publicly routable IPv4 ranges, after `net::IPAddress::IsPubliclyRoutable` (net/base/ip_address.cc): private,
 * loopback, link-local, shared, documentation, benchmarking, multicast and reserved space.
 */
const NON_PUBLIC_V4: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

function v4ToInt(address: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (m === null) return null;
  const parts = [m[1]!, m[2]!, m[3]!, m[4]!].map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** True when `address` is an IPv4 address that is not publicly routable (`!IsPubliclyRoutable`). */
export function isPrivateV4(address: string): boolean {
  const value = v4ToInt(address);
  if (value === null) return false;
  return NON_PUBLIC_V4.some(([base, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return ((value & mask) >>> 0) === base;
  });
}

/**
 * `DialDeviceData::IsValidUrl` (dial_device_data.cc): an http(s) URL whose host is the IP address the device answered
 * from, and that address is not publicly routable. A DIAL device cannot point the browser at another host.
 */
export function isValidDeviceUrl(url: string, ipAddress: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname;
  if (v4ToInt(host) === null || !isPrivateV4(host)) return false;
  return host === ipAddress;
}

/** `MediaSinkInternal::ProcessDeviceUUID` (components/media_router/common/discovery/media_sink_internal.cc). */
export function processDeviceUuid(uuid: string): string {
  if (uuid === "") return "";
  const bare = uuid.startsWith("uuid:") ? uuid.slice(5) : uuid;
  return bare.replaceAll("-", "").toLowerCase();
}

/**
 * `DialServiceImpl::DialSocket::ParseResponse` (chrome/browser/media/router/discovery/dial/dial_service_impl.cc): an
 * answer needs complete headers, a LOCATION that is a valid device URL for the sender, and a USN. The ST header is not
 * checked, as in Chromium.
 */
export function parseSsdpResponse(packet: string, fromAddress: string, now: number): DialDeviceData | null {
  const end = /\r?\n\r?\n/.exec(packet);
  if (end === null) return null;
  const lines = packet.slice(0, end.index).split(/\r?\n/);
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toUpperCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  const location = headers.get("LOCATION");
  if (location === undefined || location === "" || !isValidDeviceUrl(location, fromAddress)) return null;
  const usn = headers.get("USN");
  if (usn === undefined || usn === "") return null;
  let maxAge: number | null = null;
  const cacheControl = headers.get("CACHE-CONTROL");
  if (cacheControl !== undefined && cacheControl !== "") {
    const directive = cacheControl.split("=").map((s) => s.trim()).filter((s) => s !== "");
    if (directive.length === 2 && directive[0]!.toLowerCase() === "max-age" && /^[+-]?\d+$/.test(directive[1]!)) {
      const age = Number(directive[1]);
      if (age > 0) maxAge = Math.min(age, SSDP_MAX_MAX_AGE);
    }
  }
  let configId: number | null = null;
  const config = headers.get("CONFIGID.UPNP.ORG");
  if (config !== undefined && /^[+-]?\d+$/.test(config)) {
    const id = Number(config);
    if (id > 0 && id <= SSDP_MAX_CONFIG_ID) configId = id;
  }
  return { deviceId: usn, label: "", ipAddress: fromAddress, descriptionUrl: location, responseTime: now, maxAge, configId };
}

/** The M-SEARCH request (`BuildRequest`, dial_service_impl.cc); the extra blank line is Chromium's. */
export function buildSearchRequest(userAgent: string): string {
  return "M-SEARCH * HTTP/1.1\r\n"
    + "HOST: 239.255.255.250:1900\r\n"
    + "MAN: \"ssdp:discover\"\r\n"
    + "MX: 1\r\n"
    + "ST: urn:dial-multiscreen-org:service:dial:1\r\n"
    + `USER-AGENT: ${userAgent}\r\n`
    + "\r\n";
}

export type DeviceDescriptionError =
  | "invalid_xml" | "missing_unique_id" | "missing_friendly_name" | "missing_app_url" | "invalid_app_url";

function firstChild(parent: XmlElement, name: string): XmlElement | undefined {
  return parent.children.find((c) => c.name === name);
}

/** `ComputeFriendlyName` (safe_dial_device_description_parser.cc): the model and the UDN's last four characters. */
function computeFriendlyName(uniqueId: string, modelName: string): string {
  if (modelName === "" || uniqueId.length < 4) return "";
  return `${modelName} [${uniqueId.slice(-4)}]`;
}

/**
 * `SafeDialDeviceDescriptionParser::OnXmlParsingDone` plus `ValidateParsedDeviceDescription`
 * (device_description_service.cc): `<root><device>` with UDN, friendlyName, modelName and deviceType; the Application-URL
 * header supplies the app URL, which must be valid for the device.
 */
export function parseDeviceDescription(
  xml: string,
  appUrl: string,
  ipAddress: string,
): { ok: true; value: ParsedDialDeviceDescription } | { ok: false; error: DeviceDescriptionError } {
  const root = parseXml(xml);
  if (root === null || root.name !== "root") return { ok: false, error: "invalid_xml" };
  const devices = childrenNamed(root, "device");
  if (devices.length !== 1) return { ok: false, error: "invalid_xml" };
  const device = devices[0]!;
  // A field that is absent reads as empty; one that is present without text is a parse failure.
  const field = (name: string): string | null => {
    const el = firstChild(device, name);
    return el === undefined ? "" : el.text;
  };
  const uniqueId = field("UDN");
  const friendly = field("friendlyName");
  const model = field("modelName");
  const type = field("deviceType");
  if (uniqueId === null || friendly === null || model === null || type === null) return { ok: false, error: "invalid_xml" };
  const friendlyName = friendly === "" ? computeFriendlyName(uniqueId, model) : friendly;
  if (uniqueId === "") return { ok: false, error: "missing_unique_id" };
  if (friendlyName === "") return { ok: false, error: "missing_friendly_name" };
  if (appUrl === "") return { ok: false, error: "missing_app_url" };
  if (!isValidDeviceUrl(appUrl, ipAddress)) return { ok: false, error: "invalid_app_url" };
  return { ok: true, value: { uniqueId, friendlyName, modelName: model, deviceType: type, appUrl } };
}

/** `ParseDialAppState`: case-insensitive; anything else is unknown. */
function parseAppState(value: string): DialAppState {
  const lower = value.toLowerCase();
  return lower === "running" ? "running" : lower === "stopped" ? "stopped" : "unknown";
}

/**
 * `SafeDialAppInfoParser::OnXmlParsingDone` (safe_dial_app_info_parser.cc): one `<service>` with a name and a known
 * state. `<options allowStop>`, `<link href>` and `<additionalData>` children are read; other elements are ignored.
 */
export function parseAppInfo(xml: string): ParsedDialAppInfo | null {
  const service = parseXml(xml);
  if (service === null || service.name !== "service") return null;
  const info: ParsedDialAppInfo = {
    dialVersion: service.attributes.dialVer ?? "",
    name: "",
    allowStop: true,
    state: "unknown",
    href: "",
    extraData: {},
  };
  for (const child of service.children) {
    switch (child.name) {
      case "name":
        if (child.text === null) return null;
        info.name = child.text;
        break;
      case "options":
        info.allowStop = child.attributes.allowStop !== "false";
        break;
      case "link":
        info.href = child.attributes.href ?? "";
        break;
      case "state":
        if (child.text === null) return null;
        info.state = parseAppState(child.text);
        break;
      case "additionalData":
        for (const extra of child.children) {
          if (extra.text !== null) info.extraData[extra.name] = extra.text;
        }
        break;
      default:
        break;
    }
  }
  return info.name === "" || info.state === "unknown" ? null : info;
}

/**
 * `IsDialAppName` (media_source.cc): non-empty, not a dot segment, and only letters, digits and `-._~`, so that
 * resolving it cannot leave the device's Application-URL.
 */
export function isDialAppName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  return /^[A-Za-z0-9\-._~]+$/.test(name);
}

/** `GetDialAppUrl` (media_source.cc): the app URL with a trailing slash, resolved against the app name; null if invalid. */
export function getDialAppUrl(appUrl: string, appName: string): string | null {
  if (!isDialAppName(appName)) return null;
  try {
    const base = new URL(appUrl);
    const spec = base.href.endsWith("/") ? base.href : `${base.href}/`;
    return new URL(appName, spec).href;
  } catch {
    return null;
  }
}

function dialUrl(source: string): URL | null {
  try {
    const url = new URL(source);
    return url.protocol === `${DIAL_SCHEME}:` ? url : null;
  } catch {
    return null;
  }
}

/** True for a `cast-dial:` source (`MediaSource::IsDialSource`). */
export function isDialSource(source: string): boolean {
  return dialUrl(source) !== null;
}

/** `MediaSource::AppNameFromDialSource`: the path of a `cast-dial:` source when it is a valid app name, else "". */
export function appNameFromDialSource(source: string): string {
  const url = dialUrl(source);
  if (url === null) return "";
  return isDialAppName(url.pathname) ? url.pathname : "";
}

/**
 * The launch fields `DialActivity::From` reads from a `cast-dial:` source (dial_activity_manager.cc): the app name, the
 * required `clientId` and the optional `dialPostData`. `net::QueryIterator::GetValue` is the value as written, not
 * unescaped, and a repeated key keeps its last value; both are followed.
 */
export function parseDialLaunchSource(source: string): { appName: string; clientId: string; postData: string | null } | null {
  const url = dialUrl(source);
  if (url === null) return null;
  const appName = appNameFromDialSource(source);
  if (appName === "") return null;
  let clientId = "";
  let postData: string | null = null;
  const query = url.search.startsWith("?") ? url.search.slice(1) : "";
  for (const part of query === "" ? [] : query.split("&")) {
    const eq = part.indexOf("=");
    const key = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? "" : part.slice(eq + 1);
    if (key === "clientId") clientId = value;
    else if (key === "dialPostData") postData = value;
  }
  return clientId === "" ? null : { appName, clientId, postData };
}
