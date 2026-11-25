// Joining a session that was already running when this run of the app started (after an app restart), the way Chrome's
// Media Router does it for reconnect("cast-session_<id>"): the session is learned from the device's receiver status.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CastSessionService } from "../../src/electron/session-service.ts";
import type { SessionSnapshot } from "../../src/polyfill/bridge-types.ts";
import { FakeDevices, FakeClient, EventLog, TV, SPEAKER } from "./fakes.ts";

const YT = "233637DE";
const MDX = "urn:x-cast:com.google.youtube.mdx";
const PAGE = { id: 1, origin: "https://music.youtube.com" };
const PAGE2 = { id: 2, origin: "https://music.youtube.com" };
const EVIL = { id: 3, origin: "https://evil.example" };

function setup(opts: { devices?: FakeDevices; tweak?: (c: FakeClient) => void; allowOrigin?: (o: string) => boolean } = {}) {
  const devices = opts.devices ?? new FakeDevices();
  const log = new EventLog();
  const clients: FakeClient[] = [];
  const service = new CastSessionService({
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
  });
  return { service, devices, log, clients };
}

const init = (service: CastSessionService, sender = PAGE, autoJoinPolicy = "origin_scoped") =>
  service.handle(sender, "initialize", { appId: YT, capabilities: ["audio_out"], autoJoinPolicy });

/** A second run of the app: a fresh service whose device still runs the session the first run started. */
async function restarted(opts: { tweak?: (c: FakeClient) => void; allowOrigin?: (o: string) => boolean } = {}) {
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
  assert.ok(clients.every((c) => c.closed), "devices that did not run it are not left open");
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
  assert.equal(clients.length, 0);
});

test("a session found on a device appears as a route and route observers hear of it", async () => {
  const { service, sessionId, app } = await restarted();
  let calls = 0;
  service.observeSessions(() => void calls++);
  assert.deepEqual(service.mediaRoutes(), []);
  assert.equal((await service.handle(PAGE, "joinRunningSession", { sessionId, appId: YT })).ok, true);
  assert.ok(calls > 0, "observers were notified");
  const [route] = service.mediaRoutes();
  assert.equal(route?.id, sessionId);
  assert.equal(route?.sinkId, TV.id);
  assert.equal(route?.mediaSource, `cast:${YT}`);
  assert.deepEqual([route?.members, route?.parked, route?.description], [[PAGE.id], false, app.statusText || app.displayName]);
  const before = calls;
  await service.handle(PAGE2, "joinRunningSession", { sessionId, appId: YT });
  assert.ok(calls > before, "a second page joining is a route update");
  assert.deepEqual(service.mediaRoutes()[0]?.members, [PAGE.id, PAGE2.id]);
});
