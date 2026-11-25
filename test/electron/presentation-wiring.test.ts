// Presentation mode wiring: the preload's presentation bridge and the manager's <channel>:presentation IPC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCastManager, type CastManagerOptions, type IpcMainEventLike, type IpcMainLike } from "../../src/electron/main.ts";
import { installCastBridge, type ContextBridgeLike, type IpcRendererLike } from "../../src/electron/preload.ts";
import { installChromeCast } from "../../src/polyfill/install.ts";
import { installPresentationStandIn } from "../../src/polyfill/presentation-standin.ts";
import { MEDIA_NAMESPACE } from "../../src/electron/presentation-envelope.ts";
import { FakeDevices, FakeClient, TV, tick } from "./fakes.ts";

const ORIGIN = "https://music.youtube.com";
const MDX = "urn:x-cast:com.google.youtube.mdx";
const URL1 = "https://google.com/cast#__castAppId__=233637DE/__castClientId__=c1/__castAutoJoinPolicy__=origin_scoped";

// ---------- preload ----------

class FakeContextBridge implements ContextBridgeLike {
  exposed = new Map<string, any>();
  executed: { func: (...args: any[]) => unknown; args?: unknown[] }[] = [];
  exposeInMainWorld(key: string, api: unknown): void {
    this.exposed.set(key, api);
  }
  executeInMainWorld(script: { func: (...args: any[]) => unknown; args?: unknown[] }): unknown {
    this.executed.push(script);
    return undefined;
  }
}

class FakeIpcRenderer implements IpcRendererLike {
  invoked: { channel: string; args: unknown[] }[] = [];
  sent: { channel: string; args: unknown[] }[] = [];
  reply: (channel: string, ...args: unknown[]) => Promise<unknown> = async () => ({ ok: true, value: "pong" });
  listeners = new Map<string, ((event: unknown, ...args: any[]) => void)[]>();
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    this.invoked.push({ channel, args });
    return this.reply(channel, ...args);
  }
  send(channel: string, ...args: unknown[]): void {
    this.sent.push({ channel, args });
  }
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener]);
    return this;
  }
  push(channel: string, payload: unknown): void {
    for (const l of this.listeners.get(channel) ?? []) l({ sender: "ipc-event-object" }, payload);
  }
}

test("preload default is presentation mode: only the presentation bridge, and the stand-in", async () => {
  const contextBridge = new FakeContextBridge();
  const ipcRenderer = new FakeIpcRenderer();
  installCastBridge({ contextBridge, ipcRenderer });
  assert.deepEqual([...contextBridge.exposed.keys()], ["__electronCastPresentationBridge"]);
  assert.equal(contextBridge.executed.length, 1);
  assert.equal(contextBridge.executed[0]?.func, installPresentationStandIn);
  assert.deepEqual(contextBridge.executed[0]?.args, ["__electronCastPresentationBridge"]);

  const bridge = contextBridge.exposed.get("__electronCastPresentationBridge");
  assert.deepEqual(await bridge.call("start", { connectionId: "x" }), { ok: true, value: "pong" });
  assert.deepEqual(ipcRenderer.invoked, [{ channel: "electron-cast:presentation", args: ["start", { connectionId: "x" }] }]);
  bridge.send("conn-1", "{}");
  assert.deepEqual(ipcRenderer.sent, [{ channel: "electron-cast:presentation:send", args: ["conn-1", "{}"] }]);
  const got: unknown[] = [];
  bridge.onEvent((e: unknown) => got.push(e));
  ipcRenderer.push("electron-cast:presentation:event", { type: "message", connectionId: "conn-1", data: "d" });
  assert.deepEqual(got, [{ type: "message", connectionId: "conn-1", data: "d" }]);

  ipcRenderer.reply = async () => {
    throw new Error("boom");
  };
  assert.deepEqual(await bridge.call("start", {}), { ok: false, code: "OperationError", description: "boom" });
});

test("preload presentation mode honours the channel and key, and needs ipcRenderer.send", () => {
  const contextBridge = new FakeContextBridge();
  const ipcRenderer = new FakeIpcRenderer();
  installCastBridge({ contextBridge, ipcRenderer, mode: "presentation", channel: "my-cast", presentationBridgeKey: "__p" });
  contextBridge.exposed.get("__p").send("c", "m");
  assert.equal(ipcRenderer.sent[0]?.channel, "my-cast:presentation:send");
  const noSend = { invoke: ipcRenderer.invoke.bind(ipcRenderer), on: ipcRenderer.on.bind(ipcRenderer) };
  assert.throws(() => installCastBridge({ contextBridge: new FakeContextBridge(), ipcRenderer: noSend, mode: "presentation" }), TypeError);
});

test("preload chromecast mode installs electron-cast's chrome.cast; an unknown mode throws", () => {
  const contextBridge = new FakeContextBridge();
  installCastBridge({ contextBridge, ipcRenderer: new FakeIpcRenderer(), mode: "chromecast" });
  assert.deepEqual([...contextBridge.exposed.keys()], ["__electronCastBridge"]);
  assert.equal(contextBridge.executed[0]?.func, installChromeCast);
  assert.throws(() => installCastBridge({ contextBridge: new FakeContextBridge(), ipcRenderer: new FakeIpcRenderer(), mode: "cast" as any }), TypeError);
});

test("manager default serves presentation mode", () => {
  const ipcMain = new FakeIpcMain();
  createCastManager({ ipcMain, discovery: new FakeDiscovery(), selectDevice: async () => null });
  assert.deepEqual([...ipcMain.handlers.keys()], ["electron-cast:call", "electron-cast:presentation"]);
  assert.equal(ipcMain.listeners.get("electron-cast:presentation:send")?.length, 1);
});

// ---------- main ----------

type Listener = (event: IpcMainEventLike, ...args: any[]) => void;

class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  listeners = new Map<string, Listener[]>();
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`second handler for '${channel}'`);
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  on(channel: string, listener: Listener): unknown {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener]);
    return this;
  }
  removeListener(channel: string, listener: Listener): unknown {
    this.listeners.set(channel, (this.listeners.get(channel) ?? []).filter((l) => l !== listener));
    return this;
  }
}

class FakeWebContents extends EventEmitter {
  readonly id: number;
  sent: { channel: string; payload: any }[] = [];
  destroyed = false;
  constructor(id: number) {
    super();
    this.id = id;
  }
  send(channel: string, payload: unknown): void {
    if (this.destroyed) throw new Error("Object has been destroyed");
    this.sent.push({ channel, payload: JSON.parse(JSON.stringify(payload)) });
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
  /** presentation events, with message data parsed */
  events(): any[] {
    return this.sent.filter((s) => s.channel === "electron-cast:presentation:event").map((s) => s.payload);
  }
}

class FakeDiscovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
}

function setup(over: Partial<CastManagerOptions> = {}) {
  const ipcMain = new FakeIpcMain();
  const clients: FakeClient[] = [];
  const manager = createCastManager({
    ipcMain,
    discovery: new FakeDiscovery(),
    createClient: (d) => {
      const c = new FakeClient(d);
      const launch = c.launch.bind(c);
      c.launch = async (id: string) => {
        const app = await launch(id);
        app.namespaces.push({ name: MEDIA_NAMESPACE });
        return app;
      };
      clients.push(c);
      return c;
    },
    selectDevice: async (devices) => devices.find((d) => d.id === TV.id) ?? null,
    presentation: true,
    ...over,
  });
  const pcall = (wc: FakeWebContents, method: string, params: unknown, frame: unknown = { url: `${ORIGIN}/`, origin: ORIGIN }) => {
    const h = ipcMain.handlers.get("electron-cast:presentation");
    assert.ok(h, "presentation handler registered");
    return Promise.resolve(h({ sender: wc, senderFrame: frame }, method, params)) as Promise<any>;
  };
  const psend = (wc: FakeWebContents, connectionId: string, data: unknown) => {
    for (const l of ipcMain.listeners.get("electron-cast:presentation:send") ?? []) l({ sender: wc }, connectionId, data);
  };
  return { ipcMain, clients, manager, pcall, psend };
}

test("without presentation: no presentation handler or listener", async () => {
  const { ipcMain } = setup({ presentation: false });
  assert.deepEqual([...ipcMain.handlers.keys()], ["electron-cast:call"]);
  assert.equal(ipcMain.listeners.size, 0);
  assert.throws(() => createCastManager({
    ipcMain: { handle() {}, removeHandler() {} },
    discovery: new FakeDiscovery(),
    selectDevice: async () => null,
    presentation: true,
  }), TypeError);
});

test("start opens a connection whose envelope messages reach the page, and page sends reach the receiver", async () => {
  const { pcall, psend, clients, manager, ipcMain } = setup();
  const wc = new FakeWebContents(5);
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "w1", urls: [URL1] }), { ok: true, value: { available: true } });

  const r = await pcall(wc, "start", { connectionId: "conn-1", urls: [URL1] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.value.id, /^cast-session_/);
  assert.equal(r.value.url, URL1);
  const msgs = wc.events().filter((e) => e.type === "message");
  assert.ok(msgs.every((e) => e.connectionId === "conn-1"));
  const parsed = msgs.map((e) => JSON.parse(e.data));
  assert.deepEqual(parsed.map((m) => m.type), ["receiver_action", "new_session"]);
  const { sessionId, transportId } = parsed[1].message;

  psend(wc, "conn-1", JSON.stringify({ type: "app_message", message: { sessionId, namespaceName: MDX, message: "hi" }, sequenceNumber: 1, timeoutMillis: 3000, clientId: "c1" }));
  await tick();
  assert.deepEqual(clients[0]!.sent.at(-1), { namespace: MDX, destinationId: transportId, payload: "hi" });
  const ack = JSON.parse(wc.events().at(-1).data);
  assert.deepEqual(ack, { type: "app_message", message: null, sequenceNumber: 1, timeoutMillis: 0, clientId: "c1" });

  const other = new FakeWebContents(6);
  const before = clients[0]!.sent.length;
  psend(other, "conn-1", JSON.stringify({ type: "app_message", message: { sessionId, namespaceName: MDX, message: "x" }, sequenceNumber: 2, clientId: "c1" }));
  psend(wc, "conn-1", 42);
  await tick();
  assert.equal(clients[0]!.sent.length, before, "a send from another webContents, or a non-string, is ignored");

  assert.deepEqual(await pcall(wc, "terminate", { connectionId: "conn-1" }), { ok: true, value: undefined });
  await tick();
  assert.ok(clients[0]!.calls.includes(`stop ${sessionId}`));
  assert.deepEqual(wc.events().at(-1), { type: "statechange", connectionId: "conn-1", state: "terminated" });

  await manager.dispose();
  assert.equal(ipcMain.handlers.size, 0);
  assert.equal((ipcMain.listeners.get("electron-cast:presentation:send") ?? []).length, 0);
});

test("availability changes reach the page until stopWatching", async () => {
  const devices = new FakeDiscovery([]);
  const { pcall } = setup({ discovery: devices });
  const wc = new FakeWebContents(5);
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "w1", urls: [URL1] }), { ok: true, value: { available: false } });
  devices.up(TV);
  await tick();
  assert.deepEqual(wc.events().at(-1), { type: "availability", watchId: "w1", value: true });
  await pcall(wc, "stopWatching", { watchId: "w1" });
  const n = wc.events().length;
  devices.down(TV);
  await tick();
  assert.equal(wc.events().length, n);
});

test("a destroyed webContents loses its connections and gets nothing more", async () => {
  const { pcall, psend, clients } = setup();
  const wc = new FakeWebContents(5);
  const r = await pcall(wc, "start", { connectionId: "conn-1", urls: [URL1] });
  const { sessionId, transportId } = JSON.parse(wc.events()[1].data).message;
  wc.destroy();
  clients[0]!.pushMessage(transportId, MDX, "late");
  psend(wc, "conn-1", JSON.stringify({ type: "app_message", message: { sessionId, namespaceName: MDX, message: "x" }, sequenceNumber: 9, clientId: "c1" }));
  await tick();
  assert.equal(r.ok, true);
  assert.ok(!clients[0]!.sent.some((s) => s.payload === "x"));
});

test("errors: picker cancel, bad params, unknown method, no frame", async () => {
  const cancelled = setup({ selectDevice: async () => null });
  const wc = new FakeWebContents(5);
  const r = await cancelled.pcall(wc, "start", { connectionId: "c", urls: [URL1] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "AbortError");

  const { pcall } = setup();
  for (const [method, params] of [
    ["start", { connectionId: 1, urls: [URL1] }],
    ["start", { connectionId: "c", urls: [] }],
    ["reconnect", { connectionId: "c", urls: [URL1] }],
    ["getAvailability", null],
    ["nope", {}],
  ] as const) {
    const res = await pcall(wc, method, params);
    assert.equal(res.ok, false, method);
    assert.equal(res.code, "InvalidAccessError", `${method} ${JSON.stringify(params)}`);
  }
  assert.equal((await pcall(wc, "start", { connectionId: "c", urls: [URL1] }, null)).code, "NotAllowedError");
  const unsupported = await pcall(wc, "start", { connectionId: "c2", urls: ["https://example.test/"] });
  assert.equal(unsupported.code, "NotSupportedError");
});

test("presentation without ipcMain.on throws before registering anything", () => {
  const handlers: string[] = [];
  assert.throws(() => createCastManager({
    ipcMain: { handle: (c: string) => { handlers.push(c); }, removeHandler() {} },
    discovery: new FakeDiscovery(),
    selectDevice: async () => null,
    presentation: true,
  }), TypeError);
  assert.deepEqual(handlers, []);
});

test("a connection id is reserved while the picker is open", async () => {
  let pick!: (v: any) => void;
  const { pcall } = setup({ selectDevice: (devices) => new Promise((r) => { pick = () => r(devices.find((d) => d.id === TV.id) ?? null); }) });
  const wc = new FakeWebContents(5);
  const first = pcall(wc, "start", { connectionId: "dup", urls: [URL1] });
  await tick();
  const second = await pcall(wc, "start", { connectionId: "dup", urls: [URL1] });
  assert.equal(second.code, "InvalidAccessError");
  pick(null);
  assert.equal((await first).ok, true);
  assert.deepEqual(await pcall(wc, "close", { connectionId: "dup" }), { ok: true, value: undefined });
});

test("availability watches are capped per page, oldest dropped", async () => {
  const devices = new FakeDiscovery([]);
  const { pcall } = setup({ discovery: devices });
  const wc = new FakeWebContents(5);
  for (let i = 0; i < 40; i++) await pcall(wc, "getAvailability", { watchId: `w${i}`, urls: [URL1] });
  devices.up(TV);
  await tick();
  const ids = wc.events().filter((e) => e.type === "availability").map((e) => e.watchId);
  assert.equal(ids.length, 32);
  assert.ok(!ids.includes("w0") && ids.includes("w39"));
});

// ---------- after an app restart (Chrome: reconnect("cast-session_<id>") finds the session from receiver status) ----------

/** A first run that casts and quits, and a second manager whose device still plays that session. */
async function restarted() {
  const first = setup();
  const wc1 = new FakeWebContents(5);
  assert.equal((await first.pcall(wc1, "start", { connectionId: "conn-1", urls: [URL1] })).ok, true);
  const apps = first.clients[0]!.apps.map((a) => ({ ...a }));
  const sessionId = apps[0]!.sessionId;
  await first.manager.dispose();
  const second = setup({
    createClient: (d) => {
      const c = new FakeClient(d);
      if (d.id === TV.id) c.apps = apps.map((a) => ({ ...a }));
      second.clients.push(c);
      return c;
    },
  });
  return { second, sessionId, transportId: apps[0]!.transportId };
}

test("after a restart a page rejoins the running session with reconnect(cast-session_<id>), and auto-join does not", async () => {
  const { second, sessionId, transportId } = await restarted();
  const wc = new FakeWebContents(7);
  const other = new FakeWebContents(8);

  const auto = await second.pcall(wc, "reconnect", { connectionId: "c0", urls: [URL1], presentationId: "auto-join" });
  assert.equal(auto.ok, false, "Chrome does not auto-join a session it did not start");
  assert.equal(auto.code, "NotFoundError");

  const r = await second.pcall(wc, "reconnect", { connectionId: "c1", urls: [URL1], presentationId: `cast-session_${sessionId}` });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.id, `cast-session_${sessionId}`);
  const msgs = wc.events().filter((e) => e.type === "message").map((e) => JSON.parse(e.data));
  assert.deepEqual(msgs.map((m) => m.type), ["new_session"]);
  assert.equal(msgs[0].message.sessionId, sessionId);
  assert.equal(msgs[0].message.transportId, transportId);
  assert.deepEqual(other.events(), []);

  // The rejoined connection is live both ways.
  second.psend(wc, "c1", JSON.stringify({ type: "app_message", message: { sessionId, namespaceName: MDX, message: "hi" }, sequenceNumber: 1, timeoutMillis: 3000, clientId: "c1" }));
  await tick();
  const tv = second.clients.find((c) => c.device.id === TV.id)!;
  assert.deepEqual(tv.sent.at(-1), { namespace: MDX, destinationId: transportId, payload: "hi" });
  tv.pushMessage(transportId, MDX, "from receiver");
  await tick();
  assert.equal(JSON.parse(wc.events().at(-1).data).type, "app_message");
});

test("after a restart nothing is rejoined for another app, an unknown id, a session that ended or a refused origin", async () => {
  const { second, sessionId } = await restarted();
  const wc = new FakeWebContents(7);
  const other = `https://google.com/cast#__castAppId__=CC1AD845/__castClientId__=c1`;
  assert.equal((await second.pcall(wc, "reconnect", { connectionId: "a", urls: [other], presentationId: `cast-session_${sessionId}` })).code, "NotFoundError");
  assert.equal((await second.pcall(wc, "reconnect", { connectionId: "b", urls: [URL1], presentationId: "cast-session_nope" })).code, "NotFoundError");
  assert.deepEqual(wc.events(), []);

  const gone = await restarted();
  gone.second.clients.length = 0;
  gone.second.manager.dispose();
  const none = setup();
  assert.equal((await none.pcall(wc, "reconnect", { connectionId: "c", urls: [URL1], presentationId: `cast-session_${gone.sessionId}` })).code, "NotFoundError");

  const refused = await restarted();
  const denied = setup({ allowOrigin: () => false });
  assert.equal((await denied.pcall(wc, "reconnect", { connectionId: "d", urls: [URL1], presentationId: `cast-session_${refused.sessionId}` })).ok, false);
  assert.equal(denied.clients.length, 0, "no device is contacted for a refused origin");
});
