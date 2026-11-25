// A page's default presentation request and casting it from the app's own UI (Chrome: WebContentsPresentationManager,
// MediaRouterUI::StartCasting with MediaCastMode::PRESENTATION). See docs/MAIN-API.md.
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  MediaRouteError, createCastManager, type CastManagerOptions, type IpcMainEventLike, type IpcMainLike, type MediaRoute,
  type PresentationRequest,
} from "../../src/electron/main.ts";
import { MEDIA_NAMESPACE } from "../../src/electron/presentation-envelope.ts";
import { FakeDevices, FakeClient, SPEAKER, TV, FAST_SINKS, device } from "./fakes.ts";

const ORIGIN = "https://music.youtube.com";
const URL1 = "https://google.com/cast#__castAppId__=233637DE/__castClientId__=c1";
const URL3 = "https://google.com/cast#__castAppId__=ABCD1234/__castClientId__=c4";
const URL2 = "https://google.com/cast#__castAppId__=CC1AD845/__castClientId__=c2";
// needs video_out, which the speaker lacks
const URL_VIDEO = "https://google.com/cast#__castAppId__=233637DE(video_out)/__castClientId__=c3";

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
  events(): any[] {
    return this.sent.filter((s) => s.channel === "electron-cast:presentation:event").map((s) => s.payload);
  }
}

class FakeDiscovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
}

function setup(over: Partial<CastManagerOptions> = {}, clientSetup: (c: FakeClient) => void = () => {}) {
  const ipcMain = new FakeIpcMain();
  const devices = new FakeDiscovery();
  const clients: FakeClient[] = [];
  const picked: unknown[] = [];
  const manager = createCastManager({
    sinks: FAST_SINKS,
    ipcMain,
    discovery: devices,
    createClient: (d) => {
      const c = new FakeClient(d);
      const launch = c.launch.bind(c);
      c.launch = async (id: string) => {
        const app = await launch(id);
        app.namespaces.push({ name: MEDIA_NAMESPACE });
        return app;
      };
      clientSetup(c);
      clients.push(c);
      return c;
    },
    selectDevice: async (list, request) => {
      picked.push(request);
      return list.find((d) => d.id === TV.id) ?? null;
    },
    ...over,
  });
  const main = { url: `${ORIGIN}/`, origin: ORIGIN };
  const pcall = (wc: FakeWebContents, method: string, params: any, frame: unknown = main) =>
    Promise.resolve(ipcMain.handlers.get("electron-cast:presentation")!({ sender: wc, senderFrame: frame }, method, params)) as Promise<any>;
  // The devices are sinks only once their channels are open (a moment after discovery), so a test that sets a default
  // request and casts waits for that first
  const setDefault = async (wc: FakeWebContents, urls: string[], frame: unknown = main) => {
    await manager.settled();
    return pcall(wc, "setDefaultRequest", { urls }, frame);
  };
  // the clients that launched something (others only asked GET_APP_AVAILABILITY)
  const launchers = () => clients.filter((c) => c.calls.some((x) => x.startsWith("launch ")));
  return { ipcMain, clients, launchers, picked, manager, devices, pcall, setDefault };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof MediaRouteError, String(err));
    return err.code;
  }
  return "resolved";
}

test("setDefaultRequest is tracked per window and observers hear each real change", async () => {
  const { manager, setDefault } = setup();
  const wc = new FakeWebContents(5);
  assert.equal(manager.hasDefaultPresentationRequest(5), false);
  assert.equal(manager.getDefaultPresentationRequest(5), null);
  const seen: Array<PresentationRequest | null> = [];
  const stop = manager.addPresentationObserver(5, { onDefaultPresentationChanged: (r) => seen.push(r) });
  assert.deepEqual(seen, [], "not called on registration, like Chrome's PresentationObserver");

  assert.deepEqual(await setDefault(wc, [URL1]), { ok: true, value: undefined });
  assert.equal(manager.hasDefaultPresentationRequest(5), true);
  assert.deepEqual(manager.getDefaultPresentationRequest(5), { webContentsId: 5, presentationUrls: [URL1], frameOrigin: ORIGIN });
  await setDefault(wc, [URL1]);
  assert.equal(seen.length, 1, "the same URLs again change nothing");
  await setDefault(wc, [URL2, URL1]);
  assert.equal(seen.length, 2);
  assert.deepEqual((seen[1] as unknown as PresentationRequest).presentationUrls, [URL2, URL1]);
  await setDefault(wc, []);
  assert.equal(seen.at(-1), null);
  assert.equal(manager.hasDefaultPresentationRequest(5), false);
  await setDefault(wc, []);
  assert.equal(seen.length, 3, "clearing nothing is not a change");

  stop();
  await setDefault(wc, [URL1]);
  assert.equal(seen.length, 3, "an unregistered observer hears nothing");
  assert.equal(manager.hasDefaultPresentationRequest(6), false, "another window is unaffected");
});

test("only the main frame can own the default request, and a bad payload is refused", async () => {
  const { manager, setDefault, pcall } = setup();
  const wc = new FakeWebContents(5);
  const sub = { url: "https://ads.example/", origin: "https://ads.example", parent: {}, frameTreeNodeId: 9 };
  assert.deepEqual(await setDefault(wc, [URL1], sub), { ok: true, value: undefined });
  assert.equal(manager.hasDefaultPresentationRequest(5), false, "PresentationServiceImpl ignores a frame that is not outermost");
  assert.equal((await pcall(wc, "setDefaultRequest", { urls: "x" })).code, "InvalidAccessError");
  assert.equal((await pcall(wc, "setDefaultRequest", { urls: [1] })).code, "InvalidAccessError");
  assert.equal(manager.hasDefaultPresentationRequest(5), false);
});

test("the default request goes with a navigation or a destroyed window", async () => {
  const { manager, setDefault } = setup();
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const seen: unknown[] = [];
  manager.addPresentationObserver(5, { onDefaultPresentationChanged: (r) => seen.push(r) });
  wc.emit("did-navigate");
  assert.equal(manager.hasDefaultPresentationRequest(5), false);
  assert.deepEqual(seen, [null]);
  await setDefault(wc, [URL1]);
  wc.destroy();
  assert.equal(manager.hasDefaultPresentationRequest(5), false);
});

test("sinks can be asked for by presentation URL", async () => {
  const { manager } = setup();
  const ids = async (urls: string[]) => {
    let got: string[] = [];
    const stop = manager.registerMediaSinksObserver({ onSinksUpdated: (s) => { got = s.map((x) => x.id); } }, { presentationUrls: urls });
    await new Promise((r) => setTimeout(r, 30));  // the devices are asked whether they have the app
    stop();
    return got;
  };
  assert.deepEqual(await ids([URL1]), ["dev-tv", "dev-speaker", "dev-group"]);
  assert.deepEqual(await ids([URL_VIDEO]), ["dev-tv"]);
  assert.deepEqual(await ids(["https://example.test/"]), []);
  assert.deepEqual(await ids(["https://example.test/", URL_VIDEO]), ["dev-tv"]);
});

test("startCasting starts the default request on the sink: the page gets connectionavailable, the route is listed", async () => {
  const { manager, setDefault, clients, launchers, picked, pcall } = setup();
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const routeLists: MediaRoute[][] = [];
  manager.registerMediaRoutesObserver({ onRoutesUpdated: (r) => routeLists.push(r) });

  const route = await manager.startCasting(TV.id, { webContentsId: 5 });
  assert.equal(picked.length, 0, "the app chose the sink: no selectDevice, and no user gesture was needed");
  assert.equal(launchers().length, 1);
  assert.ok(launchers()[0]!.calls.includes("launch 233637DE"));
  assert.ok(clients.some((c) => c.calls.includes("availability 233637DE")), "the device was asked whether it has the app");
  assert.equal(route.sinkId, TV.id);
  assert.equal(route.appId, "233637DE");
  assert.equal(route.origin, ORIGIN);
  assert.deepEqual(route.members, [5]);
  assert.ok(routeLists.at(-1)?.some((r) => r.id === route.id), "routes observers see it like any other route");
  assert.deepEqual(manager.getRoutes().map((r) => r.id), [route.id]);

  const events = wc.events();
  assert.equal(events[0].type, "connectionavailable", "the connection is announced before its first message");
  assert.equal(events[0].id, `cast-session_${route.id}`);
  assert.equal(events[0].url, URL1);
  const cid = events[0].connectionId;
  const messages = events.slice(1);
  assert.ok(messages.length >= 2 && messages.every((e) => e.type === "message" && e.connectionId === cid));
  assert.deepEqual(messages.slice(0, 2).map((e) => JSON.parse(e.data).type), ["receiver_action", "new_session"]);

  // it is a normal connection: the page can terminate it, which stops the app on the device
  assert.deepEqual(await pcall(wc, "terminate", { connectionId: cid }), { ok: true, value: undefined });
  assert.ok(launchers()[0]!.calls.some((c) => c === `stop ${route.id}`), String(launchers()[0]!.calls));
  assert.deepEqual(wc.events().at(-1), { type: "statechange", connectionId: cid, state: "terminated" });
});

test("startCasting tries the request's URLs in order for the sink", async () => {
  const { manager, setDefault } = setup();
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL_VIDEO, URL2]);
  const route = await manager.startCasting(SPEAKER.id, { webContentsId: 5 });
  assert.equal(route.appId, "CC1AD845", "the speaker has no video_out, so the second URL is its source");
  assert.equal(wc.events()[0].url, URL2);
});

test("a default request with no usable sink cannot be cast (unable_to_cast), as CreateRouteParameters finds no source", async () => {
  const { manager, setDefault } = setup();
  const wc = new FakeWebContents(5);
  assert.equal(await codeOf(manager.startCasting(TV.id, { webContentsId: 5 })), "unable_to_cast", "no default request");
  await setDefault(wc, [URL_VIDEO]);
  assert.equal(await codeOf(manager.startCasting(SPEAKER.id, { webContentsId: 5 })), "unable_to_cast", "the speaker cannot run a video_out app");
  assert.equal(await codeOf(manager.startCasting("nope", { webContentsId: 5 })), "unable_to_cast", "unknown sink");
  await setDefault(wc, ["https://example.test/"]);
  assert.equal(await codeOf(manager.startCasting(TV.id, { webContentsId: 5 })), "unable_to_cast", "not a Cast URL");
  // a cast mode Chrome's MediaCastMode does not have is an argument error; TAB_MIRROR is one, which without the
  // mirroring option has no route to start
  await assert.rejects(manager.startCasting(TV.id, { webContentsId: 5, castMode: "remote_playback" as any }), RangeError);
  assert.equal(await codeOf(manager.startCasting(TV.id, { webContentsId: 5, castMode: "tab_mirror" })), "unable_to_cast", "mirroring is off");
  await assert.rejects(manager.startCasting(TV.id, {} as any), TypeError);
  await assert.rejects(manager.startCasting(5 as any, { webContentsId: 5 }), TypeError);
  const off = setup({ presentation: false });
  assert.equal(await codeOf(off.manager.startCasting(TV.id, { webContentsId: 5 })), "unable_to_cast");
});

test("startCasting reports Chrome's RouteRequestResultCode when the start fails", async () => {
  // the device said it has the app, then its channel failed and cannot be reopened: the sink stays listed while it is
  // retried (as in Chrome), but there is no channel to launch on
  let tvClients = 0;
  const unreachable = setup({}, (c) => { if (c.device.id === TV.id && tvClients++ > 0) c.connectError = new Error("no route to host"); });
  const wc = new FakeWebContents(5);
  await unreachable.setDefault(wc, [URL1]);
  const stopWatching = unreachable.manager.registerMediaSinksObserver({ onSinksUpdated: () => {} }, { presentationUrls: [URL1] });
  for (let i = 0; i < 50 && !unreachable.clients.some((c) => c.calls.includes("availability 233637DE") && c.device.id === TV.id); i++) {
    await new Promise((r) => setTimeout(r, 2));
  }
  await new Promise((r) => setTimeout(r, 5));
  stopWatching();
  unreachable.clients.find((c) => c.device.id === TV.id)!.fail();
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(unreachable.manager.devices().some((d) => d.id === TV.id), "still listed while its channel is reopened");
  assert.equal(await codeOf(unreachable.manager.startCasting(TV.id, { webContentsId: 5 })), "sink_not_found");

  const refuses = setup({}, (c) => { c.launchError = new Error("launch refused"); });
  await refuses.setDefault(wc, [URL1]);
  assert.equal(await codeOf(refuses.manager.startCasting(TV.id, { webContentsId: 5 })), "unknown_error");
  assert.equal(refuses.manager.getRoutes().length, 0);

  const wrongOrigin = setup({ allowOrigin: () => false });
  await wrongOrigin.setDefault(wc, [URL1]);
  assert.equal(await codeOf(wrongOrigin.manager.startCasting(TV.id, { webContentsId: 5 })), "invalid_origin");
});

test("a second start while one is pending is a redundant request", async () => {
  const { manager, setDefault } = setup();
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const first = manager.startCasting(TV.id, { webContentsId: 5 });
  assert.equal(await codeOf(manager.startCasting(TV.id, { webContentsId: 5 })), "redundant_request");
  await first;
});

test("a navigation during the start cancels it", async () => {
  const { manager, setDefault } = setup();
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const started = manager.startCasting(TV.id, { webContentsId: 5 });
  wc.emit("did-navigate");
  assert.equal(await codeOf(started), "cancelled");
  assert.ok(!wc.events().some((e) => e.type === "connectionavailable"));
});

test("a sink is offered for a presentation URL only when the device says it has the app (GET_APP_AVAILABILITY)", async () => {
  const { manager, setDefault, clients } = setup({}, (c) => { c.availableApps = c.device.id === TV.id ? ["233637DE"] : ["CC1AD845"]; });
  let ids: string[] = [];
  manager.registerMediaSinksObserver({ onSinksUpdated: (s) => { ids = s.map((x) => x.id); } }, { presentationUrls: [URL1] });
  for (let i = 0; i < 50 && ids.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(ids, ["dev-tv"], "the speaker and the group do not have 233637DE");
  assert.ok(clients.every((c) => c.calls.filter((x) => x.startsWith("availability")).length <= 1), "each device is asked once");

  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  assert.equal(await codeOf(manager.startCasting(SPEAKER.id, { webContentsId: 5 })), "unable_to_cast");
  await setDefault(wc, [URL1, URL2]);
  const route = await manager.startCasting(SPEAKER.id, { webContentsId: 5 });
  assert.equal(route.appId, "CC1AD845", "the first URL whose app the sink has");
});

test("a device that cannot be asked is unknown, not unavailable: not retried at every change, asked again when casting", async () => {
  // the channel is open, but the first GET_APP_AVAILABILITY gets no answer (Chrome: kUnknown)
  let failed = false;
  const { manager, setDefault, clients, devices } = setup({}, (c) => {
    if (c.device.id !== TV.id) return;
    const ask = c.getAppAvailability.bind(c);
    c.getAppAvailability = async (ids: string[]) => {
      if (!failed) {
        failed = true;
        c.calls.push(`availability ${ids.join(",")}`);
        throw new Error("no answer");
      }
      return ask(ids);
    };
  });
  await manager.settled();
  let ids: string[] = ["x"];
  manager.registerMediaSinksObserver({ onSinksUpdated: (s) => { ids = s.map((x) => x.id); } }, { presentationUrls: [URL1] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ids.includes(TV.id), false, "no answer, no sink");
  const tv = clients.find((c) => c.device.id === TV.id)!;
  const asked = tv.calls.filter((x) => x.startsWith("availability")).length;
  assert.equal(asked, 1);
  devices.up(device({ id: "dev-new", host: "10.0.0.40", addresses: ["10.0.0.40"] }));
  await manager.settled();
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(ids.includes("dev-new"), "the list changed");
  assert.equal(tv.calls.filter((x) => x.startsWith("availability")).length, asked, "a change of the list does not retry within the refresh threshold (no storm)");
  await setDefault(new FakeWebContents(5), [URL1]);
  // kUnknown is always asked again (ShouldRefreshAppAvailability), and this time the device answers
  const route = await manager.startCasting(TV.id, { webContentsId: 5 });
  assert.equal(route.sinkId, TV.id);
});

test("an unavailable answer stands for a minute, then the device is asked again (kRefreshThreshold)", async () => {
  mock.timers.enable({ apis: ["Date"] });
  try {
    const { manager, setDefault, clients } = setup({}, (c) => { c.availableApps = []; });
    await setDefault(new FakeWebContents(5), [URL1]);
    assert.equal(await codeOf(manager.startCasting(TV.id, { webContentsId: 5 })), "unable_to_cast");
    // the app is installed meanwhile; the device's kept-open channel answers the next question
    for (const c of clients) c.availableApps = null;
    mock.timers.tick(59_000);
    assert.equal(await codeOf(manager.startCasting(TV.id, { webContentsId: 5 })), "unable_to_cast", "still the earlier answer");
    mock.timers.tick(2_000);
    assert.equal((await manager.startCasting(TV.id, { webContentsId: 5 })).sinkId, TV.id, "asked again after 60 s");
  } finally {
    mock.timers.reset();
  }
});

test("an availability answer that was in flight when the device's channel was replaced is dropped", async () => {
  // the first channel's answer ("unavailable") arrives only after the channel failed and a new one opened; the test
  // holds it back itself, so no timing decides the order
  let stale = true;
  let asked!: () => void;
  const wasAsked = new Promise<void>((r) => { asked = r; });
  let answer: (() => void) | undefined;
  const { manager, setDefault, clients } = setup({}, (c) => {
    if (c.device.id !== TV.id || !stale) return;
    c.getAppAvailability = async (ids: string[]) => {
      c.calls.push(`availability ${ids.join(",")}`);
      asked();
      await new Promise<void>((r) => { answer = r; });
      return Object.fromEntries(ids.map((id) => [id, false]));
    };
  });
  await setDefault(new FakeWebContents(5), [URL1]);
  // its rejection is handled from the start: it comes as soon as the held answer is let through
  const first = codeOf(manager.startCasting(TV.id, { webContentsId: 5 }));
  await wasAsked;
  stale = false;
  clients.find((c) => c.device.id === TV.id)!.fail();
  await manager.settled();
  assert.equal(clients.filter((c) => c.device.id === TV.id).length, 2, "the channel was reopened");
  assert.ok(answer !== undefined);
  answer();
  assert.equal(await first, "unable_to_cast");
  // had the stale "unavailable" been remembered, this would stay refused for a minute
  assert.equal((await manager.startCasting(TV.id, { webContentsId: 5 })).sinkId, TV.id);
});

test("a request replaced or a page navigated while the device is asked cancels the start, and nothing is launched", async () => {
  const { manager, setDefault, launchers } = setup({}, (c) => { c.availabilityDelayMs = 40; });
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const replaced = manager.startCasting(TV.id, { webContentsId: 5 });
  await new Promise((r) => setTimeout(r, 10));
  await setDefault(wc, [URL2]);
  assert.equal(await codeOf(replaced), "cancelled");
  wc.emit("did-navigate");
  await setDefault(wc, [URL3]);
  const navigated = manager.startCasting(TV.id, { webContentsId: 5 });
  await new Promise((r) => setTimeout(r, 10));
  wc.emit("did-navigate");
  await setDefault(wc, [URL3]);  // the new page asks for the same URLs
  assert.equal(await codeOf(navigated), "cancelled", "a request of the new page is not the one that was started");
  assert.equal(launchers().length, 0);
  assert.ok(!wc.events().some((e) => e.type === "connectionavailable" || e.type === "message"));
});

test("a declined connection (request replaced mid-launch) is not wired to the page: no traffic reaches it", async () => {
  const { manager, setDefault, launchers, pcall } = setup({}, (c) => { c.launchDelayMs = 40; });
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const started = manager.startCasting(TV.id, { webContentsId: 5 });
  await new Promise((r) => setTimeout(r, 15));
  await setDefault(wc, [URL2]);
  const route = await started;
  const sent = wc.events().length;
  launchers()[0]!.pushMessage(`${TV.id}-transport-1`, "urn:x-cast:com.google.youtube.mdx", "late");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(wc.events().length, sent, "no event of the declined connection reaches the page");
  assert.equal(wc.events().filter((e) => e.type === "connectionavailable" || e.type === "message").length, 0);
  assert.ok(manager.getRoutes().some((r) => r.id === route.id), "the route stays, as Chrome's does");
  // and the page cannot drive it: its close is ignored
  assert.deepEqual(await pcall(wc, "close", { connectionId: "whatever" }), { ok: true, value: undefined });
});

test("observers of a destroyed window hear the final null and are then forgotten", async () => {
  const { manager, setDefault } = setup();
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const seen: unknown[] = [];
  manager.addPresentationObserver(5, { onDefaultPresentationChanged: (r) => seen.push(r) });
  wc.destroy();
  assert.deepEqual(seen, [null]);
  await setDefault(new FakeWebContents(5), [URL2]);
  assert.deepEqual(seen, [null], "an observer registered for a window that is gone is not kept for its id");
});

test("startCasting launches anew on a sink that has a route, and stops the route its window launched before", async () => {
  const { manager, setDefault, launchers } = setup();
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const first = await manager.startCasting(TV.id, { webContentsId: 5 });
  const second = await manager.startCasting(TV.id, { webContentsId: 5 });
  assert.notEqual(second.id, first.id, "CastActivityManager::LaunchSession launches a new session, it does not reuse");
  const calls = launchers().flatMap((c) => c.calls);
  assert.equal(calls.filter((c) => c === "launch 233637DE").length, 2);
  assert.ok(calls.includes(`stop ${first.id}`), "DoLaunchSession stops the frame's earlier route");
  assert.ok(!manager.getRoutes().some((r) => r.id === first.id));
});

test("the launch time limit is the URL's __castLaunchTimeout__ (CastMediaSource), not the dialog's 20 s", async () => {
  const slow = (c: FakeClient) => { c.launchDelayMs = 200; };
  const { manager, setDefault } = setup({}, slow);
  await setDefault(new FakeWebContents(5), [`${URL1}/__castLaunchTimeout__=30`]);
  assert.equal(await codeOf(manager.startCasting(TV.id, { webContentsId: 5 })), "timed_out");
});
