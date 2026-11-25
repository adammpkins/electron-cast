import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createCastManager, MediaRouteError, type IpcMainLike, type CastManagerOptions, type MediaRoute, type MediaSink,
} from "../../src/electron/main.ts";
import type { BridgeEvent } from "../../src/polyfill/bridge-types.ts";
import { FakeDevices, FakeClient, TV, device, tick, FAST_SINKS, launchError } from "./fakes.ts";

const YT = "233637DE";
const ORIGIN = "https://music.youtube.com";
const INIT = { appId: YT, capabilities: ["audio_out"], autoJoinPolicy: "origin_scoped" };
const REQ = { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 };

class FakeIpcMain implements IpcMainLike {
  /** Set by the test once the manager exists: calls wait for the channels to the fake devices to open first. */
  ready: () => Promise<void> = () => Promise.resolve();
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    this.handlers.set(channel, async (...args) => {
      await this.ready();
      return listener(args[0], ...args.slice(1));
    });
  }
  removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }
  on(): unknown {
    return this;
  }
  removeListener(): unknown {
    return this;
  }
}

class FakeWebContents extends EventEmitter {
  readonly id: number;
  sent: BridgeEvent[] = [];
  constructor(id: number) {
    super();
    this.id = id;
  }
  send(_channel: string, payload: BridgeEvent): void {
    this.sent.push(JSON.parse(JSON.stringify(payload)));
  }
  isDestroyed(): boolean {
    return false;
  }
  of(type: BridgeEvent["type"]): BridgeEvent[] {
    return this.sent.filter((e) => e.type === type);
  }
}

class FakeDiscovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
  /** Replace a device, as discovery does when its record changes. */
  change(d: ReturnType<typeof device>): void {
    this.list = this.list.map((x) => (x.id === d.id ? d : x));
    this.emit("deviceChanged", d);
  }
}

function setup(over: Partial<CastManagerOptions> = {}) {
  const discovery = new FakeDiscovery();
  const clients: FakeClient[] = [];
  const ipcMain = new FakeIpcMain();
  const manager = createCastManager({
    sinks: FAST_SINKS,
    ipcMain,
    discovery,
    createClient: (d) => {
      const c = new FakeClient(d);
      c.echoReplies = true;
      clients.push(c);
      return c;
    },
    selectDevice: async (devices) => devices.find((d) => d.id === TV.id) ?? null,
    ...over,
  });
  ipcMain.ready = () => manager.settled();
  const call = (wc: FakeWebContents, method: string, params: unknown) => {
    const handler = ipcMain.handlers.get("electron-cast:call")!;
    return Promise.resolve(handler({ sender: wc, senderFrame: { url: `${ORIGIN}/x`, origin: ORIGIN } }, method, params));
  };
  /** A page that initializes and starts a session on the TV. */
  const cast = async (id: number) => {
    const wc = new FakeWebContents(id);
    await call(wc, "initialize", INIT);
    const r = (await call(wc, "requestSession", REQ)) as { ok: true; value: { sessionId: string } };
    assert.equal(r.ok, true, JSON.stringify(r));
    return { wc, sessionId: r.value.sessionId };
  };
  return { discovery, clients, manager, call, cast };
}

test("a sinks observer gets the current list, then each change, with Chrome-style sinks", async () => {
  const { discovery, manager } = setup();
  await manager.settled();
  const seen: MediaSink[][] = [];
  const stop = manager.registerMediaSinksObserver({ onSinksUpdated: (s) => seen.push(s) });
  assert.deepEqual(seen[0]?.map((s) => s.id), ["dev-tv", "dev-speaker", "dev-group"]);
  assert.deepEqual(seen[0]?.map((s) => s.iconType), ["cast", "cast_audio", "cast_audio_group"]);
  assert.deepEqual(seen[0]?.[0], { id: "dev-tv", providerId: "cast", name: TV.name, description: TV.model, iconType: "cast", device: TV });
  const lamp = device({ host: "10.0.0.50", addresses: ["10.0.0.50"], id: "dev-lamp", name: "Lamp", capabilities: 4 });
  discovery.up(lamp);
  await manager.settled();
  assert.equal(seen.length, 2);
  assert.ok(seen[1]?.some((s) => s.id === "dev-lamp"));
  discovery.change({ ...lamp, name: "Desk lamp" });
  await manager.settled();
  assert.equal(seen[2]?.find((s) => s.id === "dev-lamp")?.name, "Desk lamp");
  // mDNS forgetting a device does not drop its sink: Chrome removes a sink only when its channel cannot be reopened
  discovery.down(lamp);
  await manager.settled();
  assert.equal(seen.length, 3);
  stop();
  discovery.up(device({ id: "dev-other", capabilities: 4 }));
  await manager.settled();
  assert.equal(seen.length, 3, "unregistered");
  assert.equal(discovery.listenerCount("deviceUp"), 1, "only the session service stays subscribed");
});

test("a sinks observer can ask for capabilities and ignores changes that leave its list alone", async () => {
  const { discovery, manager } = setup();
  await manager.settled();
  const seen: string[][] = [];
  manager.registerMediaSinksObserver({ onSinksUpdated: (s) => seen.push(s.map((x) => x.id)) }, { capabilities: ["video_out"] });
  assert.deepEqual(seen, [["dev-tv"]]);
  discovery.up(device({ host: "10.0.0.51", addresses: ["10.0.0.51"], id: "dev-lamp", capabilities: 4 }));
  await manager.settled();
  assert.equal(seen.length, 1);
});

test("a throwing observer does not stop the others or the manager", async () => {
  const { discovery, manager } = setup();
  await manager.settled();
  const quiet = console.error;
  console.error = () => {};
  try {
    let got = 0;
    manager.registerMediaSinksObserver({ onSinksUpdated: () => { throw new Error("boom"); } });
    manager.registerMediaSinksObserver({ onSinksUpdated: () => void got++ });
    discovery.up(device({ host: "10.0.0.52", addresses: ["10.0.0.52"], id: "dev-x" }));
    await manager.settled();
    assert.equal(got, 2);
  } finally {
    console.error = quiet;
  }
});

test("routes list the session with its sink, pages and parked state; observers follow it", async () => {
  const { manager, cast } = setup();
  const seen: MediaRoute[][] = [];
  manager.registerMediaRoutesObserver({ onRoutesUpdated: (r) => seen.push(r) });
  assert.equal(JSON.stringify(seen), "[[]]");
  const { wc, sessionId } = await cast(1);
  const route = manager.getRoutes()[0]!;
  assert.equal(route.id, sessionId);
  assert.equal(route.sinkId, "dev-tv");
  assert.equal(route.mediaSource, `cast:${YT}`);
  assert.equal(route.description, "YouTube");
  assert.equal(route.origin, ORIGIN);
  assert.deepEqual([route.members, route.parkedSenders, route.parked], [[1], [], false]);
  assert.deepEqual(route.volume, { level: 0.5, muted: false });
  assert.deepEqual(seen.at(-1)?.map((r) => r.id), [sessionId], "observer told of the new route");

  wc.emit("did-navigate");
  const parked = manager.getRoutes()[0]!;
  assert.deepEqual([parked.members, parked.parkedSenders, parked.parked], [[], [1], true]);
  assert.equal(seen.at(-1)?.[0]?.parked, true);
});

test("terminateRoute stops the app on the device and every page gets sessionEnded", async () => {
  const { manager, cast, clients, call } = setup();
  const a = await cast(1);
  const seen: MediaRoute[][] = [];
  manager.registerMediaRoutesObserver({ onRoutesUpdated: (r) => seen.push(r) });
  const b = new FakeWebContents(2);
  await call(b, "initialize", INIT); // origin_scoped: joins the running session
  assert.deepEqual(manager.getRoutes()[0]!.members, [1, 2]);
  await manager.terminateRoute(a.sessionId);
  assert.ok(clients[0]!.calls.includes(`stop ${a.sessionId}`));
  for (const wc of [a.wc, b]) {
    assert.deepEqual(wc.of("sessionEnded"), [{ type: "sessionEnded", sessionId: a.sessionId, status: "stopped" }]);
  }
  assert.deepEqual(manager.getRoutes(), []);
  assert.deepEqual(seen.at(-1), []);
});

test("the route controller sets volume and mute on the device and the page sees sessionUpdated", async () => {
  const { manager, cast, clients } = setup();
  const { wc, sessionId } = await cast(1);
  const controller = manager.getRouteController(sessionId);
  await controller.setVolume(0.8);
  await controller.setMute(true);
  assert.ok(clients[0]!.calls.includes('volume {"level":0.8}'));
  assert.ok(clients[0]!.calls.includes('volume {"muted":true}'));
  const updates = wc.of("sessionUpdated") as Extract<BridgeEvent, { type: "sessionUpdated" }>[];
  assert.deepEqual(updates.map((u) => [u.session.receiver.volume.level, u.session.receiver.volume.muted]), [[0.8, false], [0.8, true]]);
  assert.deepEqual(manager.getRoutes()[0]!.volume, { level: 0.8, muted: true });
  await assert.rejects(controller.setVolume(2), RangeError);
});

test("detachRoute lets every page go without stopping the app", async () => {
  const { manager, cast, clients } = setup();
  const { wc, sessionId } = await cast(1);
  manager.detachRoute(sessionId);
  assert.deepEqual(wc.of("sessionEnded"), [{ type: "sessionEnded", sessionId, status: "disconnected" }]);
  assert.ok(!clients[0]!.calls.some((c) => c.startsWith("stop ")));
  assert.ok(clients[0]!.calls.some((c) => c.startsWith("closeTransport ")));
  // the app still runs on the device, so the route stays, no longer local (Chrome: a non-local activity)
  assert.deepEqual(manager.getRoutes().map((r) => [r.id, r.isLocal, r.members]), [[sessionId, false, []]]);
});

test("controls on an unknown route reject with route_not_found", async () => {
  const { manager } = setup();
  await assert.rejects(manager.terminateRoute("nope"), (e: unknown) => e instanceof MediaRouteError && e.code === "route_not_found");
  assert.throws(() => manager.detachRoute("nope"), MediaRouteError);
  assert.throws(() => manager.getRouteController("nope"), MediaRouteError);
});

test("a picker hears of a device that appears while it is pending, and its signal aborts after the answer", async () => {
  let release!: (d: ReturnType<typeof device> | null) => void;
  const lists: string[][] = [];
  let signal!: AbortSignal;
  const { discovery, call, manager } = setup({
    selectDevice: (devices, _request, picker) => {
      signal = picker.signal;
      lists.push(devices.map((d) => d.id));
      picker.registerMediaSinksObserver({ onSinksUpdated: (sinks) => lists.push(sinks.map((s) => s.id)) });
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const wc = new FakeWebContents(1);
  await manager.settled();
  await call(wc, "initialize", INIT);
  const pending = call(wc, "requestSession", REQ);
  await tick();
  assert.equal(signal.aborted, false);
  discovery.up(device({ host: "10.0.0.53", addresses: ["10.0.0.53"], id: "dev-late", capabilities: 4 }));
  discovery.up(device({ host: "10.0.0.54", addresses: ["10.0.0.54"], id: "dev-video-only", capabilities: 1 }));
  await manager.settled();
  assert.deepEqual(lists.at(-1), ["dev-tv", "dev-speaker", "dev-group", "dev-late"], "filtered to the request's capabilities");
  release(null);
  assert.deepEqual(await pending, { ok: false, code: "cancel" });
  assert.equal(signal.aborted, true);
  const before = lists.length;
  discovery.up(device({ host: "10.0.0.55", addresses: ["10.0.0.55"], id: "dev-after", capabilities: 4 }));
  await manager.settled();
  assert.equal(lists.length, before, "nothing after the picker answered");
  await manager.dispose();
});

test("a pending picker is aborted when its page navigates away or the manager is disposed", async () => {
  const signals: AbortSignal[] = [];
  const { call, manager } = setup({
    selectDevice: (_d, _r, picker) => {
      signals.push(picker.signal);
      return new Promise(() => {});
    },
  });
  const a = new FakeWebContents(1);
  await call(a, "initialize", INIT);
  void call(a, "requestSession", REQ);
  await tick();
  a.emit("did-navigate");
  // watch() registers did-navigate on the first call through the handler, so the page is known by now
  assert.equal(signals[0]?.aborted, true);
  const b = new FakeWebContents(2);
  await call(b, "initialize", INIT);
  void call(b, "requestSession", REQ);
  await tick();
  await manager.dispose();
  assert.equal(signals[1]?.aborted, true);
});

test("a two-argument picker still works", async () => {
  const { call } = setup({ selectDevice: async (devices, request) => (request.appId === YT ? devices[0]! : null) });
  const wc = new FakeWebContents(1);
  await call(wc, "initialize", INIT);
  const r = (await call(wc, "requestSession", REQ)) as { ok: boolean };
  assert.equal(r.ok, true);
});

test("sink icons follow Chrome's GetCastSinkIconType: video_out first, then multizone group, else audio", async () => {
  const { manager, discovery } = setup();
  discovery.up(device({ host: "10.0.0.56", addresses: ["10.0.0.56"], id: "g-video", capabilities: 1 | 32, isGroup: true }));
  discovery.up(device({ host: "10.0.0.57", addresses: ["10.0.0.57"], id: "plain-audio", capabilities: 4 }));
  await manager.settled();
  let sinks: MediaSink[] = [];
  manager.registerMediaSinksObserver({ onSinksUpdated: (s) => (sinks = s) });
  const icon = (id: string) => sinks.find((s) => s.id === id)?.iconType;
  assert.equal(icon("g-video"), "cast", "a group that can show video is a plain Cast sink in Chrome");
  assert.equal(icon("plain-audio"), "cast_audio");
  assert.equal(icon("dev-group"), "cast_audio_group");
});

test("a failed Cast launch raises Failed to cast for the sink, a declined one raises the declined warning, and a pending one a notice", async () => {
  const { manager, clients, call } = setup();
  await manager.settled();
  const titles: string[] = [];
  manager.registerIssuesObserver({ onIssue: (i) => titles.push(`${i.info.severity}:${i.info.title}`), onIssuesCleared: () => titles.push("cleared") });
  const wc = new FakeWebContents(7);
  await call(wc, "initialize", INIT);
  const tv = clients.find((c) => c.device.id === TV.id)!;
  tv.launchError = new Error("boom");
  const r = (await call(wc, "requestSession", REQ)) as { ok: boolean };
  assert.equal(r.ok, false);
  assert.ok(titles.includes("warning:Failed to cast. Please try again."), titles.join("|"));
  // an access-denied launch: the receiver says the user declined
  titles.length = 0;
  manager.clearTopIssueForSink(TV.id);
  const declined = launchError("CANCELLED");
  (declined.response as { extendedError?: string }).extendedError = "USER_NOT_ALLOWED";
  tv.launchError = declined;
  await call(wc, "requestSession", REQ);
  assert.ok(titles.some((t) => t.startsWith("warning:") && t.includes(TV.name)), titles.join("|"));
  assert.ok(!titles.includes("warning:Failed to cast. Please try again."), titles.join("|"));
  // a pending authorization raises a notice that "user allowed" takes away again
  titles.length = 0;
  tv.launchError = null;
  tv.launchStatuses = ["user_pending_authorization", "user_allowed"];
  const ok = (await call(wc, "requestSession", REQ)) as { ok: boolean };
  assert.equal(ok.ok, true);
  assert.ok(titles.some((t) => t.startsWith("notification:")), titles.join("|"));
  assert.equal(manager.getCastProviderState()?.sessionState.length, 1);
});
