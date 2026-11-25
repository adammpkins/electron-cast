// The offscreen tab as an Electron window (createReceiverHost().openOffscreenTab, src/electron/wired-display/
// electron-windows.ts) with fake BrowserWindow and ipcMain: what `OffscreenTab::Start` and its delegate methods
// (chrome/browser/media/offscreen_tab.cc) become, and that the tab's page reaches the local presentation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OffscreenPresentations } from "../../src/electron/offscreen-presentation.ts";
import { RECEIVER_SANDBOX, createReceiverHost, createReceiverWindows } from "../../src/electron/wired-display/electron-windows.ts";

class FakeSession {
  permissionRequest: ((wc: unknown, p: string, cb: (g: boolean) => void, d?: { securityOrigin?: string }) => void) | null = null;
  downloads: ((e: { preventDefault(): void }) => void) | null = null;
  headers: ((d: any, cb: (r: any) => void) => void) | null = null;
  cleared = 0;
  webRequest = { onHeadersReceived: (l: any) => { this.headers = l; } };
  setPermissionRequestHandler(h: any) { this.permissionRequest = h; }
  setPermissionCheckHandler() {}
  on(_e: "will-download", l: any) { this.downloads = l; }
  async clearStorageData() { this.cleared++; }
  async clearCache() {}
}

class FakeWebContents extends EventEmitter {
  static next = 300;
  readonly id = FakeWebContents.next++;
  readonly session = new FakeSession();
  url = "";
  calls: string[] = [];
  sent: { channel: string; payload: any }[] = [];
  destroyed = false;
  captured = false;
  getURL() { return this.url; }
  async loadURL(url: string) { this.calls.push(`load ${url}`); this.url = url; }
  send(channel: string, payload: unknown) { this.sent.push({ channel, payload }); }
  isDestroyed() { return this.destroyed; }
  stop() { this.calls.push("stop"); }
  setWindowOpenHandler() {}
  setAudioMuted(muted: boolean) { this.calls.push(`muted ${muted}`); }
  isBeingCaptured() { return this.captured; }
}

class FakeBrowserWindow extends EventEmitter {
  static all: FakeBrowserWindow[] = [];
  readonly webContents = new FakeWebContents();
  readonly options: Record<string, any>;
  calls: string[] = [];
  destroyed = false;
  constructor(options: Record<string, any>) {
    super();
    this.options = options;
    FakeBrowserWindow.all.push(this);
  }
  showInactive() { this.calls.push("show"); }
  setFullScreen(f: boolean) { this.calls.push(`fullscreen ${f}`); }
  isFullScreen() { return false; }
  isDestroyed() { return this.destroyed; }
  setContentSize(w: number, h: number) { this.calls.push(`size ${w}x${h}`); }
  private gone(how: string) {
    if (this.destroyed) return;
    this.calls.push(how);
    this.destroyed = true;
    this.webContents.destroyed = true;
    this.emit("closed");
  }
  close() { this.gone("close"); }
  destroy() { this.gone("destroy"); }
}

class FakeIpcMain {
  handlers = new Map<string, (e: any, ...a: any[]) => any>();
  listeners = new Map<string, (e: any, ...a: any[]) => void>();
  handle(c: string, l: any) {
    if (this.handlers.has(c)) throw new Error(`second handler for ${c}`);
    this.handlers.set(c, l);
  }
  removeHandler(c: string) { this.handlers.delete(c); }
  on(c: string, l: any) { this.listeners.set(c, l); }
  removeListener(c: string) { this.listeners.delete(c); }
}

const URL1 = "https://slides.example.com/deck";

function setup() {
  FakeBrowserWindow.all = [];
  const dir = mkdtempSync(join(tmpdir(), "ec-offscreen-"));
  const ipcMain = new FakeIpcMain();
  const host = createReceiverHost({ BrowserWindow: FakeBrowserWindow as any, ipcMain: ipcMain as any, preloadDir: dir, channel: "electron-cast:offscreen-receiver" });
  const log: string[] = [];
  const events: string[] = [];
  const open = (id = "mr_1") => host.openOffscreenTab({
    url: URL1,
    presentationId: id,
    size: { width: 1920, height: 1080 },
    onDestroyed: () => events.push(`destroyed ${id}`),
    receiverCreated: (info) => events.push(`receiver ${info.id} ${info.url}`),
    receiverReset: (rid) => events.push(`reset ${rid}`),
    log: (m) => log.push(m),
  });
  return { dir, ipcMain, host, open, log, events, done: () => { host.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

test("OffscreenTab::Start: a window that is never shown, of the capture size, muted before it loads", () => {
  const t = setup();
  const tab = t.open();
  const win = FakeBrowserWindow.all[0]!;
  const o = win.options;
  assert.deepEqual(
    { show: o.show, frame: o.frame, focusable: o.focusable, skipTaskbar: o.skipTaskbar, fullscreenable: o.fullscreenable, useContentSize: o.useContentSize, width: o.width, height: o.height },
    { show: false, frame: false, focusable: false, skipTaskbar: true, fullscreenable: false, useContentSize: true, width: 1920, height: 1080 },
  );
  const prefs = o.webPreferences;
  assert.deepEqual(
    { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration, throttling: prefs.backgroundThrottling },
    { sandbox: true, contextIsolation: true, nodeIntegration: false, throttling: false },
  );
  assert.match(prefs.partition, /^electron-cast-receiver-/, "a profile of its own, in memory");
  assert.deepEqual(win.calls, ["size 1920x1080"], "sized after creation; never shown, never fullscreen");
  assert.deepEqual(win.webContents.calls, ["muted true", `load ${URL1}`]);
  assert.equal(tab.webContentsId, win.webContents.id);
  t.done();
});

test("the tab's own session carries the receiver sandbox, blocks downloads, and grants fullscreen and its own capture only", () => {
  const t = setup();
  t.open();
  const ses = FakeBrowserWindow.all[0]!.webContents.session;
  let headers: Record<string, string[]> | undefined;
  ses.headers!({ resourceType: "mainFrame", responseHeaders: {} }, (r: any) => { headers = r.responseHeaders; });
  assert.deepEqual(Object.values(headers ?? {}), [[RECEIVER_SANDBOX]]);
  const granted: Record<string, boolean> = {};
  for (const p of ["media", "display-capture", "notifications", "fullscreen"]) ses.permissionRequest!(null, p, (g) => { granted[p] = g; });
  assert.deepEqual(granted, { media: false, "display-capture": false, notifications: false, fullscreen: true });
  // Electron asks the captured page's session when the mirroring host captures it, with the host page's origin; the
  // page in the tab asking for the screen itself has its own origin and is refused (RequestMediaAccessPermission)
  const capture = (securityOrigin: string | undefined, permission = "display-capture"): boolean => {
    let answer = false;
    ses.permissionRequest!(null, permission, (g) => { answer = g; }, securityOrigin === undefined ? undefined : { securityOrigin });
    return answer;
  };
  assert.equal(capture("file:///"), true);
  assert.equal(capture("https://slides.example.com/"), false);
  assert.equal(capture("null"), false);
  assert.equal(capture(undefined), false);
  assert.equal(capture("file:///", "media"), false, "never the camera or microphone");
  let prevented = false;
  ses.downloads!({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  t.done();
});

test("keyboard input is swallowed, and a second main-frame navigation closes the tab", () => {
  const t = setup();
  t.open();
  const win = FakeBrowserWindow.all[0]!;
  const wc = win.webContents;
  let prevented = 0;
  wc.emit("before-input-event", { preventDefault: () => prevented++ }, { type: "keyDown", key: "a" });
  wc.emit("before-input-event", { preventDefault: () => prevented++ }, { type: "keyUp", key: "F11" });
  assert.equal(prevented, 2);
  assert.deepEqual(win.calls, ["size 1920x1080"], "F11 does nothing to it");
  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  assert.equal(win.destroyed, false);
  wc.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  assert.equal(win.destroyed, true);
  assert.deepEqual(t.events, ["reset mr_1", "destroyed mr_1"]);
  t.done();
});

test("the page's register reaches the local presentation with the committed URL; only its main frame is heard", async () => {
  const t = setup();
  t.open();
  const wc = FakeBrowserWindow.all[0]!.webContents;
  const call = t.ipcMain.handlers.get("electron-cast:offscreen-receiver")!;
  assert.deepEqual(await call({ sender: wc, senderFrame: { parent: {} } }, "register", {}), { ok: false }, "a subframe is not the receiver");
  assert.deepEqual(await call({ sender: { id: 1 }, senderFrame: { parent: null } }, "register", {}), { ok: false }, "nor any other page");
  assert.deepEqual(await call({ sender: wc, senderFrame: { parent: null } }, "register", {}), { ok: true });
  assert.deepEqual(t.events, [`receiver mr_1 ${URL1}`]);
  t.done();
});

test("destroy() deletes the window at once and reports it once; window.close() does the same", () => {
  const t = setup();
  const tab = t.open();
  const win = FakeBrowserWindow.all[0]!;
  tab.destroy();
  tab.destroy();
  assert.deepEqual(win.calls.slice(1), ["destroy"]);
  assert.deepEqual(t.events, ["reset mr_1", "destroyed mr_1"]);

  t.open("mr_2");
  FakeBrowserWindow.all[1]!.close();
  assert.deepEqual(t.events.slice(2), ["reset mr_2", "destroyed mr_2"]);
  t.done();
});

test("DieIfContentCaptureEnded: the tab destroys itself a poll after its capture has ended", async (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const t = setup();
  t.open();
  const win = FakeBrowserWindow.all[0]!;
  win.webContents.captured = true;
  ctx.mock.timers.tick(1000);
  ctx.mock.timers.tick(1000);
  assert.equal(win.destroyed, false);
  win.webContents.captured = false;
  ctx.mock.timers.tick(1000);
  assert.equal(win.destroyed, true);
  assert.deepEqual(t.log, ["Capture of the offscreen tab has stopped; the tab is destroyed."]);
  assert.deepEqual(t.events, ["reset mr_1", "destroyed mr_1"]);
  t.done();
});

test("DieIfContentCaptureEnded: a tab that is never captured is destroyed after a minute", (ctx) => {
  ctx.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const t = setup();
  t.open();
  const win = FakeBrowserWindow.all[0]!;
  for (let i = 0; i < 60; i++) ctx.mock.timers.tick(1000);
  assert.equal(win.destroyed, false);
  ctx.mock.timers.tick(1000);
  assert.equal(win.destroyed, true);
  assert.deepEqual(t.log, ["Capture of the offscreen tab did not start within a minute; the tab is destroyed."]);
  t.done();
});

test("receiver windows and offscreen tabs share an ipcMain on different channels; the same channel is refused", () => {
  const t = setup();
  const wired = createReceiverWindows({
    BrowserWindow: FakeBrowserWindow as any,
    session: { fromPartition: () => new FakeSession() as any },
    ipcMain: t.ipcMain as any,
    preloadDir: t.dir,
  });
  assert.deepEqual([...t.ipcMain.handlers.keys()].sort(), ["electron-cast:offscreen-receiver", "electron-cast:receiver"]);
  assert.throws(() => createReceiverHost({ BrowserWindow: FakeBrowserWindow as any, ipcMain: t.ipcMain as any, preloadDir: t.dir, channel: "electron-cast:receiver" }), /already in use/);
  wired.dispose();
  t.done();
});

test("a receiver window on a display is never capturable, whatever asks", () => {
  FakeBrowserWindow.all = [];
  const dir = mkdtempSync(join(tmpdir(), "ec-offscreen-"));
  const sessions: FakeSession[] = [];
  const wired = createReceiverWindows({
    BrowserWindow: FakeBrowserWindow as any,
    session: { fromPartition: () => { const s = new FakeSession(); sessions.push(s); return s as any; } },
    ipcMain: new FakeIpcMain() as any,
    preloadDir: dir,
  });
  wired.factory({ bounds: { x: 0, y: 0, width: 800, height: 600 }, onTerminated() {}, onTitle() {}, receiverCreated() {}, receiverReset() {} });
  let answer = true;
  sessions[0]!.permissionRequest!(null, "display-capture", (g) => { answer = g; }, { securityOrigin: "file:///" });
  assert.equal(answer, false);
  wired.dispose();
  rmSync(dir, { recursive: true, force: true });
});

test("OffscreenPresentations makes its host at the first tab, sized from the screen, and disposes it", () => {
  FakeBrowserWindow.all = [];
  const dir = mkdtempSync(join(tmpdir(), "ec-offscreen-"));
  const ipcMain = new FakeIpcMain();
  const offscreen = new OffscreenPresentations({
    BrowserWindow: FakeBrowserWindow as any,
    ipcMain: ipcMain as any,
    channel: "app:offscreen-receiver",
    screen: { getPrimaryDisplay: () => ({ size: { width: 1366, height: 768 }, scaleFactor: 1 }) },
    preloadDir: dir,
  });
  assert.equal(ipcMain.handlers.size, 0, "nothing is claimed until a presentation starts");
  let destroyed = 0;
  const tab = offscreen.openOffscreenTab({ url: URL1, presentationId: "mr_9", onDestroyed: () => destroyed++ });
  assert.deepEqual([...ipcMain.handlers.keys()], ["app:offscreen-receiver"]);
  const win = FakeBrowserWindow.all[0]!;
  assert.deepEqual(win.calls, ["size 1280x720"]);
  assert.equal(tab.webContentsId, win.webContents.id);
  offscreen.dispose();
  assert.equal(win.destroyed, true);
  assert.equal(destroyed, 1);
  assert.equal(ipcMain.handlers.size, 0);
  rmSync(dir, { recursive: true, force: true });
});
