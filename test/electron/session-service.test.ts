import { test } from "node:test";
import assert from "node:assert/strict";
import { CastSessionService, capabilityNames, type CastRequestInfo, type DeviceChoice } from "../../src/electron/session-service.ts";
import { CastTimeoutError } from "../../src/client/index.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import type { SessionSnapshot } from "../../src/polyfill/bridge-types.ts";
import { FakeDevices, FakeClient, EventLog, TV, SPEAKER, GROUP, device, launchError, tick } from "./fakes.ts";

const YT = "233637DE";
const MDX = "urn:x-cast:com.google.youtube.mdx";
const PAGE = { id: 1, origin: "https://music.youtube.com" };
const PAGE2 = { id: 2, origin: "https://music.youtube.com" };
const EVIL = { id: 3, origin: "https://evil.example" };

function setup(opts: {
  pick?: (devices: CastDevice[], req: CastRequestInfo) => Promise<DeviceChoice> | DeviceChoice;
  devices?: FakeDevices;
  allowOrigin?: (o: string) => boolean;
  tweak?: (c: FakeClient) => void;
} = {}) {
  const devices = opts.devices ?? new FakeDevices();
  const log = new EventLog();
  const clients: FakeClient[] = [];
  const picks: { devices: CastDevice[]; req: CastRequestInfo }[] = [];
  const service = new CastSessionService({
    devices,
    createClient: (d) => {
      const c = new FakeClient(d);
      opts.tweak?.(c);
      clients.push(c);
      return c;
    },
    selectDevice: async (list, req) => {
      picks.push({ devices: list, req });
      return opts.pick ? opts.pick(list, req) : (list.find((d) => d.id === TV.id) ?? null);
    },
    allowOrigin: opts.allowOrigin,
    emit: log.emit,
  });
  return { service, devices, log, clients, picks };
}

async function init(service: CastSessionService, sender = PAGE, params: Record<string, unknown> = {}) {
  return service.handle(sender, "initialize", { appId: YT, capabilities: ["audio_out"], autoJoinPolicy: "origin_scoped", ...params });
}

async function session(service: CastSessionService, sender = PAGE) {
  await init(service, sender);
  const r = await service.handle(sender, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { ok: true; value: SessionSnapshot }).value;
}

test("capabilityNames maps the Cast capability bits", () => {
  assert.deepEqual(capabilityNames(5), ["video_out", "audio_out"]);
  assert.deepEqual(capabilityNames(36), ["audio_out", "multizone_group"]);
  assert.deepEqual(capabilityNames(15), ["video_out", "video_in", "audio_out", "audio_in"]);
  assert.deepEqual(capabilityNames(464901), ["video_out", "audio_out"]);
});

test("initialize reports availability for the requested capabilities", async () => {
  const { service } = setup();
  assert.deepEqual(await init(service), { ok: true, value: { available: true, sessions: [] } });
  const onlySpeakers = setup({ devices: new FakeDevices([SPEAKER]) });
  assert.deepEqual(await init(onlySpeakers.service, PAGE, { capabilities: ["video_out", "audio_out"] }), { ok: true, value: { available: false, sessions: [] } });
});

test("a disallowed origin is refused for every method", async () => {
  const { service, picks } = setup({ allowOrigin: (o) => o === "https://music.youtube.com" });
  for (const method of ["initialize", "requestSession", "sendMessage", "stopSession"]) {
    const r = await service.handle(EVIL, method, { appId: YT, capabilities: [], sessionId: "x", namespace: MDX, message: "" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.code, "extension_missing", method);
  }
  assert.equal(picks.length, 0);
});

test("unknown methods and malformed params are invalid_parameter, never a throw", async () => {
  const { service } = setup();
  await init(service);
  const bad = [
    await service.handle(PAGE, "bogus", {}),
    await service.handle(PAGE, "requestSession", null),
    await service.handle(PAGE, "sendMessage", { sessionId: 5 }),
    await service.handle(PAGE, "setReceiverVolume", { sessionId: "s", level: "loud" }),
  ];
  for (const r of bad) assert.deepEqual(r.ok === false && r.code, "invalid_parameter", JSON.stringify(r));
});

test("requestSession offers only capable devices, connects, launches and returns a snapshot", async () => {
  const { service, clients, picks } = setup();
  await init(service);
  const r = await service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["video_out", "audio_out"], timeoutMs: 5000 });
  assert.equal(picks.length, 1);
  assert.deepEqual(picks[0]?.devices.map((d) => d.id), [TV.id], "the speaker and group have no video");
  assert.deepEqual(picks[0]?.req, { appId: YT, capabilities: ["video_out", "audio_out"], origin: PAGE.origin, senderId: PAGE.id });
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0]?.calls, ["connect", `launch ${YT}`, `connectTransport ${TV.id}-transport-1`]);
  assert.deepEqual(r, {
    ok: true,
    value: {
      sessionId: `${TV.id}-session-1`,
      appId: YT,
      displayName: "YouTube",
      appImages: [{ url: "https://example.test/yt.png" }],
      statusText: "YouTube",
      namespaces: [{ name: MDX }],
      transportId: `${TV.id}-transport-1`,
      receiver: {
        label: TV.id,
        friendlyName: TV.name,
        capabilities: ["video_out", "audio_out"],
        volume: { level: 0.5, muted: false, controlType: "attenuation", stepInterval: 0.05 },
        isActiveInput: null,
      },
    },
  });
});

test("audio-only requests include speakers and groups", async () => {
  const { service, picks } = setup();
  await session(service);
  assert.deepEqual(picks[0]?.devices.map((d) => d.id).sort(), [GROUP.id, SPEAKER.id, TV.id].sort());
});

test("requestSession error mapping", async () => {
  const noDevices = setup({ devices: new FakeDevices([]) });
  await init(noDevices.service);
  const r1 = await noDevices.service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  assert.equal(!r1.ok && r1.code, "receiver_unavailable");
  assert.equal(noDevices.picks.length, 0, "no picker without devices");

  const cancelled = setup({ pick: () => null });
  await init(cancelled.service);
  const r2 = await cancelled.service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  assert.equal(!r2.ok && r2.code, "cancel");

  const pickerBroke = setup({ pick: () => Promise.reject(new Error("ui crashed")) });
  await init(pickerBroke.service);
  const r3 = await pickerBroke.service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  assert.equal(!r3.ok && r3.code, "session_error");

  const unreachable = setup({ tweak: (c) => { c.connectError = new Error("ECONNREFUSED"); } });
  await init(unreachable.service);
  const r4 = await unreachable.service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  assert.equal(!r4.ok && r4.code, "receiver_unavailable");
  assert.match(!r4.ok ? (r4.description ?? "") : "", /ECONNREFUSED/);

  const launchFails = setup({ tweak: (c) => { c.launchError = launchError("NOT_FOUND"); } });
  await init(launchFails.service);
  const r5 = await launchFails.service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  assert.equal(!r5.ok && r5.code, "session_error");
  assert.ok(launchFails.clients[0]?.closed, "an unused client is closed after a failed launch");

  const launchTimesOut = setup({ tweak: (c) => { c.launchError = new CastTimeoutError("launch timed out"); } });
  await init(launchTimesOut.service);
  const r6 = await launchTimesOut.service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  assert.equal(!r6.ok && r6.code, "timeout");
});

test("timeoutMs bounds connect and launch, not the time spent in the picker", async () => {
  const slowPicker = setup({ pick: async (list) => { await tick(80); return list[0] ?? null; } });
  await init(slowPicker.service);
  const ok = await slowPicker.service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 40 });
  assert.equal(ok.ok, true, "a slow user is fine");

  const slowLaunch = setup({ tweak: (c) => { c.launchDelayMs = 200; } });
  await init(slowLaunch.service);
  const r = await slowLaunch.service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 40 });
  assert.equal(!r.ok && r.code, "timeout");
});

test("a second requestSession from the same sender while one is open is invalid_parameter", async () => {
  const { service } = setup({ pick: async (list) => { await tick(30); return list[0] ?? null; } });
  await init(service);
  const first = service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  const second = await service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  assert.equal(!second.ok && second.code, "invalid_parameter");
  assert.equal((await first).ok, true);
});

test("one client per device is reused across sessions", async () => {
  const { service, clients } = setup();
  await session(service, PAGE);
  await session(service, PAGE2);
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0]?.calls.filter((c) => c === "connect"), ["connect"]);
});

test("sendMessage goes to the session's transport; unknown sessions are session_error", async () => {
  const { service, clients } = setup();
  const s = await session(service);
  const r = await service.handle(PAGE, "sendMessage", { sessionId: s.sessionId, namespace: MDX, message: '{"type":"getMdxSessionStatus"}' });
  assert.deepEqual(r, { ok: true, value: undefined });
  assert.deepEqual(clients[0]?.sent, [{ namespace: MDX, destinationId: s.transportId, payload: '{"type":"getMdxSessionStatus"}' }]);
  const r2 = await service.handle(PAGE, "sendMessage", { sessionId: "nope", namespace: MDX, message: "x" });
  assert.equal(!r2.ok && r2.code, "session_error");
});

test("a sender that is not part of a session cannot use it", async () => {
  const { service } = setup();
  const s = await session(service, PAGE);
  await init(service, PAGE2, { autoJoinPolicy: "page_scoped" });
  const r = await service.handle(PAGE2, "sendMessage", { sessionId: s.sessionId, namespace: MDX, message: "x" });
  assert.equal(!r.ok && r.code, "session_error");
});

test("a send failure on a dead client is channel_error", async () => {
  const { service, clients } = setup();
  const s = await session(service);
  if (clients[0]) clients[0].connected = false;
  const r = await service.handle(PAGE, "sendMessage", { sessionId: s.sessionId, namespace: MDX, message: "x" });
  assert.equal(!r.ok && r.code, "channel_error");
});

test("app messages from the session transport reach the session's senders", async () => {
  const { service, clients, log } = setup();
  const s = await session(service);
  clients[0]?.pushMessage(s.transportId, MDX, '{"type":"mdxSessionStatus"}');
  clients[0]?.pushMessage("some-other-transport", MDX, "ignored");
  clients[0]?.pushMessage(s.transportId, MDX, Buffer.from([1]));
  assert.deepEqual(log.of(PAGE.id, "message"), [{ type: "message", sessionId: s.sessionId, namespace: MDX, message: '{"type":"mdxSessionStatus"}' }]);
});

test("receiver status changes update or end sessions", async () => {
  const { service, clients, log } = setup();
  const s = await session(service);
  const c = clients[0]!;
  log.clear();
  c.pushStatus(); // nothing changed
  assert.deepEqual(log.of(PAGE.id), []);
  c.volume.level = 0.9;
  c.apps[0]!.statusText = "Now playing";
  c.pushStatus();
  const updates = log.of(PAGE.id, "sessionUpdated");
  assert.equal(updates.length, 1);
  const u = updates[0] as { session: SessionSnapshot };
  assert.equal(u.session.statusText, "Now playing");
  assert.equal(u.session.receiver.volume.level, 0.9);
  c.apps = [];
  c.pushStatus();
  assert.deepEqual(log.of(PAGE.id, "sessionEnded"), [{ type: "sessionEnded", sessionId: s.sessionId, status: "stopped" }]);
  const r = await service.handle(PAGE, "sendMessage", { sessionId: s.sessionId, namespace: MDX, message: "x" });
  assert.equal(!r.ok && r.code, "session_error", "an ended session is gone");
});

test("a dropped device connection disconnects its sessions", async () => {
  const { service, clients, log } = setup();
  const s = await session(service);
  clients[0]?.fail();
  assert.deepEqual(log.of(PAGE.id, "sessionEnded"), [{ type: "sessionEnded", sessionId: s.sessionId, status: "disconnected" }]);
  await session(service);
  assert.equal(clients.length, 2, "a new client replaces the dead one");
});

test("a transport closed by the receiver disconnects that session", async () => {
  const { service, clients, log } = setup();
  const s = await session(service);
  clients[0]?.emit("transportClosed", s.transportId);
  assert.deepEqual(log.of(PAGE.id, "sessionEnded"), [{ type: "sessionEnded", sessionId: s.sessionId, status: "disconnected" }]);
});

test("stopSession stops the app, tells other senders, and closes the idle client", async () => {
  const { service, clients, log } = setup();
  const s = await session(service, PAGE);
  await init(service, PAGE2); // origin_scoped: auto-joins
  const r = await service.handle(PAGE, "stopSession", { sessionId: s.sessionId });
  assert.deepEqual(r, { ok: true, value: undefined });
  assert.ok(clients[0]?.calls.includes(`stop ${s.sessionId}`));
  assert.deepEqual(log.of(PAGE2.id, "sessionEnded"), [{ type: "sessionEnded", sessionId: s.sessionId, status: "stopped" }]);
  assert.deepEqual(log.of(PAGE.id, "sessionEnded"), [], "the caller learns from its own callback");
  assert.ok(clients[0]?.closed);
});

test("leaveSession detaches the sender but leaves the app running", async () => {
  const { service, clients } = setup();
  const s = await session(service);
  const r = await service.handle(PAGE, "leaveSession", { sessionId: s.sessionId });
  assert.deepEqual(r, { ok: true, value: undefined });
  assert.ok(!clients[0]?.calls.some((c) => c.startsWith("stop ")));
  assert.ok(clients[0]?.calls.includes(`closeTransport ${s.transportId}`));
  assert.ok(clients[0]?.closed, "no sessions left on the device");
  const again = await service.handle(PAGE, "sendMessage", { sessionId: s.sessionId, namespace: MDX, message: "x" });
  assert.equal(!again.ok && again.code, "session_error");
});

test("receiver volume and mute", async () => {
  const { service, clients } = setup();
  const s = await session(service);
  assert.deepEqual(await service.handle(PAGE, "setReceiverVolume", { sessionId: s.sessionId, level: 0.25 }), { ok: true, value: undefined });
  assert.deepEqual(await service.handle(PAGE, "setReceiverMuted", { sessionId: s.sessionId, muted: true }), { ok: true, value: undefined });
  assert.deepEqual(clients[0]?.calls.filter((c) => c.startsWith("volume")), ['volume {"level":0.25}', 'volume {"muted":true}']);
  const bad = await service.handle(PAGE, "setReceiverVolume", { sessionId: s.sessionId, level: 2 });
  assert.equal(!bad.ok && bad.code, "invalid_parameter");
});

test("auto-join follows the policy", async () => {
  const { service } = setup();
  const s = await session(service, PAGE);
  const origin = await init(service, PAGE2, { autoJoinPolicy: "origin_scoped" });
  assert.deepEqual(origin.ok && (origin.value as { sessions: SessionSnapshot[] }).sessions.map((x) => x.sessionId), [s.sessionId]);
  const tab = await init(service, { id: 9, origin: PAGE.origin }, { autoJoinPolicy: "tab_and_origin_scoped" });
  assert.deepEqual(tab.ok && (tab.value as { sessions: unknown[] }).sessions, []);
  const tabSame = await init(service, PAGE, { autoJoinPolicy: "tab_and_origin_scoped" });
  assert.deepEqual(tabSame.ok && (tabSame.value as { sessions: SessionSnapshot[] }).sessions.map((x) => x.sessionId), [s.sessionId]);
  const page = await init(service, { id: 10, origin: PAGE.origin }, { autoJoinPolicy: "page_scoped" });
  assert.deepEqual(page.ok && (page.value as { sessions: unknown[] }).sessions, []);
  const otherApp = await init(service, { id: 11, origin: PAGE.origin }, { appId: "CC1AD845", autoJoinPolicy: "origin_scoped" });
  assert.deepEqual(otherApp.ok && (otherApp.value as { sessions: unknown[] }).sessions, []);
  const otherOrigin = await init(service, { id: 12, origin: "https://www.youtube.com" }, { autoJoinPolicy: "origin_scoped" });
  assert.deepEqual(otherOrigin.ok && (otherOrigin.value as { sessions: unknown[] }).sessions, []);
});

test("joinSession attaches a same-origin sender", async () => {
  const { service } = setup();
  const s = await session(service, PAGE);
  await init(service, PAGE2, { autoJoinPolicy: "page_scoped" });
  const r = await service.handle(PAGE2, "joinSession", { sessionId: s.sessionId });
  assert.equal(r.ok && (r.value as SessionSnapshot).sessionId, s.sessionId);
  assert.deepEqual(await service.handle(PAGE2, "sendMessage", { sessionId: s.sessionId, namespace: MDX, message: "x" }), { ok: true, value: undefined });
  await init(service, { id: 12, origin: "https://www.youtube.com" });
  const cross = await service.handle({ id: 12, origin: "https://www.youtube.com" }, "joinSession", { sessionId: s.sessionId });
  assert.equal(!cross.ok && cross.code, "session_error");
});

test("receiver availability events follow device changes, per sender and only on change", async () => {
  const devices = new FakeDevices([SPEAKER]);
  const { service, log } = setup({ devices });
  await init(service, PAGE, { capabilities: ["video_out"] });
  await init(service, PAGE2, { capabilities: ["audio_out"] });
  log.clear();
  devices.up(TV);
  assert.deepEqual(log.of(PAGE.id, "receiverAvailability"), [{ type: "receiverAvailability", available: true }]);
  assert.deepEqual(log.of(PAGE2.id, "receiverAvailability"), [], "PAGE2 already had the speaker");
  devices.up(device({ id: "dev-tv2", name: "Second TV" }));
  assert.equal(log.of(PAGE.id, "receiverAvailability").length, 1, "no repeat while still available");
  devices.down(TV);
  devices.down({ ...TV, id: "dev-tv2" });
  assert.deepEqual(log.of(PAGE.id, "receiverAvailability").at(-1), { type: "receiverAvailability", available: false });
});

test("senderGone detaches the sender everywhere", async () => {
  const { service, clients, log } = setup();
  const s = await session(service);
  service.senderGone(PAGE.id);
  assert.ok(clients[0]?.calls.includes(`closeTransport ${s.transportId}`));
  assert.ok(clients[0]?.closed);
  log.clear();
  clients[0]?.pushMessage(s.transportId, MDX, "late");
  assert.deepEqual(log.events, []);
});

test("dispose closes every client and stops listening for devices", async () => {
  const devices = new FakeDevices();
  const { service, clients, log } = setup({ devices });
  await session(service);
  await service.dispose();
  assert.ok(clients.every((c) => c.closed));
  log.clear();
  devices.down(TV);
  devices.down(SPEAKER);
  devices.down(GROUP);
  assert.deepEqual(log.events, []);
  assert.equal(devices.listenerCount("deviceUp") + devices.listenerCount("deviceDown") + devices.listenerCount("deviceChanged"), 0);
});

// ---------------------------------------------------------------------------------------------------------------
// Against a client that behaves like CastClient: replies that carry a status are also emitted as receiverStatus
// (synchronously, before the call resolves), and launch() rejects until connect() has finished.

const echo = (c: FakeClient) => (c.echoReplies = true);

test("echoing client: requestSession succeeds and the client stays open", async () => {
  const { service, clients } = setup({ tweak: echo });
  const s = await session(service);
  assert.equal(s.sessionId, `${TV.id}-session-1`);
  assert.equal(clients.length, 1);
  assert.equal(clients[0]?.closed, false);
  assert.ok(!clients[0]?.calls.includes("close"));
  const r = await service.handle(PAGE, "sendMessage", { sessionId: s.sessionId, namespace: MDX, message: "{}" });
  assert.deepEqual(r, { ok: true, value: undefined });
});

test("echoing client: stopSession ends the session once, never for the caller, and closes the client once", async () => {
  const { service, clients, log } = setup({ tweak: echo });
  const s = await session(service, PAGE);
  await init(service, PAGE2); // origin_scoped: auto-joins
  log.clear();
  const r = await service.handle(PAGE, "stopSession", { sessionId: s.sessionId });
  assert.deepEqual(r, { ok: true, value: undefined });
  assert.deepEqual(log.of(PAGE.id, "sessionEnded"), []);
  assert.deepEqual(log.of(PAGE2.id, "sessionEnded"), [{ type: "sessionEnded", sessionId: s.sessionId, status: "stopped" }]);
  assert.equal(clients[0]?.calls.filter((c) => c === "close").length, 1);
});

test("echoing client: a volume change is pushed as sessionUpdated", async () => {
  const { service, log } = setup({ tweak: echo });
  const s = await session(service);
  log.clear();
  await service.handle(PAGE, "setReceiverVolume", { sessionId: s.sessionId, level: 0.25 });
  const updates = log.of(PAGE.id, "sessionUpdated") as { type: "sessionUpdated"; session: SessionSnapshot }[];
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.session.receiver.volume.level, 0.25);
});

test("two requests for the same device share one client and one connect", async () => {
  const { service, clients } = setup({ tweak: (c) => ((c.connectDelayMs = 20), echo(c)) });
  await init(service, PAGE, { autoJoinPolicy: "page_scoped" });
  await init(service, PAGE2, { autoJoinPolicy: "page_scoped" });
  const req = { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 };
  const [a, b] = await Promise.all([service.handle(PAGE, "requestSession", req), service.handle(PAGE2, "requestSession", req)]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(clients.length, 1);
  assert.equal(clients[0]?.calls.filter((c) => c === "connect").length, 1);
  assert.equal(clients[0]?.closed, false);
});

test("a connect failure fails every request waiting on it, and the next request makes a new client", async () => {
  let made = 0;
  const { service, clients } = setup({
    tweak: (c) => {
      c.connectDelayMs = 20;
      if (made++ === 0) c.connectError = new Error("ECONNREFUSED");
    },
  });
  await init(service, PAGE);
  await init(service, PAGE2);
  const req = { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 };
  const [a, b] = await Promise.all([service.handle(PAGE, "requestSession", req), service.handle(PAGE2, "requestSession", req)]);
  assert.equal(!a.ok && a.code, "receiver_unavailable");
  assert.equal(!b.ok && b.code, "receiver_unavailable");
  assert.equal(clients.length, 1);
  const c = await service.handle(PAGE, "requestSession", req);
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(clients.length, 2);
});

test("senderGone while its request is launching: the late session is torn down", async () => {
  const { service, clients, log } = setup({ tweak: (c) => ((c.launchDelayMs = 20), echo(c)) });
  await init(service, PAGE);
  const pending = service.handle(PAGE, "requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 });
  await tick(5);
  service.senderGone(PAGE.id);
  const r = await pending;
  assert.equal(!r.ok && r.code, "cancel");
  assert.ok(clients[0]?.calls.includes(`closeTransport ${TV.id}-transport-1`));
  assert.equal(clients[0]?.closed, true);
  await init(service, PAGE2);
  const join = await service.handle(PAGE2, "joinSession", { sessionId: `${TV.id}-session-1` });
  assert.equal(!join.ok && join.code, "session_error");
  assert.deepEqual(log.of(PAGE.id, "sessionEnded"), []);
});

// --- The picker and the sender's current session (like Chrome's cast dialog: the current device, and "Stop casting").

const REQ = { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 };

test("the picker is told about the sender's current session for that app, and nothing when there is none", async () => {
  const { service, picks } = setup();
  const s = await session(service, PAGE);
  assert.equal("session" in (picks[0]?.req ?? {}), false, "no session key at all on a first request");
  await service.handle(PAGE, "requestSession", REQ);
  assert.deepEqual(picks[1]?.req.session, { sessionId: s.sessionId, deviceId: TV.id });
  await service.handle(PAGE, "requestSession", { ...REQ, appId: "CC1AD845" });
  assert.equal("session" in (picks[2]?.req ?? {}), false, "a session of another app does not count");
});

test("another sender's session is not this sender's current session", async () => {
  const { service, picks } = setup();
  await session(service, PAGE);
  await init(service, PAGE2, { autoJoinPolicy: "page_scoped" }); // does not join
  await service.handle(PAGE2, "requestSession", { ...REQ });
  assert.equal("session" in (picks[1]?.req ?? {}), false);
});

test("picking the current session's device returns that session without launching again", async () => {
  const { service, clients } = setup({ tweak: (c) => (c.echoReplies = true) });
  const s = await session(service, PAGE);
  const r = await service.handle(PAGE, "requestSession", REQ);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.ok && (r.value as SessionSnapshot).sessionId, s.sessionId);
  assert.equal(clients.length, 1);
  assert.deepEqual(clients[0]?.calls.filter((c) => c.startsWith("launch")), [`launch ${YT}`]);
  assert.equal(clients[0]?.closed, false);
});

for (const echo of [false, true]) {
  test(`"stop" from the picker stops the current session, tells every member including the caller, and cancels (echo ${echo})`, async () => {
    const { service, clients, log } = setup({
      tweak: (c) => (c.echoReplies = echo),
      pick: (list, req) => (req.session ? "stop" : (list.find((d) => d.id === TV.id) ?? null)),
    });
    const s = await session(service, PAGE);
    await init(service, PAGE2); // origin_scoped: auto-joins
    const r = await service.handle(PAGE, "requestSession", REQ);
    assert.deepEqual(r, { ok: false, code: "cancel" });
    assert.deepEqual(clients[0]?.calls.filter((c) => c.startsWith("stop")), [`stop ${s.sessionId}`]);
    const stop = { type: "receiverAction", sessionId: s.sessionId, action: "stop" };
    assert.deepEqual(log.of(PAGE.id, "receiverAction"), [stop], "the caller hears the stop before the session ends");
    assert.deepEqual(log.of(PAGE2.id, "receiverAction"), [], "only the caller gets the receiverAction event");
    const ended = { type: "sessionEnded", sessionId: s.sessionId, status: "stopped" };
    assert.deepEqual(log.of(PAGE.id, "sessionEnded"), [ended], "the caller did not call stop itself, so it is told");
    assert.deepEqual(log.of(PAGE2.id, "sessionEnded"), [ended]);
    assert.equal(clients[0]?.calls.filter((c) => c === "close").length, 1, "the idle client is closed once");
    const again = await service.handle(PAGE, "sendMessage", { sessionId: s.sessionId, namespace: MDX, message: "x" });
    assert.equal(again.ok, false, "the session is gone");
  });
}

test('"stop" with no current session just cancels, with no client', async () => {
  const { service, clients } = setup({ pick: () => "stop" });
  await init(service);
  assert.deepEqual(await service.handle(PAGE, "requestSession", REQ), { ok: false, code: "cancel" });
  assert.equal(clients.length, 0);
});

test('a failed "stop" from the picker is session_error and the session stays', async () => {
  const { service, log } = setup({
    tweak: (c) => {
      c.stop = async () => {
        throw new Error("device said no");
      };
    },
    pick: (list, req) => (req.session ? "stop" : (list.find((d) => d.id === TV.id) ?? null)),
  });
  const s = await session(service, PAGE);
  assert.deepEqual(await service.handle(PAGE, "requestSession", REQ), { ok: false, code: "session_error", description: "device said no" });
  assert.deepEqual(log.of(PAGE.id, "sessionEnded"), []);
  const msg = await service.handle(PAGE, "sendMessage", { sessionId: s.sessionId, namespace: MDX, message: "x" });
  assert.equal(msg.ok, true, "the session still works");
});
