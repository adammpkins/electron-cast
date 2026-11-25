// The DIAL route provider: the message flow between Google's Cast SDK and a DIAL device, after
// DialMediaRouteProvider, DialActivityManager and DialInternalMessageUtil
// (chrome/browser/media/router/providers/dial/). Pure: no Electron, and no page transport; the presentation handler
// carries the messages.
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import type { DialHttp } from "./http.ts";
import type { DialSink } from "./dial-sink-service.ts";
import {
  getDialAppUrl, isValidDeviceUrl, parseDialLaunchSource, type DialAppInfoResult, type ParsedDialAppInfo,
} from "./parse.ts";

/** `RouteRequestResultCode` names used by the DIAL provider (components/media_router/common/mojom/media_router.mojom). */
export type DialRouteErrorCode =
  | "SINK_NOT_FOUND" | "NO_SUPPORTED_PROVIDER" | "ROUTE_ALREADY_EXISTS" | "ROUTE_NOT_FOUND"
  | "REDUNDANT_REQUEST" | "ROUTE_ALREADY_TERMINATED" | "UNKNOWN_ERROR";

export class DialRouteError extends Error {
  readonly code: DialRouteErrorCode;
  constructor(code: DialRouteErrorCode, message: string) {
    super(message);
    this.name = "DialRouteError";
    this.code = code;
  }
}

/** The part of a `MediaRoute` the provider knows. */
export interface DialRouteInfo {
  /** `urn:x-org.chromium:media:route:<presentation id>/<sink id>/<source id>` (`MediaRoute::GetMediaRouteId`). */
  id: string;
  presentationId: string;
  sinkId: string;
  /** The full `cast-dial:` source, as `MediaRoute::media_source`. */
  mediaSource: string;
  /** The app name: `MediaRoute::description`. */
  appName: string;
  origin: string;
  /** The SDK's client id, from the source. */
  clientId: string;
}

export interface DialRouteProviderEvents {
  /** `OnRouteMessagesReceived`: JSON router messages for the page(s) holding the route. */
  messages: [routeId: string, messages: string[]];
  /** `OnPresentationConnectionStateChanged(TERMINATED)`. */
  terminated: [routeId: string];
  /** `OnRoutesUpdated`. */
  routes: [];
  /** `OnIssue`: a stop that could not be confirmed (`IDS_MEDIA_ROUTER_ISSUE_CANNOT_TERMINATE`). */
  issue: [sinkId: string, message: string];
}

interface Activity {
  route: DialRouteInfo;
  appLaunchUrl: string;
  postData: string | null;
  state: "created" | "launched";
  appInstanceUrl: string | null;
  pendingLaunch: boolean;
  pendingStop: boolean;
  /** Cancels the launch POST: the record owning the fetcher is erased on a stop (`DialActivityManager::StopApp`). */
  launchAbort: AbortController | null;
}

export interface DialRouteProviderOptions {
  sinks: {
    getSink(id: string): DialSink | undefined;
    fetchAppInfo(sink: DialSink, appName: string): Promise<DialAppInfoResult>;
  };
  http: DialHttp;
  /** Salt of the receiver label (`hash_token_`); the presentation handler's, so a label means one thing per process. */
  hashToken: string;
  /** Lower-level trace, for diagnostics. */
  log?: (message: string) => void;
}

/** `kSequenceNumberWrap` is `2 << 30` (dial_internal_message_util.cc). */
const SEQUENCE_WRAP = 2 ** 31;
/** `kMaxPendingDialLaunches` (dial_media_route_provider.cc). */
const MAX_PENDING_LAUNCHES = 10;
/** `IDS_MEDIA_ROUTER_ISSUE_CANNOT_TERMINATE` in Chrome's English strings. */
const CANNOT_TERMINATE = "Unable to stop the app. Try stopping it from the device.";

let nextLaunchSequence = 0;
let nextSessionId = 0;

/** `GetNextDialLaunchSequenceNumber`: 1, 2, 3, ... wrapping at 2^31. */
function takeLaunchSequence(): number {
  nextLaunchSequence = (nextLaunchSequence + 1) % SEQUENCE_WRAP;
  return nextLaunchSequence;
}

/** `GetNextSessionId`: "1", "2", ... wrapping at 2^31. */
function takeSessionId(): string {
  nextSessionId = (nextSessionId + 1) % SEQUENCE_WRAP;
  return String(nextSessionId);
}

/** `base::EscapeForHTML`. */
function escapeForHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** The router message every DIAL reply uses (`CreateDialMessageCommon`): the sequence number defaults to -1. */
export function dialEnvelope(type: string, message: object | null, clientId: string, sequenceNumber = -1): string {
  return JSON.stringify({ type, message, clientId, sequenceNumber, timeoutMillis: 0 });
}

/** The DIAL router message types the provider accepts from the page (`StringToDialInternalMessageType`). */
const DIAL_MESSAGE_TYPES = new Set([
  "client_connect", "v2_message", "receiver_action", "new_session", "custom_dial_launch", "dial_app_info", "error",
]);

interface DialMessage { type: string; body: unknown; clientId: string; sequenceNumber: number }

/** `DialInternalMessage::From`: a dictionary with a known `type` and a string `clientId`; `message` may be anything. */
export function parseDialMessage(raw: string): DialMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const dict = data as Record<string, unknown>;
  if (typeof dict.type !== "string" || !DIAL_MESSAGE_TYPES.has(dict.type)) return null;
  if (typeof dict.clientId !== "string") return null;
  const seq = dict.sequenceNumber;
  return {
    type: dict.type,
    body: dict.message,
    clientId: dict.clientId,
    sequenceNumber: typeof seq === "number" && Number.isInteger(seq) ? seq : -1,
  };
}

export class DialRouteProvider extends EventEmitter<DialRouteProviderEvents> {
  private readonly opts: DialRouteProviderOptions;
  private readonly activities = new Map<string, Activity>();
  /** Sequence numbers of custom_dial_launch messages sent and not answered yet (`pending_dial_launches_`, ordered). */
  private pendingLaunches: number[] = [];

  constructor(options: DialRouteProviderOptions) {
    super();
    this.opts = options;
  }

  /** A fresh presentation id: `"mr_" + uuid` (`MediaRouterBase::CreatePresentationId`). */
  static newPresentationId(): string {
    return `mr_${randomUUID()}`;
  }

  routes(): DialRouteInfo[] {
    return [...this.activities.values()].map((a) => ({ ...a.route }));
  }

  /**
   * `DialMediaRouteProvider::CreateRoute`. Throws {@link DialRouteError} like the provider's error replies. A route to
   * a sink that already has one replaces it. Returns the route and the messages that go to the page at once
   * (RECEIVER_ACTION, then NEW_SESSION).
   */
  createRoute(source: string, sinkId: string, presentationId: string, origin: string): { route: DialRouteInfo; messages: string[] } {
    const sink = this.opts.sinks.getSink(sinkId);
    if (sink === undefined) throw new DialRouteError("SINK_NOT_FOUND", `Unknown sink ${sinkId}`);
    const launch = parseDialLaunchSource(source);
    const appLaunchUrl = launch === null ? null : getDialAppUrl(sink.appUrl, launch.appName);
    if (launch === null || appLaunchUrl === null) throw new DialRouteError("NO_SUPPORTED_PROVIDER", `Unsupported source ${source}`);
    const route: DialRouteInfo = {
      id: `urn:x-org.chromium:media:route:${presentationId}/${sinkId}/${source}`,
      presentationId,
      sinkId,
      mediaSource: source,
      appName: launch.appName,
      origin,
      clientId: launch.clientId,
    };
    if (this.activities.has(route.id)) throw new DialRouteError("ROUTE_ALREADY_EXISTS", "Route already exists");
    // Terminate the existing session on this sink before creating the new one.
    for (const other of this.activities.values()) {
      if (other.route.sinkId === sinkId) void this.terminateRoute(other.route.id).catch(() => undefined);
    }
    this.activities.set(route.id, {
      route, appLaunchUrl, postData: launch.postData, state: "created", appInstanceUrl: null, pendingLaunch: false, pendingStop: false, launchAbort: null,
    });
    // The messages that start the SDK's launch sequence follow the reply: RECEIVER_ACTION, then NEW_SESSION.
    const messages = [
      dialEnvelope("receiver_action", { receiver: this.receiver(sink), action: "cast" }, launch.clientId),
      dialEnvelope("new_session", this.newSessionBody(launch.appName, sink), launch.clientId),
    ];
    this.emit("routes");
    return { route: { ...route }, messages };
  }

  /** `DialMediaRouteProvider::JoinRoute` / `DialActivityManager::GetActivityToJoin`: same presentation id, source and origin. */
  joinRoute(presentationId: string, source: string, origin: string): DialRouteInfo | null {
    for (const a of this.activities.values()) {
      if (a.route.presentationId === presentationId && a.route.mediaSource === source && a.route.origin === origin) return { ...a.route };
    }
    return null;
  }

  /** `DialMediaRouteProvider::TerminateRoute`. Resolves when the app is stopped; rejects with the provider's result code otherwise. */
  async terminateRoute(routeId: string): Promise<void> {
    const activity = this.activities.get(routeId);
    if (activity === undefined) throw new DialRouteError("ROUTE_NOT_FOUND", "Activity not found");
    const sink = this.opts.sinks.getSink(activity.route.sinkId);
    if (sink === undefined) throw new DialRouteError("SINK_NOT_FOUND", "Sink not found");
    await this.doTerminate(activity, sink);
  }

  /** `DialMediaRouteProvider::SendRouteMessage`: one JSON router message from the page. */
  sendRouteMessage(routeId: string, raw: string): void {
    const message = parseDialMessage(raw);
    if (message === null) return;
    const activity = this.activities.get(routeId);
    if (activity === undefined) return;
    const sink = this.opts.sinks.getSink(activity.route.sinkId);
    if (sink === undefined) return;
    switch (message.type) {
      case "client_connect":
        this.handleClientConnect(activity, sink);
        return;
      case "custom_dial_launch":
        this.handleCustomDialLaunchResponse(activity, message);
        return;
      case "dial_app_info":
        this.handleAppInfoRequest(activity, sink, message.sequenceNumber);
        return;
      case "v2_message":
        if (isStopMessage(message)) void this.doTerminate(activity, sink).catch(() => undefined);
        return;
      default:
        return;
    }
  }

  /** `HandleClientConnect`: fetch the app's current state, then ask the page whether and how to launch. */
  private handleClientConnect(activity: Activity, sink: DialSink): void {
    const routeId = activity.route.id;
    void this.opts.sinks.fetchAppInfo(sink, activity.route.appName).then((result) => {
      if (result.appInfo === null) {
        // Chromium leaves the route stuck here; the client has to terminate it.
        this.opts.log?.(`Failed to send custom app launch message. Cannot find app info (${result.errorMessage}).`);
        return;
      }
      const current = this.activities.get(routeId);
      const liveSink = this.opts.sinks.getSink(sink.id);
      if (current === undefined || liveSink === undefined) return;
      const seq = takeLaunchSequence();
      this.pendingLaunches.push(seq);
      if (this.pendingLaunches.length > MAX_PENDING_LAUNCHES) {
        // The set is ordered: the smallest number goes first.
        const smallest = Math.min(...this.pendingLaunches);
        this.pendingLaunches.splice(this.pendingLaunches.indexOf(smallest), 1);
      }
      // A CUSTOM_DIAL_LAUNCH has the shape of a DIAL_APP_INFO answer.
      this.emit("messages", routeId, [
        dialEnvelope("custom_dial_launch", this.appInfoBody(liveSink, result.appInfo), current.route.clientId, seq),
      ]);
    });
  }

  /** `HandleDiapAppInfoRequest` / `SendDialAppInfoResponse`. */
  private handleAppInfoRequest(activity: Activity, sink: DialSink, sequenceNumber: number): void {
    const routeId = activity.route.id;
    void this.opts.sinks.fetchAppInfo(sink, activity.route.appName).then((result) => {
      const current = this.activities.get(routeId);
      const liveSink = this.opts.sinks.getSink(sink.id);
      // Nobody is told about a route that no longer exists.
      if (current === undefined || liveSink === undefined) return;
      const clientId = current.route.clientId;
      if (result.appInfo !== null) {
        this.emit("messages", routeId, [dialEnvelope("dial_app_info", this.appInfoBody(liveSink, result.appInfo), clientId, sequenceNumber)]);
        return;
      }
      // chrome.cast.Error: a code, a description, and the HTTP status for an http_error.
      const body: Record<string, unknown> = { code: result.resultCode, description: result.errorMessage };
      if (result.resultCode === "http_error") body.details = { http_error_code: result.httpErrorCode ?? 0 };
      this.emit("messages", routeId, [dialEnvelope("error", body, clientId, sequenceNumber)]);
    });
  }

  /** `HandleCustomDialLaunchResponse` / `DialActivityManager::LaunchApp`. */
  private handleCustomDialLaunchResponse(activity: Activity, message: DialMessage): void {
    const at = this.pendingLaunches.indexOf(message.sequenceNumber);
    if (at === -1) return;
    this.pendingLaunches.splice(at, 1);
    if (activity.pendingLaunch || activity.state === "launched") return;
    // `CustomDialLaunchMessageBody::From`: without a boolean doLaunch the defaults apply (launch, no override).
    let doLaunch = true;
    let launchParameter: string | null = null;
    const body = message.body;
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      const dict = body as Record<string, unknown>;
      if (typeof dict.doLaunch === "boolean") {
        doLaunch = dict.doLaunch;
        if (typeof dict.launchParameter === "string") launchParameter = dict.launchParameter;
      }
    }
    if (!doLaunch) {
      activity.state = "launched";
      this.onLaunchResult(activity, true);
      return;
    }
    // The launch parameter replaces the POST data of the source.
    const postData = launchParameter ?? activity.postData;
    activity.pendingLaunch = true;
    const abort = new AbortController();
    activity.launchAbort = abort;
    void this.opts.http.post(activity.appLaunchUrl, postData, abort.signal).then((res) => {
      if (this.activities.get(activity.route.id) !== activity) return;
      activity.pendingLaunch = false;
      activity.launchAbort = null;
      if (!res.ok) {
        this.activities.delete(activity.route.id);
        this.onLaunchResult(activity, false);
        return;
      }
      activity.appInstanceUrl = applicationInstanceUrl(res.headers.location, this.opts.sinks.getSink(activity.route.sinkId)?.ipAddress);
      activity.state = "launched";
      this.onLaunchResult(activity, true);
    });
  }

  /** `HandleAppLaunchResult`: only the route list is told; the page learns nothing from a failed launch. */
  private onLaunchResult(activity: Activity, success: boolean): void {
    this.opts.log?.(success ? "Successfully launched app." : "Failed to launch app.");
    this.emit("routes");
  }

  /** `DoTerminateRoute`. */
  private async doTerminate(activity: Activity, sink: DialSink): Promise<void> {
    const routeId = activity.route.id;
    if (activity.pendingStop) throw new DialRouteError("REDUNDANT_REQUEST", "A pending request already exists");
    this.emit("messages", routeId, [dialEnvelope("receiver_action", { receiver: this.receiver(sink), action: "stop" }, activity.route.clientId)]);
    let failure: DialRouteError | null = null;
    // A launch that has not been confirmed is treated as never made: nothing to stop on the device. Chrome erases the
    // record, which destroys the launch fetcher: the POST is cancelled and its answer is never read. The device may
    // still have started the app (a gap Chrome has too).
    activity.launchAbort?.abort();
    activity.launchAbort = null;
    if (activity.state === "launched") {
      activity.pendingStop = true;
      const target = activity.appInstanceUrl ?? `${activity.appLaunchUrl}/run`;
      const res = await this.opts.http.delete(target);
      if (!res.ok) {
        // Most failures mean the session is already gone from the device; another look at the app tells which.
        const info = await this.opts.sinks.fetchAppInfo(sink, activity.route.appName);
        failure = info.appInfo !== null && info.appInfo.state !== "running"
          ? new DialRouteError("ROUTE_ALREADY_TERMINATED", res.message)
          : new DialRouteError("UNKNOWN_ERROR", res.message);
      }
    }
    this.activities.delete(routeId);
    if (failure !== null && failure.code !== "ROUTE_ALREADY_TERMINATED") {
      // The app may still run on the receiver: Chrome forgets the route and tells the user to stop it there.
      this.emit("issue", sink.id, CANNOT_TERMINATE);
    }
    this.emit("terminated", routeId);
    this.emit("routes");
    if (failure !== null && failure.code !== "ROUTE_ALREADY_TERMINATED") throw failure;
  }

  private receiver(sink: DialSink): Record<string, unknown> {
    return {
      label: createHash("sha256").update(sink.id + this.opts.hashToken).digest("base64url"),
      friendlyName: escapeForHtml(sink.name),
      capabilities: [],
      volume: null,
      isActiveInput: null,
      displayStatus: null,
      receiverType: "dial",
      ipAddress: sink.ipAddress,
    };
  }

  private newSessionBody(appName: string, sink: DialSink): Record<string, unknown> {
    return {
      sessionId: takeSessionId(),
      appId: "",
      displayName: appName,
      statusText: "",
      appImages: [],
      receiver: this.receiver(sink),
      senderApps: [],
      namespaces: [],
      media: [],
      status: "connected",
      transportId: "",
    };
  }

  private appInfoBody(sink: DialSink, info: ParsedDialAppInfo): Record<string, unknown> {
    return { receiver: this.receiver(sink), appState: info.state, extraData: { ...info.extraData } };
  }

  /** Forget everything; nothing is stopped on any device. */
  dispose(): void {
    for (const activity of this.activities.values()) activity.launchAbort?.abort();
    this.activities.clear();
    this.pendingLaunches = [];
    this.removeAllListeners();
  }
}

/** `DialInternalMessageUtil::IsStopSessionMessage`: a v2_message whose body is a dictionary with `type` "STOP". */
function isStopMessage(message: DialMessage): boolean {
  const body = message.body;
  return message.type === "v2_message" && typeof body === "object" && body !== null && !Array.isArray(body)
    && (body as Record<string, unknown>).type === "STOP";
}

/**
 * `GetApplicationInstanceURL` (dial_activity_manager.cc): the LOCATION of a 201 answer, if it is an http URL on the
 * device's own address; otherwise null and the stop falls back to `<app url>/run`.
 */
function applicationInstanceUrl(location: string | undefined, ipAddress: string | undefined): string | null {
  if (location === undefined || ipAddress === undefined) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== ipAddress) return null;
  // Chromium accepts any address that equals the sink's, public or not; the check above is that equality.
  void isValidDeviceUrl;
  return url.href;
}
