// Codec between Chromium's private Cast "router message" envelope (what Google's clank.js sender speaks over a
// PresentationConnection) and electron-cast's snapshot types. Pure module: no Electron imports.
import { createHash } from "node:crypto";
import { parseCastMediaSource, type CastMediaSourceInfo } from "./cast-media-source.ts";
import type { ReceiverSnapshot, SessionSnapshot } from "../polyfill/bridge-types.ts";

/** The Cast media namespace; the only reserved namespace kept by {@link filterNamespaces}. */
export const MEDIA_NAMESPACE = "urn:x-cast:com.google.cast.media";

/**
 * The fields parsed out of a presentation request URL by `CastMediaSource::FromMediaSourceId`
 * (see cast-media-source.ts, which holds the parsing and its Chromium citations).
 */
export interface PresentationUrl extends CastMediaSourceInfo {
  /** The first app of the URL: the one launched when the sink is not known yet (`appInfos[0]`). */
  appId: string;
  /** The capability names of the first app. */
  capabilities: string[];
}

/** A validated inbound router message, with `timeoutMillis` dropped and object messages null-stripped. */
export interface ParsedEnvelope {
  type: string;
  message: unknown;
  sequenceNumber?: number;
  clientId: string;
}

/**
 * Parses a presentation request URL (the legacy `https://google.com/cast#__castAppId__=...` form or
 * `cast:<appId>?...`) into its launch fields, or null for anything that is not one of those forms.
 */
export function parsePresentationUrl(url: string): PresentationUrl | null {
  const source = parseCastMediaSource(url);
  if (source === null) return null;
  const first = source.appInfos[0]!;
  return { ...source, appId: first.appId, capabilities: first.capabilities };
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
