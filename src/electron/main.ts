import { CastSessionService, type CastClientLike, type DeviceSource, type CastRequestInfo, type DeviceChoice, type DisplayChoice } from "./session-service.ts";
import type { CastDevice } from "../discovery/index.ts";
import { CastDiscovery } from "../discovery/index.ts";
import { CastClient } from "../client/index.ts";
import { CastPresentationHandler, PresentationError, type PresentationConnectionHandle } from "./presentation-handler.ts";
import { randomBytes, randomUUID } from "node:crypto";
import {
  MediaRouteError, combineSources, createManagerApi, createSinksObservers, presentationUrlForDevice,
  type CastManagerApi, type DevicePickerContext, type MediaRoute,
} from "./manager-api.ts";
import { parsePresentationUrl } from "./presentation-envelope.ts";
import { DefaultPresentationRequests, samePresentationRequest } from "./default-presentation.ts";
import type { CastSinkOptions, ChannelParams } from "./sink-service.ts";
import { MAX_MESSAGE_SIZE, asBytes, messageFields } from "./wired-display/local-presentation.ts";
import type { WiredDisplaySink } from "./wired-display/displays.ts";
import { createWiredDisplay, isWiredDisplaySource, type LocalConnectionHandle, type WiredDisplayApi, type WiredDisplayOptions } from "./wired-display/index.ts";
import type { AccessCodeDevice, AccessCodeOptions, AccessCodeRememberedSink, AddSinkResult } from "./access-code.ts";
import { DiscoveryNetworkMonitor, type NetworkMonitor } from "./network-monitor.ts";
import { MirroringManager, MirroringRouteError, type MirroringRoute } from "../mirroring/mirroring-manager.ts";
import { createElectronMirroringServiceFactory, type ElectronMirroringOptions } from "../mirroring/electron/host.ts";
import type { MirroringClient, MirroringServiceFactory } from "../mirroring/mirroring-activity.ts";
import type { BridgeMethod } from "../polyfill/bridge-types.ts";
import { DialService, type DialHttp, type DialHttpOptions, type DialRegistryOptions } from "../dial/index.ts";
import { appNameFromDialSource, isDialSource, processDeviceUuid } from "../dial/parse.ts";

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
export type { CastSinkOptions, ChannelParams, SinkRetryOptions } from "./sink-service.ts";
export type { DialHttp, DialHttpOptions, DialRegistryOptions } from "../dial/index.ts";
export {
  createReceiverWindows, isWiredDisplaySource, availableDisplays, wiredDisplaySinks,
  type WiredDisplayApi, type WiredDisplayOptions, type WiredDisplayRequest, type WiredDisplaySink, type WiredDisplayRoute,
  type ReceiverWindows, type ReceiverWindowsOptions, type ScreenLike, type DisplayLike, type WindowLike, type PresentationMessage,
} from "./wired-display/index.ts";
export { AccessCodeCastDisabledError, createAccessCodeSink } from "./access-code.ts";
export type { NetworkMonitor } from "./network-monitor.ts";
export type { MirroringCastMode } from "../mirroring/mirroring-manager.ts";
export type { ElectronMirroringApi, ElectronMirroringOptions } from "../mirroring/electron/host.ts";
export type {
  AccessCodeCapabilities, AccessCodeDevice, AccessCodeOptions, AccessCodeRememberedSink, AccessCodeStore, AddSinkResult,
  SinkCreationFailure,
} from "./access-code.ts";
export type {
  MediaController, MediaImage, MediaPlayState, MediaStatus, MediaStatusObserver,
} from "./media-controller.ts";
export type {
  CastManagerApi, DevicePickerContext, MediaCastMode, StartCastingOptions, MediaRoute, MediaRouteController, MediaRoutesObserver, MediaSink,
  MediaSinksObserver, MediaSinksQuery, PresentationObserver, PresentationRequest, SinkIconType,
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
  createClient?(device: CastDevice, params: ChannelParams): CastClientLike; // default new CastClient({ host, port, timeouts })
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
   * How the manager opens and keeps a channel to each discovered device, whose open channels are what it lists as
   * devices. The defaults are Chrome's, and there is no way to turn the tracking off: Chrome has none.
   */
  sinks?: CastSinkOptions;
  /**
   * DIAL (SSDP discovery, `cast-dial:` sources), which Chrome runs next to Cast discovery. Default true, except that a
   * custom `discovery` turns it off unless this is given. `false` disables it; an object replaces its network layers
   * (tests, mostly). `log` receives discovery problems (a socket that failed, ...), which are never thrown.
   *
   * DIAL sinks are listed next to the Cast sinks, except a device that is a Cast sink too (its UDN is the Cast id), which
   * is listed as Cast only, as in Chrome. In `mode: "chromecast"` the sinks observers of the manager API still list
   * DIAL sinks (they have port 0 and no Cast capabilities); only the Presentation API path can start a DIAL route.
   */
  dial?: boolean | { registry?: DialRegistryOptions; http?: DialHttp; httpOptions?: DialHttpOptions; settleMs?: number; log?: (message: string) => void };
  /**
   * Show a page's presentation on another screen, as Chrome's wired display provider does (presentation mode only).
   * Chrome has it always on; here the app passes Electron's `screen` and a window factory, because this package never
   * imports Electron. See {@link WiredDisplayOptions}.
   */
  wiredDisplay?: WiredDisplayOptions;
  /**
   * Adding a device by its address, as Chrome's access code casting adds the device a code resolved to (see
   * {@link CastManager.addSinkByAddress}). Off unless `enabled`, as Chrome's `AccessCodeCastEnabled` policy is.
   */
  accessCode?: AccessCodeOptions;
  /**
   * Enables tab and desktop mirroring (`startCasting` with `castMode: "tab_mirror"` or `"desktop_mirror"`). Pass the
   * Electron classes it needs (`BrowserWindow`, `utilityProcess`, `MessageChannelMain`, `desktopCapturer`,
   * `webContents`); off by default. `createService` replaces the Electron engine (tests, or a different one).
   */
  mirroring?: ElectronMirroringOptions | { createService: MirroringServiceFactory };
  /**
   * Network changes, as Chrome's `DiscoveryNetworkMonitor` tells its media router: the DIAL devices given up on are tried
   * again, the sinks of a network the machine comes back to are reopened, and devices added by address are removed and
   * re-added. By default the manager reads `os.networkInterfaces()` every 5 s while started (docs/DESIGN.md, "Network
   * changes"); a custom `discovery` turns that off unless this is given. `false` turns it off; your own
   * {@link NetworkMonitor} drives it in tests.
   */
  networkMonitor?: NetworkMonitor | false;
}
/** The main-process cast manager; the observers, routes and route control come from {@link CastManagerApi}. */
export interface CastManager extends CastManagerApi {
  start(): Promise<void>;
  /** The devices that have an open, authenticated channel (what Chrome lists as sinks), not everything mDNS has heard. */
  devices(): CastDevice[];
  /** Try again now to open a channel to each discovered device that has none (Chrome: `CastMediaSinkService::DiscoverSinksNow`). */
  discoverSinksNow(): void;
  /**
   * Resolves when no channel is being opened and none is waiting to be (a retry waiting out its backoff does not count),
   * so the devices that can be reached are listed. Discovery and Chrome's random delay (up to 5 s) come first, so call it
   * some time after `start()`.
   */
  settled(options?: { retries?: boolean }): Promise<void>;
  /**
   * Add a device whose address the app knows, as Chrome adds the device an access code resolved to. electron-cast does not
   * resolve codes: that is a private Google service (docs/DESIGN.md, "Access code casting"), so the app supplies the
   * address. A channel is opened to the device and it is listed like a discovered one, then removed 20 s after
   * `accessCode.deviceDuration` seconds, or once a route to it ends after that. Rejects with `AccessCodeCastDisabledError`
   * unless `accessCode.enabled`. The address rules of discovered devices apply: a public or loopback address is refused
   * (`channel_open_error`) unless `sinks.allowAllIps` is set.
   */
  addSinkByAddress(device: AccessCodeDevice): Promise<AddSinkResult>;
  /** Change `accessCode.enabled` and `accessCode.deviceDuration` while running, as Chrome applies its policies. */
  configureAccessCode(settings: { enabled?: boolean; deviceDuration?: number }): Promise<void>;
  /** The devices added by address that are remembered now. */
  rememberedSinks(): AccessCodeRememberedSink[];
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
/**
 * A mirroring activity's view of the device's shared channel. Chrome runs every activity on a sink over its one
 * `CastSocket`; here the activity's `connect()` only checks that channel is open and `close()` detaches the activity
 * (its listeners go quiet) without closing the channel the other sessions and the session tracker use.
 */
function sharedChannelClient(deviceId: string, channel: CastClientLike | undefined): MirroringClient {
  let attached = true;
  const need = (): CastClientLike => {
    if (channel === undefined || !channel.connected) throw new Error(`no open channel to ${deviceId}`);
    if (channel.senderId === undefined) throw new Error("the Cast client has no senderId, which mirroring needs");
    return channel;
  };
  return {
    get senderId() {
      return channel?.senderId ?? "";
    },
    async connect() {
      need();
    },
    close() {
      attached = false;
    },
    send: (namespace, destinationId, payload) => {
      if (attached) need().send(namespace, destinationId, payload);
    },
    launch: (appId) => need().launch(appId),
    stop: (sessionId) => need().stop(sessionId),
    connectTransport: (transportId) => need().connectTransport(transportId),
    closeTransport: (transportId) => need().closeTransport(transportId),
    on(event: string, listener: (...args: any[]) => void) {
      (channel as { on(event: string, l: (...args: any[]) => void): unknown } | undefined)?.on(event, (...args: any[]) => {
        if (attached) listener(...args);
      });
      return this;
    },
  } as MirroringClient;
}

/** How long starting a default request on a DIAL sink waits for its app info, as a page's request does. */
const DIAL_APP_WAIT_MS = 5000;

/**
 * The first `cast-dial:` URL, in order, whose app the DIAL sink has for a page at `origin`. Apps not known yet are
 * asked about and the answers waited for (up to 5 s), as the Cast path asks the device (`checkAppAvailability`).
 */
async function dialUrlFor(dial: DialService, device: CastDevice, urls: readonly string[], origin: string): Promise<string | null> {
  const candidates = urls.map((url) => ({ url, app: isDialSource(url) ? appNameFromDialSource(url) : "" })).filter((c) => c.app !== "");
  const first = (): string | null =>
    candidates.find((c) => dial.availableFor(c.app, origin).some((d) => d.id === device.id))?.url ?? null;
  if (candidates.length === 0 || first() !== null) return first();
  const releases = candidates.map((c) => dial.monitorApp(c.app, origin)).filter((r): r is () => void => r !== null);
  if (releases.length === 0) return null;
  try {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        dial.off("change", check);
        resolve();
      };
      const check = (): void => {
        if (first() !== null) done();
      };
      const timer = setTimeout(done, DIAL_APP_WAIT_MS);
      dial.on("change", check);
    });
  } finally {
    for (const release of releases) release();
  }
  return first();
}

export function createCastManager(options: CastManagerOptions): CastManager {
  const channel = options.channel ?? "electron-cast";
  if (options.presentation !== false && (typeof options.ipcMain.on !== "function" || typeof options.ipcMain.removeListener !== "function")) {
    throw new TypeError("presentation mode needs ipcMain.on and ipcMain.removeListener");
  }
  const discovery = options.discovery ?? new CastDiscovery();
  const networkMonitor = options.networkMonitor === false ? undefined
    : options.networkMonitor ?? (options.discovery === undefined ? new DiscoveryNetworkMonitor() : undefined);
  const createClient = options.createClient ?? ((d: CastDevice, params: ChannelParams) =>
    new CastClient({
      host: d.host,
      port: d.port,
      verifyDevice: options.verifyDevices !== false,
      connectTimeoutMs: params.connectTimeoutMs,
      heartbeatTimeoutMs: params.livenessTimeoutMs,
      heartbeatIntervalMs: params.pingIntervalMs,
    }));
  // The receiver labels of Cast and DIAL routes are hashed with one per-process token, as in Chrome.
  const hashToken = randomBytes(16).toString("hex");
  const dialOption = options.dial ?? (options.discovery === undefined);
  // A DIAL sink whose processed UDN is a Cast sink's id is removed: CastMediaSinkServiceImpl removes it from the DIAL
  // sink service when the Cast channel opens (OnChannelOpenSucceeded) and when the DIAL sink comes after the Cast one
  // (TryConnectDialDiscoveredSink), and only DIAL discovery adds it back. A Cast sink is a device with an open, authenticated channel, not one mDNS merely
  // heard, so this asks the session service; `service` exists before DIAL is started.
  let castSinks: () => CastDevice[] = () => [];
  const dial = dialOption === false ? undefined : new DialService({
    hashToken,
    isCastDevice: (uuid) => castSinks().some((d) => processDeviceUuid(d.id) === uuid),
    ...(typeof dialOption === "object" ? dialOption : {}),
  });
  const routeListeners = new Set<() => void>();
  const notifyRoutes = (): void => {
    for (const l of [...routeListeners]) l();
  };
  dial?.provider.on("routes", notifyRoutes);
  /** The DIAL sinks as a device source: their one change event stands for a changed device. */
  const dialSource: DeviceSource | undefined = dial === undefined ? undefined : {
    devices: () => dial.devices(),
    on: (event, listener) => (event === "deviceChanged" ? dial.on("change", listener as () => void) : undefined),
    off: (event, listener) => (event === "deviceChanged" ? dial.off("change", listener as () => void) : undefined),
  };
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
  /** Each window's default presentation request (Chrome keeps it per WebContents, from its outermost frame only). */
  const defaults = new DefaultPresentationRequests();
  /** The route each window's main frame launched last (CastActivityManager's routes_by_frame_). */
  const launchedFrom = new Map<number, string>();

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
  /** Tab and desktop mirroring, when the `mirroring` option is given (set up once the service exists). */
  let mirroring: MirroringManager | undefined;
  const service = new CastSessionService({
    devices: discovery,
    createClient,
    // a mirroring route's session, or one being launched on the sink, is a local activity
    ownsSession: (sessionId, sinkId) =>
      mirroring?.routes().some((r) => r.sinkId === sinkId && (r.sessionId === sessionId || r.sessionId === "")) ?? false,
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
    sinks: options.sinks,
    ...(dial !== undefined && dialSource !== undefined ? {
      dial: {
        source: dialSource,
        available: (app: string, origin: string) => dial.availableFor(app, origin),
        monitor: (app: string, origin: string) => dial.monitorApp(app, origin),
      },
    } : {}),
    accessCode: options.accessCode,
    ...(networkMonitor !== undefined ? { networkMonitor } : {}),
    // The same one-route-per-frame rule (`routes_by_frame_`) from the other side: a page's Cast SDK or Presentation API
    // session ends a mirroring route of that page. Subframe sender ids never match a tab, as only the main frame is one.
    onSessionLaunched: (senderId) => mirroring?.stopMirroringRoutesOfTab(senderId),
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
      defaults.forget(wc.id);
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
    const h = new CastPresentationHandler({ service, token: hashToken, ...(dial !== undefined ? { dial } : {}), dialRoutesChanged: notifyRoutes });
    handler = h;
    const connections = new Map<string, { conn: PresentationConnectionHandle | null; sid: number }>();
    const watches = new Map<string, { ac: AbortController; sid: number }>();
    const sendTo = (sid: number, payload: unknown): void => {
      deliver(sid, `${channel}:presentation:event`, payload);
    };
    const invalid = (description: string) => ({ ok: false as const, code: "InvalidAccessError", description });
    const isId = (v: unknown): v is string => typeof v === "string" && v !== "" && v.length <= 256;
    const isUrls = (v: unknown): v is string[] =>
      Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every((u) => typeof u === "string");

    /** Finish a start/reconnect: register the connection and route its traffic to the page. */
    const open = async (
      sid: number,
      connectionId: string,
      opening: () => Promise<PresentationConnectionHandle>,
      /** Runs once the connection exists and before any of its messages reach the page; false declines it. */
      opened?: (conn: PresentationConnectionHandle) => boolean,
    ): Promise<{ ok: false; code: string; description: string } | { ok: true; value: { id: string; url: string } }> => {
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
      if (opened?.(conn) === false) {
        // Declined (OnPresentationResponse hands a connection only to the request it answers): the session stays, but the
        // connection belongs to nobody, so nothing of it reaches the page that has the sender id now
        connections.delete(connectionId);
        conn.onclose = null;
        conn.onmessage = () => {};
        return { ok: true as const, value: { id: conn.id, url: conn.url } };
      }
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
    /** A URL the Cast provider serves (a Cast app URL), or the DIAL provider (a `cast-dial:` URL, when DIAL is on). */
    const providerUrl = (u: string): boolean => parsePresentationUrl(u) !== null || (dial !== undefined && isDialSource(u));
    /** The URLs of a request that the Cast and DIAL providers serve. */
    const castUrlsOf = (urls: string[]): string[] => urls.filter(providerUrl);
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
      if (displays.length === 0 || service.devices().length + (dial?.devices().length ?? 0) === 0) {
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

    /** Only a display serves these URLs: one is a standard presentation source and none is a Cast or DIAL one. */
    const displayOnly = (urls: string[]): boolean =>
      wired !== undefined && urls.some((u) => isWiredDisplaySource(u)) && !urls.some(providerUrl);

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
          case "setDefaultRequest": {
            // Blink's Presentation::setDefaultRequest sends the URLs on every set (none when it is cleared)
            if (!Array.isArray(p.urls) || p.urls.length > 16 || !p.urls.every((u) => typeof u === "string" && u.length <= 4096)) {
              return invalid("setDefaultRequest expects { urls }");
            }
            // PresentationServiceImpl::SetDefaultPresentationUrls ignores a frame that is not the outermost document
            if (isMainFrame(event.senderFrame)) defaults.set(event.sender.id, p.urls as string[], origin);
            return { ok: true, value: undefined };
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
              // A display-only request opens a window on a display; a request a display and a sink can both serve goes to
              // the one picker; the rest is the Cast (and DIAL) provider's
              if (displayOnly(urls)) return await open(sid, p.connectionId, () => startOnDisplay(sid, origin, urls));
              const started = wired !== undefined && urls.some((u) => isWiredDisplaySource(u))
                ? await open(sid, p.connectionId, () => startMixed(sid, origin, urls))
                : await open(sid, p.connectionId, () => h.startPresentation({ urls, origin, senderId: sid }));
              // CastActivityManager's earlier-route rule is for Cast sessions only
              if (started.ok && started.value.id.startsWith("cast-session_")) launchedFrom.set(sid, started.value.id.slice("cast-session_".length));
              return started;
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
        // PresentationServiceImpl::Reset (navigation, frame gone): the frame's default request goes with it
        defaults.clear(sid);
        launchedFrom.delete(sid);
        h.senderGone(sid);
        wired?.controllers.senderGone(sid);
        for (const [id, c] of connections) if (c.sid === sid) connections.delete(id);
        for (const [id, w] of watches) {
          if (w.sid !== sid) continue;
          w.ac.abort();
          watches.delete(id);
        }
      },
      /**
       * MediaRouterUI::StartCasting(sink, PRESENTATION) on the window's default request: MediaRouteStarter's
       * CreateRouteParameters, MediaRouter::CreateRoute, then WebContentsPresentationManager::OnPresentationResponse.
       */
      async startDefaultPresentation(webContentsId: number, sinkId: string): Promise<MediaRoute> {
        const request = defaults.get(webContentsId);
        const serial = defaults.serialOf(webContentsId);
        // No source for the sink (no default request, or its URLs do not suit the sink): CreateRouteParameters is null
        const unable = (why: string) => new MediaRouteError("unable_to_cast", why);
        if (request === null) throw unable("the window has no default presentation request");
        // The dialog's sinks are the Cast sinks and the DIAL sinks (QueryResultManager observes each URL's source, and
        // the DIAL provider serves the cast-dial: ones)
        const device = [...service.devices(), ...(dial?.devices() ?? [])].find((d) => d.id === sinkId);
        if (device === undefined) throw unable(`no sink ${sinkId}`);
        // GetSourceForCastModeAndSink: the first URL, in order, the sink is compatible with. A Cast sink is a source's
        // once the device says the app is there (CastAppAvailabilityTracker::GetAvailableSinks); a DIAL sink once its
        // DIAL server says so for the page's origin (DialMediaSinkServiceImpl, DialMediaRouteProvider::GetOrigins).
        let url: string | null = null;
        if (device.dial !== undefined) {
          url = dial === undefined ? null : await dialUrlFor(dial, device, request.presentationUrls, request.frameOrigin);
        } else {
          for (const candidate of request.presentationUrls) {
            const parsed = parsePresentationUrl(candidate);
            if (parsed === null || presentationUrlForDevice(device, [candidate]) === null) continue;
            if (await service.checkAppAvailability(device, parsed.appId)) {
              url = candidate;
              break;
            }
          }
        }
        if (url === null) throw unable("the sink cannot run the default presentation request's URLs");
        // the page navigated or cleared its request while the device was asked
        if (defaults.serialOf(webContentsId) !== serial) {
          throw new MediaRouteError("cancelled", "the window's default presentation request changed while the device was asked");
        }
        // CastActivityManager::DoLaunchSession stops the route this frame launched before, then launches
        const earlier = launchedFrom.get(webContentsId);
        if (earlier !== undefined && routes().some((r) => r.id === earlier)) void service.terminateSession(earlier);
        if (!senders.has(webContentsId)) throw unable("the window is gone");
        const connectionId = randomUUID();
        let failure: unknown;
        const result = await open(
          webContentsId,
          connectionId,
          () => h.startPresentation({
            urls: [url, ...request.presentationUrls.filter((u) => u !== url)],
            origin: request.frameOrigin,
            senderId: webContentsId,
            deviceId: device.id,
          }).catch((err: unknown) => {
            failure = err;
            throw err;
          }),
          (conn) => {
            // OnPresentationResponse hands the connection to the page only while the request it answers is still the default one
            const current = defaults.get(webContentsId);
            if (current === null || !samePresentationRequest(current, request)) return false;
            sendTo(webContentsId, { type: "connectionavailable", connectionId, id: conn.id, url: conn.url });
            return true;
          },
        );
        if (!result.ok) {
          // RouteRequestResultCode, from the cause the handler saw
          const bridge = (failure as { bridgeCode?: unknown } | undefined)?.bridgeCode;
          const code = bridge === "timeout" ? "timed_out"
            : bridge === "cancel" || (failure === undefined && result.code === "AbortError") ? "cancelled"
            : bridge === "receiver_unavailable" ? "sink_not_found"
            : bridge === "extension_missing" ? "invalid_origin"
            : bridge === "invalid_parameter" ? "redundant_request"
            : "unknown_error";
          throw new MediaRouteError(code, result.description);
        }
        if (device.dial !== undefined) {
          // A DIAL route's id is MediaRoute::GetMediaRouteId(presentation id, sink id, source)
          const prefix = `urn:x-org.chromium:media:route:${result.value.id}/`;
          const dialRoute = routes().find((r) => r.providerId === "dial" && r.id.startsWith(prefix));
          if (dialRoute === undefined) throw new MediaRouteError("route_not_found", `no route for ${result.value.id}`);
          return dialRoute;
        }
        const sessionId = result.value.id.slice("cast-session_".length);
        launchedFrom.set(webContentsId, sessionId);
        const route = routes().find((r) => r.id === sessionId);
        if (route === undefined) throw new MediaRouteError("route_not_found", `no route ${sessionId}`);
        return route;
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
  // Tab and desktop mirroring: MirroringActivity, a CastActivity that runs on the device's one channel
  let disposeMirroring: (() => void) | undefined;
  if (options.mirroring !== undefined) {
    const m = options.mirroring;
    let createService: MirroringServiceFactory;
    if ("createService" in m) {
      createService = m.createService;
    } else {
      const electron = createElectronMirroringServiceFactory(m);
      createService = electron.factory;
      disposeMirroring = () => electron.dispose();
    }
    mirroring = new MirroringManager({
      // only a sink (an open, authenticated channel) can be cast to
      findDevice: (id) => service.devices().find((d) => d.id === id),
      createClient: (d) => sharedChannelClient(d.id, service.channelClient(d.id)),
      createService,
      terminateRoutesOfPage: (wcId) => {
        for (const id of service.sessionsLaunchedBy(wcId)) void service.terminateSession(id);
      },
      log: (level, message) => (level === "error" ? console.error : console.debug)(`electron-cast mirroring: ${message}`),
    });
  }
  const dialRoutes = (): MediaRoute[] =>
    (dial?.provider.routes() ?? []).map((r) => {
      const members = windowIds(handler?.dialMembers(r.id) ?? []);
      return {
        id: r.id,
        providerId: "dial" as const,
        mediaSource: r.mediaSource,
        sinkId: r.sinkId,
        sinkName: dial?.devices().find((d) => d.id === r.sinkId)?.name ?? "",
        isLocal: true,
        description: r.appName,
        appId: "",
        displayName: r.appName,
        origin: r.origin,
        volume: { level: null, muted: null },
        members,
        parkedSenders: [],
        parked: members.length === 0,
      };
    });
  const mirroringRoutes = (): MediaRoute[] => (mirroring?.routes() ?? []).map((r: MirroringRoute) => ({
    id: r.id,
    providerId: "cast" as const,
    mediaSource: r.mediaSource,
    sinkId: r.sinkId,
    sinkName: service.devices().find((d) => d.id === r.sinkId)?.name ?? "",
    isLocal: true,
    description: r.description,
    appId: r.appId,
    displayName: r.displayName,
    origin: "",
    volume: { level: null, muted: null },
    members: r.webContentsId === undefined ? [] : [r.webContentsId],
    parkedSenders: [],
    parked: false,
    freezeInfo: r.freezeInfo,
  }));
  const routes = (): MediaRoute[] => [
    ...service.mediaRoutes().map((r) => ({ ...r, members: windowIds(r.members), parkedSenders: windowIds(r.parkedSenders) })),
    ...dialRoutes(),
    ...mirroringRoutes(),
  ];
  const isMirroringRoute = (id: string): boolean => mirroring?.routes().some((r) => r.id === id) ?? false;
  const isDialRoute = (id: string): boolean => dial?.provider.routes().some((r) => r.id === id) ?? false;
  const notDial = { ok: false as const, code: "invalid_parameter", description: "A DIAL route has no volume or media control" };
  const castDevices = service.deviceSource();
  const api = createManagerApi(createSinksObservers(dialSource === undefined ? castDevices : combineSources(castDevices, dialSource), {
    cached: (d, appId) => service.cachedAppAvailability(d, appId),
    check: (d, appId) => service.checkAppAvailability(d, appId),
    ...(dial === undefined ? {} : {
      dial: {
        available: (d: CastDevice, app: string, origin: string) => dial.availableFor(app, origin).some((x) => x.id === d.id),
        monitor: (app: string, origin: string) => dial.monitorApp(app, origin),
      },
    }),
  }), {
    mediaRoutes: routes,
    observeSessions: (l) => {
      const off = service.observeSessions(l);
      const offMirroring = mirroring?.observe(l);
      routeListeners.add(l);
      return () => {
        off();
        offMirroring?.();
        routeListeners.delete(l);
      };
    },
    async terminateSession(id) {
      if (mirroring?.terminate(id) === true) return { ok: true, value: undefined };
      if (!isDialRoute(id)) return service.terminateSession(id);
      try {
        await dial!.provider.terminateRoute(id);
        return { ok: true, value: undefined };
      } catch (err) {
        const e = err as { code?: unknown; message?: unknown };
        return { ok: false, code: typeof e.code === "string" ? e.code : "session_error", description: String(e.message ?? err) };
      }
    },
    setSessionVolume: async (id, v) => (isDialRoute(id) ? notDial : service.setSessionVolume(id, v)),
    startCasting:
      mirroring === undefined
        ? undefined
        : async (sinkId, o) => {
            const m = mirroring!;
            try {
              const route = await m.startMirroring(sinkId, o);
              const listed = routes().find((r) => r.id === route.id);
              if (listed === undefined) throw new MediaRouteError("route_not_found", `no route ${route.id}`);
              return listed;
            } catch (err) {
              if (err instanceof MirroringRouteError) throw new MediaRouteError(err.code, err.message);
              throw err;
            }
          },
    detachSession(id) {
      if (isMirroringRoute(id)) return { ok: false, code: "invalid_parameter", description: "A mirroring route cannot be detached" };
      if (!isDialRoute(id)) return service.detachSession(id);
      handler?.detachDialRoute(id);
      return { ok: true, value: undefined };
    },
    sendSessionMessage: (id, ns, m) => (isDialRoute(id) ? notDial : service.sendSessionMessage(id, ns, m)),
    observeSessionStatus: (l) => service.observeSessionStatus(l),
    observeMediaStatus: (l) => service.observeMediaStatus(l),
    sessionVolume: (id) => service.sessionVolume(id),
    switchMirroringSourceTab:
      mirroring === undefined
        ? undefined
        : (id, webContentsId) => {
            try {
              mirroring!.switchMirroringSourceTab(id, webContentsId);
            } catch (err) {
              if (err instanceof MirroringRouteError) throw new MediaRouteError(err.code, err.message);
              throw err;
            }
          },
    freezeRoute: (id) => mirroring?.freezeRoute(id) ?? false,
    unfreezeRoute: (id) => mirroring?.unfreezeRoute(id) ?? false,
    mirroringStats:
      mirroring === undefined
        ? undefined
        : {
            get: (id) => mirroring.getMirroringStats(id),
            setEnabled: (enabled) => mirroring.setMirroringStatsEnabled(enabled),
            isEnabled: () => mirroring.isMirroringStatsEnabled(),
            observe: (observer) => mirroring.observeMirroringStats(observer),
          },
  }, {
    requests: defaults,
    start: (webContentsId, sinkId) => {
      if (presentation === undefined) return Promise.reject(new MediaRouteError("unable_to_cast", "presentation mode is off"));
      return presentation.startDefaultPresentation(webContentsId, sinkId);
    },
  });
  // Cast sinks coming and going decide which DIAL sinks are shown; the DIAL sinks are looked up again.
  castSinks = () => service.devices();
  const castChanged = (): void => dial?.castDevicesChanged();
  if (dial !== undefined) for (const e of ["deviceUp", "deviceDown", "deviceChanged"] as const) castDevices.on(e, castChanged);
  let disposed = false;
  return {
    ...api,
    ...(wired !== undefined ? { wiredDisplay: wired.api } : {}),
    async start() {
      networkMonitor?.start();
      await discovery.start();
      dial?.start();
    },
    devices: () => service.devices(),
    discoverSinksNow: () => service.discoverSinksNow(),
    settled: (options) => service.settled(options),
    addSinkByAddress: (device) => service.addSinkByAddress(device),
    configureAccessCode: (settings) => service.configureAccessCode(settings),
    rememberedSinks: () => service.rememberedSinks(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      api.dispose();
      defaults.dispose();
      mirroring?.dispose();
      disposeMirroring?.();
      options.ipcMain.removeHandler(`${channel}:call`);
      presentation?.dispose();
      if (dial !== undefined) for (const e of ["deviceUp", "deviceDown", "deviceChanged"] as const) castDevices.off(e, castChanged);
      dial?.stop();
      networkMonitor?.stop();
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
