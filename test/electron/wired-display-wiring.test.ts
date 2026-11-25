// Wired displays through createCastManager: the page's presentation IPC (availability, start on a chosen display,
// reconnect) and the manager's wiredDisplay API, with a fake screen and fake receiver windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCastManager, type CastManagerOptions, type WiredDisplaySink } from "../../src/electron/main.ts";
import { FakeDevices } from "./fakes.ts";
import { FakeScreen, disp, windowFactory } from "./wired-fakes.ts";

const ORIGIN = "http://127.0.0.1:4000";
const URL1 = "https://example.com/receiver.html";
const CAST_URL = "https://google.com/cast#__castAppId__=233637DE/__castClientId__=c1";
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

class FakeIpcMain {
  handlers = new Map<string, (e: any, ...a: any[]) => unknown>();
  listeners = new Map<string, ((e: any, ...a: any[]) => void)[]>();
  handle(c: string, l: any) { this.handlers.set(c, l); }
  removeHandler(c: string) { this.handlers.delete(c); }
  on(c: string, l: any) { this.listeners.set(c, [...(this.listeners.get(c) ?? []), l]); }
  removeListener(c: string, l: any) { this.listeners.set(c, (this.listeners.get(c) ?? []).filter((x) => x !== l)); }
}

class FakeWebContents extends EventEmitter {
  readonly id: number;
  sent: { channel: string; payload: any }[] = [];
  constructor(id: number) {
    super();
    this.id = id;
  }
  send(channel: string, payload: unknown) { this.sent.push({ channel, payload: JSON.parse(JSON.stringify(payload)) }); }
  isDestroyed() { return false; }
  events(): any[] { return this.sent.filter((s) => s.channel === "electron-cast:presentation:event").map((s) => s.payload); }
}

class FakeDiscovery extends FakeDevices {
  async start() {}
  stop() {}
}

function setup(over: Partial<CastManagerOptions> = {}, picked: { sinks?: WiredDisplaySink[]; choose?: (s: WiredDisplaySink[]) => string | null } = {}) {
  const ipcMain = new FakeIpcMain();
  const screen = new FakeScreen([disp(1, 0, 0), disp(2, 1920, 0)]);
  const f = windowFactory();
  const manager = createCastManager({
    ipcMain: ipcMain as any,
    discovery: new FakeDiscovery([]),
    selectDevice: async () => null,
    wiredDisplay: {
      screen,
      createReceiverWindow: f.create,
      selectDisplay: async (sinks) => {
        picked.sinks = sinks;
        return (picked.choose ?? ((s) => s[0]?.id ?? null))(sinks);
      },
      displayOf: () => 1,
    },
    ...over,
  });
  const pcall = (wc: FakeWebContents, method: string, params: any) => {
    const h = ipcMain.handlers.get("electron-cast:presentation")!;
    const sent = method === "start" ? { hasGesture: true, ...params } : params;
    return Promise.resolve(h({ sender: wc, senderFrame: { url: `${ORIGIN}/`, origin: ORIGIN } }, method, sent)) as Promise<any>;
  };
  const psend = (wc: FakeWebContents, connectionId: string, data: unknown) => {
    for (const l of ipcMain.listeners.get("electron-cast:presentation:send") ?? []) l({ sender: wc }, connectionId, data);
  };
  return { ipcMain, screen, f, manager, pcall, psend };
}

test("availability: true when displays exist for an https URL, false for plain http and file, and it follows the screen", async () => {
  const t = setup();
  const wc = new FakeWebContents(5);
  assert.deepEqual(await t.pcall(wc, "getAvailability", { watchId: "w1", urls: [URL1] }), { ok: true, value: { available: true } });
  assert.deepEqual(await t.pcall(wc, "getAvailability", { watchId: "w2", urls: ["http://example.com/r"] }), { ok: true, value: { available: false } });
  assert.deepEqual(await t.pcall(wc, "getAvailability", { watchId: "w3", urls: ["file:///r.html"] }), { ok: true, value: { available: false } });
  t.screen.remove(2);
  assert.deepEqual(wc.events().filter((e) => e.watchId === "w1"), [{ type: "availability", watchId: "w1", value: false }]);
  t.screen.add(disp(3, 1920, 0));
  assert.equal(wc.events().filter((e) => e.watchId === "w1").at(-1).value, true);
  await t.pcall(wc, "stopWatching", { watchId: "w1" });
  t.screen.remove(3);
  assert.equal(wc.events().filter((e) => e.watchId === "w1").length, 2, "no event after stopWatching");
  await t.manager.dispose();
});

test("availability of a request with a Cast URL and a page URL is the OR of both", async () => {
  const t = setup();
  const wc = new FakeWebContents(5);
  assert.deepEqual(await t.pcall(wc, "getAvailability", { watchId: "w1", urls: [CAST_URL, URL1] }), { ok: true, value: { available: true } });
  t.screen.remove(2);
  assert.deepEqual(wc.events().filter((e) => e.watchId === "w1"), [{ type: "availability", watchId: "w1", value: false }]);
  await t.manager.dispose();
});

test("start: the picker is offered the other displays only, a window opens, the page gets a connecting connection that then connects and echoes", async () => {
  const picked: { sinks?: WiredDisplaySink[] } = {};
  const t = setup({}, picked);
  const wc = new FakeWebContents(5);
  const r = await t.pcall(wc, "start", { connectionId: "conn-1", urls: [URL1] });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(picked.sinks!.map((s) => s.id), ["wired_display_2"], "displayOf says the page is on display 1, so its sink is hidden");
  assert.match(r.value.id, /^mr_/);
  assert.equal(r.value.url, URL1);
  assert.equal(r.value.state, "connecting");
  assert.equal(t.f.windows[0]!.started?.url, URL1);
  t.f.windows[0]!.register();
  assert.deepEqual(wc.events(), [{ type: "statechange", connectionId: "conn-1", state: "connected" }]);
  // controller -> receiver and back
  const rx: string[] = [];
  t.f.windows[0]!.ends[0]!.onmessage = (m) => rx.push(m);
  t.psend(wc, "conn-1", "hello");
  t.f.windows[0]!.ends[0]!.send("echo hello");
  assert.deepEqual(rx, ["hello"]);
  assert.deepEqual(wc.events().at(-1), { type: "message", connectionId: "conn-1", data: "echo hello" });
  // the manager API
  assert.deepEqual(t.manager.wiredDisplay!.getRoutes().map((x) => [x.id, x.sinkId]), [[r.value.id, "wired_display_2"]]);
  await t.pcall(wc, "close", { connectionId: "conn-1" });
  assert.equal(t.f.windows[0]!.closed, false, "closing a connection keeps the presentation");
  await t.manager.dispose();
});

test("start: a cancelled picker is AbortError; start without a gesture is AbortError; a display that vanished is OperationError", async () => {
  const t = setup({}, { choose: () => null });
  const wc = new FakeWebContents(5);
  assert.deepEqual(await t.pcall(wc, "start", { connectionId: "a", urls: [URL1] }), { ok: false, code: "AbortError", description: "The user cancelled the request" });
  const t2 = setup({}, { choose: () => "wired_display_99" });
  const r = await t2.pcall(wc, "start", { connectionId: "b", urls: [URL1] });
  assert.deepEqual([r.ok, r.code, r.description], [false, "OperationError", "Display not found"]);
  await t.manager.dispose();
  await t2.manager.dispose();
});

test("a Cast app URL still goes to the Cast flow, not to a display", async () => {
  const t = setup();
  const wc = new FakeWebContents(5);
  const r = await t.pcall(wc, "start", { connectionId: "c", urls: [CAST_URL] });
  assert.equal(r.ok, false);
  assert.equal(r.code, "NotFoundError", "no Cast devices: the Cast flow answered, and no display window opened");
  assert.equal(t.f.windows.length, 0);
  await t.manager.dispose();
});

test("reconnect(id) from another page joins the running presentation; after termination it is NotFoundError", async () => {
  const t = setup();
  const a = new FakeWebContents(5);
  const b = new FakeWebContents(6);
  const first = await t.pcall(a, "start", { connectionId: "c1", urls: [URL1] });
  t.f.windows[0]!.register();
  const again = await t.pcall(b, "reconnect", { connectionId: "c2", urls: [URL1], presentationId: first.value.id });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.value.id, first.value.id);
  assert.notEqual(again.value.state, "connecting", "the receiver was ready");
  assert.equal(t.f.windows[0]!.ends.length, 2);
  await t.manager.wiredDisplay!.terminateRoute(first.value.id);
  assert.equal(a.events().at(-1)!.state, "terminated");
  assert.equal(b.events().at(-1)!.state, "terminated");
  const gone = await t.pcall(b, "reconnect", { connectionId: "c3", urls: [URL1], presentationId: first.value.id });
  assert.equal(gone.ok, false);
  assert.equal(gone.code, "NotFoundError");
  await t.manager.dispose();
});

test("the controller page navigating away leaves the receiver window running", async () => {
  const t = setup();
  const wc = new FakeWebContents(5);
  await t.pcall(wc, "start", { connectionId: "c1", urls: [URL1] });
  t.f.windows[0]!.register();
  wc.emit("did-navigate");
  assert.equal(t.f.windows[0]!.closed, false);
  assert.equal(t.manager.wiredDisplay!.getRoutes().length, 1);
  await t.manager.dispose();
  assert.equal(t.f.windows[0]!.closed, true, "disposing the manager closes it");
});

test("without the wiredDisplay option there is no wiredDisplay API and https page URLs are not available", async () => {
  const ipcMain = new FakeIpcMain();
  const manager = createCastManager({ ipcMain: ipcMain as any, discovery: new FakeDiscovery([]), selectDevice: async () => null });
  assert.equal(manager.wiredDisplay, undefined);
  const wc = new FakeWebContents(5);
  const h = ipcMain.handlers.get("electron-cast:presentation")!;
  const r: any = await h({ sender: wc, senderFrame: { url: `${ORIGIN}/`, origin: ORIGIN } }, "getAvailability", { watchId: "w", urls: [URL1] });
  assert.deepEqual(r, { ok: true, value: { available: false } });
  await manager.dispose();
  await tick();
});

test("observers of the manager's wiredDisplay API get sinks and routes", async () => {
  const t = setup();
  const sinks: string[][] = [];
  const routes: number[] = [];
  const offS = t.manager.wiredDisplay!.registerMediaSinksObserver({ onSinksUpdated: (s) => sinks.push(s.map((x) => x.name)) });
  const offR = t.manager.wiredDisplay!.registerMediaRoutesObserver({ onRoutesUpdated: (r) => routes.push(r.length) });
  t.screen.add(disp(3, 3840, 0));
  const wc = new FakeWebContents(5);
  await t.pcall(wc, "start", { connectionId: "c1", urls: [URL1] });
  t.f.windows[0]!.close();
  assert.deepEqual(sinks, [["Display 1", "Display 2"], ["Display 1", "Display 2", "Display 3"]]);
  assert.deepEqual(routes, [0, 1, 0]);
  offS();
  offR();
  await t.manager.dispose();
});
