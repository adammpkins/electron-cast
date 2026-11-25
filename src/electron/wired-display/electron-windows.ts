// The Electron half of a presentation receiver window, after PresentationReceiverWindowController
// (chrome/browser/ui/media_router/presentation_receiver_window_controller.cc) and PresentationReceiverWindowView
// (chrome/browser/ui/views/media_router/presentation_receiver_window_view.cc). The Electron objects are passed in, never
// imported, like everywhere in this package.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installPresentationReceiver } from "../../polyfill/presentation-receiver.ts";
import { MAX_MESSAGE_SIZE, asBytes, messageFields, type ReceiverEnd } from "./local-presentation.ts";
import type { ReceiverWindow, ReceiverWindowFactory, ReceiverWindowRequest } from "./provider.ts";
import type { PresentationInfo, ReceiverConnectionCallback } from "./local-presentation.ts";
import { watchCapture, type OffscreenTabHandle, type Size } from "../../mirroring/offscreen-tab.ts";

/** The part of an Electron `Session` used here. */
export interface ReceiverSessionLike {
  setPermissionRequestHandler(
    handler: ((wc: unknown, permission: string, callback: (granted: boolean) => void, details?: { securityOrigin?: string }) => void) | null,
  ): void;
  setPermissionCheckHandler(handler: ((wc: unknown, permission: string) => boolean) | null): void;
  on(event: "will-download", listener: (event: { preventDefault(): void }) => void): unknown;
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
  readonly webRequest: {
    onHeadersReceived(
      listener: (
        details: { resourceType?: string; responseHeaders?: Record<string, string[]> },
        callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
      ) => void,
    ): void;
  };
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
  /** The session of the contents; used for an offscreen tab when no `session` module was given. */
  readonly session?: ReceiverSessionLike;
  /** Offscreen tabs only (`WebContents::SetAudioMuted`, `IsBeingCaptured`). */
  setAudioMuted?(muted: boolean): void;
  isBeingCaptured?(): boolean;
}

/** The part of an Electron `BrowserWindow` used here. */
export interface ReceiverBrowserWindowLike {
  readonly webContents: ReceiverWebContentsLike;
  showInactive(): void;
  setFullScreen(flag: boolean): void;
  isFullScreen(): boolean;
  isDestroyed(): boolean;
  close(): void;
  /** Windows and Linux; absent where there is no per-window menu. */
  removeMenu?(): void;
  once(event: "closed", listener: () => void): unknown;
  /** Offscreen tabs only. */
  setContentSize?(width: number, height: number): void;
  destroy?(): void;
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

/**
 * `kPresentationReceiverSandboxFlags` (content/public/browser/presentation_receiver_flags.h) is kModals | kPopups |
 * kTopNavigation, set as the starting sandbox flags of the receiver's browsing context so every frame in it inherits them.
 * Electron has no way to set starting flags, so the same sandbox is sent as a `Content-Security-Policy: sandbox` header on
 * every document the receiver loads. A sandbox removes every capability its tokens do not name, so this names all of the
 * capabilities but those three: no `allow-modals` (alert, confirm, prompt, print, beforeunload dialogs, in any frame),
 * no `allow-popups` and no `allow-top-navigation`, `allow-top-navigation-by-user-activation` or
 * `allow-top-navigation-to-custom-protocols`. `allow-same-origin` keeps the page's origin, as without a sandbox.
 */
export const RECEIVER_SANDBOX =
  "sandbox allow-downloads allow-forms allow-orientation-lock allow-pointer-lock allow-presentation allow-same-origin allow-scripts allow-storage-access-by-user-activation";

/**
 * The origin of the mirroring host's capture page (src/mirroring/electron/host.ts loads it with `loadFile`), as Electron
 * reports it in a permission request's `securityOrigin`.
 */
const CAPTURER_ORIGIN = "file:///";

/** Sessions that were cleared and can serve another presentation; more would only hold memory. */
const MAX_POOLED_SESSIONS = 4;

/** An `ipcMain` can have one receiver bridge per channel; a second `ipcMain.handle` on it would throw an opaque error. */
const claimedChannels = new WeakMap<object, Set<string>>();

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
 *    (`OTRProfileID::CreateUniqueForMediaRouter`); a finished presentation's session is cleared (storage, cache) and
 *    reused by a later one, so sessions do not pile up, at most {@link MAX_POOLED_SESSIONS} are kept;
 *  - no popups, dialogs or top-level navigation by the page or any frame in it: the {@link RECEIVER_SANDBOX} header
 *    (`kPresentationReceiverSandboxFlags`), `setWindowOpenHandler`, and beforeunload prompts that cannot hold the window;
 *  - the first main-frame navigation is the start URL, any later one that is not same-document stops the page and
 *    terminates the presentation (`PresentationNavigationPolicy`);
 *  - closing the window terminates the presentation (`WindowClosed` -> `Terminate`).
 *
 * One call per `ipcMain` and `channel` until its `dispose()`: a second one throws.
 */
export function createReceiverWindows(options: ReceiverWindowsOptions): ReceiverWindows {
  const host = createReceiverHost(options);
  return { factory: host.factory, dispose: host.dispose };
}

/** What an offscreen tab is opened with (`OffscreenTab::Start` with a presentation id). */
export interface OffscreenReceiverRequest {
  url: string;
  presentationId: string;
  /** `initial_size`. */
  size: Size;
  /** The tab is gone, for whatever reason. Runs once. */
  onDestroyed(): void;
  /** As {@link ReceiverWindowRequest}'s. */
  receiverCreated(info: PresentationInfo, callback: ReceiverConnectionCallback): void;
  receiverReset(presentationId: string): void;
  /** Why the tab destroyed itself, for the log. */
  log?(message: string): void;
}

/** The receiver windows and the offscreen tabs: both are a page with `ReceiverPresentationServiceDelegateImpl`. */
export interface ReceiverHost extends ReceiverWindows {
  /**
   * `OffscreenTab::Start` (chrome/browser/media/offscreen_tab.cc) with a presentation id: what
   * `CastMirroringServiceHost::OpenOffscreenTab` opens to render a presentation URL that is then mirrored. Chrome makes
   * a `WebContents` that is in no window; Electron has none without a window, so this is a window that is never shown:
   *  - `initial_size` is the size of its page (set after the window is made: Windows clamps the size a window is created
   *    with to the work area);
   *  - muted from the start ("Mute audio output. When tab capture starts, the audio will be automatically unmuted, but
   *    will be captured into the MediaStream"): the mirroring host keeps a captured tab silent here for the whole session;
   *  - a profile of its own, the receiver sandbox flags, no popups and the presentation navigation policy, as for a
   *    receiver window: a second main-frame navigation closes the tab (`DidStartNavigation` -> `Close`);
   *  - no input reaches it (`PreHandleKeyboardEvent`, `ShouldFocusLocationBarByDefault`): it cannot be focused;
   *  - no downloads (`CanDownload`), no camera or microphone (`RequestMediaAccessPermission` answers NOT_SUPPORTED);
   *  - an element may go fullscreen and then fills the tab (`EnterFullscreenModeForTab`); the window stays hidden;
   *  - `window.close()` destroys it (`CloseContents`), and so does `DieIfContentCaptureEnded` (see `watchCapture`).
   * Throws when the window cannot be made.
   */
  openOffscreenTab(request: OffscreenReceiverRequest): OffscreenTabHandle;
}

/** {@link createReceiverWindows} with the offscreen tabs. `session` may be left out: a window's own session is used then. */
export function createReceiverHost(options: Omit<ReceiverWindowsOptions, "session"> & { session?: ReceiverWindowsOptions["session"] }): ReceiverHost {
  const channel = options.channel ?? "electron-cast:receiver";
  const platform = options.platform ?? process.platform;
  const ipc = options.ipcMain;
  const claimed = claimedChannels.get(ipc) ?? new Set<string>();
  if (claimed.has(channel)) {
    throw new Error(`createReceiverWindows: the channel "${channel}" is already in use on this ipcMain; dispose() the first one, or pass another channel`);
  }
  const preload = writePreload(options.preloadDir, channel);
  claimed.add(channel);
  claimedChannels.set(ipc, claimed);
  const byContents = new Map<number, Live>();

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
          end.onmessage = (data) => sendEvent(live, { type: "message", connectionId, ...messageFields(data) });
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
    if (live === undefined || typeof connectionId !== "string") return;
    const message = typeof data === "string" ? data : asBytes(data);
    if (message === null || (typeof message === "string" ? message.length : message.byteLength) > MAX_MESSAGE_SIZE) return;
    live.connections.get(connectionId)?.send(message);
  };
  ipc.on(`${channel}:send`, onSend);

  const open = new Set<Live>();

  interface PooledSession { partition: string; ses: ReceiverSessionLike | null; capturable: boolean }
  const pool: PooledSession[] = [];
  let disposed = false;

  const configure = (ses: ReceiverSessionLike, session: PooledSession): void => {
    // The receiver has nobody to answer a permission prompt, and Chrome's off-the-record profile starts with no grants.
    // Fullscreen stays, as `requestFullscreen()` is how a presentation fills its screen.
    //
    // An offscreen tab must be capturable by the mirroring host. Electron asks the session of the page that is captured,
    // not of the page that captures, for `display-capture`, and asks it the same thing when the page itself wants to
    // capture the screen (`getUserMedia` with `chromeMediaSource: "desktop"`). The two differ only in the request's
    // `securityOrigin`: the capturing page's, which for the mirroring host is a file page and for the receiver's page
    // (loaded over http or https, and unable to navigate or to frame a file) never is. So that one origin is granted, and
    // the page's own requests are refused as `OffscreenTab::RequestMediaAccessPermission` refuses them (NOT_SUPPORTED).
    ses.setPermissionRequestHandler((_wc, permission, callback, details) =>
      callback(permission === "fullscreen" || (session.capturable && permission === "display-capture" && details?.securityOrigin === CAPTURER_ORIGIN)));
    ses.setPermissionCheckHandler((_wc, permission) => permission === "fullscreen");
    ses.on("will-download", (e) => e.preventDefault());
    // kPresentationReceiverSandboxFlags on every document of the receiver, frames included
    ses.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") {
        callback({});
        return;
      }
      const headers = { ...details.responseHeaders };
      const key = Object.keys(headers).find((k) => k.toLowerCase() === "content-security-policy") ?? "Content-Security-Policy";
      headers[key] = [...(headers[key] ?? []), RECEIVER_SANDBOX];
      callback({ responseHeaders: headers });
    });
  };
  const newSession = (): PooledSession => {
    // A partition without the `persist:` prefix lives in memory only
    const partition = `electron-cast-receiver-${randomUUID()}`;
    const session: PooledSession = { partition, ses: options.session?.fromPartition(partition) ?? null, capturable: false };
    if (session.ses !== null) configure(session.ses, session);
    return session;
  };

  /** `offscreen` is set for an offscreen tab; a receiver window is on its display's bounds. */
  const openWindow = (request: ReceiverWindowRequest, offscreen?: { log(message: string): void }): { receiver: ReceiverWindow; webContentsId: number; destroy(): void } => {
    const session = pool.pop() ?? newSession();
    const { partition } = session;
    session.capturable = offscreen !== undefined;

    const b = request.bounds;
    const win = new options.BrowserWindow({
      show: false,
      ...(offscreen === undefined
        ? { x: b.x, y: b.y, fullscreenable: true, autoHideMenuBar: true }
        // Never shown and never focused. Not fullscreenable, so that an element's fullscreen fills the page and leaves
        // the window alone, as OffscreenTab::EnterFullscreenModeForTab only resizes the tab.
        : { useContentSize: true, frame: false, focusable: false, skipTaskbar: true, fullscreenable: false }),
      width: b.width,
      height: b.height,
      webPreferences: {
        partition,
        preload,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: false,
        webviewTag: false,
        spellcheck: false,
        allowRunningInsecureContent: false,
        // A page that is never shown must still render: Chrome's capturer keeps the tab visible to its renderer
        ...(offscreen === undefined ? {} : { backgroundThrottling: false }),
      },
    });
    if (session.ses === null) {
      const own = win.webContents.session;
      if (own === undefined) {
        win.close();
        throw new Error("the receiver's session cannot be reached");
      }
      configure(own, session);
      session.ses = own;
    }
    const ses = session.ses;
    if (offscreen !== undefined) win.setContentSize?.(b.width, b.height);
    // Chrome's receiver window has no browser UI, so no menu accelerators (reload, developer tools) either
    win.removeMenu?.();
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
      // The session goes back to the pool once nothing of the page is left in it; one that fails to clear is dropped
      void Promise.all([ses.clearStorageData(), ses.clearCache()]).then(
        () => {
          if (!disposed && pool.length < MAX_POOLED_SESSIONS) pool.push(session);
        },
        () => {},
      );
      request.onTerminated();
    };
    byContents.set(wcId, live);
    open.add(live);

    // kPopups (the sandbox header covers frames; this covers the window itself even for a document without headers)
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
      if (offscreen !== undefined) {
        // OffscreenTab::PreHandleKeyboardEvent: "Intercept and silence all keyboard events"
        e.preventDefault();
        return;
      }
      if (input.type !== "keyDown") return;
      const toggle = platform === "darwin" ? input.control === true && input.meta === true && input.key.toLowerCase() === "f" : input.key === "F11";
      if (!toggle) return;
      e.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    });
    // PresentationReceiverWindowController::WindowClosed and CloseContents
    let stopWatching: (() => void) | undefined;
    win.once("closed", () => {
      stopWatching?.();
      finish();
    });
    /** `destroy_callback_`: the contents are deleted, with no unload handlers. */
    const destroy = (): void => {
      stopWatching?.();
      if (terminated) return;
      if (win.isDestroyed()) finish();
      else if (win.destroy !== undefined) win.destroy();
      else win.close();
    };

    const terminate = (): void => {
      if (terminated) return;
      if (win.isDestroyed()) finish();
      else win.close();
    };

    const receiver: ReceiverWindow = {
      start(id, url) {
        live.presentationId = id;
        if (offscreen !== undefined) wc.setAudioMuted?.(true);
        void wc.loadURL(url).catch(() => {
          // A failed load shows Chrome's error page; the presentation stays until its window closes.
        });
        if (offscreen === undefined) {
          win.showInactive();
          win.setFullScreen(true);
          return;
        }
        // OffscreenTab::Start ends with DieIfContentCaptureEnded()
        if (wc.isBeingCaptured !== undefined) {
          stopWatching = watchCapture({
            isBeingCaptured: () => !wc.isDestroyed() && wc.isBeingCaptured!(),
            destroy: (reason) => {
              offscreen.log(reason === "capture_ended"
                ? "Capture of the offscreen tab has stopped; the tab is destroyed."
                : "Capture of the offscreen tab did not start within a minute; the tab is destroyed.");
              destroy();
            },
          });
        }
      },
      terminate,
      exitFullscreen() {
        if (offscreen === undefined && !win.isDestroyed()) win.setFullScreen(false);
      },
    };
    return { receiver, webContentsId: wcId, destroy };
  };
  const factory: ReceiverWindowFactory = (request) => openWindow(request).receiver;

  return {
    factory,
    openOffscreenTab(request) {
      const tab = openWindow({
        bounds: { x: 0, y: 0, width: request.size.width, height: request.size.height },
        onTerminated: () => request.onDestroyed(),
        // The route of an offscreen tab is described by its URL, never by the page's title
        onTitle: () => {},
        receiverCreated: (info, callback) => request.receiverCreated(info, callback),
        receiverReset: (id) => request.receiverReset(id),
      }, { log: (message) => request.log?.(message) });
      tab.receiver.start(request.presentationId, request.url);
      return { webContentsId: tab.webContentsId, destroy: tab.destroy };
    },
    dispose() {
      disposed = true;
      claimed.delete(channel);
      ipc.removeHandler(channel);
      ipc.removeListener(`${channel}:send`, onSend);
      for (const live of [...open]) if (!live.win.isDestroyed()) live.win.close();
    },
  };
}
