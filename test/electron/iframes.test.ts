// Frames as senders: every frame of a webContents (main frame or iframe) is its own controlling context.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCastManager, type CastManagerOptions, type IpcMainLike } from "../../src/electron/main.ts";
import { MEDIA_NAMESPACE } from "../../src/electron/presentation-envelope.ts";
import { FakeDevices, FakeClient, FakeFrame, FramedWebContents, SPEAKER, TV, tick } from "./fakes.ts";

const MAIN = "https://music.youtube.com/";
const EMBED = "https://embed.example/player";
const URL1 = "https://google.com/cast#__castAppId__=233637DE/__castClientId__=c1/__castAutoJoinPolicy__=origin_scoped";
const YT = "233637DE";

class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  listeners = new Map<string, ((event: any, ...args: any[]) => void)[]>();
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown {
    this.listeners.set(channel, [...(this.listeners.get(channel) ?? []), listener]);
    return this;
  }
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): unknown {
    this.listeners.set(channel, (this.listeners.get(channel) ?? []).filter((l) => l !== listener));
    return this;
  }
}

class FakeDiscovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
}

function setup(over: Partial<CastManagerOptions> = {}) {
  const ipcMain = new FakeIpcMain();
  const clients: FakeClient[] = [];
  const requests: { origin: string; senderId: number }[] = [];
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
    // The main frame gets the TV, anything else the speaker, so the two frames' sessions are on different devices.
    selectDevice: async (devices, request) => {
      requests.push({ origin: request.origin, senderId: request.senderId });
      const wanted = request.origin === "https://music.youtube.com" ? TV.id : SPEAKER.id;
      return devices.find((d) => d.id === wanted) ?? null;
    },
    ...over,
  });
  const pcall = (wc: FramedWebContents, frame: FakeFrame | null, method: string, params: unknown) =>
    Promise.resolve(ipcMain.handlers.get("electron-cast:presentation")!({ sender: wc, senderFrame: frame }, method, params)) as Promise<any>;
  const ccall = (wc: FramedWebContents, frame: FakeFrame | null, method: string, params: unknown) =>
    Promise.resolve(ipcMain.handlers.get("electron-cast:call")!({ sender: wc, senderFrame: frame }, method, params)) as Promise<any>;
  const psend = (wc: FramedWebContents, frame: FakeFrame | null | undefined, connectionId: string, data: unknown) => {
    for (const l of ipcMain.listeners.get("electron-cast:presentation:send") ?? []) l({ sender: wc, senderFrame: frame }, connectionId, data);
  };
  return { ipcMain, clients, requests, manager, pcall, ccall, psend };
}

const clientFor = (clients: FakeClient[], id: string) => clients.find((c) => c.device.id === id)!;

test("two frames of one webContents each get only their own presentation events", async () => {
  const { pcall, requests, manager } = setup();
  const wc = new FramedWebContents(5, MAIN);
  const sub = wc.addFrame(EMBED);

  assert.equal((await pcall(wc, wc.main, "start", { connectionId: "conn-main", urls: [URL1] })).ok, true);
  assert.equal((await pcall(wc, sub, "start", { connectionId: "conn-sub", urls: [URL1] })).ok, true);

  const ids = (f: FakeFrame) => new Set(f.events("presentation").map((e) => e.connectionId));
  assert.deepEqual([...ids(wc.main)], ["conn-main"]);
  assert.deepEqual([...ids(sub)], ["conn-sub"]);
  assert.ok(sub.events("presentation").length > 0 && wc.main.events("presentation").length > 0);

  // each frame is a sender with its own origin, and the main frame keeps the webContents id
  assert.deepEqual(requests.map((r) => r.origin), ["https://music.youtube.com", "https://embed.example"]);
  assert.equal(requests[0]!.senderId, 5);
  assert.notEqual(requests[1]!.senderId, 5);
  await manager.dispose();
});

test("availability watches are per frame", async () => {
  const devices = new FakeDiscovery([]);
  const { pcall, manager } = setup({ discovery: devices });
  const wc = new FramedWebContents(5, MAIN);
  const sub = wc.addFrame(EMBED);
  // the same watchId from the other frame is the other frame's own business, not "in use"
  await pcall(wc, wc.main, "getAvailability", { watchId: "w", urls: [URL1] });
  assert.equal((await pcall(wc, sub, "getAvailability", { watchId: "w", urls: [URL1] })).code, "InvalidAccessError");
  await pcall(wc, sub, "getAvailability", { watchId: "w-sub", urls: [URL1] });
  devices.up(TV);
  await tick();
  assert.deepEqual(wc.main.events("presentation").map((e) => e.watchId), ["w"]);
  assert.deepEqual(sub.events("presentation").map((e) => e.watchId), ["w-sub"]);
  // a frame cannot stop another frame's watch
  await pcall(wc, sub, "stopWatching", { watchId: "w" });
  devices.down(TV);
  await tick();
  assert.equal(wc.main.events("presentation").filter((e) => e.value === false).length, 1);
  await manager.dispose();
});

test("an iframe cannot send to, close or terminate the main frame's connection", async () => {
  const { pcall, psend, clients, manager } = setup();
  const wc = new FramedWebContents(5, MAIN);
  const sub = wc.addFrame(EMBED);
  await pcall(wc, wc.main, "start", { connectionId: "conn-main", urls: [URL1] });
  const tv = clientFor(clients, TV.id);
  const { sessionId } = JSON.parse(wc.main.events("presentation")[1].data).message;
  const seen = wc.main.events("presentation").length;

  assert.deepEqual(await pcall(wc, sub, "close", { connectionId: "conn-main" }), { ok: true, value: undefined });
  assert.deepEqual(await pcall(wc, sub, "terminate", { connectionId: "conn-main" }), { ok: true, value: undefined });
  const msg = JSON.stringify({ type: "app_message", message: { sessionId, namespaceName: "urn:x-cast:com.google.youtube.mdx", message: "evil" }, sequenceNumber: 1, clientId: "c1" });
  psend(wc, sub, "conn-main", msg);
  await tick();
  assert.equal(wc.main.events("presentation").length, seen, "the connection was not closed");
  assert.ok(!tv.calls.some((c) => c.startsWith("stop")));
  assert.ok(!tv.sent.some((s) => s.payload === "evil"));

  // and the owner still can; a send with no senderFrame property is the main frame's
  psend(wc, undefined, "conn-main", msg.replace("evil", "fine"));
  await tick();
  assert.ok(tv.sent.some((s) => s.payload === "fine"));
  await pcall(wc, wc.main, "terminate", { connectionId: "conn-main" });
  await tick();
  assert.ok(tv.calls.some((c) => c.startsWith("stop")));
  await manager.dispose();
});

test("an iframe navigating parks only its own sessions, and the reloaded frame reconnects to them", async () => {
  const { pcall, clients, manager } = setup();
  const wc = new FramedWebContents(5, MAIN);
  let sub = wc.addFrame(EMBED);
  assert.equal((await pcall(wc, wc.main, "start", { connectionId: "conn-main", urls: [URL1] })).ok, true);
  const started = await pcall(wc, sub, "start", { connectionId: "conn-sub", urls: [URL1] });
  assert.equal(started.ok, true);
  const tv = clientFor(clients, TV.id);
  const speaker = clientFor(clients, SPEAKER.id);
  const mainSeen = wc.main.events("presentation").length;

  sub = wc.navigate(sub, "https://embed.example/player2");
  await tick();
  assert.ok(!speaker.closed && !speaker.calls.some((c) => c.startsWith("stop")), "the iframe's session stays open on the device");
  assert.ok(!tv.closed && !tv.calls.some((c) => c.startsWith("stop")));
  assert.equal(wc.main.events("presentation").length, mainSeen, "the main frame's connection was not touched");

  // the main frame still has its connection: a message from the receiver reaches it
  const { transportId } = JSON.parse(wc.main.events("presentation")[1].data).message;
  tv.pushMessage(transportId, "urn:x-cast:com.google.youtube.mdx", "still here");
  await tick();
  assert.ok(wc.main.events("presentation").length > mainSeen);

  // the new document in the same frame is the same sender, so it can reconnect to its parked session
  const again = await pcall(wc, sub, "reconnect", { connectionId: "conn-sub-2", urls: [URL1], presentationId: started.value.id });
  assert.equal(again.ok, true, JSON.stringify(again));
  // the main frame (another sender, another origin) cannot reconnect to the iframe's session
  const stolen = await pcall(wc, wc.main, "reconnect", { connectionId: "conn-x", urls: [URL1], presentationId: started.value.id });
  assert.equal(stolen.ok, false);
  await manager.dispose();
});

test("a removed iframe is noticed and its session ends", async () => {
  const { pcall, clients, manager } = setup();
  const wc = new FramedWebContents(5, MAIN);
  const sub = wc.addFrame(EMBED);
  assert.equal((await pcall(wc, sub, "start", { connectionId: "conn-sub", urls: [URL1] })).ok, true);
  const speaker = clientFor(clients, SPEAKER.id);
  wc.removeFrame(sub);
  // Electron announces no removal; the next navigation event anywhere in the page sweeps removed frames
  wc.emit("did-frame-navigate", {}, MAIN, 200, "OK", false, 999, 999);
  await tick();
  assert.ok(speaker.calls.some((c) => c.startsWith("stop")) || speaker.closed);
  await manager.dispose();
});

test("chrome.cast mode stays main-frame only", async () => {
  const { ccall, manager } = setup();
  const wc = new FramedWebContents(5, MAIN);
  const sub = wc.addFrame(EMBED);
  const init = { appId: YT, capabilities: ["audio_out"], autoJoinPolicy: "origin_scoped" };
  assert.equal((await ccall(wc, sub, "initialize", init)).code, "extension_missing");
  assert.equal((await ccall(wc, wc.main, "initialize", init)).ok, true);
  await manager.dispose();
});

test("a main-frame navigation ends the page's iframes for good and a destroyed webContents ends everything", async () => {
  const { pcall, clients, manager } = setup();
  const wc = new FramedWebContents(5, MAIN);
  const sub = wc.addFrame(EMBED);
  await pcall(wc, sub, "start", { connectionId: "conn-sub", urls: [URL1] });
  const speaker = clientFor(clients, SPEAKER.id);
  const { sessionId } = JSON.parse(sub.events("presentation")[1].data).message;
  wc.navigate(wc.main, "https://music.youtube.com/next");
  await tick();
  assert.ok(speaker.calls.includes(`stop ${sessionId}`) || speaker.closed, "the iframe left with its page");

  const wc2 = new FramedWebContents(6, MAIN);
  const sub2 = wc2.addFrame(EMBED);
  await pcall(wc2, sub2, "start", { connectionId: "c2", urls: [URL1] });
  const n = clients.length;
  wc2.destroy();
  await tick();
  assert.ok(clients.slice(n - 1).every((c) => c.closed || c.calls.some((x) => x.startsWith("stop"))));
  await manager.dispose();
});

test("a subframe the manager cannot identify is refused, and a frame that is gone is ignored", async () => {
  const { pcall, ccall, psend, manager } = setup();
  const wc = new FramedWebContents(5, MAIN);
  const sub = wc.addFrame(EMBED);
  const anonymous = { url: EMBED, origin: "https://embed.example", parent: wc.main };
  assert.equal((await pcall(wc, anonymous as any, "start", { connectionId: "c", urls: [URL1] })).code, "NotAllowedError");
  assert.equal((await ccall(wc, anonymous as any, "initialize", {})).code, "extension_missing");
  assert.equal((await pcall(wc, null, "start", { connectionId: "c", urls: [URL1] })).code, "NotAllowedError");
  await pcall(wc, sub, "start", { connectionId: "conn-sub", urls: [URL1] });
  psend(wc, null, "conn-sub", "{}");  // a null senderFrame is a frame that no longer exists
  await manager.dispose();
});

test("main-frame behaviour is unchanged for a webContents without a frame tree", async () => {
  const { pcall, manager } = setup();
  const sent: unknown[] = [];
  const framed = new FramedWebContents(9, MAIN);
  framed.main.send = (_c: string, p: unknown) => void sent.push(p);
  const wc = Object.create(framed, { mainFrame: { value: undefined } }) as FramedWebContents;
  const r = await pcall(wc, { url: MAIN, origin: "https://music.youtube.com" } as any, "start", { connectionId: "c", urls: [URL1] });
  assert.equal(r.ok, true);
  assert.ok(sent.length > 0);
  await manager.dispose();
});
