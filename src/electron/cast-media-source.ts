// A Cast presentation URL read the way Chromium reads it: `CastMediaSource::FromMediaSourceId`
// (components/media_router/common/providers/cast/cast_media_source.cc), including its `ParseCastUrl`,
// `ParseLegacyCastUrl` and `CreateFromURLParams`. Pure module: no Electron imports.
//
// The field names are Chrome's (`CastMediaSource` accessors), in camelCase.

/** `cast_channel::CastDeviceCapability`, the bit values the `ca` TXT record uses (cast_device_capability.h). */
export const CAST_DEVICE_CAPABILITY = {
  video_out: 1 << 0,
  video_in: 1 << 1,
  audio_out: 1 << 2,
  audio_in: 1 << 3,
  dev_mode: 1 << 4,
  multizone_group: 1 << 5,
} as const;

/** `cast_channel::ReceiverAppType` as written in LAUNCH `supportedAppTypes` (the `EnumTable<ReceiverAppType>` names). */
export type ReceiverAppType = "OTHER" | "WEB" | "ANDROID_TV";

/** `media_router::AutoJoinPolicy` (the `EnumTable<AutoJoinPolicy>` names). */
export type AutoJoinPolicy = "page_scoped" | "tab_and_origin_scoped" | "origin_scoped";

/** `media_router::DefaultActionPolicy` (the `EnumTable<DefaultActionPolicy>` names). */
export type DefaultActionPolicy = "create_session" | "cast_this_tab";

/** `media_router::CastAppInfo`: an app and the capabilities a sink needs to run it. */
export interface CastAppInfo {
  appId: string;
  /** `CastAppInfo::required_capabilities` as a bit set of {@link CAST_DEVICE_CAPABILITY}. */
  requiredCapabilities: number;
  /** The names that made `requiredCapabilities`, in the URL's order, unknown names dropped. */
  capabilities: string[];
}

/** The `media_router::CastMediaSource` of a Cast presentation URL. */
export interface CastMediaSourceInfo {
  /** `app_infos()`, in URL order; never empty. */
  appInfos: CastAppInfo[];
  /** `auto_join_policy()`: `page_scoped` unless the URL names one of the three policies. */
  autoJoinPolicy: AutoJoinPolicy;
  /** `default_action_policy()`: `create_session` unless the URL names `cast_this_tab`. */
  defaultActionPolicy: DefaultActionPolicy;
  /** `client_id()`; null when the URL has none (Chrome's empty string). */
  clientId: string | null;
  /**
   * `launch_timeout()` in ms when the URL sets a positive one; null otherwise, where Chrome uses
   * `kDefaultLaunchTimeout` (60 s).
   */
  launchTimeout: number | null;
  /** `target_playout_delay()` in ms (`streamingTargetPlayoutDelayMillis`, a `cast:` URL only); null when unset. */
  targetPlayoutDelayMillis: number | null;
  /** `site_requested_audio_capture()`: false only for `streamingCaptureAudio=0` (a `cast:` URL only). */
  siteRequestedAudioCapture: boolean;
  /** `supported_app_types()`: LAUNCH `supportedAppTypes`; `["WEB"]` unless `supportedAppTypes` names some (`cast:` only). */
  supportedAppTypes: ReceiverAppType[];
  /** `app_params()`: LAUNCH `appParams`, "" when absent (`cast:` only). */
  appParams: string;
  /** `connection_type()`: `invisible` for `invisibleSender=true` (`cast:` only), else `strong`. */
  connectionType: "strong" | "invisible";
}

/** `kMaxCastPresentationUrlLength`. */
const MAX_URL_LENGTH = 64 * 1024;
/** `kLegacyCastPresentationUrlPrefix` (media_source.cc). */
const LEGACY_PREFIX = "https://google.com/cast#";

const AUTO_JOIN_POLICIES: readonly string[] = ["page_scoped", "tab_and_origin_scoped", "origin_scoped"];
const DEFAULT_ACTION_POLICIES: readonly string[] = ["create_session", "cast_this_tab"];
const APP_TYPES: readonly string[] = ["OTHER", "WEB", "ANDROID_TV"];

/** `CastMediaSource::ChooseAppId`'s test: a sink runs an app when it has every capability the app requires. */
export function sinkSupportsApp(sinkCapabilities: number, info: CastAppInfo): boolean {
  return (sinkCapabilities & info.requiredCapabilities) === info.requiredCapabilities;
}

/**
 * `CastActivityManager::ChooseAppId` for a URL's apps: the first one the sink can run, else the first one.
 */
export function chooseAppInfo(infos: readonly CastAppInfo[], sinkCapabilities: number): CastAppInfo {
  return infos.find((i) => sinkSupportsApp(sinkCapabilities, i)) ?? infos[0]!;
}

// ---- base::UnescapeURLComponent ---------------------------------------------------------------------------------------
// base/strings/escape.cc, with the rules both parsers use: SPACES | PATH_SEPARATORS |
// URL_SPECIAL_CHARS_EXCEPT_PATH_SEPARATORS | REPLACE_PLUS_WITH_SPACE.

/** Code points `ShouldUnescapeCodePoint` keeps escaped (BiDi controls, spoofable symbols, spaces, invisible format chars). */
function isBannedCodePoint(c: number): boolean {
  return c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) || c === 0x061c || (c >= 0x2066 && c <= 0x2069)
    || c === 0x1f50f || c === 0x1f510 || c === 0x1f512 || c === 0x1f513
    || c === 0x0085 || c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029
    || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0x2800
    || c === 0x00ad || c === 0x034f || (c >= 0x0600 && c <= 0x0605) || c === 0x06dd || c === 0x070f || c === 0x08e2
    || c === 0x115f || c === 0x1160 || c === 0x17b4 || c === 0x17b5 || (c >= 0x180b && c <= 0x180e)
    || c === 0x200b || c === 0x200c || c === 0x200d || (c >= 0x2060 && c <= 0x2065) || (c >= 0x206a && c <= 0x206f)
    || c === 0x3164 || (c >= 0xfff0 && c <= 0xfff8) || (c >= 0xfe00 && c <= 0xfe0f) || c === 0xfeff || c === 0xffa0
    || c === 0xfff9 || c === 0xfffa || c === 0xfffb || c === 0x110bd || c === 0x110cd
    || (c >= 0x13430 && c <= 0x13438) || (c >= 0x1bca0 && c <= 0x1bca3) || (c >= 0x1d173 && c <= 0x1d17a)
    || (c >= 0xe0000 && c <= 0xe0fff);
}

function hexByteAt(s: string, i: number): number | null {
  if (i + 2 >= s.length || s[i] !== "%") return null;
  const hex = s.slice(i + 1, i + 3);
  return /^[0-9A-Fa-f]{2}$/.test(hex) ? parseInt(hex, 16) : null;
}

/** Decodes one UTF-8 sequence from `bytes` (strict, like ReadUnicodeCharacter), or null. */
function decodeUtf8(bytes: number[]): { codePoint: number; length: number } | null {
  const b0 = bytes[0]!;
  if (b0 < 0x80) return { codePoint: b0, length: 1 };
  const need = b0 >= 0xf0 && b0 <= 0xf4 ? 4 : b0 >= 0xe0 ? 3 : b0 >= 0xc2 && b0 < 0xe0 ? 2 : 0;
  if (need === 0 || b0 > 0xf4 || bytes.length < need) return null;
  let cp = b0 & (need === 2 ? 0x1f : need === 3 ? 0x0f : 0x07);
  for (let k = 1; k < need; k++) {
    const b = bytes[k]!;
    if ((b & 0xc0) !== 0x80) return null;
    cp = (cp << 6) | (b & 0x3f);
  }
  const min = need === 2 ? 0x80 : need === 3 ? 0x800 : 0x10000;
  if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
  return { codePoint: cp, length: need };
}

/**
 * `base::UnescapeURLComponent(value, SPACES | PATH_SEPARATORS | URL_SPECIAL_CHARS_EXCEPT_PATH_SEPARATORS |
 * REPLACE_PLUS_WITH_SPACE)`: `%XX` becomes its byte (control bytes stay escaped; so do the spoofable and invisible
 * Unicode characters), a `+` becomes a space, and a lone invalid byte is unescaped as it is. Bytes are read as UTF-8.
 */
export function unescapeUrlComponent(text: string): string {
  const out: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < text.length;) {
    const first = hexByteAt(text, i);
    if (first === null) {
      // not escaped here: keep the (possibly non-ASCII) character as UTF-8
      const cp = text.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      if (ch === "+") out.push(0x20);
      else out.push(...enc.encode(ch));
      i += ch.length;
      continue;
    }
    // collect trail bytes of a lead byte, as UnescapeUTF8CharacterAtIndex does
    const bytes = [first];
    if (first >= 0xc0) {
      while (bytes.length < 4) {
        const next = hexByteAt(text, i + bytes.length * 3);
        if (next === null || (next & 0xc0) !== 0x80) break;
        bytes.push(next);
      }
    }
    const decoded = decodeUtf8(bytes);
    if (decoded === null) {
      out.push(first);
      i += 3;
      continue;
    }
    const { codePoint, length } = decoded;
    const keep = codePoint < 0x80 ? codePoint < 0x20 : isBannedCodePoint(codePoint);
    if (keep) out.push(...enc.encode(text.slice(i, i + length * 3)));
    else out.push(...bytes.slice(0, length));
    i += length * 3;
  }
  return new TextDecoder().decode(Uint8Array.from(out));
}

// ---- parameter parsing ------------------------------------------------------------------------------------------------

/** `CastDeviceCapabilitiesFromString`: a comma list of capability names (`KEEP_WHITESPACE`, `SPLIT_WANT_NONEMPTY`). */
function capabilitiesFromString(s: string): { names: string[]; bits: number } {
  const names: string[] = [];
  let bits = 0;
  for (const name of s.split(",")) {
    if (name === "" || !Object.hasOwn(CAST_DEVICE_CAPABILITY, name)) continue; // unknown names are logged and skipped
    const bit = CAST_DEVICE_CAPABILITY[name as keyof typeof CAST_DEVICE_CAPABILITY];
    if ((bits & bit) === 0) names.push(name);
    bits |= bit;
  }
  return { names, bits };
}

/** `SupportedAppTypesFromString`. */
function supportedAppTypesFromString(s: string): ReceiverAppType[] {
  return s.split(",").filter((t) => t !== "" && APP_TYPES.includes(t)) as ReceiverAppType[];
}

/** `base::StringToInt` for a positive value: an optional sign and decimal digits only, within int32. */
function positiveInt(raw: string): number | null {
  if (!/^[+-]?\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && n <= 2147483647 ? n : null;
}

interface RawParams {
  autoJoinPolicy: string;
  defaultActionPolicy: string;
  clientId: string;
  launchTimeout: string;
  targetPlayoutDelayMillis: string;
  streamingCaptureAudio: string;
  supportedAppTypes: ReceiverAppType[];
  appParams: string;
  invisibleSender: string;
}

/** `CreateFromURLParams`. */
function createFromParams(appInfos: CastAppInfo[], p: RawParams): CastMediaSourceInfo | null {
  if (appInfos.length === 0) return null;
  return {
    appInfos,
    autoJoinPolicy: AUTO_JOIN_POLICIES.includes(p.autoJoinPolicy) ? (p.autoJoinPolicy as AutoJoinPolicy) : "page_scoped",
    defaultActionPolicy: DEFAULT_ACTION_POLICIES.includes(p.defaultActionPolicy)
      ? (p.defaultActionPolicy as DefaultActionPolicy)
      : "create_session",
    clientId: p.clientId === "" ? null : p.clientId,
    launchTimeout: positiveInt(p.launchTimeout),
    targetPlayoutDelayMillis: positiveInt(p.targetPlayoutDelayMillis),
    siteRequestedAudioCapture: p.streamingCaptureAudio !== "0",
    supportedAppTypes: p.supportedAppTypes.length > 0 ? p.supportedAppTypes : ["WEB"],
    appParams: p.appParams,
    connectionType: p.invisibleSender === "true" ? "invisible" : "strong",
  };
}

/** `MakeQueryMap`: `net::QueryIterator` keys are not unescaped, values are, and the last of a repeated key wins. */
function queryMap(search: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const segment of search.replace(/^\?/, "").split("&")) {
    if (segment === "") continue; // url::ExtractQueryKeyValue skips empty segments
    const eq = segment.indexOf("=");
    map.set(eq === -1 ? segment : segment.slice(0, eq), eq === -1 ? "" : unescapeUrlComponent(segment.slice(eq + 1)));
  }
  return map;
}

/** `ParseCastUrl`: `cast:<appId>?<params>`. */
function parseCastUrl(url: URL): CastMediaSourceInfo | null {
  // GURL::GetPath: the app id is the path as the URL canonicalizer left it, not unescaped, and `(caps)` is not split off
  const appId = url.pathname;
  if (appId === "") return null;
  const params = queryMap(url.search);
  const get = (key: string): string => params.get(key) ?? "";
  const caps = capabilitiesFromString(get("capabilities"));
  return createFromParams(
    [{ appId, requiredCapabilities: caps.bits, capabilities: caps.names }],
    {
      autoJoinPolicy: get("autoJoinPolicy"),
      defaultActionPolicy: get("defaultActionPolicy"),
      clientId: get("clientId"),
      launchTimeout: get("launchTimeout"),
      targetPlayoutDelayMillis: get("streamingTargetPlayoutDelayMillis"),
      streamingCaptureAudio: get("streamingCaptureAudio"),
      supportedAppTypes: supportedAppTypesFromString(get("supportedAppTypes")),
      appParams: get("appParams"),
      invisibleSender: get("invisibleSender"),
    },
  );
}

/**
 * `base::SplitStringIntoKeyValuePairs(ref, '=', '/')`: pairs split on `/` (whitespace trimmed, empty ones dropped), each
 * at its first `=` with every run of `=` after it skipped. A pair that has no `=`, or nothing after it, is kept with an
 * empty value (and, with no `=`, an empty key).
 */
function splitKeyValuePairs(ref: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const raw of ref.split("/")) {
    const pair = raw.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, "");
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq === -1) {
      pairs.push(["", ""]);
      continue;
    }
    pairs.push([pair.slice(0, eq), pair.slice(eq).replace(/^=+/, "")]);
  }
  return pairs;
}

/** `ParseLegacyCastUrl`: `https://google.com/cast#__castAppId__=ID(caps)/__castClientId__=...`. */
function parseLegacyCastUrl(url: URL): CastMediaSourceInfo | null {
  const pairs = splitKeyValuePairs(url.hash.replace(/^#/, "")).map(([k, v]): [string, string] => [k, unescapeUrlComponent(v)]);
  const appInfos: CastAppInfo[] = [];
  for (const [key, value] of pairs) {
    if (key !== "__castAppId__") continue;
    const open = value.indexOf("(");
    const appId = open === -1 ? value : value.slice(0, open);
    let capabilities = "";
    if (open !== -1) {
      const close = value.indexOf(")", open);
      if (close !== -1 && close > open) capabilities = value.slice(open + 1, close);
    }
    if (appId === "") continue;
    const caps = capabilitiesFromString(capabilities);
    appInfos.push({ appId, requiredCapabilities: caps.bits, capabilities: caps.names });
  }
  // FindValueOr on the pair list: the first pair with the key wins
  const first = (key: string): string => pairs.find(([k]) => k === key)?.[1] ?? "";
  return createFromParams(appInfos, {
    autoJoinPolicy: first("__castAutoJoinPolicy__"),
    defaultActionPolicy: first("__castDefaultActionPolicy__"),
    clientId: first("__castClientId__"),
    launchTimeout: first("__castLaunchTimeout__"),
    // the legacy form carries none of these
    targetPlayoutDelayMillis: "",
    streamingCaptureAudio: "",
    supportedAppTypes: [],
    appParams: "",
    invisibleSender: "",
  });
}

/**
 * `CastMediaSource::FromMediaSourceId` for the two Cast presentation URL forms: `cast:` and the legacy
 * `https://google.com/cast#...`. Null for anything else, for a URL over 64 KB and for one that names no app. (Chrome also
 * turns a plain http(s) URL into a tab-mirroring source, and the mirroring URNs and `remote-playback:` into streaming
 * sources; those are classified in presentation-source.ts, not here.)
 */
export function parseCastMediaSource(source: string): CastMediaSourceInfo | null {
  if (typeof source !== "string" || source.length === 0) return null;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (url.href.length > MAX_URL_LENGTH) return null;
  if (url.protocol === "cast:") return parseCastUrl(url);
  // IsLegacyCastPresentationUrl: a case-insensitive prefix of the canonical spec
  if (url.href.slice(0, LEGACY_PREFIX.length).toLowerCase() === LEGACY_PREFIX) return parseLegacyCastUrl(url);
  return null;
}
