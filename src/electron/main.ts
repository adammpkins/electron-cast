import { CastSessionService, type CastClientLike, type DeviceSource, type CastRequestInfo, type DeviceChoice } from "./session-service.ts";
import type { CastDevice } from "../discovery/index.ts";
import { CastDiscovery } from "../discovery/index.ts";
import { CastClient } from "../client/index.ts";
import { CastPresentationHandler, type PresentationConnectionHandle } from "./presentation-handler.ts";

export type { CastRequestInfo, DeviceChoice } from "./session-service.ts";
export type { CastDevice } from "../discovery/index.ts";

/** The subset of an Electron `WebFrameMain` the manager needs. */
export interface FrameLike { url: string; origin?: string }
/** The subset of an Electron `WebContents` the manager needs. */
export interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: any[]): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "did-navigate", listener: (...args: any[]) => void): unknown;
}
/** The subset of an Electron `IpcMainInvokeEvent` the manager needs. */
export interface IpcMainInvokeEventLike { sender: WebContentsLike; senderFrame: FrameLike | null }
/** The subset of an Electron `IpcMainEvent` the manager needs. */
export interface IpcMainEventLike { sender: WebContentsLike }
/** The subset of an Electron `IpcMain` the manager needs (`on`/`removeListener` unless `presentation: false`). */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEventLike, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
  on?(channel: string, listener: (event: IpcMainEventLike, ...args: any[]) => void): unknown;
  removeListener?(channel: string, listener: (event: IpcMainEventLike, ...args: any[]) => void): unknown;
}
/** Dependencies of {@link createCastManager}; the Electron objects are passed in, never imported. */
export interface CastManagerOptions {
  ipcMain: IpcMainLike;
  selectDevice(devices: CastDevice[], request: CastRequestInfo): Promise<DeviceChoice>;
  allowOrigin?(origin: string): boolean;
  discovery?: DeviceSource & { start(): Promise<void>; stop(): void };  // default new CastDiscovery()
  createClient?(device: CastDevice): CastClientLike;                     // default new CastClient({ host, port })
  channel?: string;                                                       // default "electron-cast"
  /**
   * Answer the preload's presentation mode (the page's own Google Cast SDK running on a stand-in Presentation API),
   * which is the preload's default. Needs `ipcMain.on` and `ipcMain.removeListener`. Default true; false serves only
   * the preload's `mode: "chromecast"`.
   */
  presentation?: boolean;
}
/** The main-process cast manager. */
export interface CastManager {
  start(): Promise<void>;
  devices(): CastDevice[];
  dispose(): Promise<void>;
}

/** Availability watches kept per webContents; the page never releases one, so the oldest are dropped. */
const MAX_WATCHES_PER_PAGE = 32;
/** Largest page-to-receiver message accepted (Cast messages are capped at 64 KiB on the wire). */
const MAX_MESSAGE_CHARS = 1 << 20;

/** The sending frame's origin; null when there is no frame. An unparseable URL gives "" so allowOrigin decides. */
function originOf(frame: FrameLike | null): string | null {
  if (frame === null) return null;
  if (typeof frame.origin === "string" && frame.origin !== "") return frame.origin;
  try {
    return new URL(frame.url).origin;
  } catch {
    return "";
  }
}

/**
 * Wires the session service to Electron IPC: one invoke handler per app on
 * `<channel>:call`, events sent back on `<channel>:event`. Each webContents is
 * a sender that leaves its sessions when it is destroyed or navigates. Unless
 * `presentation: false` it also serves `<channel>:presentation` (see {@link CastManagerOptions.presentation}).
 */
export function createCastManager(options: CastManagerOptions): CastManager {
  const channel = options.channel ?? "electron-cast";
  if (options.presentation !== false && (typeof options.ipcMain.on !== "function" || typeof options.ipcMain.removeListener !== "function")) {
    throw new TypeError("presentation mode needs ipcMain.on and ipcMain.removeListener");
  }
  const discovery = options.discovery ?? new CastDiscovery();
  const createClient = options.createClient ?? ((d: CastDevice) => new CastClient({ host: d.host, port: d.port }));
  const contents = new Map<number, WebContentsLike>();
  let handler: CastPresentationHandler | undefined;
  const service = new CastSessionService({
    devices: discovery,
    createClient,
    selectDevice: options.selectDevice,
    allowOrigin: options.allowOrigin,
    emit(senderId, event) {
      try {
        handler?.onServiceEvent(senderId, event);
      } catch (err) {
        console.error("electron-cast: presentation handler failed on a service event", err);
      }
      const wc = contents.get(senderId);
      if (wc === undefined || wc.isDestroyed()) return;
      try {
        wc.send(`${channel}:event`, event);
      } catch {
        // the webContents was destroyed between the check and the send
      }
    },
  });

  /** Record a webContents on first use and watch it once. */
  const watch = (wc: WebContentsLike): void => {
    if (contents.has(wc.id)) return;
    contents.set(wc.id, wc);
    wc.once("destroyed", () => {
      presentation?.senderGone(wc.id);
      contents.delete(wc.id);
      service.senderGone(wc.id);
    });
    wc.on("did-navigate", () => {
      presentation?.senderGone(wc.id);
      service.senderGone(wc.id);
    });
  };

  options.ipcMain.handle(`${channel}:call`, (event, method, params) => {
    const origin = originOf(event.senderFrame);
    if (origin === null) {
      return Promise.resolve({ ok: false, code: "extension_missing", description: "No sender frame" });
    }
    watch(event.sender);
    return service.handle({ id: event.sender.id, origin }, method, params);
  });

  /** Presentation mode: IPC for the page's stand-in Presentation API, answered by a CastPresentationHandler. */
  const setUpPresentation = () => {
    const ipc = options.ipcMain;
    const on = ipc.on!.bind(ipc);
    const off = ipc.removeListener!.bind(ipc);
    const h = new CastPresentationHandler({ service });
    handler = h;
    const connections = new Map<string, { conn: PresentationConnectionHandle | null; wcId: number }>();
    const watches = new Map<string, { ac: AbortController; wcId: number }>();
    const sendTo = (wcId: number, payload: unknown): void => {
      const wc = contents.get(wcId);
      if (wc === undefined || wc.isDestroyed()) return;
      try {
        wc.send(`${channel}:presentation:event`, payload);
      } catch {
        // destroyed between the check and the send
      }
    };
    const invalid = (description: string) => ({ ok: false, code: "InvalidAccessError", description });
    const isId = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= 256;
    const isUrls = (v: unknown): v is string[] =>
      Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every((u) => typeof u === "string");

    /** Finish a start/reconnect: register the connection and route its traffic to the page. */
    const open = async (wcId: number, connectionId: string, opening: () => Promise<PresentationConnectionHandle>) => {
      if (connections.has(connectionId)) return invalid("connectionId in use");
      const slot: { conn: PresentationConnectionHandle | null; wcId: number } = { conn: null, wcId };
      connections.set(connectionId, slot);  // reserved while the picker or join is pending
      let conn: PresentationConnectionHandle;
      try {
        conn = await opening();
      } catch (err) {
        if (connections.get(connectionId) === slot) connections.delete(connectionId);
        const e = err as { name?: unknown; message?: unknown } | null;
        const name = typeof e?.name === "string" && e.name !== "" && e.name !== "Error" ? e.name : "OperationError";
        return { ok: false, code: name, description: typeof e?.message === "string" ? e.message : String(err) };
      }
      if (!contents.has(wcId) || connections.get(connectionId) !== slot) {
        conn.close();
        return { ok: false, code: "AbortError", description: "The page went away" };
      }
      slot.conn = conn;
      conn.onclose = (state) => {
        if (connections.get(connectionId) === slot) connections.delete(connectionId);
        sendTo(wcId, { type: "statechange", connectionId, state });
      };
      // The stand-in registered this connectionId before calling, so it buffers anything sent before the reply.
      conn.onmessage = (data) => sendTo(wcId, { type: "message", connectionId, data });
      return { ok: true, value: { id: conn.id, url: conn.url } };
    };

    ipc.handle(`${channel}:presentation`, async (event, method, params) => {
      const origin = originOf(event.senderFrame);
      if (origin === null) return { ok: false, code: "NotAllowedError", description: "No sender frame" };
      watch(event.sender);
      const wcId = event.sender.id;
      const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
      try {
        switch (method) {
          case "getAvailability": {
            if (!isId(p.watchId) || !isUrls(p.urls)) return invalid("getAvailability expects { watchId, urls }");
            const watchId = p.watchId;
            const old = watches.get(watchId);
            if (old !== undefined && old.wcId !== wcId) return invalid("watchId in use");
            old?.ac.abort();
            watches.delete(watchId);
            const mine = [...watches].filter(([, w]) => w.wcId === wcId);
            for (const [id, w] of mine.slice(0, Math.max(0, mine.length - (MAX_WATCHES_PER_PAGE - 1)))) {
              w.ac.abort();
              watches.delete(id);
            }
            const ac = new AbortController();
            watches.set(watchId, { ac, wcId });
            const available = await h.getAvailability({
              urls: p.urls,
              origin,
              senderId: wcId,
              signal: ac.signal,
              onchange: (value) => sendTo(wcId, { type: "availability", watchId, value }),
            });
            return { ok: true, value: { available } };
          }
          case "stopWatching": {
            const w = isId(p.watchId) ? watches.get(p.watchId) : undefined;
            if (w !== undefined && w.wcId === wcId) {
              w.ac.abort();
              watches.delete(p.watchId as string);
            }
            return { ok: true, value: undefined };
          }
          case "start":
            if (!isId(p.connectionId) || !isUrls(p.urls)) return invalid("start expects { connectionId, urls }");
            {
              const urls = p.urls;
              return await open(wcId, p.connectionId, () => h.startPresentation({ urls, origin, senderId: wcId }));
            }
          case "reconnect":
            if (!isId(p.connectionId) || !isUrls(p.urls) || !isId(p.presentationId)) {
              return invalid("reconnect expects { connectionId, urls, presentationId }");
            }
            {
              const { urls, presentationId } = p;
              return await open(wcId, p.connectionId,
                () => h.reconnectPresentation({ urls, origin, senderId: wcId, presentationId }));
            }
          case "close":
          case "terminate": {
            const c = isId(p.connectionId) ? connections.get(p.connectionId) : undefined;
            if (c !== undefined && c.wcId === wcId && c.conn !== null) {
              if (method === "close") c.conn.close();
              else c.conn.terminate();
            }
            return { ok: true, value: undefined };
          }
          default:
            return invalid(`unknown method: ${String(method)}`);
        }
      } catch (err) {
        return { ok: false, code: "OperationError", description: err instanceof Error ? err.message : String(err) };
      }
    });

    const onSend = (event: IpcMainEventLike, connectionId: unknown, data: unknown): void => {
      if (typeof connectionId !== "string" || typeof data !== "string") return;
      const c = connections.get(connectionId);
      if (c === undefined || c.wcId !== event.sender.id || c.conn === null) return;
      if (data.length > MAX_MESSAGE_CHARS) return;
      c.conn.send(data);
    };
    on(`${channel}:presentation:send`, onSend);

    return {
      /** Close the page's connections and watches before the service drops it. */
      senderGone(wcId: number): void {
        h.senderGone(wcId);
        for (const [id, c] of connections) if (c.wcId === wcId) connections.delete(id);
        for (const [id, w] of watches) {
          if (w.wcId !== wcId) continue;
          w.ac.abort();
          watches.delete(id);
        }
      },
      dispose(): void {
        ipc.removeHandler(`${channel}:presentation`);
        off(`${channel}:presentation:send`, onSend);
        for (const w of watches.values()) w.ac.abort();
        watches.clear();
        connections.clear();
      },
    };
  };
  const presentation = options.presentation !== false ? setUpPresentation() : undefined;

  let disposed = false;
  return {
    start: () => discovery.start(),
    devices: () => discovery.devices(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      options.ipcMain.removeHandler(`${channel}:call`);
      presentation?.dispose();
      discovery.stop();
      await service.dispose();
      contents.clear();
    },
  };
}
