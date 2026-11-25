import { installChromeCast } from "../polyfill/install.ts";
import { installPresentationStandIn } from "../polyfill/presentation-standin.ts";
import type { BridgeEvent, BridgeMethod, BridgeResult } from "../polyfill/bridge-types.ts";

/** The subset of an Electron `contextBridge` the bridge needs. */
export interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
  executeInMainWorld(script: { func: (...args: any[]) => unknown; args?: unknown[] }): unknown;
}
/** The subset of an Electron `ipcRenderer` the bridge needs. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown;
  /** Needed in presentation mode (the default). */
  send?(channel: string, ...args: unknown[]): void;
}
/** Dependencies of {@link installCastBridge}; the Electron objects are passed in, never imported. */
export interface CastBridgeOptions {
  contextBridge: ContextBridgeLike;
  ipcRenderer: IpcRendererLike;
  channel?: string;    // default "electron-cast"
  bridgeKey?: string;  // default "__electronCastBridge"
  /**
   * "presentation" (default) installs a stand-in Presentation API, so the page's own copy of Google's Cast SDK
   * loads and runs unmodified. "chromecast" installs electron-cast's own chrome.cast instead and blocks Google's
   * loader scripts.
   */
  mode?: "chromecast" | "presentation";
  presentationBridgeKey?: string;  // default "__electronCastPresentationBridge"
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Call from a preload script. Exposes the bridge and, before the page's scripts run, installs the Presentation API
 * stand-in (default) or, with `mode: "chromecast"`, electron-cast's own chrome.cast.
 */
export function installCastBridge(options: CastBridgeOptions): void {
  const channel = options.channel ?? "electron-cast";
  const mode = options.mode ?? "presentation";
  if (mode !== "presentation" && mode !== "chromecast") throw new TypeError(`unknown mode: ${String(mode)}`);
  if (mode === "presentation") {
    installPresentationBridge(options, channel);
    return;
  }
  const bridgeKey = options.bridgeKey ?? "__electronCastBridge";
  const bridge = {
    /** Forward one bridge call to the main process; never rejects. */
    call(method: BridgeMethod, params: unknown): Promise<BridgeResult> {
      let invoked: Promise<unknown>;
      try {
        invoked = options.ipcRenderer.invoke(`${channel}:call`, method, params);
      } catch (err) {
        invoked = Promise.reject(err);
      }
      return invoked.then(
        (result) => result as BridgeResult,
        (err: unknown) => ({ ok: false, code: "session_error", description: describe(err) }),
      );
    },
    /** Relay `<channel>:event` payloads to the page, dropping the IPC event object. */
    onEvent(listener: (event: BridgeEvent) => void): void {
      options.ipcRenderer.on(`${channel}:event`, (_event, payload) => {
        try {
          listener(payload);
        } catch (err) {
          console.error(err);
        }
      });
    },
  };
  options.contextBridge.exposeInMainWorld(bridgeKey, bridge);
  options.contextBridge.executeInMainWorld({ func: installChromeCast, args: [bridgeKey] });
}

/** Presentation mode: expose the stand-in's bridge and install the stand-in; chrome.cast is left to Google's SDK. */
function installPresentationBridge(options: CastBridgeOptions, channel: string): void {
  const key = options.presentationBridgeKey ?? "__electronCastPresentationBridge";
  const ipc = options.ipcRenderer;
  if (typeof ipc.send !== "function") throw new TypeError("presentation mode needs ipcRenderer.send");
  const send = ipc.send.bind(ipc);
  const bridge = {
    /** Forward one call to the main process; never rejects. */
    call(method: string, params: unknown): Promise<unknown> {
      let invoked: Promise<unknown>;
      try {
        invoked = ipc.invoke(`${channel}:presentation`, method, params);
      } catch (err) {
        invoked = Promise.reject(err);
      }
      return invoked.then(
        (result) => result,
        (err: unknown) => ({ ok: false, code: "OperationError", description: describe(err) }),
      );
    },
    /** Page -> main: one message on an open connection; the reply comes back in-band. */
    send(connectionId: string, data: string): void {
      send(`${channel}:presentation:send`, connectionId, data);
    },
    /** Relay `<channel>:presentation:event` payloads to the page, dropping the IPC event object. */
    onEvent(listener: (event: unknown) => void): void {
      ipc.on(`${channel}:presentation:event`, (_event, payload) => {
        try {
          listener(payload);
        } catch (err) {
          console.error(err);
        }
      });
    },
  };
  options.contextBridge.exposeInMainWorld(key, bridge);
  options.contextBridge.executeInMainWorld({ func: installPresentationStandIn, args: [key] });
}
