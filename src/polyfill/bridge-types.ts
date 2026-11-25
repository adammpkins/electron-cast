/** What a bridge call settles with: the value, or an error code and description. Calls never reject. */
export type BridgeResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; code: string; description?: string };
/** The calls the page-side polyfill makes of the main process (`mode: "chromecast"`). */
export type BridgeMethod = "initialize" | "requestSession" | "joinSession" | "sendMessage" | "stopSession"
  | "leaveSession" | "setReceiverVolume" | "setReceiverMuted";
/** The object the preload exposes to the page. */
export interface CastBridge {
  call(method: BridgeMethod, params: unknown): Promise<BridgeResult>;   // never rejects; errors come as ok:false
  onEvent(listener: (event: BridgeEvent) => void): void;               // one listener; install calls it once
}
/** A receiver's volume as the page sees it. */
export interface VolumeSnapshot { level: number | null; muted: boolean | null; controlType?: string; stepInterval?: number }
/** An image a receiver app advertises. */
export interface ImageSnapshot { url: string; height?: number | null; width?: number | null }
/** A receiver (a Cast device) as the page sees it. */
export interface ReceiverSnapshot {
  label: string; friendlyName: string; capabilities: string[]; volume: VolumeSnapshot;
  isActiveInput?: boolean | null; displayStatus?: { statusText: string; appImages: ImageSnapshot[] } | null;
}
/** A session (a receiver app running on a device) as the page sees it. */
export interface SessionSnapshot {
  sessionId: string; appId: string; displayName: string; appImages: ImageSnapshot[]; statusText: string | null;
  namespaces: { name: string }[]; transportId: string; receiver: ReceiverSnapshot;
  senderApps?: { platform: string; url?: string | null; packageId?: string | null }[];
}
/** What the main process pushes to the page's listener. */
export type BridgeEvent =
  | { type: "receiverAvailability"; available: boolean }
  | { type: "sessionUpdated"; session: SessionSnapshot }
  | { type: "sessionEnded"; sessionId: string; status: "stopped" | "disconnected" }
  | { type: "receiverAction"; sessionId: string; action: "stop" }
  | { type: "message"; sessionId: string; namespace: string; message: string };
/** Parameters of the bridge's `initialize` call. */
export interface InitializeParams { appId: string; capabilities: string[]; autoJoinPolicy: string }
/** What the bridge's `initialize` call returns: whether a device is available, and the sessions auto-join rejoined for the page. */
export interface InitializeResult { available: boolean; sessions: SessionSnapshot[] }
/** Parameters of the bridge's `requestSession` call. */
export interface RequestSessionParams { appId: string; capabilities: string[]; timeoutMs: number }
