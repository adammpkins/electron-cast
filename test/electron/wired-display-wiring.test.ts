// Wired displays through createCastManager: the page's presentation IPC (availability, start on a chosen display,
// reconnect) and the manager's wiredDisplay API, with a fake screen and fake receiver windows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCastManager, type CastManagerOptions, type WiredDisplayOptions, type WiredDisplayRequest, type WiredDisplaySink } from "../../src/electron/main.ts";
import { FakeDevices } from "./fakes.ts";
import { FakePageWindow, FakeScreen, disp, windowFactory } from "./wired-fakes.ts";

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

function setup(
  over: Partial<CastManagerOptions> = {},
  picked: { sinks?: WiredDisplaySink[]; request?: WiredDisplayRequest; choose?: (s: WiredDisplaySink[]) => string | null } = {},
  wiredOver: Partial<WiredDisplayOptions> | null = null,
) {
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
      selectDisplay: async (sinks, request) => {
        picked.sinks = sinks;
        picked.request = request;
        return (picked.choose ?? ((s) => s[0]?.id ?? null))(sinks);
      },
      ...(wiredOver === null ? { displayOf: () => 1 } : wiredOver),
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
  t.f.windows[0]!.ends[0]!.onmessage = (m) => rx.push(m as string);
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

test("binary: bytes go both ways between the page and the receiver, copied, and text is unchanged", async () => {
  const t = setup();
  const wc = new FakeWebContents(5);
  await t.pcall(wc, "start", { connectionId: "c1", urls: [URL1] });
  const win = t.f.windows[0]!;
  win.register();
  const rx: (string | Uint8Array)[] = [];
  win.ends[0]!.onmessage = (m) => rx.push(m);
  const mine = new Uint8Array([1, 2, 3]);
  t.psend(wc, "c1", mine);
  t.psend(wc, "c1", new Uint8Array([7, 8, 9]).buffer); // an ArrayBuffer over IPC is accepted too
  t.psend(wc, "c1", "text");
  mine[0] = 99;
  assert.deepEqual(rx.map((m) => (typeof m === "string" ? m : Array.from(m))), [[1, 2, 3], [7, 8, 9], "text"]);
  assert.notEqual(rx[0], mine, "the receiver gets a copy");
  const reply = new Uint8Array([4, 5]);
  win.ends[0]!.send(reply);
  reply[0] = 0;
  win.ends[0]!.send("back");
  const msgs = wc.events().filter((e) => e.type === "message");
  assert.deepEqual(msgs.map((e) => (e.bytes ? ["bytes", Object.values(e.bytes)] : ["data", e.data])), [["bytes", [4, 5]], ["data", "back"]]);
  t.psend(wc, "c1", 123 as any);
  t.psend(wc, "c1", { not: "bytes" } as any);
  assert.equal(rx.length, 3, "anything but text or bytes is ignored");
  await t.manager.dispose();
});

test("binary: bytes before the receiver connected are not sent, and bytes over the size cap are dropped", async () => {
  const t = setup();
  const wc = new FakeWebContents(5);
  await t.pcall(wc, "start", { connectionId: "c1", urls: [URL1] });
  const win = t.f.windows[0]!;
  t.psend(wc, "c1", new Uint8Array([1])); // CanSendMessage: not connected yet
  win.register();
  const rx: unknown[] = [];
  win.ends[0]!.onmessage = (m) => rx.push(m);
  t.psend(wc, "c1", new Uint8Array(64 * 1024 * 1024 + 1));
  assert.deepEqual(rx, []);
  await t.manager.dispose();
});

test("displayOf default: the page's window is found with BrowserWindow.fromWebContents and screen.getDisplayMatching", async () => {
  const wc = new FakeWebContents(5);
  const win = new FakePageWindow({ x: 100, y: 100, width: 800, height: 600 });
  const picked: { sinks?: WiredDisplaySink[] } = {};
  const t = setup({}, picked, { BrowserWindow: { fromWebContents: (w: unknown) => (w === wc ? win : null) } });
  await t.pcall(wc, "start", { connectionId: "c1", urls: [URL1] });
  assert.deepEqual(picked.sinks!.map((s) => s.id), ["wired_display_2"], "the window is on display 1, whose sink is left out");
  win.moveTo(2000, 100);
  await t.pcall(wc, "start", { connectionId: "c2", urls: [URL1] });
  assert.deepEqual(picked.sinks!.map((s) => s.id), ["wired_display_1"], "the lookup runs at every start, on the window's current bounds");
  await t.manager.dispose();
});

test("displayOf default: a webContents with no window is offered every display, and the displayOf option overrides the lookup", async () => {
  const wc = new FakeWebContents(5);
  const ids = async (wired: Partial<WiredDisplayOptions>) => {
    const picked: { sinks?: WiredDisplaySink[] } = {};
    const t = setup({}, picked, wired);
    await t.pcall(wc, "start", { connectionId: "c1", urls: [URL1] });
    await t.manager.dispose();
    return picked.sinks!.map((s) => s.id);
  };
  const win = new FakePageWindow({ x: 0, y: 0, width: 100, height: 100 });
  const destroyed = new FakePageWindow({ x: 0, y: 0, width: 100, height: 100 });
  destroyed.destroyed = true;
  const both = ["wired_display_1", "wired_display_2"];
  assert.deepEqual(await ids({ BrowserWindow: { fromWebContents: () => null } }), both, "no window");
  assert.deepEqual(await ids({}), both, "neither BrowserWindow nor displayOf");
  assert.deepEqual(await ids({ BrowserWindow: { fromWebContents: () => destroyed } }), both, "a destroyed window counts as none");
  assert.deepEqual(await ids({ BrowserWindow: { fromWebContents: () => { throw new Error("not a webContents"); } } }), both, "a lookup that throws counts as none");
  assert.deepEqual(await ids({ BrowserWindow: { fromWebContents: () => win }, displayOf: () => 2 }), ["wired_display_1"], "displayOf wins");
});

test("an open picker follows the page's window as it moves or resizes, and displays coming and going", async () => {
  const wc = new FakeWebContents(5);
  const win = new FakePageWindow({ x: 100, y: 100, width: 800, height: 600 });
  const picked: { request?: WiredDisplayRequest } = {};
  const t = setup({}, picked, { BrowserWindow: { fromWebContents: () => win } });
  await t.pcall(wc, "start", { connectionId: "c1", urls: [URL1] });
  const seen: string[][] = [];
  const stop = picked.request!.observeSinks((s) => seen.push(s.map((x) => x.id)));
  win.moveTo(2000, 100);
  win.moveTo(2100, 150, "resize"); // still display 2: no new list
  t.screen.add(disp(3, 3840, 0));
  win.moveTo(100, 100);
  stop();
  win.moveTo(2000, 100);
  t.screen.add(disp(4, 5760, 0));
  assert.deepEqual(seen, [["wired_display_1"], ["wired_display_1", "wired_display_3"], ["wired_display_2", "wired_display_3"]]);
  assert.equal(win.listenerCount("move") + win.listenerCount("resize"), 0, "stopping removes the window listeners");
  await t.manager.dispose();
});
