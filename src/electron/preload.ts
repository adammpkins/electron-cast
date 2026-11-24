import { installChromeCast } from "../polyfill/install.ts";
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
}
/** Dependencies of {@link installCastBridge}; the Electron objects are passed in, never imported. */
export interface CastBridgeOptions {
  contextBridge: ContextBridgeLike;
  ipcRenderer: IpcRendererLike;
  channel?: string;    // default "electron-cast"
  bridgeKey?: string;  // default "__electronCastBridge"
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Call from a preload script: exposes the bridge and installs chrome.cast in the page before its scripts run. */
export function installCastBridge(options: CastBridgeOptions): void {
  const channel = options.channel ?? "electron-cast";
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
