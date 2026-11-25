import type { MediaRouterLogger } from "./logger.ts";

/**
 * `CastMessageLogging` (`kCastMessageLogging`, chrome/browser/media/router/media_router_feature.cc; disabled by default):
 * when the feature is on, the messages of a Cast route go to the media router log. Chrome has five places that write them:
 *
 * - `CastSessionClientImpl::SendMessageToClient` (cast_session_client_impl.cc): every message to the page.
 * - `LogCastInternalMessage`, called by `CastSessionClientImpl::HandleParsedClientMessage`: every message from the page that
 *   parsed and is for this client and session.
 * - `CastActivityManager::OnAppMessage`, `OnInternalMessage` and `OnMessageSent` (cast_activity_manager.cc): the messages the
 *   receiver sends to an activity's channel, and the ones sent to it.
 *
 * All five log at `Info` in the `Route` category; the logger does the truncation (1024 characters of message, 9 of an id).
 */

/** The fields of a CastMessage the log prints. */
export interface LoggedCastMessage {
  sourceId: string;
  destinationId: string;
  namespace: string;
  /** A string payload, or a Buffer for a binary one. */
  data: string | Uint8Array;
}

/** The activity a channel message belongs to (`CastActivity`): its sink, app and session. */
export interface LoggedActivity {
  sinkId: string;
  appId: string;
  sessionId: string;
}

/** cast_message_util.h `kCastReservedNamespacePrefix` and `kReservedNamespaces`. */
const RESERVED_PREFIX = "urn:x-cast:com.google.cast.";
const RESERVED_NAMESPACES = [
  "urn:x-cast:com.google.cast.tp.deviceauth",
  "urn:x-cast:com.google.cast.tp.heartbeat",
  "urn:x-cast:com.google.cast.tp.connection",
  "urn:x-cast:com.google.cast.receiver",
  "urn:x-cast:com.google.cast.media",
  "urn:x-cast:com.google.cast.remoting",
  "urn:x-cast:com.google.cast.webrtc",
];

/**
 * `cast_channel::IsCastReservedNamespace`: a namespace that is, or is a dotted extension of, one of the reserved ones. The
 * receiver's messages in them are internal messages; the others are app messages.
 */
export function isCastReservedNamespace(namespace: string): boolean {
  if (!namespace.startsWith(RESERVED_PREFIX)) return false;
  return RESERVED_NAMESPACES.some((reserved) => namespace.startsWith(reserved) && (namespace.length === reserved.length || namespace[reserved.length] === "."));
}

/** The `CastMessageType` strings of cast_message_util.cc (`EnumTable<CastMessageType>`); anything else is `kOther`. */
const CAST_MESSAGE_TYPES = new Set([
  "PING", "PONG", "RPC", "GET_APP_AVAILABILITY", "GET_STATUS", "CONNECT", "CLOSE", "APPLICATION_BROADCAST", "LAUNCH", "STOP",
  "RECEIVER_STATUS", "MEDIA_STATUS", "LAUNCH_STATUS", "LAUNCH_ERROR", "OFFER", "ANSWER", "CAPABILITIES_RESPONSE", "STATUS_RESPONSE",
  "MULTIZONE_STATUS", "INVALID_PLAYER_STATE", "LOAD_FAILED", "LOAD_CANCELLED", "INVALID_REQUEST", "PRESENTATION", "GET_CAPABILITIES",
]);

/** `kMaxDepth` the log passes to `base::WriteJson`. */
const JSON_MAX_DEPTH = 10;

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

function jsonString(text: string): string {
  // base::EscapeJSONString: the short escapes, `<` as <, U+2028/2029, other controls as \uXXXX
  let out = '"';
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "<") out += "\\u003C";
    else if (code === 0x2028) out += "\\u2028";
    else if (code === 0x2029) out += "\\u2029";
    else if (code < 32) out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/** `base::JSONWriter::BuildJSONString` for a number: a double always shows a `.0` or an exponent. */
function jsonNumber(n: number): string {
  // base::Value keeps an integer that fits an int as an int; everything else is a double
  if (Number.isInteger(n) && Math.abs(n) <= 2 ** 31 - 1) return String(n);
  const text = String(n);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

function writeValue(value: unknown, depthLeft: number): string | undefined {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return jsonNumber(value);
  if (typeof value === "string") return jsonString(value);
  if (Array.isArray(value)) {
    if (depthLeft === 0) return undefined;
    const items: string[] = [];
    for (const item of value) {
      const text = writeValue(item, depthLeft - 1);
      if (text === undefined) return undefined;
      items.push(text);
    }
    return `[${items.join(",")}]`;
  }
  if (typeof value === "object") {
    if (depthLeft === 0) return undefined;
    // base::DictValue is ordered by key
    const entries: string[] = [];
    for (const key of Object.keys(value).sort(byteOrder)) {
      const text = writeValue((value as Record<string, unknown>)[key], depthLeft - 1);
      if (text === undefined) return undefined;
      entries.push(`${jsonString(key)}:${text}`);
    }
    return `{${entries.join(",")}}`;
  }
  return undefined;
}

/**
 * `base::WriteJson(value, 10)`: compact JSON with the dictionary keys in order; `undefined` when the value nests more than ten
 * containers deep, as there. (A number read from `1.0` is an integer here, so it prints as `1`; Chrome keeps it a double.)
 */
export function writeJson(value: unknown): string | undefined {
  return writeValue(value, JSON_MAX_DEPTH);
}

const payloadText = (data: string | Uint8Array): string => (typeof data === "string" ? data : "<BINARY>");

/** `CastMessageToDebugString(const CastMessage&)` (cast_activity_manager.cc). */
export function castMessageToDebugString(message: LoggedCastMessage): string {
  return `source_id = ${message.sourceId}; destination_id = ${message.destinationId}; namespace = ${message.namespace}; payload = "${payloadText(message.data)}"`;
}

/**
 * `CastMessageToDebugString(const InternalMessage&)`: the type, the ids and the payload as `WriteJson` writes it (`<error>`
 * when it cannot).
 */
function internalMessageToDebugString(type: string, message: LoggedCastMessage, body: unknown): string {
  return `type = ${type}; source_id = ${message.sourceId}; destination_id = ${message.destinationId}; namespace = ${message.namespace}; payload = "${writeJson(body) ?? "<error>"}"`;
}

/** A parsed message from the page, as `LogCastInternalMessage` reads it (a `CastInternalMessage`). */
export interface LoggedClientMessage {
  /** `CastInternalMessage::Type` as a string: `app_message`, `v2_message`, `client_connect`, `leave_session`... */
  type: string;
  clientId: string;
  /** The `message` member, after `RemoveNullFields`. */
  message: unknown;
}

/** The part of the log the Cast route code writes through; see the file comment. */
export class CastMessageLog {
  private readonly logger: MediaRouterLogger;

  constructor(logger: MediaRouterLogger) {
    this.logger = logger;
  }

  /** `CastSessionClientImpl::SendMessageToClient`: `message` is the text given to the page. */
  sentToClient(client: { clientId: string; origin: string; sessionId: string | null }, message: string): void {
    this.logger.info("Route", "Cast::SendMessageToClient", message, {
      sinkId: client.clientId,
      mediaSource: client.origin,
      sessionId: client.sessionId ?? "",
    });
  }

  /** `LogCastInternalMessage`, from `CastSessionClientImpl::HandleParsedClientMessage`. */
  fromClient(message: LoggedClientMessage): void {
    let json: string | undefined;
    let messageType = message.type;
    let sessionId = "";
    const body = message.message as Record<string, unknown>;
    if (message.type === "app_message") {
      sessionId = String(body.sessionId);
      messageType = String(body.namespaceName);
      json = writeJson(body.message);
    } else if (message.type === "v2_message") {
      sessionId = String(body.sessionId);
      messageType = String(body.type);
      json = writeJson(body);
    }
    this.logger.info("Route", "Cast::HandleParsedClientMessage", json ?? "", {
      sinkId: message.clientId,
      mediaSource: messageType,
      sessionId,
    });
  }

  /**
   * What `CastMessageHandler::OnMessage` does with a message the receiver sent on a channel that has an activity: an app
   * message (outside the reserved namespaces) goes to `CastActivityManager::OnAppMessage`; a reserved namespace's message that
   * is a JSON object of a known type, other than CLOSE, goes to `OnInternalMessage`; the rest is dropped.
   */
  received(activity: LoggedActivity, message: LoggedCastMessage): void {
    if (!isCastReservedNamespace(message.namespace)) {
      this.write("CastActivityManager::OnAppMessage", castMessageToDebugString(message), activity);
      return;
    }
    if (typeof message.data !== "string") return;
    let body: unknown;
    try {
      body = JSON.parse(message.data);
    } catch {
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) return;
    const type = (body as Record<string, unknown>).type;
    if (typeof type !== "string" || !CAST_MESSAGE_TYPES.has(type) || type === "CLOSE") return;
    this.write("CastActivityManager::OnInternalMessage", internalMessageToDebugString(type, message, body), activity);
  }

  /** `CastActivityManager::OnMessageSent`. */
  sent(activity: LoggedActivity, message: LoggedCastMessage): void {
    this.write("CastActivityManager::MessageSent", castMessageToDebugString(message), activity);
  }

  private write(component: string, text: string, activity: LoggedActivity): void {
    this.logger.info("Route", component, text, {
      sinkId: activity.sinkId,
      mediaSource: activity.appId,
      sessionId: activity.sessionId,
    });
  }
}
