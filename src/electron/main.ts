import { CastSessionService, type CastClientLike, type DeviceSource, type CastRequestInfo, type DeviceChoice, type DisplayChoice } from "./session-service.ts";
import type { CastDevice } from "../discovery/index.ts";
import { CastDiscovery } from "../discovery/index.ts";
import { CastClient } from "../client/index.ts";
import { CastPresentationHandler, PresentationError, type PresentationConnectionHandle } from "./presentation-handler.ts";
import { parsePresentationUrl } from "./presentation-envelope.ts";
import { MAX_MESSAGE_SIZE, asBytes, messageFields } from "./wired-display/local-presentation.ts";
import type { WiredDisplaySink } from "./wired-display/displays.ts";
import { createWiredDisplay, isWiredDisplaySource, type LocalConnectionHandle, type WiredDisplayApi, type WiredDisplayOptions } from "./wired-display/index.ts";
import { createManagerApi, createSinksObservers, type CastManagerApi, type DevicePickerContext } from "./manager-api.ts";
import type { BridgeMethod } from "../polyfill/bridge-types.ts";

/**
 * The methods a page may call over IPC: the bridge's own. The service also handles methods that only main calls
 * (joinRunningSession, from the presentation handler), which a page must not reach directly.
 */
const PAGE_METHODS: ReadonlySet<string> = new Set<BridgeMethod>([
  "initialize", "requestSession", "joinSession", "sendMessage", "stopSession",
  "leaveSession", "setReceiverVolume", "setReceiverMuted",
]);

export type { CastRequestInfo, DeviceChoice, DisplayChoice } from "./session-service.ts";
export type { CastDevice } from "../discovery/index.ts";
export { MediaRouteError } from "./manager-api.ts";
export {
  createReceiverWindows, isWiredDisplaySource, availableDisplays, wiredDisplaySinks,
  type WiredDisplayApi, type WiredDisplayOptions, type WiredDisplayRequest, type WiredDisplaySink, type WiredDisplayRoute,
  type ReceiverWindows, type ReceiverWindowsOptions, type ScreenLike, type DisplayLike, type WindowLike, type PresentationMessage,
} from "./wired-display/index.ts";
export type {
  CastManagerApi, DevicePickerContext, MediaRoute, MediaRouteController, MediaRoutesObserver, MediaSink, MediaSinksObserver,
  MediaSinksQuery, SinkIconType,
} from "./manager-api.ts";

/** The subset of an Electron `WebFrameMain` the manager needs. */
export interface FrameLike {
  url: string;
  origin?: string;
  /** Browser-global and constant for the frame's lifetime, across navigations; identifies a subframe. */
  frameTreeNodeId?: number;
  /** Null or absent on a main frame. */
  parent?: unknown;
  processId?: number;
  routingId?: number;
  /** Reaches only this frame (and needs the preload to run there: `nodeIntegrationInSubFrames`). */
  send?(channel: string, ...args: any[]): void;
}
/** The subset of an Electron `WebContents` the manager needs. */
export interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: any[]): void;
  isDestroyed(): boolean;
  /** The frame tree; consulted to find a subframe's current frame and to notice frames that were removed. */
  readonly mainFrame?: { readonly framesInSubtree: readonly FrameLike[] };
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "did-navigate" | "did-frame-navigate", listener: (...args: any[]) => void): unknown;
}
/** The subset of an Electron `IpcMainInvokeEvent` the manager needs. */
export interface IpcMainInvokeEventLike { sender: WebContentsLike; senderFrame: FrameLike | null }
/** The subset of an Electron `IpcMainEvent` the manager needs. */
export interface IpcMainEventLike { sender: WebContentsLike; senderFrame?: FrameLike | null }
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
  /** `picker` (optional to declare) streams device changes while the picker is open; see {@link DevicePickerContext}. */
  selectDevice(devices: CastDevice[], request: CastRequestInfo, picker: DevicePickerContext): Promise<DeviceChoice | DisplayChoice>;
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
  /**
   * Verify each device is a genuine Google-certified Cast device when connecting, as Chrome does (CastClient's
   * `verifyDevice`). Default true; false allows uncertified receivers. Ignored when `createClient` is given.
   */
  verifyDevices?: boolean;
  /**
   * Show a page's presentation on another screen, as Chrome's wired display provider does (presentation mode only).
   * Chrome has it always on; here the app passes Electron's `screen` and a window factory, because this package never
   * imports Electron. See {@link WiredDisplayOptions}.
   */
  wiredDisplay?: WiredDisplayOptions;
}
/** The main-process cast manager; the observers, routes and route control come from {@link CastManagerApi}. */
export interface CastManager extends CastManagerApi {
  start(): Promise<void>;
  devices(): CastDevice[];
  dispose(): Promise<void>;
  /** The wired display sinks and routes; present when the `wiredDisplay` option was given. */
  readonly wiredDisplay?: WiredDisplayApi;
}

/** Availability watches kept per frame; the page never releases one, so the oldest are dropped. */
const MAX_WATCHES_PER_PAGE = 32;
/** Sender ids of subframes start here, far above any webContents id (a main frame's sender id is its webContents id). */
const SUBFRAME_ID_BASE = 2 ** 30;
/** How often removed iframes (which Electron does not announce) are noticed and their sessions released. */
const FRAME_SWEEP_MS = 5000;
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
  const createClient = options.createClient ?? ((d: CastDevice) => new CastClient({ host: d.host, port: d.port, verifyDevice: options.verifyDevices !== false }));
  /**
   * A sender is one frame. A main frame's sender id is its webContents id; a subframe gets an id of its own, kept for
   * the frame's lifetime (across its navigations, so a reloaded iframe can rejoin its session). The frame is looked up
   * in the frame tree on every use, never held, because navigating can swap the frame object.
   */
  interface SenderEntry { wc: WebContentsLike; frameTreeNodeId: number | null }
  const senders = new Map<number, SenderEntry>();
  const subframeIds = new Map<number, number>();  // frameTreeNodeId -> sender id
  const watched = new Set<number>();              // webContents ids
  let nextSubframeId = SUBFRAME_ID_BASE;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let handler: CastPresentationHandler | undefined;

  const findFrame = (wc: WebContentsLike, frameTreeNodeId: number): FrameLike | undefined => {
    try {
      return wc.mainFrame?.framesInSubtree.find((f) => f.frameTreeNodeId === frameTreeNodeId);
    } catch {
      return undefined;  // the webContents is gone
    }
  };
  const isMainFrame = (frame: FrameLike): boolean => frame.parent === undefined || frame.parent === null;
  /**
   * The sender id of an IPC event's frame, without registering it; undefined when it is not a known sender. An event
   * with no `senderFrame` property at all is the main frame's; a null one is a frame that is already gone.
   */
  const senderIdOf = (wc: WebContentsLike, frame: FrameLike | null | undefined): number | undefined => {
    if (frame === undefined) return wc.id;
    if (frame === null) return undefined;
    if (isMainFrame(frame)) return wc.id;
    return typeof frame.frameTreeNodeId === "number" ? subframeIds.get(frame.frameTreeNodeId) : undefined;
  };
  /** The sender id of an IPC event's frame, registering a subframe (and watching its webContents) on first use. */
  const registerSender = (wc: WebContentsLike, frame: FrameLike): number | null => {
    if (isMainFrame(frame)) {
      watch(wc);
      if (!senders.has(wc.id)) senders.set(wc.id, { wc, frameTreeNodeId: null });
      return wc.id;
    }
    const node = frame.frameTreeNodeId;
    if (typeof node !== "number") return null;
    watch(wc);
    let id = subframeIds.get(node);
    if (id === undefined) {
      id = nextSubframeId++;
      subframeIds.set(node, id);
      senders.set(id, { wc, frameTreeNodeId: node });
      sweepTimer ??= setInterval(sweepFrames, FRAME_SWEEP_MS);
      sweepTimer.unref?.();
    }
    return id;
  };
  /** Forget a subframe sender for good: its connections, watches and sessions end. */
  const dropSubframe = (id: number): void => {
    const entry = senders.get(id);
    if (entry === undefined || entry.frameTreeNodeId === null) return;
    presentation?.senderGone(id);
    senders.delete(id);
    subframeIds.delete(entry.frameTreeNodeId);
    service.senderGone(id);
    if (subframeIds.size === 0 && sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  };
  /** Drop subframe senders whose frame was removed (Electron announces neither an iframe's removal nor its page's). */
  function sweepFrames(): void {
    for (const [id, entry] of [...senders]) {
      if (entry.frameTreeNodeId === null) continue;
      if (entry.wc.isDestroyed() || findFrame(entry.wc, entry.frameTreeNodeId) === undefined) dropSubframe(id);
    }
  }
  /** Send to the one frame that owns the sender; a frame that is gone ends the sender. */
  const deliver = (senderId: number, ch: string, payload: unknown): void => {
    const entry = senders.get(senderId);
    if (entry === undefined || entry.wc.isDestroyed()) return;
    try {
      if (entry.frameTreeNodeId === null) {
        entry.wc.send(ch, payload);
        return;
      }
      const frame = findFrame(entry.wc, entry.frameTreeNodeId);
      if (frame?.send === undefined) {
        queueMicrotask(() => dropSubframe(senderId));  // not inside the service's own emit
        return;
      }
      frame.send(ch, payload);
    } catch {
      // the webContents or frame was destroyed between the check and the send
    }
  };
  /**
   * Starts whose URLs a display and a Cast device can both serve, while their picker is open. The one picker lists both kinds
   * of sink, as Chrome's dialog does; a display chosen in it is recorded here and the Cast flow is told the user cancelled.
   */
  const mixedStarts = new Map<number, { displays: WiredDisplaySink[]; chosen: string | null }>();
  const service = new CastSessionService({
    devices: discovery,
    createClient,
    async selectDevice(devices, request, picker) {
      const mixed = mixedStarts.get(request.senderId);
      const choice = await options.selectDevice(devices, mixed === undefined ? request : { ...request, displays: mixed.displays }, picker);
      if (typeof choice === "object" && choice !== null && "display" in choice) {
        if (mixed !== undefined && mixed.displays.some((d) => d.id === choice.display)) mixed.chosen = choice.display;
        return null;
      }
      return choice;
    },
    allowOrigin: options.allowOrigin,
    emit(senderId, event) {
      try {
        handler?.onServiceEvent(senderId, event);
      } catch (err) {
        console.error("electron-cast: presentation handler failed on a service event", err);
      }
      deliver(senderId, `${channel}:event`, event);
    },
  });

  /** Watch a webContents once: its destruction and its navigations end or park its senders. */
  function watch(wc: WebContentsLike): void {
    if (watched.has(wc.id)) return;
    watched.add(wc.id);
    const subframes = (): number[] =>
      [...senders].filter(([, e]) => e.wc === wc && e.frameTreeNodeId !== null).map(([id]) => id);
    wc.once("destroyed", () => {
      watched.delete(wc.id);
      for (const id of subframes()) dropSubframe(id);
      presentation?.senderGone(wc.id);
      senders.delete(wc.id);
      service.senderGone(wc.id);
    });
    // A navigation ends the page's connections, but its sessions stay open (parked) so the next page can rejoin them
    wc.on("did-navigate", () => {
      presentation?.senderGone(wc.id);
      service.senderNavigated(wc.id);
      for (const id of subframes()) dropSubframe(id);  // the page's iframes went with it
    });
    // An iframe that navigates on its own is treated the same way (the main frame is handled above).
    wc.on("did-frame-navigate", (_event, _url, _code, _text, mainFrame, processId, routingId) => {
      if (mainFrame === true) return;
      const frame = wc.mainFrame?.framesInSubtree.find((f) => f.processId === processId && f.routingId === routingId);
      const id = typeof frame?.frameTreeNodeId === "number" ? subframeIds.get(frame.frameTreeNodeId) : undefined;
      if (id !== undefined) {
        presentation?.senderGone(id);
        service.senderNavigated(id);
      }
      sweepFrames();
    });
  }

  options.ipcMain.handle(`${channel}:call`, (event, method, params) => {
    const origin = originOf(event.senderFrame);
    if (origin === null || event.senderFrame === null) {
      return Promise.resolve({ ok: false, code: "extension_missing", description: "No sender frame" });
    }
    // mode "chromecast" is main-frame only; iframes are served in presentation mode, as in Chrome
    if (!isMainFrame(event.senderFrame)) {
      return Promise.resolve({ ok: false, code: "extension_missing", description: "chrome.cast is not available in iframes; use presentation mode" });
    }
    if (typeof method !== "string" || !PAGE_METHODS.has(method)) {
      return Promise.resolve({ ok: false, code: "invalid_parameter", description: `unknown method: ${String(method)}` });
    }
    const id = registerSender(event.sender, event.senderFrame)!;
    return service.handle({ id, origin }, method, params);
  });

  const wired = options.wiredDisplay !== undefined && options.presentation !== false ? createWiredDisplay(options.wiredDisplay) : undefined;

  /** Presentation mode: IPC for the page's stand-in Presentation API, answered by a CastPresentationHandler. */
  const setUpPresentation = () => {
    const ipc = options.ipcMain;
    const on = ipc.on!.bind(ipc);
    const off = ipc.removeListener!.bind(ipc);
    const h = new CastPresentationHandler({ service });
    handler = h;
    const connections = new Map<string, { conn: PresentationConnectionHandle | null; sid: number }>();
    const watches = new Map<string, { ac: AbortController; sid: number }>();
    const sendTo = (sid: number, payload: unknown): void => {
      deliver(sid, `${channel}:presentation:event`, payload);
    };
    const invalid = (description: string) => ({ ok: false, code: "InvalidAccessError", description });
    const isId = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= 256;
    const isUrls = (v: unknown): v is string[] =>
      Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every((u) => typeof u === "string");

    /** Finish a start/reconnect: register the connection and route its traffic to the page. */
    const open = async (sid: number, connectionId: string, opening: () => Promise<PresentationConnectionHandle>) => {
      if (connections.has(connectionId)) return invalid("connectionId in use");
      const slot: { conn: PresentationConnectionHandle | null; sid: number } = { conn: null, sid };
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
      if (!senders.has(sid) || connections.get(connectionId) !== slot) {
        conn.close();
        return { ok: false, code: "AbortError", description: "The page went away" };
      }
      slot.conn = conn;
      // A wired display connection starts out connecting, as Blink's does, and connects when the receiver page is ready
      const local = conn as Partial<LocalConnectionHandle>;
      if (typeof local.connecting === "boolean") {
        (conn as LocalConnectionHandle).onconnect = () => sendTo(sid, { type: "statechange", connectionId, state: "connected" });
      }
      conn.onclose = (state) => {
        if (connections.get(connectionId) === slot) connections.delete(connectionId);
        sendTo(sid, { type: "statechange", connectionId, state });
      };
      // The stand-in registered this connectionId before calling, so it buffers anything sent before the reply.
      if (typeof local.connecting === "boolean") {
        (conn as LocalConnectionHandle).onmessage = (data) => sendTo(sid, { type: "message", connectionId, ...messageFields(data) });
      } else {
        conn.onmessage = (data) => sendTo(sid, { type: "message", connectionId, data });
      }
      return { ok: true, value: { id: conn.id, url: conn.url, ...(local.connecting === true ? { state: "connecting" } : {}), ...(typeof local.connecting === "boolean" ? { local: true } : {}) } };
    };

    /** A start() whose URLs only a display can show: the app picks a display, a window opens on it. */
    const startOnDisplay = async (sid: number, origin: string, urls: string[]): Promise<PresentationConnectionHandle> => {
      const w = wired!;
      const wc = senders.get(sid)?.wc;
      const sinks = w.sinksFor(wc);
      const request = { urls: [...urls], origin, senderId: sid, observeSinks: (l: Parameters<typeof w.observeSinksFor>[1]) => w.observeSinksFor(wc, l) };
      const choice = await w.selectDisplay(sinks, request);
      if (choice === null) throw new PresentationError("AbortError", "The user cancelled the request");
      return w.controllers.start(request, choice);
    };
    /** The Cast app URLs of a request, which the Cast provider serves. */
    const castUrlsOf = (urls: string[]): string[] => urls.filter((u) => parsePresentationUrl(u) !== null);
    /**
     * A start() whose URLs a display and a Cast device can both serve: one picker offers both kinds and the sink it returns
     * decides (a display starts a wired display presentation, a device the Cast flow). With no displays or no devices there
     * is nothing to choose between and the flow of the one kind that exists runs.
     */
    const startMixed = async (sid: number, origin: string, urls: string[]): Promise<PresentationConnectionHandle> => {
      const w = wired!;
      const wc = senders.get(sid)?.wc;
      const displays = w.sinksFor(wc);
      const castUrls = castUrlsOf(urls);
      if (displays.length === 0 || discovery.devices().length === 0) {
        return displays.length > 0 ? startOnDisplay(sid, origin, urls) : h.startPresentation({ urls: castUrls, origin, senderId: sid });
      }
      const mixed = { displays, chosen: null as string | null };
      mixedStarts.set(sid, mixed);
      try {
        return await h.startPresentation({ urls: castUrls, origin, senderId: sid });
      } catch (err) {
        if (mixed.chosen === null) throw err;
        return w.controllers.start({ urls: [...urls], origin, senderId: sid }, mixed.chosen);
      } finally {
        mixedStarts.delete(sid);
      }
    };

    /** Only a display serves these URLs: one is a standard presentation source and none is a Cast app URL. */
    const displayOnly = (urls: string[]): boolean =>
      wired !== undefined && urls.some((u) => isWiredDisplaySource(u)) && !urls.some((u) => parsePresentationUrl(u) !== null);

    ipc.handle(`${channel}:presentation`, async (event, method, params) => {
      const origin = originOf(event.senderFrame);
      if (origin === null || event.senderFrame === null) return { ok: false, code: "NotAllowedError", description: "No sender frame" };
      const sid = registerSender(event.sender, event.senderFrame);
      if (sid === null) return { ok: false, code: "NotAllowedError", description: "Unidentifiable sender frame" };
      const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
      try {
        switch (method) {
          case "getAvailability": {
            if (!isId(p.watchId) || !isUrls(p.urls)) return invalid("getAvailability expects { watchId, urls }");
            const watchId = p.watchId;
            const old = watches.get(watchId);
            if (old !== undefined && old.sid !== sid) return invalid("watchId in use");
            old?.ac.abort();
            watches.delete(watchId);
            const mine = [...watches].filter(([, w]) => w.sid === sid);
            for (const [id, w] of mine.slice(0, Math.max(0, mine.length - (MAX_WATCHES_PER_PAGE - 1)))) {
              w.ac.abort();
              watches.delete(id);
            }
            const ac = new AbortController();
            watches.set(watchId, { ac, sid });
            if (wired !== undefined && p.urls.some((u) => isWiredDisplaySource(u))) {
              // Blink ORs the sources of a request: available when displays exist for a standard source, or the
              // request's Cast URLs have a device. Displays are not hidden here (only the dialog hides one).
              const castUrls = p.urls.filter((u) => !isWiredDisplaySource(u));
              let displays = false;
              let cast = false;
              let ready = false;
              let last = false;
              const update = (): void => {
                const next = displays || cast;
                if (!ready || next === last) return;
                last = next;
                sendTo(sid, { type: "availability", watchId, value: next });
              };
              const stop = wired.provider.observeSinks((sinks) => {
                displays = sinks.length > 0;
                update();
              });
              ac.signal.addEventListener("abort", stop, { once: true });
              if (ac.signal.aborted) stop();
              if (castUrls.length > 0) {
                cast = await h.getAvailability({
                  urls: castUrls, origin, senderId: sid, signal: ac.signal,
                  onchange: (value) => {
                    cast = value;
                    update();
                  },
                });
              }
              ready = true;
              last = displays || cast;
              return { ok: true, value: { available: last } };
            }
            const available = await h.getAvailability({
              urls: p.urls,
              origin,
              senderId: sid,
              signal: ac.signal,
              onchange: (value) => sendTo(sid, { type: "availability", watchId, value }),
            });
            return { ok: true, value: { available } };
          }
          case "stopWatching": {
            const w = isId(p.watchId) ? watches.get(p.watchId) : undefined;
            if (w !== undefined && w.sid === sid) {
              w.ac.abort();
              watches.delete(p.watchId as string);
            }
            return { ok: true, value: undefined };
          }
          case "start":
            if (!isId(p.connectionId) || !isUrls(p.urls)) return invalid("start expects { connectionId, urls }");
            // PresentationServiceImpl::StartPresentation: PRESENTATION_REQUEST_CANCELLED, which the page sees as AbortError
            if (p.hasGesture !== true) {
              return { ok: false, code: "AbortError", description: "PresentationRequest::start() requires user gesture." };
            }
            {
              const urls = p.urls;
              if (displayOnly(urls)) return await open(sid, p.connectionId, () => startOnDisplay(sid, origin, urls));
              if (wired !== undefined && urls.some((u) => isWiredDisplaySource(u))) return await open(sid, p.connectionId, () => startMixed(sid, origin, urls));
              return await open(sid, p.connectionId, () => h.startPresentation({ urls, origin, senderId: sid }));
            }
          case "reconnect":
            if (!isId(p.connectionId) || !isUrls(p.urls) || !isId(p.presentationId)) {
              return invalid("reconnect expects { connectionId, urls, presentationId }");
            }
            {
              const { urls, presentationId } = p;
              // A local presentation (a display) is joined again from any page, by its id; for a URL only a display
              // serves, an id that is not local is the provider's unknown error, which the page sees as NotFoundError
              if (wired !== undefined && (displayOnly(urls) || wired.provider.local.isLocalPresentation(presentationId))) {
                return await open(sid, p.connectionId, async () => wired.controllers.reconnect({ urls, senderId: sid }, presentationId));
              }
              return await open(sid, p.connectionId,
                () => h.reconnectPresentation({ urls: wired !== undefined && castUrlsOf(urls).length > 0 ? castUrlsOf(urls) : urls, origin, senderId: sid, presentationId }));
            }
          case "close":
          case "terminate": {
            const c = isId(p.connectionId) ? connections.get(p.connectionId) : undefined;
            if (c !== undefined && c.sid === sid && c.conn !== null) {
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
      if (typeof connectionId !== "string") return;
      const c = connections.get(connectionId);
      if (c === undefined || c.sid !== senderIdOf(event.sender, event.senderFrame) || c.conn === null) return;
      const isLocal = typeof (c.conn as Partial<LocalConnectionHandle>).connecting === "boolean";
      if (typeof data === "string") {
        // The stand-in refuses an oversized send() with a RangeError; this is for a page that does not use it
        if (data.length <= (isLocal ? MAX_MESSAGE_SIZE : MAX_MESSAGE_CHARS)) c.conn.send(data);
        return;
      }
      const bytes = asBytes(data);
      if (bytes === null || bytes.byteLength > MAX_MESSAGE_SIZE) return;
      // A wired display carries bytes (PresentationConnectionMessage.data). A Cast connection drops them, as Chrome's
      // CastSessionClientImpl::OnMessage does with anything that is not text.
      if (isLocal) (c.conn as LocalConnectionHandle).send(bytes);
    };
    on(`${channel}:presentation:send`, onSend);

    return {
      /** Close the page's connections and watches before the service drops it. */
      senderGone(sid: number): void {
        h.senderGone(sid);
        wired?.controllers.senderGone(sid);
        for (const [id, c] of connections) if (c.sid === sid) connections.delete(id);
        for (const [id, w] of watches) {
          if (w.sid !== sid) continue;
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

  // The service knows frames by sender id (an iframe has a synthetic one); the API speaks of windows, so a route's
  // pages are reported as `webContents.id`s, once each however many of its frames hold the route.
  const windowIds = (ids: number[]): number[] => [...new Set(ids.map((id) => senders.get(id)?.wc.id ?? id))];
  const api = createManagerApi(createSinksObservers(discovery), {
    mediaRoutes: () =>
      service.mediaRoutes().map((r) => ({ ...r, members: windowIds(r.members), parkedSenders: windowIds(r.parkedSenders) })),
    observeSessions: (l) => service.observeSessions(l),
    terminateSession: (id) => service.terminateSession(id),
    setSessionVolume: (id, v) => service.setSessionVolume(id, v),
    detachSession: (id) => service.detachSession(id),
  });
  let disposed = false;
  return {
    ...api,
    ...(wired !== undefined ? { wiredDisplay: wired.api } : {}),
    start: () => discovery.start(),
    devices: () => discovery.devices(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      api.dispose();
      options.ipcMain.removeHandler(`${channel}:call`);
      presentation?.dispose();
      wired?.dispose();
      discovery.stop();
      await service.dispose();
      senders.clear();
      subframeIds.clear();
      watched.clear();
      if (sweepTimer !== undefined) clearInterval(sweepTimer);
      sweepTimer = undefined;
    },
  };
}
