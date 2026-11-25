import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCastManager, type IpcMainLike, type CastManagerOptions } from "../../src/electron/main.ts";
import type { CastClientLike } from "../../src/electron/session-service.ts";
import { CastClient } from "../../src/client/index.ts";
import { CastDiscovery } from "../../src/discovery/index.ts";
import type { BridgeEvent } from "../../src/polyfill/bridge-types.ts";
import { FakeDevices, FakeClient, TV, tick } from "./fakes.ts";

// Compile-time: the real classes fit the shapes the manager takes.
const _client: CastClientLike = new CastClient({ host: "127.0.0.1" });
const _discovery: NonNullable<CastManagerOptions["discovery"]> = new CastDiscovery();
void _client;
void _discovery;

const YT = "233637DE";
const MDX = "urn:x-cast:com.google.youtube.mdx";
const ORIGIN = "https://music.youtube.com";

class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`);
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  listeners = new Map<string, ((...args: any[]) => void)[]>();
  on(channel: string, listener: (...args: any[]) => void): unknown {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener]);
    return this;
  }
  removeListener(channel: string, listener: (...args: any[]) => void): unknown {
    this.listeners.set(channel, (this.listeners.get(channel) ?? []).filter((l) => l !== listener));
    return this;
  }
}

class FakeWebContents extends EventEmitter {
  readonly id: number;
  sent: { channel: string; payload: BridgeEvent }[] = [];
  destroyed = false;
  constructor(id: number) {
    super();
    this.id = id;
  }
  send(channel: string, payload: BridgeEvent): void {
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
}

class FakeDiscovery extends FakeDevices {
  starts = 0;
  stops = 0;
  async start(): Promise<void> {
    this.starts++;
  }
  stop(): void {
    this.stops++;
  }
}

function setup(over: Partial<CastManagerOptions> = {}) {
  const ipcMain = new FakeIpcMain();
  const discovery = new FakeDiscovery();
  const clients: FakeClient[] = [];
  const picks: unknown[] = [];
  const manager = createCastManager({
    ipcMain,
    discovery,
    createClient: (d) => {
      const c = new FakeClient(d);
      clients.push(c);
      return c;
    },
    selectDevice: async (devices, request) => {
      picks.push({ ids: devices.map((d) => d.id), request });
      return devices.find((d) => d.id === TV.id) ?? null;
    },
    ...over,
  });
  const call = (wc: FakeWebContents, method: string, params: unknown, url: string | null = `${ORIGIN}/watch?v=x`) => {
    const handler = ipcMain.handlers.get(`${over.channel ?? "electron-cast"}:call`);
    assert.ok(handler, "call handler registered");
    const senderFrame = url === null ? null : { url, origin: new URL(url).origin };
    return Promise.resolve(handler({ sender: wc, senderFrame }, method, params));
  };
  return { ipcMain, discovery, clients, picks, manager, call };
}

const INIT = { appId: YT, capabilities: ["audio_out"], autoJoinPolicy: "origin_scoped" };
const REQ = { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 };

test("registers one invoke handler on <channel>:call and removes it on dispose", async () => {
  const { ipcMain, manager } = setup();
  assert.deepEqual([...ipcMain.handlers.keys()], ["electron-cast:call", "electron-cast:presentation"]);
  await manager.dispose();
  assert.deepEqual([...ipcMain.handlers.keys()], []);
  await manager.dispose();
});

test("a custom channel prefix is used", () => {
  const { ipcMain } = setup({ channel: "my-cast" });
  assert.deepEqual([...ipcMain.handlers.keys()], ["my-cast:call", "my-cast:presentation"]);
});

test("calls reach the session service as the sending webContents and frame origin", async () => {
  const { call, picks } = setup();
  const wc = new FakeWebContents(7);
  assert.deepEqual(await call(wc, "initialize", INIT), { ok: true, value: { available: true, sessions: [] } });
  const r = await call(wc, "requestSession", REQ);
  assert.equal(r && (r as { ok: boolean }).ok, true, JSON.stringify(r));
  assert.deepEqual((picks[0] as { request: unknown }).request, { appId: YT, capabilities: ["audio_out"], origin: ORIGIN, senderId: 7 });
});

test("allowOrigin sees the frame's origin", async () => {
  const seen: string[] = [];
  const { call } = setup({ allowOrigin: (o) => (seen.push(o), o === ORIGIN) });
  const ok = await call(new FakeWebContents(1), "initialize", INIT);
  const no = await call(new FakeWebContents(2), "initialize", INIT, "https://evil.example/x");
  assert.equal((ok as { ok: boolean }).ok, true);
  assert.deepEqual(no, { ok: false, code: "extension_missing", description: "Casting is not allowed for this origin" });
  assert.deepEqual(seen, [ORIGIN, "https://evil.example"]);
});

test("a call without a sender frame is refused", async () => {
  const { call } = setup();
  const r = await call(new FakeWebContents(1), "initialize", INIT, null);
  assert.equal((r as { ok: boolean; code?: string }).code, "extension_missing");
});

test("service events are sent to that webContents on <channel>:event", async () => {
  const { call, clients } = setup();
  const wc = new FakeWebContents(3);
  await call(wc, "initialize", INIT);
  const r = (await call(wc, "requestSession", REQ)) as { ok: true; value: { sessionId: string; transportId: string } };
  clients[0]?.pushMessage(r.value.transportId, MDX, '{"type":"x"}');
  assert.deepEqual(wc.sent.at(-1), {
    channel: "electron-cast:event",
    payload: { type: "message", sessionId: r.value.sessionId, namespace: MDX, message: '{"type":"x"}' },
  });
});

test("a destroyed webContents leaves its sessions", async () => {
  const { call, clients } = setup();
  const wc = new FakeWebContents(4);
  await call(wc, "initialize", INIT);
  const r = (await call(wc, "requestSession", REQ)) as { ok: true; value: { transportId: string } };
  wc.destroy();
  assert.ok(clients[0]?.calls.includes(`closeTransport ${r.value.transportId}`));
  assert.equal(clients[0]?.closed, true);
});

test("a main-frame navigation (reload or new page) also leaves its sessions", async () => {
  const { call, clients } = setup();
  const wc = new FakeWebContents(5);
  await call(wc, "initialize", INIT);
  const r = (await call(wc, "requestSession", REQ)) as { ok: true; value: { transportId: string } };
  wc.emit("did-navigate");
  assert.ok(clients[0]?.calls.includes(`closeTransport ${r.value.transportId}`));
});

test("each webContents is watched once, however many calls it makes", async () => {
  const { call } = setup();
  const wc = new FakeWebContents(6);
  await call(wc, "initialize", INIT);
  await call(wc, "initialize", INIT);
  assert.equal(wc.listenerCount("destroyed"), 1);
  assert.equal(wc.listenerCount("did-navigate"), 1);
});

test("events for a webContents that is already destroyed are dropped without throwing", async () => {
  const { call, discovery } = setup();
  const wc = new FakeWebContents(8);
  await call(wc, "initialize", INIT);
  wc.destroyed = true; // destroyed, but the "destroyed" event has not been delivered yet
  // Every device going away flips availability to false, which the service sends to this webContents.
  assert.doesNotThrow(() => {
    for (const d of discovery.devices()) discovery.down(d);
  });
  assert.deepEqual(wc.sent, []);
});

test("start starts discovery; devices lists it; dispose stops discovery and closes clients", async () => {
  const { call, discovery, clients, manager } = setup();
  await manager.start();
  assert.equal(discovery.starts, 1);
  assert.deepEqual(manager.devices().map((d) => d.id), discovery.devices().map((d) => d.id));
  const wc = new FakeWebContents(9);
  await call(wc, "initialize", INIT);
  await call(wc, "requestSession", REQ);
  await manager.dispose();
  assert.equal(discovery.stops, 1);
  assert.ok(clients.every((c) => c.closed));
  await tick();
  assert.deepEqual(wc.sent.filter((s) => s.payload.type === "sessionEnded"), [], "no events after dispose");
});

test("defaults: real discovery and clients, nothing opened until start", async () => {
  const ipcMain = new FakeIpcMain();
  const manager = createCastManager({ ipcMain, selectDevice: async () => null });
  assert.deepEqual(manager.devices(), []);
  await manager.dispose();
  assert.deepEqual([...ipcMain.handlers.keys()], []);
});

test('selectDevice may answer "stop", which cancels the request', async () => {
  const { call } = setup({ selectDevice: async () => "stop" as const });
  const wc = new FakeWebContents(10);
  await call(wc, "initialize", INIT);
  assert.deepEqual(await call(wc, "requestSession", REQ), { ok: false, code: "cancel" });
});
