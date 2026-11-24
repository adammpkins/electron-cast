import { CastSessionService, type CastClientLike, type DeviceSource, type CastRequestInfo, type DeviceChoice, type SessionStore } from "./session-service.ts";
import type { CastDevice } from "../discovery/index.ts";
import { CastDiscovery } from "../discovery/index.ts";
import { CastClient } from "../client/index.ts";

export type { CastRequestInfo, DeviceChoice, SavedSession, SessionStore } from "./session-service.ts";
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
/** The subset of an Electron `IpcMain` the manager needs. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEventLike, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
}
/** Dependencies of {@link createCastManager}; the Electron objects are passed in, never imported. */
export interface CastManagerOptions {
  ipcMain: IpcMainLike;
  selectDevice(devices: CastDevice[], request: CastRequestInfo): Promise<DeviceChoice>;
  allowOrigin?(origin: string): boolean;
  sessionStore?: SessionStore;                                            // rejoin the last session after a restart
  discovery?: DeviceSource & { start(): Promise<void>; stop(): void };  // default new CastDiscovery()
  createClient?(device: CastDevice): CastClientLike;                     // default new CastClient({ host, port })
  channel?: string;                                                       // default "electron-cast"
}
/** The main-process cast manager. */
export interface CastManager {
  start(): Promise<void>;
  devices(): CastDevice[];
  dispose(): Promise<void>;
}

/**
 * Wires the session service to Electron IPC: one invoke handler per app on
 * `<channel>:call`, events sent back on `<channel>:event`. Each webContents is
 * a sender that leaves its sessions when it is destroyed or navigates.
 */
export function createCastManager(options: CastManagerOptions): CastManager {
  const channel = options.channel ?? "electron-cast";
  const discovery = options.discovery ?? new CastDiscovery();
  const createClient = options.createClient ?? ((d: CastDevice) => new CastClient({ host: d.host, port: d.port }));
  const contents = new Map<number, WebContentsLike>();
  const service = new CastSessionService({
    devices: discovery,
    createClient,
    selectDevice: options.selectDevice,
    allowOrigin: options.allowOrigin,
    sessionStore: options.sessionStore,
    emit(senderId, event) {
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
      contents.delete(wc.id);
      service.senderGone(wc.id);
    });
    wc.on("did-navigate", () => {
      service.senderGone(wc.id);
    });
  };

  options.ipcMain.handle(`${channel}:call`, (event, method, params) => {
    const frame = event.senderFrame;
    if (frame === null) {
      return Promise.resolve({ ok: false, code: "extension_missing", description: "No sender frame" });
    }
    let origin = "";
    if (typeof frame.origin === "string" && frame.origin !== "") {
      origin = frame.origin;
    } else {
      try {
        origin = new URL(frame.url).origin;
      } catch {
        // invalid URL: keep "" so allowOrigin decides
      }
    }
    watch(event.sender);
    return service.handle({ id: event.sender.id, origin }, method, params);
  });

  let disposed = false;
  return {
    start: () => discovery.start(),
    devices: () => discovery.devices(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      options.ipcMain.removeHandler(`${channel}:call`);
      discovery.stop();
      await service.dispose();
      contents.clear();
    },
  };
}
