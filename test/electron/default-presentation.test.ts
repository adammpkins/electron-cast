// A page's default presentation request and casting it from the app's own UI (Chrome: WebContentsPresentationManager,
// MediaRouterUI::StartCasting with MediaCastMode::PRESENTATION). See docs/MAIN-API.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  MediaRouteError, createCastManager, type CastManagerOptions, type IpcMainEventLike, type IpcMainLike, type MediaRoute,
  type PresentationRequest,
} from "../../src/electron/main.ts";
import { MEDIA_NAMESPACE } from "../../src/electron/presentation-envelope.ts";
import { FakeDevices, FakeClient, SPEAKER, TV } from "./fakes.ts";

const ORIGIN = "https://music.youtube.com";
const URL1 = "https://google.com/cast#__castAppId__=233637DE/__castClientId__=c1";
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
  const setDefault = (wc: FakeWebContents, urls: string[], frame: unknown = main) => pcall(wc, "setDefaultRequest", { urls }, frame);
  return { ipcMain, clients, picked, manager, devices, pcall, setDefault };
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

test("sinks can be asked for by presentation URL", () => {
  const { manager } = setup();
  const ids = (urls: string[]) => {
    let got: string[] = [];
    manager.registerMediaSinksObserver({ onSinksUpdated: (s) => { got = s.map((x) => x.id); } }, { presentationUrls: urls })();
    return got;
  };
  assert.deepEqual(ids([URL1]), ["dev-tv", "dev-speaker", "dev-group"]);
  assert.deepEqual(ids([URL_VIDEO]), ["dev-tv"]);
  assert.deepEqual(ids(["https://example.test/"]), []);
  assert.deepEqual(ids(["https://example.test/", URL_VIDEO]), ["dev-tv"]);
});

test("startCasting starts the default request on the sink: the page gets connectionavailable, the route is listed", async () => {
  const { manager, setDefault, clients, picked, pcall } = setup();
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const routeLists: MediaRoute[][] = [];
  manager.registerMediaRoutesObserver({ onRoutesUpdated: (r) => routeLists.push(r) });

  const route = await manager.startCasting(TV.id, { webContentsId: 5 });
  assert.equal(picked.length, 0, "the app chose the sink: no selectDevice, and no user gesture was needed");
  assert.equal(clients.length, 1);
  assert.ok(clients[0]!.calls.includes("launch 233637DE"));
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
  assert.ok(clients[0]!.calls.some((c) => c === `stop ${route.id}`), String(clients[0]!.calls));
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
  await assert.rejects(manager.startCasting(TV.id, { webContentsId: 5, castMode: "tab_mirror" as any }), RangeError);
  await assert.rejects(manager.startCasting(TV.id, {} as any), TypeError);
  await assert.rejects(manager.startCasting(5 as any, { webContentsId: 5 }), TypeError);
  const off = setup({ presentation: false });
  assert.equal(await codeOf(off.manager.startCasting(TV.id, { webContentsId: 5 })), "unable_to_cast");
});

test("startCasting reports Chrome's RouteRequestResultCode when the start fails", async () => {
  const unreachable = setup({}, (c) => { c.connectError = new Error("no route to host"); });
  const wc = new FakeWebContents(5);
  await unreachable.setDefault(wc, [URL1]);
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

test("when the page replaced its default request during the start, the connection is not announced", async () => {
  const { manager, setDefault } = setup();
  const wc = new FakeWebContents(5);
  await setDefault(wc, [URL1]);
  const started = manager.startCasting(TV.id, { webContentsId: 5 });
  await setDefault(wc, [URL2]);
  const route = await started;
  assert.ok(route.id);
  assert.ok(!wc.events().some((e) => e.type === "connectionavailable"), "OnPresentationResponse answers only the request it started");
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
