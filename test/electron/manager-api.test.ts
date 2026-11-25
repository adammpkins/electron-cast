import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createCastManager, MediaRouteError, type IpcMainLike, type CastManagerOptions, type MediaRoute, type MediaSink,
} from "../../src/electron/main.ts";
import type { BridgeEvent } from "../../src/polyfill/bridge-types.ts";
import { FakeDevices, FakeClient, TV, device, tick } from "./fakes.ts";

const YT = "233637DE";
const ORIGIN = "https://music.youtube.com";
const INIT = { appId: YT, capabilities: ["audio_out"], autoJoinPolicy: "origin_scoped" };
const REQ = { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 };

class FakeIpcMain implements IpcMainLike {
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void {
    this.handlers.set(channel, listener);
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

test("a sinks observer gets the current list, then each change, with Chrome-style sinks", () => {
  const { discovery, manager } = setup();
  const seen: MediaSink[][] = [];
  const stop = manager.registerMediaSinksObserver({ onSinksUpdated: (s) => seen.push(s) });
  assert.deepEqual(seen[0]?.map((s) => s.id), ["dev-tv", "dev-speaker", "dev-group"]);
  assert.deepEqual(seen[0]?.map((s) => s.iconType), ["cast", "cast_audio", "cast_audio_group"]);
  assert.deepEqual(seen[0]?.[0], { id: "dev-tv", name: TV.name, description: TV.model, iconType: "cast", device: TV });
  const lamp = device({ id: "dev-lamp", name: "Lamp", capabilities: 4 });
  discovery.up(lamp);
  assert.equal(seen.length, 2);
  assert.ok(seen[1]?.some((s) => s.id === "dev-lamp"));
  discovery.change({ ...lamp, name: "Desk lamp" });
  assert.equal(seen[2]?.find((s) => s.id === "dev-lamp")?.name, "Desk lamp");
  discovery.down(lamp);
  assert.ok(!seen[3]?.some((s) => s.id === "dev-lamp"));
  stop();
  discovery.up(lamp);
  assert.equal(seen.length, 4, "unregistered");
  assert.equal(discovery.listenerCount("deviceUp"), 1, "only the session service stays subscribed");
});

test("a sinks observer can ask for capabilities and ignores changes that leave its list alone", () => {
  const { discovery, manager } = setup();
  const seen: string[][] = [];
  manager.registerMediaSinksObserver({ onSinksUpdated: (s) => seen.push(s.map((x) => x.id)) }, { capabilities: ["video_out"] });
  assert.deepEqual(seen, [["dev-tv"]]);
  discovery.up(device({ id: "dev-lamp", capabilities: 4 }));
  assert.equal(seen.length, 1);
});

test("a throwing observer does not stop the others or the manager", () => {
  const { discovery, manager } = setup();
  const quiet = console.error;
  console.error = () => {};
  try {
    let got = 0;
    manager.registerMediaSinksObserver({ onSinksUpdated: () => { throw new Error("boom"); } });
    manager.registerMediaSinksObserver({ onSinksUpdated: () => void got++ });
    discovery.up(device({ id: "dev-x" }));
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
  assert.deepEqual(manager.getRoutes(), []);
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
  await call(wc, "initialize", INIT);
  const pending = call(wc, "requestSession", REQ);
  await tick();
  assert.equal(signal.aborted, false);
  discovery.up(device({ id: "dev-late", capabilities: 4 }));
  discovery.up(device({ id: "dev-video-only", capabilities: 1 }));
  assert.deepEqual(lists.at(-1), ["dev-tv", "dev-speaker", "dev-group", "dev-late"], "filtered to the request's capabilities");
  release(null);
  assert.deepEqual(await pending, { ok: false, code: "cancel" });
  assert.equal(signal.aborted, true);
  const before = lists.length;
  discovery.up(device({ id: "dev-after", capabilities: 4 }));
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
