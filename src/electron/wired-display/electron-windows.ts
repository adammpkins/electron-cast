// The Electron half of a presentation receiver window, after PresentationReceiverWindowController
// (chrome/browser/ui/media_router/presentation_receiver_window_controller.cc) and PresentationReceiverWindowView
// (chrome/browser/ui/views/media_router/presentation_receiver_window_view.cc). The Electron objects are passed in, never
// imported, like everywhere in this package.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installPresentationReceiver } from "../../polyfill/presentation-receiver.ts";
import type { ReceiverEnd } from "./local-presentation.ts";
import type { ReceiverWindow, ReceiverWindowFactory, ReceiverWindowRequest } from "./provider.ts";

/** The part of an Electron `Session` used here. */
export interface ReceiverSessionLike {
  setPermissionRequestHandler(handler: ((wc: unknown, permission: string, callback: (granted: boolean) => void) => void) | null): void;
  setPermissionCheckHandler(handler: ((wc: unknown, permission: string) => boolean) | null): void;
  on(event: "will-download", listener: (event: { preventDefault(): void }) => void): unknown;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
}

/** The part of an Electron `WebContents` used here. */
export interface ReceiverWebContentsLike {
  readonly id: number;
  getURL(): string;
  loadURL(url: string): Promise<void>;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  stop(): void;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
  readonly mainFrame?: unknown;
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** The part of an Electron `BrowserWindow` used here. */
export interface ReceiverBrowserWindowLike {
  readonly webContents: ReceiverWebContentsLike;
  showInactive(): void;
  setFullScreen(flag: boolean): void;
  isFullScreen(): boolean;
  isDestroyed(): boolean;
  close(): void;
  once(event: "closed", listener: () => void): unknown;
}

/** The subset of Electron's `ipcMain` used here. */
export interface ReceiverIpcMainLike {
  handle(channel: string, listener: (event: { sender: ReceiverWebContentsLike; senderFrame: { parent?: unknown } | null }, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: { sender: ReceiverWebContentsLike; senderFrame?: { parent?: unknown } | null }, ...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (...args: any[]) => void): unknown;
}

/** Dependencies of {@link createReceiverWindows}. */
export interface ReceiverWindowsOptions {
  /** `electron.BrowserWindow`. */
  BrowserWindow: new (options: Record<string, unknown>) => ReceiverBrowserWindowLike;
  /** `electron.session`. */
  session: { fromPartition(partition: string): ReceiverSessionLike };
  ipcMain: ReceiverIpcMainLike;
  /** Where the receiver window's preload script is written (it is generated, because a sandboxed preload cannot import). Use a folder only this user can write, such as `app.getPath("userData")`. */
  preloadDir: string;
  /** IPC channel prefix of the receiver page's bridge. Default `electron-cast:receiver`. */
  channel?: string;
  /** Default `process.platform`; decides the fullscreen shortcut (F11, or Control+Command+F on macOS). */
  platform?: string;
}

/** What {@link createReceiverWindows} returns. */
export interface ReceiverWindows {
  readonly factory: ReceiverWindowFactory;
  /** Closes every receiver window and removes the IPC handlers. */
  dispose(): void;
}

const BRIDGE_KEY = "__electronCastReceiverBridge";

/** The generated preload: exposes the receiver bridge and installs the receiver stand-in before the page's scripts. */
export function receiverPreloadSource(channel: string): string {
  return `"use strict";
const { contextBridge, ipcRenderer } = require("electron");
const KEY = ${JSON.stringify(BRIDGE_KEY)};
const CHANNEL = ${JSON.stringify(channel)};
contextBridge.exposeInMainWorld(KEY, {
  call(method, params) {
    return ipcRenderer.invoke(CHANNEL, method, params).then((r) => r, () => ({ ok: false }));
  },
  send(connectionId, data) {
    ipcRenderer.send(CHANNEL + ":send", connectionId, data);
  },
  onEvent(listener) {
    ipcRenderer.on(CHANNEL + ":event", (_event, payload) => {
      try {
        listener(payload);
      } catch (err) {
        console.error(err);
      }
    });
  },
});
contextBridge.executeInMainWorld({ func: (${installPresentationReceiver.toString()}), args: [KEY] });
`;
}

/** Writes the preload (named by its content) unless it is already there; returns its path. */
function writePreload(dir: string, channel: string): string {
  const source = receiverPreloadSource(channel);
  const name = `electron-cast-receiver-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.cjs`;
  const path = join(dir, name);
  let current: string | null = null;
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // not written yet
  }
  if (current !== source) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, source, { mode: 0o600 });
  }
  return path;
}

interface Live {
  win: ReceiverBrowserWindowLike;
  wc: ReceiverWebContentsLike;
  presentationId: string;
  request: ReceiverWindowRequest;
  connections: Map<string, ReceiverEnd>;
}

/**
 * The receiver windows of wired display presentations. Per Chrome's `PresentationReceiverWindowController`:
 *  - a window of its own on the display's bounds, shown without stealing focus, then fullscreen (`ShowInactiveFullscreen`);
 *  - a separate, non-persistent session per presentation, as Chrome uses a unique off-the-record profile
 *    (`OTRProfileID::CreateUniqueForMediaRouter`);
 *  - the page may not open windows or dialogs and may not navigate: the first main-frame navigation is the start URL,
 *    any later one that is not same-document stops the page and terminates the presentation
 *    (`PresentationNavigationPolicy`, `kPresentationReceiverSandboxFlags`);
 *  - closing the window terminates the presentation (`WindowClosed` -> `Terminate`).
 */
export function createReceiverWindows(options: ReceiverWindowsOptions): ReceiverWindows {
  const channel = options.channel ?? "electron-cast:receiver";
  const platform = options.platform ?? process.platform;
  const preload = writePreload(options.preloadDir, channel);
  const byContents = new Map<number, Live>();
  const ipc = options.ipcMain;

  /** The receiver page's IPC is trusted only from the main frame of a window of ours. */
  const liveOf = (event: { sender: ReceiverWebContentsLike; senderFrame?: { parent?: unknown } | null }): Live | undefined => {
    const live = byContents.get(event.sender.id);
    if (live === undefined) return undefined;
    const frame = event.senderFrame;
    if (frame === null || (frame !== undefined && frame.parent !== undefined && frame.parent !== null)) return undefined;
    return live;
  };

  const sendEvent = (live: Live, payload: unknown): void => {
    if (!live.wc.isDestroyed()) live.wc.send(`${channel}:event`, payload);
  };

  ipc.handle(channel, (event, method, params) => {
    const live = liveOf(event);
    if (live === undefined) return { ok: false };
    const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    switch (method) {
      case "register": {
        // ReceiverPresentationServiceDelegateImpl::RegisterReceiverConnectionAvailableCallback: the page's committed URL
        live.request.receiverCreated({ id: live.presentationId, url: live.wc.getURL() }, (end) => {
          const connectionId = randomUUID();
          live.connections.set(connectionId, end);
          end.onmessage = (data) => sendEvent(live, { type: "message", connectionId, data });
          end.onclose = () => {
            live.connections.delete(connectionId);
            sendEvent(live, { type: "closed", connectionId });
          };
          sendEvent(live, { type: "connection", connectionId, id: end.id, url: end.url });
        });
        return { ok: true };
      }
      case "close":
      case "terminate": {
        const end = typeof p.connectionId === "string" ? live.connections.get(p.connectionId) : undefined;
        if (end !== undefined) {
          if (method === "close") {
            live.connections.delete(p.connectionId as string);
            end.close();
          } else {
            end.terminate();
          }
        }
        return { ok: true };
      }
      default:
        return { ok: false };
    }
  });
  const onSend = (event: { sender: ReceiverWebContentsLike; senderFrame?: { parent?: unknown } | null }, connectionId: unknown, data: unknown): void => {
    const live = liveOf(event);
    if (live === undefined || typeof connectionId !== "string" || typeof data !== "string") return;
    live.connections.get(connectionId)?.send(data);
  };
  ipc.on(`${channel}:send`, onSend);

  const open = new Set<Live>();

  const factory: ReceiverWindowFactory = (request) => {
    // A partition without the `persist:` prefix lives in memory only
    const partition = `electron-cast-receiver-${randomUUID()}`;
    const ses = options.session.fromPartition(partition);
    // The receiver has nobody to answer a permission prompt, and Chrome's off-the-record profile starts with no grants.
    // Fullscreen stays, as `requestFullscreen()` is how a presentation fills its screen.
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === "fullscreen"));
    ses.setPermissionCheckHandler((_wc, permission) => permission === "fullscreen");
    ses.on("will-download", (e) => e.preventDefault());

    const b = request.bounds;
    const win = new options.BrowserWindow({
      show: false,
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      fullscreenable: true,
      autoHideMenuBar: true,
      webPreferences: {
        partition,
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        webviewTag: false,
        spellcheck: false,
        allowRunningInsecureContent: false,
      },
    });
    const wc = win.webContents;
    const wcId = wc.id;
    const live: Live = { win, wc, presentationId: "", request, connections: new Map() };
    let terminated = false;
    let firstNavigation = false;

    const finish = (): void => {
      if (terminated) return;
      terminated = true;
      open.delete(live);
      byContents.delete(wcId);
      live.connections.clear();
      // Receiver Reset: the page is gone
      if (live.presentationId !== "") request.receiverReset(live.presentationId);
      void ses.clearStorageData().catch(() => {});
      void ses.clearCache().catch(() => {});
      request.onTerminated();
    };
    byContents.set(wcId, live);
    open.add(live);

    // kPopups
    wc.setWindowOpenHandler(() => ({ action: "deny" }));
    wc.on("will-attach-webview", (e: { preventDefault(): void }) => e.preventDefault());
    // ClosePage runs unload handlers but a beforeunload prompt cannot hold the window open
    wc.on("will-prevent-unload", (e: { preventDefault(): void }) => e.preventDefault());
    // PresentationNavigationPolicy::AllowNavigation: only the first cross-document main-frame navigation is allowed
    wc.on("did-start-navigation", (e: { isMainFrame?: boolean; isSameDocument?: boolean }) => {
      if (e.isMainFrame !== true || e.isSameDocument === true) return;
      if (!firstNavigation) {
        firstNavigation = true;
        return;
      }
      // StopAndTerminate
      wc.stop();
      terminate();
    });
    wc.on("page-title-updated", (_e: unknown, title: string) => request.onTitle(title));
    // The window's accelerator for IDC_FULLSCREEN
    wc.on("before-input-event", (e: { preventDefault(): void }, input: { type: string; key: string; control?: boolean; meta?: boolean }) => {
      if (input.type !== "keyDown") return;
      const toggle = platform === "darwin" ? input.control === true && input.meta === true && input.key.toLowerCase() === "f" : input.key === "F11";
      if (!toggle) return;
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    });
    // PresentationReceiverWindowController::WindowClosed and CloseContents
    win.once("closed", finish);

    const terminate = (): void => {
      if (terminated) return;
      if (win.isDestroyed()) finish();
      else win.close();
    };

    const receiver: ReceiverWindow = {
      start(id, url) {
        live.presentationId = id;
        void wc.loadURL(url).catch(() => {
          // A failed load shows Chrome's error page; the presentation stays until its window closes.
        });
        win.showInactive();
        win.setFullScreen(true);
      },
      terminate,
      exitFullscreen() {
        if (!win.isDestroyed()) win.setFullScreen(false);
      },
    };
    return receiver;
  };

  return {
    factory,
    dispose() {
      ipc.removeHandler(channel);
      ipc.removeListener(`${channel}:send`, onSend);
      for (const live of [...open]) if (!live.win.isDestroyed()) live.win.close();
    },
  };
}
