// Codec between Chromium's private Cast "router message" envelope (what Google's clank.js sender speaks over a
// PresentationConnection) and electron-cast's snapshot types. Pure module: no Electron imports.
import { createHash } from "node:crypto";
import type { ReceiverSnapshot, SessionSnapshot } from "../polyfill/bridge-types.ts";

/** The Cast media namespace; the only reserved namespace kept by {@link filterNamespaces}. */
export const MEDIA_NAMESPACE = "urn:x-cast:com.google.cast.media";

/** The fields parsed out of a presentation request URL. */
export interface PresentationUrl {
  appId: string;
  capabilities: string[];
  clientId: string | null;
  autoJoinPolicy: string;
  defaultActionPolicy: string;
  launchTimeout: number | null;
}

/** A validated inbound router message, with `timeoutMillis` dropped and object messages null-stripped. */
export interface ParsedEnvelope {
  type: string;
  message: unknown;
  sequenceNumber?: number;
  clientId: string;
}

const APP_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Splits `<appId>(cap,cap)` into its parts; no suffix means no capabilities. */
function splitAppId(raw: string): { appId: string; capabilities: string[] } {
  const open = raw.indexOf("(");
  if (open === -1 || !raw.endsWith(")")) return { appId: raw, capabilities: [] };
  return { appId: raw.slice(0, open), capabilities: raw.slice(open + 1, -1).split(",").filter((c) => c !== "") };
}

/** A positive integer millisecond count, or null for anything else. */
function parseLaunchTimeout(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Parses a presentation request URL (the legacy `https://google.com/cast#__castAppId__=...` form or
 * `cast:<appId>?...`) into its launch fields, or null for anything that is not one of those forms.
 */
export function parsePresentationUrl(url: string): PresentationUrl | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 4096) return null;
  const legacyPrefix = "https://google.com/cast#";
  if (url.startsWith(legacyPrefix)) {
    let appId: string | null = null;
    let capabilities: string[] = [];
    let clientId: string | null = null;
    let autoJoinPolicy = "tab_and_origin_scoped";
    let defaultActionPolicy = "create_session";
    let launchTimeout: number | null = null;
    for (const part of url.slice(legacyPrefix.length).split("/")) {
      const eq = part.indexOf("=");
      const key = eq === -1 ? part : part.slice(0, eq);
      const value = eq === -1 ? "" : part.slice(eq + 1);
      switch (key) {
        case "__castAppId__": {
          const split = splitAppId(value);
          appId = split.appId;
          capabilities = split.capabilities;
          break;
        }
        case "__castClientId__":
          clientId = value === "" ? null : value;
          break;
        case "__castAutoJoinPolicy__":
          if (value !== "") autoJoinPolicy = value;
          break;
        case "__castDefaultActionPolicy__":
          if (value !== "") defaultActionPolicy = value;
          break;
        case "__castLaunchTimeout__":
          launchTimeout = parseLaunchTimeout(value);
          break;
        case "__dialPostData__":
          // Its base64 value may contain "/", which would break the split: stop parsing here.
          return appId !== null && APP_ID_RE.test(appId)
            ? { appId, capabilities, clientId, autoJoinPolicy, defaultActionPolicy, launchTimeout }
            : null;
        default:
          // Unknown keys and __dialAppName__ are ignored.
          break;
      }
    }
    return appId !== null && APP_ID_RE.test(appId)
      ? { appId, capabilities, clientId, autoJoinPolicy, defaultActionPolicy, launchTimeout }
      : null;
  }
  if (url.startsWith("cast:")) {
    const rest = url.slice("cast:".length);
    const q = rest.indexOf("?");
    const split = splitAppId(q === -1 ? rest : rest.slice(0, q));
    if (!APP_ID_RE.test(split.appId)) return null;
    const params = new URLSearchParams(q === -1 ? "" : rest.slice(q + 1));
    const param = (k: string): string | null => {
      const v = params.get(k);
      return v === null || v === "" ? null : v;
    };
    const queryCaps = param("capabilities");
    return {
      appId: split.appId,
      capabilities: split.capabilities.length > 0
        ? split.capabilities
        : queryCaps !== null ? queryCaps.split(",").filter((c) => c !== "") : [],
      clientId: param("clientId"),
      autoJoinPolicy: param("autoJoinPolicy") ?? "tab_and_origin_scoped",
      defaultActionPolicy: param("defaultActionPolicy") ?? "create_session",
      launchTimeout: parseLaunchTimeout(param("launchTimeout")),
    };
  }
  return null;
}

/** Deep-copies a value, dropping every object property whose value is null (null array elements are kept). */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => stripNulls(x));
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null) continue;
      out[k] = stripNulls(val);
    }
    return out;
  }
  return v;
}

/** Escapes the five HTML metacharacters, as Chromium's `base::EscapeForHTML` does for receiver names. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Chromium's receiver label: unpadded base64url of sha256(deviceId + per-process token). */
export function receiverLabel(deviceId: string, token: string): string {
  return createHash("sha256").update(deviceId + token).digest("base64url");
}

/** Shapes a ReceiverSnapshot into the receiver object clank reads, with an escaped name and hashed label. */
export function toReceiver(r: ReceiverSnapshot, label: string) {
  return {
    label,
    friendlyName: escapeHtml(r.friendlyName),
    capabilities: r.capabilities,
    volume: r.volume,
    isActiveInput: r.isActiveInput ?? null,
    displayStatus: null,
    receiverType: "cast",
  };
}

/** Reserved namespaces Chromium never advertises to senders (the media namespace is not among them). */
const RESERVED_NAMESPACES = new Set([
  "urn:x-cast:com.google.cast.tp.deviceauth",
  "urn:x-cast:com.google.cast.tp.heartbeat",
  "urn:x-cast:com.google.cast.tp.connection",
  "urn:x-cast:com.google.cast.receiver",
  "urn:x-cast:com.google.cast.remoting",
  "urn:x-cast:com.google.cast.webrtc",
]);

/** Drops the reserved namespaces from a session's namespace list, keeping everything else in order. */
export function filterNamespaces(ns: { name: string }[]): { name: string }[] {
  return ns.filter((n) => !RESERVED_NAMESPACES.has(n.name));
}

/** Shapes a SessionSnapshot into the new_session/update_session message clank's converter copies onto the session. */
export function toSession(s: SessionSnapshot, label: string, media?: object[]) {
  const out: Record<string, unknown> = {
    sessionId: s.sessionId,
    appId: s.appId,
    displayName: s.displayName ?? "",
    appImages: s.appImages ?? [],
    receiver: toReceiver(s.receiver, label),
    transportId: s.transportId,
    namespaces: filterNamespaces(s.namespaces),
    statusText: s.statusText,
    senderApps: s.senderApps ?? [],
  };
  if (media !== undefined) out.media = media;
  return out;
}

/** The receiver's supportedMediaCommands bitmask bits, in the order clank's supportsCommand expects. */
const MEDIA_COMMAND_BITS: Array<[number, string]> = [
  [1, "pause"],
  [2, "seek"],
  [4, "stream_volume"],
  [8, "stream_mute"],
  [64, "queue_next"],
  [128, "queue_prev"],
];

/** Converts a supportedMediaCommands bitmask (or passes through an array of strings) into command names. */
export function mediaCommands(v: unknown): string[] {
  if (typeof v === "number" && Number.isFinite(v)) {
    return MEDIA_COMMAND_BITS.filter(([bit]) => (v & bit) !== 0).map(([, name]) => name);
  }
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return [];
}

/** Shallow-copies a media-status entry, stamping its sessionId and converting its media commands to strings. */
export function toMediaEntry(entry: Record<string, unknown>, sessionId: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...entry };
  if ("supportedMediaCommands" in out) out.supportedMediaCommands = mediaCommands(out.supportedMediaCommands);
  out.sessionId = sessionId;
  return out;
}

/** True for objects made by an object literal or JSON.parse (and nothing else, including arrays). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Serialises an outbound Chromium router message; undefined/null/empty-object messages become null. */
export function envelope(type: string, message: unknown, clientId: string, sequenceNumber?: number): string {
  const empty = message !== undefined && message !== null && isPlainObject(message) && Object.keys(message).length === 0;
  const out: Record<string, unknown> = { type, message: message === undefined || message === null || empty ? null : message };
  if (typeof sequenceNumber === "number") out.sequenceNumber = sequenceNumber;
  out.timeoutMillis = 0;
  out.clientId = clientId;
  return JSON.stringify(out);
}

/** The eight router message types Chromium's parser accepts; anything else is dropped. */
const ENVELOPE_TYPES = new Set([
  "client_connect",
  "app_message",
  "v2_message",
  "leave_session",
  "receiver_action",
  "new_session",
  "update_session",
  "error",
]);

/** Validates an inbound router message the way Chromium's CIM parser does, stripping nulls from object messages. */
export function parseEnvelope(raw: string): ParsedEnvelope | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(data)) return null;
  const { type, clientId, message, sequenceNumber } = data;
  if (typeof type !== "string" || !ENVELOPE_TYPES.has(type)) return null;
  if (typeof clientId !== "string" || clientId.length === 0) return null;
  if (type === "app_message") {
    if (!isPlainObject(message)) return null;
    if (typeof message.sessionId !== "string" || typeof message.namespaceName !== "string") return null;
    const inner = message.message;
    if (!(typeof inner === "string" || isPlainObject(inner))) return null;
  } else if (type === "v2_message") {
    if (!isPlainObject(message)) return null;
    if (typeof message.type !== "string" || typeof message.sessionId !== "string") return null;
  } else if (!(typeof message === "string" || isPlainObject(message))) {
    return null;
  }
  const out: ParsedEnvelope = {
    type,
    message: typeof message === "string" ? message : stripNulls(message),
    clientId,
  };
  if (typeof sequenceNumber === "number") out.sequenceNumber = sequenceNumber;
  return out;
}

/**
 * The v2_message media request types Chromium forwards to the receiver (IsMediaRequestMessageType in
 * cast_message_util.cc); SET_VOLUME/STOP/LAUNCH are not among them. Any type missing here gets no reply at all.
 */
const MEDIA_REQUEST_TYPES = new Set([
  "LOAD",
  "QUEUE_LOAD",
  "MEDIA_GET_STATUS",
  "PLAY",
  "PAUSE",
  "SEEK",
  "STOP_MEDIA",
  "MEDIA_SET_VOLUME",
  "EDIT_TRACKS_INFO",
  "QUEUE_INSERT",
  "QUEUE_UPDATE",
  "QUEUE_REMOVE",
  "QUEUE_REORDER",
  "QUEUE_NEXT",
  "QUEUE_PREV",
  "PRECACHE",
]);

/** True when a v2_message type is one of the media requests forwarded to the receiver. */
export function isMediaRequest(type: string): boolean {
  return MEDIA_REQUEST_TYPES.has(type);
}

/** Maps the media request types to the receiver's protocol names, leaving all other types unchanged. */
export function receiverMediaType(type: string): string {
  switch (type) {
    case "STOP_MEDIA":
      return "STOP";
    case "MEDIA_SET_VOLUME":
      return "SET_VOLUME";
    case "MEDIA_GET_STATUS":
      return "GET_STATUS";
    default:
      return type;
  }
}
