// App availability over the sinks' open channels: Chrome's CastAppDiscoveryServiceImpl and CastAppAvailabilityTracker
// (cast_app_discovery_service.cc, cast_app_availability_tracker.cc), and what a page's PresentationRequest gets from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CastAppDiscovery, APP_AVAILABILITY_REFRESH_MS, type AppDiscoverySinks } from "../../src/electron/app-discovery.ts";
import { CastSessionService } from "../../src/electron/session-service.ts";
import { CastPresentationHandler, PresentationError } from "../../src/electron/presentation-handler.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import { FakeClient, FakeDevices, TV, SPEAKER, GROUP, FAST_SINKS, tick, waitForSinks } from "./fakes.ts";

const YT = "233637DE";
const OTHER = "CC1AD845";

/** A sink service of open channels a test controls. */
function sinks(list: CastDevice[]) {
  const clients = new Map<string, FakeClient>();
  for (const d of list) {
    const c = new FakeClient(d);
    c.connected = true;
    clients.set(d.id, c);
  }
  const current = new Map(list.map((d) => [d.id, d]));
  const service: AppDiscoverySinks = {
    sinks: () => [...current.values()],
    sinkOf: (id) => current.get(id),
    clientOf: (id) => clients.get(id),
  };
  return { service, clients, current };
}

const asks = (c: FakeClient) => c.calls.filter((x) => x.startsWith("availability"));
const ids = (list: CastDevice[]) => list.map((d) => d.id).sort();

test("the first observer of a source has its apps asked about on every sink, once; a cached answer comes at once", async () => {
  const s = sinks([TV, SPEAKER]);
  s.clients.get(SPEAKER.id)!.availableApps = [];
  const discovery = new CastAppDiscovery(s.service);
  const seen: string[][] = [];
  const stop = discovery.startObserving({ appIds: [YT], capabilities: [] }, (list) => seen.push(ids(list)));
  assert.deepEqual(seen, [], "nothing is known yet, so the callback is not called at once");
  await discovery.settled({ appIds: [YT], capabilities: [] });
  assert.deepEqual(seen, [[TV.id]], "told when the app became available on a sink");
  // a second observer of the same source: StartObservingMediaSinks returns the cached sinks, and asks nothing
  const second: string[][] = [];
  const stop2 = discovery.startObserving({ appIds: [YT], capabilities: [] }, (list) => second.push(ids(list)));
  assert.deepEqual(second, [[TV.id]]);
  assert.deepEqual([asks(s.clients.get(TV.id)!).length, asks(s.clients.get(SPEAKER.id)!).length], [1, 1]);
  stop();
  stop2();
});

test("Chrome's refresh rules: available stands, unavailable is asked again after a minute, unknown always", async () => {
  let now = 1_000;
  const s = sinks([TV]);
  const tv = s.clients.get(TV.id)!;
  const discovery = new CastAppDiscovery(s.service, () => now);
  tv.availableApps = [YT];
  await discovery.request(TV.id, YT);
  await discovery.request(TV.id, OTHER);
  assert.deepEqual([discovery.cached(TV.id, YT), discovery.cached(TV.id, OTHER)], [true, false]);
  now += APP_AVAILABILITY_REFRESH_MS;
  await discovery.request(TV.id, YT);
  await discovery.request(TV.id, OTHER);
  assert.equal(asks(tv).length, 2, "kAvailable never and kUnavailable not within the threshold");
  now += 1;
  await discovery.request(TV.id, OTHER);
  assert.equal(asks(tv).length, 3, "kUnavailable once the threshold has passed");
  // an error is kUnknown, kept but asked again every time
  tv.getAppAvailability = async () => { throw new Error("timeout"); };
  await discovery.request(TV.id, "ABCD1234");
  assert.equal(discovery.availability(TV.id, "ABCD1234").result, "unknown");
  assert.equal(discovery.cached(TV.id, "ABCD1234"), undefined);
});

test("observers are told only when an app becomes or stops being available, and a sink's channel opening asks again", async () => {
  let now = 0;
  const s = sinks([TV]);
  const tv = s.clients.get(TV.id)!;
  tv.availableApps = [];
  const discovery = new CastAppDiscovery(s.service, () => now);
  const seen: string[][] = [];
  discovery.startObserving({ appIds: [YT], capabilities: [] }, (list) => seen.push(ids(list)));
  await tick();
  assert.deepEqual(seen, [], "unknown to unavailable is not a change for the queries");
  // a new sink with the app: OnSinkAddedOrUpdated asks the registered apps on it
  const speaker = new FakeClient(SPEAKER);
  speaker.connected = true;
  s.clients.set(SPEAKER.id, speaker);
  s.current.set(SPEAKER.id, SPEAKER);
  discovery.onSinkAddedOrUpdated(SPEAKER);
  await tick();
  assert.deepEqual(seen, [[SPEAKER.id]]);
  // the TV's channel reopens a minute later and it has the app now
  now += APP_AVAILABILITY_REFRESH_MS + 1;
  tv.availableApps = null;
  discovery.onSinkAddedOrUpdated(TV);
  await tick();
  assert.deepEqual(seen.at(-1), [SPEAKER.id, TV.id].sort());
  // OnSinkRemoved drops the sink's answers and tells the queries that listed it
  s.current.delete(SPEAKER.id);
  discovery.onSinkRemoved(SPEAKER);
  assert.deepEqual(seen.at(-1), [TV.id]);
  assert.equal(discovery.availability(SPEAKER.id, YT).result, "unknown");
});

test("required capabilities, a sink with no open channel, an answer about a replaced channel", async () => {
  const s = sinks([TV, SPEAKER]);
  const discovery = new CastAppDiscovery(s.service);
  const video = { appIds: [YT], capabilities: ["video_out"] };
  discovery.startObserving(video, () => {});
  await discovery.settled(video);
  assert.deepEqual(ids(discovery.availableSinks(video)), [TV.id], "the speaker has the app but no video_out");
  // no channel right now: nothing is asked (Chrome skips a sink whose socket is gone)
  s.clients.delete(GROUP.id);
  s.current.set(GROUP.id, GROUP);
  await discovery.request(GROUP.id, OTHER);
  assert.equal(discovery.availability(GROUP.id, OTHER).result, "unknown");
  // the channel is replaced while the old one is being asked: its answer is dropped
  const tv = s.clients.get(TV.id)!;
  tv.availabilityDelayMs = 20;
  const late = discovery.request(TV.id, OTHER);
  discovery.onSinkAddedOrUpdated(TV);
  await late;
  assert.equal(discovery.availability(TV.id, OTHER).result, "unknown");
});

/** A service and handler over fake devices, as main.ts wires them. */
function page(o: { devices?: CastDevice[]; tweak?: (c: FakeClient) => void; offered?: string[][] } = {}) {
  const devices = new FakeDevices(o.devices ?? [TV, SPEAKER]);
  const clients: FakeClient[] = [];
  let handler: CastPresentationHandler | undefined;
  const service = new CastSessionService({
    sinks: { ...FAST_SINKS, retry: { maxAttempts: 1 } },
    devices,
    createClient: (d) => {
      const c = new FakeClient(d);
      if (devices.unreachable.has(d.id)) c.connectError = new Error("unreachable");
      o.tweak?.(c);
      clients.push(c);
      return c;
    },
    selectDevice: async (list) => {
      o.offered?.push(ids(list));
      return list[0] ?? null;
    },
    emit: (id, ev) => handler?.onServiceEvent(id, ev),
  });
  handler = new CastPresentationHandler({ service, token: "tok" });
  return { devices, clients, service, handler };
}
const request = (url = `cast:${YT}`) => ({ urls: [url], origin: "https://music.youtube.com", senderId: 1 });

test("a page's availability: false before any sink, then true as soon as a sink's channel says it has the app", async () => {
  const p = page();
  const changes: boolean[] = [];
  // the page asks at load, before the channels are open
  const first = await p.handler.getAvailability({ ...request(), onchange: (v) => changes.push(v), signal: new AbortController().signal });
  assert.equal(first, false);
  await p.service.settled();
  await tick();
  assert.deepEqual(changes, [true], "the change comes with the channel's answer, not after the 3 s report");
  assert.ok(p.clients.every((c) => c.calls.filter((x) => x === "connect").length === 1), "asked over the one channel each sink has");
  assert.ok(p.clients.some((c) => c.calls.includes(`availability ${YT}`)));
  await p.service.dispose();
});

test("a page's first answer is prompt: one sink saying yes answers it, without waiting for a slow one", async () => {
  const p = page({ tweak: (c) => { if (c.device.id === SPEAKER.id) c.availabilityDelayMs = 5_000; } });
  await p.service.settled();
  const started = Date.now();
  const ac = new AbortController();
  assert.equal(await p.handler.getAvailability({ ...request(), onchange: () => {}, signal: ac.signal }), true);
  assert.ok(Date.now() - started < 2_000);
  ac.abort();
  await p.service.dispose();
});

test("a page's availability follows the sinks: no sink has the app is false, losing the only one that has it is a change", async () => {
  const p = page({ tweak: (c) => { c.availableApps = c.device.id === TV.id ? [YT] : []; } });
  await p.service.settled();
  const changes: boolean[] = [];
  const ac = new AbortController();
  assert.equal(await p.handler.getAvailability({ ...request(`cast:${OTHER}`), onchange: () => {}, signal: new AbortController().signal }), false, "no sink has that app");
  assert.equal(await p.handler.getAvailability({ ...request(), onchange: (v) => changes.push(v), signal: ac.signal }), true);
  // the TV's channel fails and cannot be reopened: the sink is removed (OnSinkRemoved)
  const tv = p.clients.find((c) => c.device.id === TV.id)!;
  p.devices.unreachable.add(TV.id);
  tv.fail();
  await p.service.settled({ retries: true });
  await tick();
  assert.deepEqual(changes, [false]);
  ac.abort();
  await p.service.dispose();
});

test("a page's start() is offered only the sinks that have the app, and finds no screen when none has it", async () => {
  const offered: string[][] = [];
  const p = page({ devices: [TV, SPEAKER, GROUP], offered, tweak: (c) => { c.availableApps = c.device.id === SPEAKER.id ? [] : [YT]; } });
  waitForSinks(p.service);
  const conn = await p.handler.startPresentation(request());
  assert.deepEqual(offered, [[GROUP.id, TV.id]], "without asking getAvailability first, the sinks were asked when start() came");
  conn.terminate();
  await assert.rejects(p.handler.startPresentation(request(`cast:${OTHER}`)), (e: unknown) => e instanceof PresentationError && e.name === "NotFoundError");
  await p.service.dispose();
});
