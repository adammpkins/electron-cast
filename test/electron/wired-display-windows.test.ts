// The Electron receiver window (src/electron/wired-display/electron-windows.ts) with fake BrowserWindow, session and
// ipcMain: how it is created and locked down, and how the receiver page's IPC reaches the local presentation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceiverWindows, receiverPreloadSource } from "../../src/electron/wired-display/electron-windows.ts";
import { createWiredDisplay } from "../../src/electron/wired-display/index.ts";
import { FakeScreen } from "./wired-fakes.ts";

class FakeWebContents extends EventEmitter {
  static next = 100;
  readonly id = FakeWebContents.next++;
  url = "";
  loaded: string[] = [];
  sent: { channel: string; payload: any }[] = [];
  stopped = 0;
  destroyed = false;
  openHandler: (() => { action: string }) | null = null;
  getURL() { return this.url; }
  async loadURL(url: string) { this.loaded.push(url); this.url = url; }
  send(channel: string, payload: unknown) { this.sent.push({ channel, payload }); }
  isDestroyed() { return this.destroyed; }
  stop() { this.stopped++; }
  setWindowOpenHandler(h: () => { action: string }) { this.openHandler = h as any; }
}

class FakeBrowserWindow extends EventEmitter {
  static all: FakeBrowserWindow[] = [];
  readonly webContents = new FakeWebContents();
  fullscreen = false;
  shown: string[] = [];
  closeCalls = 0;
  destroyed = false;
  readonly options: Record<string, any>;
  constructor(options: Record<string, any>) {
    super();
    this.options = options;
    FakeBrowserWindow.all.push(this);
  }
  showInactive() { this.shown.push("showInactive"); }
  setFullScreen(f: boolean) { this.fullscreen = f; this.shown.push(`fullscreen:${f}`); }
  isFullScreen() { return this.fullscreen; }
  isDestroyed() { return this.destroyed; }
  close() { this.closeCalls++; this.destroyed = true; this.webContents.destroyed = true; this.emit("closed"); }
}

class FakeSession {
  permissionRequest: ((wc: unknown, p: string, cb: (g: boolean) => void) => void) | null = null;
  permissionCheck: ((wc: unknown, p: string) => boolean) | null = null;
  downloads: ((e: { preventDefault(): void }) => void) | null = null;
  cleared = 0;
  setPermissionRequestHandler(h: any) { this.permissionRequest = h; }
  setPermissionCheckHandler(h: any) { this.permissionCheck = h; }
  on(_e: "will-download", l: any) { this.downloads = l; }
  async clearStorageData() { this.cleared++; }
  async clearCache() {}
}

class FakeIpcMain {
  handlers = new Map<string, (e: any, ...a: any[]) => any>();
  listeners = new Map<string, (e: any, ...a: any[]) => void>();
  handle(c: string, l: any) { this.handlers.set(c, l); }
  removeHandler(c: string) { this.handlers.delete(c); }
  on(c: string, l: any) { this.listeners.set(c, l); }
  removeListener(c: string) { this.listeners.delete(c); }
}

function setup(platform = "win32") {
  FakeBrowserWindow.all = [];
  const dir = mkdtempSync(join(tmpdir(), "ec-receiver-"));
  const ipcMain = new FakeIpcMain();
  const sessions = new Map<string, FakeSession>();
  const windows = createReceiverWindows({
    BrowserWindow: FakeBrowserWindow as any,
    session: { fromPartition: (p: string) => { const s = new FakeSession(); sessions.set(p, s); return s as any; } },
    ipcMain: ipcMain as any,
    preloadDir: dir,
    platform,
  });
  const screen = new FakeScreen();
  const wired = createWiredDisplay({ screen, createReceiverWindow: windows.factory, selectDisplay: async () => null });
  return { dir, ipcMain, sessions, windows, wired, screen, done: () => { windows.dispose(); wired.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}
const CH = "electron-cast:receiver";
const URL1 = "https://example.com/receiver.html";
const main = (wc: FakeWebContents) => ({ sender: wc, senderFrame: { parent: null } });

test("the receiver window: on the display's bounds, hidden until start, then shown inactive and fullscreen (ShowInactiveFullscreen)", () => {
  const t = setup();
  const conn = t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
  const win = FakeBrowserWindow.all[0]!;
  assert.deepEqual([win.options.x, win.options.y, win.options.width, win.options.height, win.options.show], [1920, 0, 1920, 1080, false]);
  assert.deepEqual(win.webContents.loaded, [URL1]);
  assert.deepEqual(win.shown, ["showInactive", "fullscreen:true"]);
  assert.equal(conn.connecting, true);
  t.done();
});

test("locked down: sandboxed, isolated, no node, its own in-memory session, no popups, no permissions but fullscreen, no downloads", () => {
  const t = setup();
  t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
  const win = FakeBrowserWindow.all[0]!;
  const prefs = win.options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webviewTag, false);
  assert.match(prefs.partition, /^electron-cast-receiver-[0-9a-f-]{36}$/, "a partition without persist: lives in memory");
  assert.equal(win.webContents.openHandler?.().action, "deny");
  const ses = t.sessions.get(prefs.partition)!;
  const grants: boolean[] = [];
  ses.permissionRequest!(null, "geolocation", (g) => grants.push(g));
  ses.permissionRequest!(null, "fullscreen", (g) => grants.push(g));
  assert.deepEqual(grants, [false, true]);
  assert.equal(ses.permissionCheck!(null, "media"), false);
  let prevented = false;
  ses.downloads!({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  // every presentation has a session of its own
  t.wired.controllers.start({ urls: ["https://example.com/two"], origin: "https://c.test", senderId: 1 }, "wired_display_1");
  assert.equal(t.sessions.size, 2);
  t.done();
});

test("the preload is generated into preloadDir, named by content, and installs the receiver stand-in", () => {
  const t = setup();
  t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
  const file = FakeBrowserWindow.all[0]!.options.webPreferences.preload as string;
  assert.deepEqual(readdirSync(t.dir), [file.split(/[\\/]/).pop()]);
  const src = readFileSync(file, "utf8");
  assert.equal(src, receiverPreloadSource(CH));
  assert.match(src, /contextBridge\.executeInMainWorld/);
  assert.match(src, /function installPresentationReceiver/);
  assert.match(src, /electron-cast:receiver/);
  t.done();
});

test("navigation: the first main-frame navigation loads, a later cross-document one stops the page and terminates; same-document and subframes are fine (PresentationNavigationPolicy)", async () => {
  const t = setup();
  const conn = t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
  const log: string[] = [];
  conn.onclose = (r) => log.push(r);
  const win = FakeBrowserWindow.all[0]!;
  const wc = win.webContents;
  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  wc.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  assert.equal(win.closeCalls, 0);
  assert.equal(wc.stopped, 0);
  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.equal(wc.stopped, 1);
  assert.equal(win.closeCalls, 1);
  assert.deepEqual(log, ["terminated"]);
  assert.deepEqual(t.wired.provider.routes(), []);
  t.done();
});

test("the window closing terminates the presentation, and the session is cleared", async () => {
  const t = setup();
  const conn = t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
  const log: string[] = [];
  conn.onclose = (r) => log.push(r);
  const win = FakeBrowserWindow.all[0]!;
  win.emit("closed");
  assert.deepEqual(log, ["terminated"]);
  assert.equal([...t.sessions.values()][0]!.cleared, 1);
  t.done();
});

test("a beforeunload prompt cannot keep the window open, and a title is passed on", () => {
  const t = setup();
  t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
  const wc = FakeBrowserWindow.all[0]!.webContents;
  let prevented = false;
  wc.emit("will-prevent-unload", { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  wc.emit("page-title-updated", {}, "Slides");
  assert.equal(t.wired.provider.routes()[0]!.title, "Slides");
  t.done();
});

test("F11 toggles fullscreen (Control+Command+F on macOS), other keys do not", () => {
  for (const [platform, key] of [["win32", { type: "keyDown", key: "F11" }], ["darwin", { type: "keyDown", key: "f", control: true, meta: true }]] as const) {
    const t = setup(platform);
    t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
    const win = FakeBrowserWindow.all[0]!;
    const press = (input: object) => win.webContents.emit("before-input-event", { preventDefault() {} }, input);
    press({ type: "keyDown", key: "a" });
    assert.equal(win.fullscreen, true);
    press(key);
    assert.equal(win.fullscreen, false);
    press(key);
    assert.equal(win.fullscreen, true);
    t.done();
  }
});

test("the receiver page's IPC: register delivers the connection, messages and close flow both ways, terminate closes the window", () => {
  const t = setup();
  const conn = t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
  const got: string[] = [];
  const log: string[] = [];
  conn.onmessage = (m) => got.push(m);
  conn.onclose = (r) => log.push(r);
  conn.onconnect = () => log.push("connect");
  const win = FakeBrowserWindow.all[0]!;
  const wc = win.webContents;
  const handle = t.ipcMain.handlers.get(CH)!;
  assert.deepEqual(handle(main(wc), "register", {}), { ok: true });
  const first = wc.sent[0]!;
  assert.equal(first.channel, `${CH}:event`);
  assert.deepEqual([first.payload.type, first.payload.id, first.payload.url], ["connection", conn.id, URL1]);
  assert.deepEqual(log, ["connect"]);
  const cid = first.payload.connectionId as string;
  // page -> controller
  t.ipcMain.listeners.get(`${CH}:send`)!(main(wc), cid, "from page");
  assert.deepEqual(got, ["from page"]);
  // controller -> page
  conn.send("from controller");
  assert.deepEqual(wc.sent[1]!.payload, { type: "message", connectionId: cid, data: "from controller" });
  // page closes
  handle(main(wc), "close", { connectionId: cid });
  assert.deepEqual(log, ["connect", "closed"]);
  // a second connection, terminated by the page
  const again = t.wired.controllers.reconnect({ urls: [URL1], senderId: 2 }, conn.id);
  const alog: string[] = [];
  again.onclose = (r) => alog.push(r);
  const cid2 = wc.sent.at(-1)!.payload.connectionId as string;
  handle(main(wc), "terminate", { connectionId: cid2 });
  assert.equal(win.closeCalls, 1);
  assert.deepEqual(alog, ["terminated"]);
  t.done();
});

test("IPC from anything but the main frame of a receiver window is ignored", () => {
  const t = setup();
  t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
  const wc = FakeBrowserWindow.all[0]!.webContents;
  const handle = t.ipcMain.handlers.get(CH)!;
  assert.deepEqual(handle({ sender: new FakeWebContents(), senderFrame: { parent: null } }, "register", {}), { ok: false });
  assert.deepEqual(handle({ sender: wc, senderFrame: { parent: {} } }, "register", {}), { ok: false });
  assert.deepEqual(handle({ sender: wc, senderFrame: null }, "register", {}), { ok: false });
  assert.deepEqual(handle(main(wc), "nonsense", {}), { ok: false });
  assert.equal(wc.sent.length, 0);
  t.done();
});

test("dispose closes the windows and removes the IPC", () => {
  const t = setup();
  t.wired.controllers.start({ urls: [URL1], origin: "https://c.test", senderId: 1 }, "wired_display_2");
  t.windows.dispose();
  assert.equal(t.ipcMain.handlers.size, 0);
  assert.equal(t.ipcMain.listeners.size, 0);
  assert.equal(FakeBrowserWindow.all[0]!.closeCalls, 1);
  t.wired.dispose();
  rmSync(t.dir, { recursive: true, force: true });
});
