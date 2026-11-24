export type BridgeResult<T = unknown> = { ok: true; value: T } | { ok: false; code: string; description?: string };
export type BridgeMethod = "initialize" | "requestSession" | "joinSession" | "sendMessage" | "stopSession"
  | "leaveSession" | "setReceiverVolume" | "setReceiverMuted";
export interface CastBridge {
  call(method: BridgeMethod, params: unknown): Promise<BridgeResult>;   // never rejects; errors come as ok:false
  onEvent(listener: (event: BridgeEvent) => void): void;               // one listener; install calls it once
}
export interface VolumeSnapshot { level: number | null; muted: boolean | null; controlType?: string; stepInterval?: number }
export interface ImageSnapshot { url: string; height?: number | null; width?: number | null }
export interface ReceiverSnapshot {
  label: string; friendlyName: string; capabilities: string[]; volume: VolumeSnapshot;
  isActiveInput?: boolean | null; displayStatus?: { statusText: string; appImages: ImageSnapshot[] } | null;
}
export interface SessionSnapshot {
  sessionId: string; appId: string; displayName: string; appImages: ImageSnapshot[]; statusText: string | null;
  namespaces: { name: string }[]; transportId: string; receiver: ReceiverSnapshot;
  senderApps?: { platform: string; url?: string | null; packageId?: string | null }[];
}
export type BridgeEvent =
  | { type: "receiverAvailability"; available: boolean }
  | { type: "sessionJoined"; session: SessionSnapshot }
  | { type: "sessionUpdated"; session: SessionSnapshot }
  | { type: "sessionEnded"; sessionId: string; status: "stopped" | "disconnected" }
  | { type: "message"; sessionId: string; namespace: string; message: string };
export interface InitializeParams { appId: string; capabilities: string[]; autoJoinPolicy: string }
export interface InitializeResult { available: boolean; sessions: SessionSnapshot[] }
export interface RequestSessionParams { appId: string; capabilities: string[]; timeoutMs: number }
