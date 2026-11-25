import { test } from "node:test";
import assert from "node:assert/strict";
import { installCastBridge, type ContextBridgeLike, type IpcRendererLike } from "../../src/electron/preload.ts";
import { installChromeCast } from "../../src/polyfill/install.ts";
import type { BridgeEvent, BridgeResult, CastBridge } from "../../src/polyfill/bridge-types.ts";

class FakeContextBridge implements ContextBridgeLike {
  order: string[] = [];
  exposed = new Map<string, unknown>();
  executed: { func: (...args: any[]) => unknown; args?: unknown[] }[] = [];
  exposeInMainWorld(key: string, api: unknown): void {
    this.order.push(`expose ${key}`);
    this.exposed.set(key, api);
  }
  executeInMainWorld(script: { func: (...args: any[]) => unknown; args?: unknown[] }): unknown {
    this.order.push("execute");
    this.executed.push(script);
    return undefined;
  }
}

class FakeIpcRenderer implements IpcRendererLike {
  invoked: { channel: string; args: unknown[] }[] = [];
  reply: (channel: string, ...args: unknown[]) => Promise<unknown> = async () => ({ ok: true, value: "pong" });
  listeners = new Map<string, ((event: unknown, ...args: any[]) => void)[]>();
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invoked.push({ channel, args });
    return this.reply(channel, ...args);
  }
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener]);
    return this;
  }
  push(channel: string, payload: unknown): void {
    for (const l of this.listeners.get(channel) ?? []) l({ sender: "ipc-event-object" }, payload);
  }
}

function setup(opts: { channel?: string; bridgeKey?: string } = {}) {
  const contextBridge = new FakeContextBridge();
  const ipcRenderer = new FakeIpcRenderer();
  installCastBridge({ contextBridge, ipcRenderer, mode: "chromecast", ...opts });
  const bridge = contextBridge.exposed.get(opts.bridgeKey ?? "__electronCastBridge") as CastBridge | undefined;
  assert.ok(bridge, "bridge exposed");
  return { contextBridge, ipcRenderer, bridge };
}

test("exposes the bridge, then installs the polyfill in the main world with the bridge key", () => {
  const { contextBridge } = setup();
  assert.deepEqual(contextBridge.order, ["expose __electronCastBridge", "execute"]);
  assert.equal(contextBridge.executed[0]?.func, installChromeCast);
  assert.deepEqual(contextBridge.executed[0]?.args, ["__electronCastBridge"]);
});

test("custom channel and bridge key", async () => {
  const { contextBridge, ipcRenderer, bridge } = setup({ channel: "my-cast", bridgeKey: "__myBridge" });
  assert.deepEqual(contextBridge.order, ["expose __myBridge", "execute"]);
  assert.deepEqual(contextBridge.executed[0]?.args, ["__myBridge"]);
  await bridge.call("initialize", {});
  assert.equal(ipcRenderer.invoked[0]?.channel, "my-cast:call");
  const got: BridgeEvent[] = [];
  bridge.onEvent((e) => got.push(e));
  ipcRenderer.push("my-cast:event", { type: "receiverAvailability", available: true });
  assert.equal(got.length, 1);
});

test("call invokes <channel>:call with the method and params and returns the reply", async () => {
  const { ipcRenderer, bridge } = setup();
  const r = await bridge.call("sendMessage", { sessionId: "s", namespace: "urn:x", message: "m" });
  assert.deepEqual(ipcRenderer.invoked, [{ channel: "electron-cast:call", args: ["sendMessage", { sessionId: "s", namespace: "urn:x", message: "m" }] }]);
  assert.deepEqual(r, { ok: true, value: "pong" });
});

test("a rejected invoke becomes a session_error result, never a rejection", async () => {
  const { ipcRenderer, bridge } = setup();
  ipcRenderer.reply = async () => {
    throw new Error("Error invoking remote method 'electron-cast:call': No handler registered");
  };
  const r: BridgeResult = await bridge.call("initialize", {});
  assert.deepEqual(r, { ok: false, code: "session_error", description: "Error invoking remote method 'electron-cast:call': No handler registered" });
});

test("a non-Error rejection is described as a string", async () => {
  const { ipcRenderer, bridge } = setup();
  ipcRenderer.reply = () => Promise.reject("boom");
  assert.deepEqual(await bridge.call("initialize", {}), { ok: false, code: "session_error", description: "boom" });
});

test("onEvent relays <channel>:event payloads, without the IPC event object", () => {
  const { ipcRenderer, bridge } = setup();
  const got: unknown[][] = [];
  bridge.onEvent((...args: unknown[]) => got.push(args));
  const ev: BridgeEvent = { type: "sessionEnded", sessionId: "s1", status: "stopped" };
  ipcRenderer.push("electron-cast:event", ev);
  assert.deepEqual(got, [[ev]]);
});

test("a listener that throws does not break later events", () => {
  const { ipcRenderer, bridge } = setup();
  const got: BridgeEvent[] = [];
  let first = true;
  bridge.onEvent((e) => {
    if (first) {
      first = false;
      throw new Error("page bug");
    }
    got.push(e);
  });
  const ev: BridgeEvent = { type: "receiverAvailability", available: false };
  assert.doesNotThrow(() => ipcRenderer.push("electron-cast:event", ev));
  ipcRenderer.push("electron-cast:event", ev);
  assert.deepEqual(got, [ev]);
});

test("the bridge object exposes only call and onEvent", () => {
  const { bridge } = setup();
  assert.deepEqual(Object.keys(bridge).sort(), ["call", "onEvent"]);
});
