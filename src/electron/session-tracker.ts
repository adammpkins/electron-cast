// Keeps the session each device runs, learned from the receiver status on the device's channel, whoever started it, as
// Chrome's CastSessionTracker does (chrome/browser/media/router/providers/cast/cast_session_tracker.cc and
// CastSession::From in cast_internal_message_util.cc; docs/DESIGN.md lists each rule). Nothing here is specific to an app.
import { EventEmitter } from "node:events";
import type { ReceiverApplication, ReceiverStatus, ReceiverVolume } from "../client/index.ts";
import type { CastClientLike } from "./session-service.ts";

/** The session a device runs (Chrome: `CastSession`). */
export interface TrackedSession {
  /** The device's id. */
  sinkId: string;
  sessionId: string;
  appId: string;
  transportId: string;
  displayName: string;
  /** Empty when the app sets none (Chrome: `status_`). */
  statusText: string;
  /** The app's namespaces, without Cast's own reserved ones (`message_namespaces_`). */
  namespaces: string[];
  /** The application as the receiver reported it. */
  app: ReceiverApplication;
  /** The receiver's volume as last reported. */
  volume: ReceiverVolume;
  /** The last MEDIA_STATUS entries seen on the device's channel (`CastSession::UpdateMedia`). */
  media: Record<string, unknown>[];
}

interface TrackerEvents {
  /** A session appeared on a device or its status text, namespaces, volume or media changed. */
  sessionAddedOrUpdated: [session: TrackedSession];
  /** A device no longer runs a session. */
  sessionRemoved: [sinkId: string, session: TrackedSession];
}

const BACKDROP_APP_ID = "E8C28D3C";
const MULTIZONE_LEADER_APP_ID = "MultizoneLeader";
const PLATFORM_RECEIVER_ID = "receiver-0";
const RESERVED_PREFIX = "urn:x-cast:com.google.cast.";
// kReservedNamespaces, minus the media namespace, which sessions keep (cast_message_util.cc)
const RESERVED_NAMESPACES = [
  "urn:x-cast:com.google.cast.tp.deviceauth",
  "urn:x-cast:com.google.cast.tp.heartbeat",
  "urn:x-cast:com.google.cast.tp.connection",
  "urn:x-cast:com.google.cast.receiver",
  "urn:x-cast:com.google.cast.remoting",
  "urn:x-cast:com.google.cast.webrtc",
];
const MEDIA_NAMESPACE = "urn:x-cast:com.google.cast.media";

/** `IsCastReservedNamespace`: a reserved name, or a name below it (after a dot). */
function isReserved(namespace: string): boolean {
  if (!namespace.startsWith(RESERVED_PREFIX)) return false;
  return RESERVED_NAMESPACES.some((r) => namespace.startsWith(r) && (namespace.length === r.length || namespace[r.length] === "."));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `CastSession::From`: the session a receiver status describes, or undefined when it describes none. Exactly one
 * application with a session id, app id, transport id and display name counts; not one whose transport is the platform
 * receiver, not the backdrop app, and not one without namespaces (a multizone leader may have none).
 */
export function sessionFromStatus(sinkId: string, status: ReceiverStatus): TrackedSession | undefined {
  const apps: unknown = status.applications;
  if (!Array.isArray(apps) || apps.length !== 1) return undefined;
  const app: unknown = apps[0];
  if (!isRecord(app)) return undefined;
  const { sessionId, appId, transportId, displayName } = app;
  if (typeof sessionId !== "string" || typeof appId !== "string" || typeof transportId !== "string" || typeof displayName !== "string") {
    return undefined;
  }
  if (transportId === PLATFORM_RECEIVER_ID || appId === BACKDROP_APP_ID) return undefined;
  const rawNamespaces: unknown = app.namespaces;
  const namespaces: string[] = [];
  if (!Array.isArray(rawNamespaces) || rawNamespaces.length === 0) {
    if (appId !== MULTIZONE_LEADER_APP_ID) return undefined;
  } else {
    for (const ns of rawNamespaces) {
      if (!isRecord(ns) || typeof ns.name !== "string") continue;
      if (isReserved(ns.name) && ns.name !== MEDIA_NAMESPACE) continue;
      namespaces.push(ns.name);
    }
  }
  return {
    sinkId,
    sessionId,
    appId,
    transportId,
    displayName,
    statusText: typeof app.statusText === "string" ? app.statusText : "",
    namespaces,
    app: app as ReceiverApplication,
    volume: isRecord(status.volume) ? { ...(status.volume as ReceiverVolume) } : {},
    media: [],
  };
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * One session per device, from RECEIVER_STATUS (asked for when a channel opens, and then pushed by the receiver) and
 * MEDIA_STATUS on the device's channel. Chrome's tracker does not look at which sender started a session; neither does this.
 */
export class CastSessionTracker extends EventEmitter<TrackerEvents> {
  private readonly bySink = new Map<string, TrackedSession>();
  /** The client each device's status comes from; events of any other client (a replaced channel) are ignored. */
  private readonly clients = new Map<string, CastClientLike>();

  /** Follow a device's channel and ask it for its status (Chrome: `OnSinkAddedOrUpdated` -> `RequestReceiverStatus`). */
  attach(sinkId: string, client: CastClientLike): void {
    this.clients.set(sinkId, client);
    client.on("receiverStatus", (status) => this.applyStatus(sinkId, client, status));
    client.on("message", (msg) => {
      if (msg.namespace !== MEDIA_NAMESPACE || typeof msg.data !== "string") return;
      this.applyMedia(sinkId, client, msg.data);
    });
    client.getStatus().then((status) => this.applyStatus(sinkId, client, status), () => {
      // the channel went away; its close is handled by the sink service
    });
  }

  /** A device left the list (`OnSinkRemoved`): its session goes with it. */
  removeSink(sinkId: string): void {
    this.clients.delete(sinkId);
    this.drop(sinkId);
  }

  /** The session each device runs now (`GetSessions`). */
  sessions(): TrackedSession[] {
    return [...this.bySink.values()];
  }

  sessionOf(sinkId: string): TrackedSession | undefined {
    return this.bySink.get(sinkId);
  }

  /** `GetSessionById`. */
  sessionById(sessionId: string): TrackedSession | undefined {
    for (const s of this.bySink.values()) if (s.sessionId === sessionId) return s;
    return undefined;
  }

  /**
   * `HandleReceiverStatusMessage`. A status that describes no session removes the device's session. The client's own
   * replies (stop, volume) are fed in here too, because a receiver need not echo them as a status message.
   */
  applyStatus(sinkId: string, client: CastClientLike, status: ReceiverStatus): void {
    if (this.clients.get(sinkId) !== client) return;
    const next = sessionFromStatus(sinkId, status);
    if (next === undefined) {
      this.drop(sinkId);
      return;
    }
    const current = this.bySink.get(sinkId);
    // `CastSession::UpdateSession` keeps the old session id and app when another session shows up on the device, which
    // would leave the tracker naming a session the device no longer runs; a different session replaces the old one.
    if (current === undefined || current.sessionId !== next.sessionId || current.appId !== next.appId) {
      this.bySink.set(sinkId, next);
      this.emit("sessionAddedOrUpdated", next);
      return;
    }
    const merged: TrackedSession = { ...current, statusText: next.statusText, namespaces: next.namespaces, volume: next.volume, app: next.app };
    if (sameJson(merged, current)) return;
    this.bySink.set(sinkId, merged);
    this.emit("sessionAddedOrUpdated", merged);
  }

  /**
   * `HandleMediaStatusMessage`: a media status is taken to belong to the session the device is known to run, as Chrome
   * has no way to tell (its comment in the source). Entries are matched to the saved ones by `mediaSessionId`, and
   * fields the new entry lacks are filled from the saved one (`CopySavedMediaFieldsToMediaList`).
   */
  private applyMedia(sinkId: string, client: CastClientLike, data: string): void {
    if (this.clients.get(sinkId) !== client) return;
    const session = this.bySink.get(sinkId);
    if (session === undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed) || parsed.type !== "MEDIA_STATUS" || !Array.isArray(parsed.status)) return;
    const media = parsed.status.filter(isRecord).map((entry) => {
      const saved = typeof entry.mediaSessionId === "number"
        ? session.media.find((m) => m.mediaSessionId === entry.mediaSessionId)
        : undefined;
      return { ...saved, ...entry, sessionId: session.sessionId };
    });
    if (sameJson(media, session.media)) return;
    const next = { ...session, media };
    this.bySink.set(sinkId, next);
    this.emit("sessionAddedOrUpdated", next);
  }

  private drop(sinkId: string): void {
    const session = this.bySink.get(sinkId);
    if (session === undefined) return;
    this.bySink.delete(sinkId);
    this.emit("sessionRemoved", sinkId, session);
  }

  dispose(): void {
    this.bySink.clear();
    this.clients.clear();
    this.removeAllListeners();
  }
}
