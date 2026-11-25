// Chrome's 1-UA mode on a Cast sink, end to end through the manager with a fake device, a fake mirroring service and a
// fake offscreen tab: an https presentation URL is a source of the Cast provider (`CastMediaSource::FromMediaSource`),
// its route is a mirroring route whose tab is an offscreen one (`MirroringActivity`, `kOffscreenTab`), and the page's
// connection is a local presentation connection to that tab (`PresentationFrame::ConnectToPresentation`,
// `LocalPresentationManager`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCastManager, type CastManagerOptions, type IpcMainEventLike, type IpcMainLike } from "../../src/electron/main.ts";
import { presentationUrlForDevice } from "../../src/electron/manager-api.ts";
import { castAppInfosOf, chooseSource } from "../../src/electron/presentation-source.ts";
import type { OffscreenReceiverRequest } from "../../src/electron/wired-display/electron-windows.ts";
import type { ReceiverEnd } from "../../src/electron/wired-display/local-presentation.ts";
import type { MirroringSource } from "../../src/mirroring/routing.ts";
import { FakeDevices, FakeClient, TV, SPEAKER, FAST_SINKS, tick } from "./fakes.ts";

const ORIGIN = "https://controller.example";
const URL_A = "https://slides.example.com/deck?id=1";
const APP_URL = "https://google.com/cast#__castAppId__=233637DE/__castClientId__=c1";

// ---- which source a request is served from ------------------------------------------------------------------------------

test("chooseSource: an https URL is a Cast source only when an offscreen tab can be opened, in URL order", () => {
  assert.equal(chooseSource([URL_A]).kind, "unsupported");
  const only = chooseSource([URL_A], { offscreenTab: true });
  assert.ok(only.kind === "launch" && only.offscreenTab === true && only.url === URL_A);
  assert.deepEqual(only.parsed.appInfos.map((a) => [a.appId, a.requiredCapabilities]), [["0F5096E8", 5], ["85CDB22F", 4]]);
  const first = chooseSource([URL_A, "cast:233637DE"], { offscreenTab: true });
  assert.ok(first.kind === "launch" && first.offscreenTab === true);
  const second = chooseSource(["cast:233637DE", URL_A], { offscreenTab: true });
  assert.ok(second.kind === "launch" && second.offscreenTab === undefined && second.url === "cast:233637DE");
  const withDial = chooseSource([URL_A, "cast-dial:YouTube"], { offscreenTab: true, dial: true });
  assert.ok(withDial.kind === "launch" && withDial.offscreenTab === true && withDial.dial?.app === "YouTube");
  assert.equal(chooseSource(["http://example.com/"], { offscreenTab: true }).kind, "unsupported", "http is no presentation URL off localhost");
  assert.equal(chooseSource(["remote-playback:x", "ftp://x/"], { offscreenTab: true }).kind, "no_sink");
});

test("a Cast sink with a streaming app is a sink of an https URL; a DIAL sink is not", () => {
  assert.equal(castAppInfosOf(URL_A, false), null);
  assert.deepEqual(castAppInfosOf(URL_A, true)!.map((a) => a.appId), ["0F5096E8", "85CDB22F"]);
  assert.equal(presentationUrlForDevice(TV, [URL_A]), null);
  assert.equal(presentationUrlForDevice(TV, [URL_A], undefined, undefined, true), URL_A);
  assert.equal(presentationUrlForDevice(SPEAKER, [URL_A], undefined, undefined, true), URL_A, "audio only: the audio streaming app");
  assert.equal(presentationUrlForDevice(TV, [URL_A], (_d, app) => app === "85CDB22F", undefined, true), URL_A);
  assert.equal(presentationUrlForDevice(TV, [URL_A], () => false, undefined, true), null, "the app must be available when that is asked");
  assert.equal(presentationUrlForDevice({ ...TV, dial: { appUrl: "http://10.0.0.9/apps" } } as typeof TV, [URL_A], undefined, () => true, true), null);
});

// ---- the wiring ---------------------------------------------------------------------------------------------------------

type Listener = (event: IpcMainEventLike, ...args: any[]) => void;
class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  listeners = new Map<string, Listener[]>();
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
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
  constructor(id: number) {
    super();
    this.id = id;
  }
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload: JSON.parse(JSON.stringify(payload)) });
  }
  isDestroyed(): boolean {
    return false;
  }
  events(connectionId: string): any[] {
    return this.sent.filter((s) => s.channel === "electron-cast:presentation:event" && s.payload.connectionId === connectionId).map((s) => s.payload);
  }
  states(connectionId: string): string[] {
    return this.events(connectionId).filter((e) => e.type === "statechange").map((e) => e.state);
  }
}

class FakeDiscovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
}

/** An offscreen tab whose page the test plays. */
class FakeTab {
  static nextId = 500;
  readonly webContentsId = FakeTab.nextId++;
  readonly request: OffscreenReceiverRequest;
  destroyed = false;
  ends: ReceiverEnd[] = [];
  received: unknown[] = [];
  constructor(request: OffscreenReceiverRequest) {
    this.request = request;
  }
  /** The page uses `navigator.presentation.receiver`. */
  register(): void {
    this.request.receiverCreated({ id: this.request.presentationId, url: this.request.url }, (end) => {
      this.ends.push(end);
      end.onmessage = (data) => this.received.push(data);
    });
  }
  /** `OffscreenTab` is destroyed, by its owner or by itself (window.close(), a navigation, capture ended). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.request.receiverReset(this.request.presentationId);
    this.request.onDestroyed();
  }
}

function setup(over: Partial<CastManagerOptions> = {}) {
  const ipcMain = new FakeIpcMain();
  const devices = new FakeDiscovery();
  const clients: FakeClient[] = [];
  const tabs: FakeTab[] = [];
  const sources: MirroringSource[] = [];
  const order: string[] = [];
  let stops = 0;
  const manager = createCastManager({
    sinks: FAST_SINKS,
    ipcMain,
    discovery: devices,
    createClient: (d) => {
      const c = new FakeClient(d);
      clients.push(c);
      return c;
    },
    selectDevice: async (list) => list.find((d) => d.id === TV.id) ?? null,
    mirroring: {
      createService: (_params, _observer, _channel, source) => {
        sources.push({ ...source });
        order.push("service");
        return { onMessage() {}, stop: () => void stops++ };
      },
      openOffscreenTab: (request) => {
        const tab = new FakeTab(request);
        tabs.push(tab);
        order.push("tab");
        return tab;
      },
    },
    ...over,
  });
  const frame = { url: `${ORIGIN}/`, origin: ORIGIN };
  const pcall = (wc: FakeWebContents, method: string, params: any) =>
    Promise.resolve(ipcMain.handlers.get("electron-cast:presentation")!({ sender: wc, senderFrame: frame }, method, params)) as Promise<any>;
  const psend = (wc: FakeWebContents, connectionId: string, data: unknown) => {
    for (const l of ipcMain.listeners.get("electron-cast:presentation:send") ?? []) l({ sender: wc, senderFrame: frame } as any, connectionId, data);
  };
  const launches = () => clients.flatMap((c) => c.calls.filter((x) => x.startsWith("launch ")));
  const idle = async (until: () => boolean) => {
    for (let i = 0; i < 40 && !until(); i++) await tick();
  };
  return { manager, pcall, psend, tabs, sources, order, launches, idle, stops: () => stops };
}

test("an https URL is available on a Cast sink and starts as a mirrored offscreen tab", async () => {
  const { manager, pcall, tabs, sources, order, launches } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  const watch = await pcall(wc, "getAvailability", { watchId: "w1", urls: [URL_A] });
  assert.deepEqual(watch, { ok: true, value: { available: true } });

  const started = await pcall(wc, "start", { connectionId: "c1", urls: [URL_A], hasGesture: true });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.ok(started.value.id.startsWith("mr_"), "MediaRouterBase::CreatePresentationId");
  assert.deepEqual({ url: started.value.url, state: started.value.state, local: started.value.local }, { url: URL_A, state: "connecting", local: true });
  assert.deepEqual(launches(), ["launch 0F5096E8"], "the streaming app, as for tab mirroring");
  assert.equal(tabs.length, 1);
  assert.deepEqual({ url: tabs[0]!.request.url, id: tabs[0]!.request.presentationId, size: tabs[0]!.request.size },
    { url: URL_A, id: started.value.id, size: { width: 1920, height: 1080 } });
  assert.deepEqual(order, ["tab", "service"], "the tab is opened with the activity, before the session starts");
  assert.deepEqual({ id: sources[0]!.id, type: sources[0]!.type, tabId: sources[0]!.tabId },
    { id: URL_A, type: "offscreen_tab", tabId: tabs[0]!.webContentsId }, "the session captures the offscreen tab, not the page");

  const routes = manager.getRoutes();
  assert.equal(routes.length, 1);
  assert.deepEqual(
    { source: routes[0]!.mediaSource, description: routes[0]!.description, members: routes[0]!.members, sink: routes[0]!.sinkId, local: routes[0]!.isLocal },
    { source: URL_A, description: "Presenting (slides.example.com)", members: [7], sink: TV.id, local: true },
  );
  assert.equal(routes[0]!.id, `urn:x-org.chromium:media:route:${started.value.id}/${TV.id}/${URL_A}`);
  await manager.dispose();
  assert.equal(tabs[0]!.destroyed, true);
});

test("the connection connects when the tab's page uses the receiver API, and carries messages both ways", async () => {
  const { manager, pcall, psend, tabs, idle } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  const started = await pcall(wc, "start", { connectionId: "c1", urls: [URL_A], hasGesture: true });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.deepEqual(wc.states("c1"), [], "connecting until there is a receiver");
  const tab = tabs[0]!;
  tab.register();
  await idle(() => wc.states("c1").length > 0);
  assert.deepEqual(wc.states("c1"), ["connected"]);
  assert.equal(tab.ends.length, 1);
  assert.deepEqual({ id: tab.ends[0]!.id, url: tab.ends[0]!.url }, { id: started.value.id, url: URL_A });

  psend(wc, "c1", "hello tab");
  await idle(() => tab.received.length > 0);
  assert.deepEqual(tab.received, ["hello tab"]);
  tab.ends[0]!.send("hello page");
  await idle(() => wc.events("c1").some((e) => e.type === "message"));
  assert.deepEqual(wc.events("c1").filter((e) => e.type === "message").map((e) => e.data), ["hello page"]);
  await manager.dispose();
});

test("terminate() from the page ends the route, the session and the tab", async () => {
  const { manager, pcall, tabs, idle, stops } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  await pcall(wc, "start", { connectionId: "c1", urls: [URL_A], hasGesture: true });
  tabs[0]!.register();
  await idle(() => wc.states("c1").length > 0);
  await pcall(wc, "terminate", { connectionId: "c1" });
  await idle(() => manager.getRoutes().length === 0);
  assert.deepEqual(manager.getRoutes(), []);
  assert.equal(stops(), 1);
  assert.equal(tabs[0]!.destroyed, true, "the host owns the tab: it goes with the activity");
  assert.equal(wc.states("c1").at(-1), "terminated");
  await manager.dispose();
});

test("the tab going away ends the route and terminates the page's connection (WebContentsDestroyed)", async () => {
  const { manager, pcall, tabs, idle, stops } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  await pcall(wc, "start", { connectionId: "c1", urls: [URL_A], hasGesture: true });
  tabs[0]!.register();
  await idle(() => wc.states("c1").length > 0);
  tabs[0]!.destroy();
  await idle(() => manager.getRoutes().length === 0);
  assert.deepEqual(manager.getRoutes(), []);
  assert.equal(stops(), 1);
  assert.equal(wc.states("c1").at(-1), "terminated");
  await manager.dispose();
});

test("the receiver's terminate() ends the presentation; its close() only closes the connection", async () => {
  const { manager, pcall, tabs, idle } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  await pcall(wc, "start", { connectionId: "c1", urls: [URL_A], hasGesture: true });
  const tab = tabs[0]!;
  tab.register();
  await idle(() => tab.ends.length > 0);
  tab.ends[0]!.close();
  await idle(() => wc.states("c1").includes("closed"));
  assert.equal(wc.states("c1").at(-1), "closed");
  assert.equal(manager.getRoutes().length, 1, "the route lives on");
  assert.equal(tab.destroyed, false);

  // the page joins it again, by id (ReconnectPresentation of a local presentation)
  const id = manager.getRoutes()[0]!.id.split(":route:")[1]!.split("/")[0]!;
  const again = await pcall(wc, "reconnect", { connectionId: "c2", urls: [URL_A], presentationId: id });
  assert.equal(again.ok, true, JSON.stringify(again));
  await idle(() => tab.ends.length > 1);
  tab.ends[1]!.terminate();
  await idle(() => manager.getRoutes().length === 0);
  assert.deepEqual(manager.getRoutes(), []);
  assert.equal(tab.destroyed, true);
  assert.equal(wc.states("c2").at(-1), "terminated");
  await manager.dispose();
});

test("close() from the page keeps the route; another page reconnects by id and URL only", async () => {
  const { manager, pcall, psend, tabs, idle } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  const other = new FakeWebContents(8);
  const started = await pcall(wc, "start", { connectionId: "c1", urls: [URL_A], hasGesture: true });
  tabs[0]!.register();
  await idle(() => wc.states("c1").length > 0);
  await pcall(wc, "close", { connectionId: "c1" });
  await idle(() => wc.states("c1").includes("closed"));
  assert.equal(manager.getRoutes().length, 1);
  assert.equal(tabs[0]!.destroyed, false);

  const wrongUrl = await pcall(other, "reconnect", { connectionId: "k0", urls: ["https://other.example/"], presentationId: started.value.id });
  assert.deepEqual({ ok: wrongUrl.ok, code: wrongUrl.code }, { ok: false, code: "NotFoundError" });
  const wrongId = await pcall(other, "reconnect", { connectionId: "k1", urls: [URL_A], presentationId: "mr_nothing" });
  assert.deepEqual({ ok: wrongId.ok, code: wrongId.code }, { ok: false, code: "NotFoundError" });
  const joined = await pcall(other, "reconnect", { connectionId: "k2", urls: [URL_A], presentationId: started.value.id });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  // the receiver is ready, so the controller is delivered to it at once: the connection is not returned connecting
  assert.deepEqual(joined.value, { id: started.value.id, url: URL_A, local: true });
  assert.equal(tabs[0]!.ends.length, 2);
  psend(other, "k2", "from the second page");
  await idle(() => tabs[0]!.received.length > 0);
  assert.deepEqual(tabs[0]!.received, ["from the second page"]);
  await manager.dispose();
});

test("a second presentation from the same page ends its first (routes_by_frame_), and a Cast app launch ends it too", async () => {
  const { manager, pcall, tabs, idle, launches } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  await pcall(wc, "start", { connectionId: "c1", urls: [URL_A], hasGesture: true });
  const second = await pcall(wc, "start", { connectionId: "c2", urls: ["https://slides.example.com/other"], hasGesture: true });
  assert.equal(second.ok, true, JSON.stringify(second));
  await idle(() => tabs[0]!.destroyed);
  assert.equal(tabs[0]!.destroyed, true);
  assert.equal(tabs[1]!.destroyed, false);
  assert.deepEqual(manager.getRoutes().map((r) => r.mediaSource), ["https://slides.example.com/other"]);
  assert.equal(wc.states("c1").at(-1), "terminated");

  const app = await pcall(wc, "start", { connectionId: "c3", urls: [APP_URL], hasGesture: true });
  assert.equal(app.ok, true, JSON.stringify(app));
  await idle(() => tabs[1]!.destroyed);
  assert.equal(tabs[1]!.destroyed, true);
  assert.equal(launches().at(-1), "launch 233637DE");
  await manager.dispose();
});

test("a tab that cannot be opened fails the start and leaves no route", async () => {
  const { manager, pcall } = setup({
    mirroring: {
      createService: () => ({ onMessage() {}, stop() {} }),
      openOffscreenTab: () => {
        throw new Error("no window");
      },
    },
  });
  await manager.settled();
  const wc = new FakeWebContents(7);
  const started = await pcall(wc, "start", { connectionId: "c1", urls: [URL_A], hasGesture: true });
  assert.deepEqual({ ok: started.ok, code: started.code }, { ok: false, code: "OperationError" });
  assert.deepEqual(manager.getRoutes(), []);
  await manager.dispose();
});

test("without an offscreen tab an https URL stays unsupported and unavailable", async () => {
  const { manager, pcall } = setup({ mirroring: { createService: () => ({ onMessage() {}, stop() {} }) } });
  await manager.settled();
  const wc = new FakeWebContents(7);
  assert.deepEqual(await pcall(wc, "getAvailability", { watchId: "w1", urls: [URL_A] }), { ok: true, value: { available: false } });
  const started = await pcall(wc, "start", { connectionId: "c1", urls: [URL_A], hasGesture: true });
  assert.deepEqual({ ok: started.ok, code: started.code }, { ok: false, code: "NotSupportedError" });
  await manager.dispose();
});

test("the dialog's sinks for a default request with an https URL include the Cast sinks, and the sink starts it", async () => {
  const { manager, pcall, tabs, idle } = setup();
  await manager.settled();
  const wc = new FakeWebContents(7);
  assert.equal((await pcall(wc, "setDefaultRequest", { urls: [URL_A] })).ok, true);
  let sinks: string[] = [];
  const stop = manager.registerMediaSinksObserver({ onSinksUpdated: (list) => { sinks = list.map((s) => s.id); } }, { presentationUrls: [URL_A], origin: ORIGIN });
  await idle(() => sinks.includes(TV.id));
  assert.ok(sinks.includes(TV.id), JSON.stringify(sinks));
  stop();
  const route = await manager.startCasting(TV.id, { castMode: "presentation", webContentsId: 7 });
  assert.equal(route.mediaSource, URL_A);
  assert.equal(route.description, "Presenting (slides.example.com)");
  assert.equal(tabs.length, 1);
  await manager.dispose();
});
