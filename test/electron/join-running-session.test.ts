// Joining a session that was already running when this run of the app started (after an app restart), the way Chrome's
// Media Router does it for reconnect("cast-session_<id>"): the session is learned from the device's receiver status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CastSessionService } from "../../src/electron/session-service.ts";
import type { SessionSnapshot } from "../../src/polyfill/bridge-types.ts";
import { FakeDevices, FakeClient, EventLog, tick, TV, SPEAKER, onlyChannels, FAST_SINKS, waitForSinks } from "./fakes.ts";

const YT = "233637DE";
const MDX = "urn:x-cast:com.google.youtube.mdx";
const PAGE = { id: 1, origin: "https://music.youtube.com" };
const PAGE2 = { id: 2, origin: "https://music.youtube.com" };
const EVIL = { id: 3, origin: "https://evil.example" };

function setup(opts: { devices?: FakeDevices; tweak?: (c: FakeClient) => void; allowOrigin?: (o: string) => boolean; sinks?: Record<string, unknown> } = {}) {
  const devices = opts.devices ?? new FakeDevices();
  const log = new EventLog();
  const clients: FakeClient[] = [];
  const service = waitForSinks(new CastSessionService({
    sinks: { ...FAST_SINKS, ...opts.sinks },
    devices,
    createClient: (d) => {
      const c = new FakeClient(d);
      opts.tweak?.(c);
      clients.push(c);
      return c;
    },
    selectDevice: async (list) => list.find((d) => d.id === TV.id) ?? null,
    allowOrigin: opts.allowOrigin,
    emit: log.emit,
  }));
  return { service, devices, log, clients };
}

const init = (service: CastSessionService, sender = PAGE, autoJoinPolicy = "origin_scoped") =>
  service.handle(sender, "initialize", { appId: YT, capabilities: ["audio_out"], autoJoinPolicy });

/** A second run of the app: a fresh service whose device still runs the session the first run started. */
async function restarted(opts: { tweak?: (c: FakeClient) => void; allowOrigin?: (o: string) => boolean; sinks?: Record<string, unknown> } = {}) {
  const first = setup();
  await init(first.service);
  const r = await first.service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  assert.equal(r.ok, true);
  const sessionId = (r as { ok: true; value: SessionSnapshot }).value.sessionId;
  const app = first.clients[0]!.apps[0]!;
  await first.service.dispose();
  const device = { over: false };
  const second = setup({
    allowOrigin: opts.allowOrigin,
    sinks: opts.sinks,
    tweak: (c) => {
      if (c.device.id === TV.id && !device.over) c.apps = [{ ...app }];
      opts.tweak?.(c);
    },
  });
  return { ...second, app, sessionId, device };
}

test("a session still running from before a restart is joined by its id, like Chrome's non-local activity", async () => {
  const { service, log, clients, sessionId, app, device } = await restarted();
  const joined = await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT });
  assert.equal(joined.ok, true, JSON.stringify(joined));
  const snap = (joined as { ok: true; value: SessionSnapshot }).value;
  assert.equal(snap.sessionId, sessionId);
  assert.equal(snap.appId, YT);
  const tv = clients.find((c) => c.device.id === TV.id)!;
  assert.ok(tv.transports.has(app.transportId), "the transport is connected");

  const sent = await service.handle(PAGE, "sendMessage", { sessionId, namespace: MDX, message: "hi" });
  assert.equal(sent.ok, true);
  assert.deepEqual(tv.sent.at(-1), { namespace: MDX, destinationId: app.transportId, payload: "hi" });

  // From here it is an ordinary session: the receiver ending it is reported, and it can no longer be found.
  device.over = true;
  tv.apps = [];
  tv.pushStatus();
  assert.equal(log.of(PAGE.id, "sessionEnded").length, 1);
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId })).ok, false);
});

test("auto-join never picks up a session from before a restart; only its id does (Chrome: it is not local)", async () => {
  const { service, sessionId } = await restarted();
  for (const policy of ["origin_scoped", "tab_and_origin_scoped"]) {
    const r = await init(service, PAGE, policy);
    assert.deepEqual((r as { ok: true; value: { sessions: unknown[] } }).value.sessions, []);
  }
  assert.equal((await service.handle(PAGE, "joinSession", { sessionId })).ok, false, "joinSession knows only what this run holds");
});

test("joining by id needs the session's app; unknown ids and bad params find nothing and leave no client open", async () => {
  const { service, clients, sessionId } = await restarted();
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId, appId: "CC1AD845" })).ok, false);
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId: "nope", appId: YT })).ok, false);
  assert.equal((await service.handle(PAGE, "joinRunningSession", {})).ok, false);
  assert.ok(clients.every((c) => !c.calls.some((x) => x.startsWith("connectTransport") || x.startsWith("launch"))), "no device that did not run it was touched");
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT })).ok, true, "the right app still joins");
});

test("an unreachable device does not stop the others from being searched", async () => {
  const { service, sessionId } = await restarted({ tweak: (c) => { if (c.device.id === SPEAKER.id) c.connectError = new Error("down"); } });
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT })).ok, true);
});

test("a session this run already holds is joined by id with no origin check, as Chrome does, while joinSession keeps its own rule", async () => {
  const { service, sessionId } = await restarted();
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT })).ok, true);
  assert.equal((await service.handle(PAGE2, "joinRunningSession", { sessionId, appId: YT })).ok, true);
  assert.equal((await service.handle(EVIL, "joinRunningSession", { sessionId, appId: YT })).ok, true, "AppActivity::CanJoinSession checks only the app");
  assert.equal((await service.handle({ id: 4, origin: "https://evil2.example" }, "joinSession", { sessionId })).ok, false, "joinSession (mode chromecast) is unchanged");
});

test("allowOrigin gates joinRunningSession before any device is contacted", async () => {
  const { service, clients, sessionId } = await restarted({ allowOrigin: () => false });
  const r = await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT });
  assert.equal(r.ok === false && r.code, "extension_missing");
  assert.ok(onlyChannels(clients), "nothing was asked of any device");
});

test("a session found on a device appears as a route and route observers hear of it", async () => {
  const { service, sessionId, app } = await restarted();
  let calls = 0;
  service.observeSessions(() => void calls++);
  await service.settled();
  // before any page joins, the session is already a route: one this service holds no page for (Chrome: non-local)
  const [before0] = service.mediaRoutes();
  assert.deepEqual([service.mediaRoutes().length, before0?.id, before0?.isLocal, before0?.members, before0?.origin, before0?.sinkName], [1, sessionId, false, [], "", TV.name]);
  assert.ok(calls > 0, "observers heard of the session when the device reported it");
  calls = 0;
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT })).ok, true);
  assert.ok(calls > 0, "observers were notified");
  const [route] = service.mediaRoutes();
  assert.equal(route?.id, sessionId);
  assert.equal(route?.sinkId, TV.id);
  assert.equal(route?.mediaSource, `cast:${YT}`);
  assert.equal(route?.isLocal, true, "a page holds it now");
  assert.deepEqual([route?.members, route?.parked, route?.description], [[PAGE.id], false, app.statusText || app.displayName]);
  const before = calls;
  await service.handle(PAGE2, "joinRunningSession", { sessionId, appId: YT });
  assert.ok(calls > before, "a second page joining is a route update");
  assert.deepEqual(service.mediaRoutes()[0]?.members, [PAGE.id, PAGE2.id]);
});

// ---------- sessions the devices run, as the tracker keeps them (Chrome: CastSessionTracker and non-local activities) ----------

test("a non-local route follows the device: status text and volume updates, and it ends when the app stops", async () => {
  const { service, clients, sessionId } = await restarted();
  await service.settled();
  const tv = clients.find((c) => c.device.id === TV.id)!;
  let calls = 0;
  service.observeSessions(() => void calls++);
  tv.apps = tv.apps.map((a) => ({ ...a, statusText: "Now playing" }));
  tv.volume.level = 0.9;
  tv.pushStatus();
  const [route] = service.mediaRoutes();
  assert.deepEqual([route?.description, route?.volume.level, route?.isLocal], ["Now playing", 0.9, false]);
  assert.ok(calls > 0);
  calls = 0;
  tv.pushStatus();
  assert.equal(calls, 0, "an unchanged status is not an update");
  tv.apps = [];
  tv.pushStatus();
  assert.deepEqual(service.mediaRoutes(), []);
  assert.ok(calls > 0, "observers heard it end");
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT })).ok, false, "nothing to join any more");
});

test("a session another sender started, in an app we do not know, is a route too, and it is not joinable by another app id", async () => {
  const { service, clients, sessionId } = await restarted();
  await service.settled();
  const tv = clients.find((c) => c.device.id === TV.id)!;
  tv.apps = [{ ...tv.apps[0]!, appId: "CC1AD845", sessionId: "other-session", transportId: "other-transport", displayName: "Default Media Receiver" }];
  tv.pushStatus();
  assert.deepEqual(service.mediaRoutes().map((r) => [r.id, r.mediaSource, r.appId]), [["other-session", "cast:CC1AD845", "CC1AD845"]]);
  const wrong = await service.handle(PAGE, "joinRunningSession", { sessionId: "other-session", appId: YT });
  assert.equal(wrong.ok, false);
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT })).ok, false, "the old session is gone from the device");
});

test("a status with two applications or none we can use describes no session", async () => {
  const { service, clients } = await restarted();
  await service.settled();
  const tv = clients.find((c) => c.device.id === TV.id)!;
  assert.equal(service.mediaRoutes().length, 1);
  tv.apps = [tv.apps[0]!, { ...tv.apps[0]!, sessionId: "s2", transportId: "t2" }];
  tv.pushStatus();
  assert.deepEqual(service.mediaRoutes(), [], "Chrome's CastSession::From needs exactly one application");
});

test("a non-local route can be terminated and its volume set, over the device's own channel", async () => {
  const { service, clients, sessionId } = await restarted();
  await service.settled();
  const tv = clients.find((c) => c.device.id === TV.id)!;
  assert.equal((await service.setSessionVolume(sessionId, { level: 0.2 })).ok, true);
  assert.ok(tv.calls.includes(`volume {"level":0.2}`));
  assert.equal(service.mediaRoutes()[0]?.volume.level, 0.2, "the tracker took the reply as the new volume");
  assert.deepEqual(service.detachSession(sessionId), { ok: true, value: undefined }, "nothing to detach, and no error");
  assert.equal((await service.terminateSession(sessionId)).ok, true);
  assert.ok(tv.calls.includes(`stop ${sessionId}`));
  assert.deepEqual(service.mediaRoutes(), []);
  assert.equal((await service.terminateSession("nope")).ok, false);
});

test("a session the first page ends up leaving stays a route until the app stops; the tracker answers joins with no scan", async () => {
  const { service, clients, sessionId } = await restarted();
  await service.settled();
  const connects = clients.map((c) => c.calls.filter((x) => x === "connect").length);
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT })).ok, true);
  assert.equal((await service.handle(PAGE2, "joinRunningSession", { sessionId, appId: YT })).ok, true);
  assert.deepEqual(clients.map((c) => c.calls.filter((x) => x === "connect").length), connects, "no device was connected to for it");
  assert.equal(clients.length, 3, "no client was made for it");
});

test("a device that stops being a sink takes its session route with it", async () => {
  let unreachable = false;
  const { service, clients } = await restarted({ sinks: { retry: { initialDelayMs: 5, jitter: 0, maxAttempts: 2 } }, tweak: (c) => { if (unreachable) c.connectError = new Error("EHOSTUNREACH"); } });
  await service.settled();
  assert.equal(service.mediaRoutes().length, 1);
  unreachable = true;
  clients.find((c) => c.device.id === TV.id)!.fail();
  await service.settled({ retries: true });
  assert.deepEqual(service.mediaRoutes(), []);
});

test("dispose drops the tracker's sessions and closes every channel", async () => {
  const { service, clients } = await restarted();
  await service.settled();
  await service.dispose();
  assert.ok(clients.every((c) => c.closed));
  assert.deepEqual(service.mediaRoutes(), []);
});

test("terminating a non-local route whose channel is down fails as Chrome's StopSession does, and the route stays", async () => {
  // Chrome: CastMessageHandler::StopSession finds no socket and reports a failure, which
  // CastActivityManager::HandleStopSessionResponse turns into this message; the activity is kept.
  let down = false;
  const { service, clients, sessionId } = await restarted({ tweak: (c) => { if (down) c.connectError = new Error("EHOSTUNREACH"); } });
  await service.settled();
  down = true;
  clients.find((c) => c.device.id === TV.id)!.fail();
  await service.settled();
  assert.equal(service.mediaRoutes().length, 1, "the sink and its session stay listed while the channel is reopened");
  assert.deepEqual(await service.terminateSession(sessionId), { ok: false, code: "session_error", description: "StopSession response is not OK. Failed to terminate route." });
  assert.equal(service.mediaRoutes().length, 1);
});
