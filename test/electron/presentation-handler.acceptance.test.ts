// Acceptance tests for the presentation handler (written before the implementation; do not edit to make them pass).
// Spec: docs/upstream/research/presentation-mode-spec.md, sections 2 and 3. The handler runs on top of the real
// CastSessionService with the fake devices and fake Cast client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CastSessionService, type CastRequestInfo, type DeviceChoice } from "../../src/electron/session-service.ts";
import { CastPresentationHandler, type PresentationConnectionHandle } from "../../src/electron/presentation-handler.ts";
import { MEDIA_NAMESPACE, escapeHtml, receiverLabel } from "../../src/electron/presentation-envelope.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import { FakeDevices, FakeClient, TV, tick, FAST_SINKS, waitForSinks } from "./fakes.ts";

const YT = "233637DE";
const MDX = "urn:x-cast:com.google.youtube.mdx";
const PAGE = { id: 1, origin: "https://music.youtube.com" };
const PAGE2 = { id: 2, origin: "https://music.youtube.com" };
const URL_O = `https://google.com/cast#__castAppId__=${YT}/__castClientId__=c1/__castAutoJoinPolicy__=origin_scoped`;
const URL_P = `https://google.com/cast#__castAppId__=${YT}/__castClientId__=c1/__castAutoJoinPolicy__=page_scoped`;

function setup(o: { devices?: FakeDevices; pick?: (l: CastDevice[], r: CastRequestInfo) => DeviceChoice } = {}) {
  const devices = o.devices ?? new FakeDevices();
  const clients: FakeClient[] = [];
  let handler: CastPresentationHandler | undefined;
  const service = waitForSinks(new CastSessionService({
    sinks: { ...FAST_SINKS, retry: { maxAttempts: 1 } },
    devices,
    createClient: (d) => {
      const c = new FakeClient(d);
      if (devices.unreachable.has(d.id)) c.connectError = new Error("unreachable");
      const launch = c.launch.bind(c);
      c.launch = async (id: string) => {
        const app = await launch(id);
        app.namespaces.push({ name: MEDIA_NAMESPACE });
        return app;
      };
      clients.push(c);
      return c;
    },
    selectDevice: async (list, req) => (o.pick ? o.pick(list, req) : (list.find((d) => d.id === TV.id) ?? null)),
    emit: (id, ev) => handler?.onServiceEvent(id, ev),
  }));
  handler = new CastPresentationHandler({ service, token: "tok" });
  return { service, handler, devices, clients };
}

const req = (url = URL_O, sender = PAGE) => ({ urls: [url], origin: sender.origin, senderId: sender.id });

function open(conn: PresentationConnectionHandle) {
  const got: any[] = [];
  const closes: string[] = [];
  conn.onmessage = (data: string) => got.push(JSON.parse(data));
  conn.onclose = (reason: string) => closes.push(reason);
  return { got, closes };
}

async function started(h: ReturnType<typeof setup>, url = URL_O) {
  const conn = await h.handler.startPresentation(req(url));
  const { got, closes } = open(conn);
  const session = got.find((m) => m.type === "new_session").message;
  return { conn, got, closes, sid: session.sessionId as string, transport: session.transportId as string, client: h.clients[0]! };
}

const out = (conn: PresentationConnectionHandle, o: Record<string, unknown>) =>
  conn.send(JSON.stringify({ timeoutMillis: 3000, clientId: "c1", ...o }));

test("getAvailability reports devices and calls onchange when they change, until aborted", async () => {
  const devices = new FakeDevices([]);
  const h = setup({ devices });
  const changes: boolean[] = [];
  const kept: boolean[] = [];
  const ac = new AbortController();
  assert.equal(await h.handler.getAvailability({ ...req(), onchange: (v: boolean) => changes.push(v), signal: ac.signal }), false);
  // the positive control: a watch that is never aborted
  await h.handler.getAvailability({ ...req(), onchange: (v: boolean) => kept.push(v), signal: new AbortController().signal });
  devices.up(TV);
  await h.service.settled();
  assert.deepEqual(changes, [true]);
  ac.abort();
  // the TV genuinely leaves: its channel fails and cannot be reopened (Chrome drops a sink only then)
  devices.unreachable.add(TV.id);
  h.clients.find((c) => c.device.id === TV.id)!.fail();
  await h.service.settled();
  assert.deepEqual(kept, [true, false], "without the abort the same step reports the loss");
  assert.deepEqual(changes, [true], "no change after abort");
  assert.equal(await h.handler.getAvailability({ ...req("https://example.test/"), onchange: () => {}, signal: new AbortController().signal }), false);
});

test("startPresentation launches and queues receiver_action cast then new_session until onmessage is set", async () => {
  const h = setup();
  const conn = await h.handler.startPresentation(req());
  assert.equal(conn.url, URL_O);
  assert.match(conn.id, /^cast-session_/);
  const { got } = open(conn);
  assert.deepEqual(got.map((m) => m.type), ["receiver_action", "new_session"]);
  assert.ok(got.every((m) => m.clientId === "c1" && m.timeoutMillis === 0 && !("sequenceNumber" in m)));
  const s = got[1].message;
  assert.equal(conn.id, `cast-session_${s.sessionId}`);
  assert.equal(s.appId, YT);
  assert.equal(s.receiver.label, receiverLabel(TV.id, "tok"));
  assert.equal(s.receiver.friendlyName, escapeHtml(TV.name));
  assert.equal(s.receiver.receiverType, "cast");
  assert.ok(s.namespaces.some((n: { name: string }) => n.name === MEDIA_NAMESPACE));
  assert.deepEqual(got[0].message, { receiver: s.receiver, action: "cast" });
  const gs = h.clients[0]!.sent.find((x) => x.namespace === MEDIA_NAMESPACE);
  assert.ok(gs, "a GET_STATUS goes to the receiver");
  assert.equal(gs.destinationId, s.transportId);
  const body = JSON.parse(gs.payload as string);
  assert.equal(body.type, "GET_STATUS");
  assert.ok(Number.isInteger(body.requestId) && body.requestId > 0);
});

test("startPresentation errors carry DOMException names", async () => {
  await assert.rejects(setup({ pick: () => null }).handler.startPresentation(req()), { name: "AbortError" });
  await assert.rejects(setup({ devices: new FakeDevices([]) }).handler.startPresentation(req()), { name: "NotFoundError" });
  await assert.rejects(setup().handler.startPresentation(req("https://example.test/")), { name: "NotSupportedError" });
});

test("app messages go to the receiver and are acked; bad ones are refused or dropped", async () => {
  const h = setup();
  const { conn, got, sid, transport, client } = await started(h);
  out(conn, { type: "client_connect", message: "c1", sequenceNumber: -1 });
  out(conn, { type: "app_message", message: { sessionId: sid, namespaceName: MDX, message: "hi" }, sequenceNumber: 3 });
  await tick();
  assert.deepEqual(client.sent.at(-1), { namespace: MDX, destinationId: transport, payload: "hi" });
  assert.deepEqual(got.at(-1), { type: "app_message", message: null, sequenceNumber: 3, timeoutMillis: 0, clientId: "c1" });
  out(conn, { type: "app_message", message: { sessionId: sid, namespaceName: MDX, message: { a: 1 } }, sequenceNumber: 4 });
  await tick();
  assert.equal(client.sent.at(-1)?.payload, '{"a":1}');
  out(conn, { type: "app_message", message: { sessionId: sid, namespaceName: "urn:x-cast:other", message: "x" }, sequenceNumber: 5 });
  await tick();
  assert.deepEqual(got.at(-1), {
    type: "error", message: { code: "invalid_parameter", description: "Invalid namespace: urn:x-cast:other", details: null },
    sequenceNumber: 5, timeoutMillis: 0, clientId: "c1",
  });
  const sent = client.sent.length;
  const replies = got.length;
  out(conn, { type: "app_message", message: { sessionId: sid, namespaceName: MDX, message: "x" }, sequenceNumber: 6, clientId: "other" });
  out(conn, { type: "app_message", message: { sessionId: "nope", namespaceName: MDX, message: "x" }, sequenceNumber: 7 });
  conn.send("not json");
  await tick();
  assert.equal(client.sent.length, sent, "nothing sent");
  assert.equal(got.length, replies, "no reply");
});

test("receiver app messages reach the page as app_message", async () => {
  const h = setup();
  const { got, sid, transport, client } = await started(h);
  client.pushMessage(transport, MDX, "yo");
  await tick();
  assert.deepEqual(got.at(-1), { type: "app_message", message: { sessionId: sid, namespaceName: MDX, message: "yo" }, timeoutMillis: 0, clientId: "c1" });
});

test("media requests get fresh request ids and replies map back to their sequence numbers", async () => {
  const h = setup();
  const { conn, got, sid, transport, client } = await started(h);
  out(conn, { type: "v2_message", message: { type: "PAUSE", requestId: 0, sessionId: sid, mediaSessionId: 1, customData: null }, sequenceNumber: 7 });
  await tick();
  const pause = JSON.parse(client.sent.at(-1)!.payload as string);
  assert.equal(client.sent.at(-1)!.namespace, MEDIA_NAMESPACE);
  assert.equal(client.sent.at(-1)!.destinationId, transport);
  assert.equal(pause.type, "PAUSE");
  assert.equal(pause.sessionId, sid);
  assert.equal(pause.mediaSessionId, 1);
  assert.ok(Number.isInteger(pause.requestId) && pause.requestId > 0);
  assert.ok(!("customData" in pause), "nulls are stripped");

  client.pushMessage(transport, MEDIA_NAMESPACE, JSON.stringify({
    type: "MEDIA_STATUS", requestId: pause.requestId,
    status: [{ mediaSessionId: 1, playerState: "PAUSED", currentTime: 12, supportedMediaCommands: 3 }],
  }));
  await tick();
  assert.deepEqual(got.at(-1), {
    type: "v2_message", sequenceNumber: 7, timeoutMillis: 0, clientId: "c1",
    message: { type: "MEDIA_STATUS", requestId: pause.requestId,
      status: [{ mediaSessionId: 1, playerState: "PAUSED", currentTime: 12, supportedMediaCommands: ["pause", "seek"], sessionId: sid }] },
  });

  client.pushMessage(transport, MEDIA_NAMESPACE, JSON.stringify({ type: "MEDIA_STATUS", requestId: 0, status: [{ mediaSessionId: 1, playerState: "PLAYING" }] }));
  await tick();
  assert.equal(got.at(-1).type, "v2_message");
  assert.ok(!("sequenceNumber" in got.at(-1)), "unsolicited status has no sequence number");
  assert.equal(got.at(-1).message.status[0].sessionId, sid);

  out(conn, { type: "v2_message", message: { type: "STOP_MEDIA", requestId: 0, sessionId: sid, mediaSessionId: 1 }, sequenceNumber: 8 });
  await tick();
  const stop = JSON.parse(client.sent.at(-1)!.payload as string);
  assert.equal(stop.type, "STOP");
  client.pushMessage(transport, MEDIA_NAMESPACE, JSON.stringify({ type: "INVALID_REQUEST", requestId: stop.requestId, reason: "INVALID_COMMAND" }));
  await tick();
  assert.deepEqual(got.at(-1), { type: "v2_message", message: { type: "INVALID_REQUEST", requestId: stop.requestId, reason: "INVALID_COMMAND" }, sequenceNumber: 8, timeoutMillis: 0, clientId: "c1" });

  const n = got.length;
  client.pushMessage(transport, MEDIA_NAMESPACE, JSON.stringify({ type: "LOAD_FAILED", requestId: 999999 }));
  await tick();
  assert.equal(got.length, n, "an unmatched non-status reply is dropped");
});

test("SET_VOLUME and STOP are acked; STOP then ends the session for the page", async () => {
  const h = setup();
  const { conn, got, closes, sid, client } = await started(h);
  out(conn, { type: "v2_message", message: { type: "SET_VOLUME", requestId: 0, sessionId: sid, volume: { level: 0.2, muted: null }, expectedVolume: null }, sequenceNumber: 9 });
  await tick();
  assert.ok(client.calls.includes('volume {"level":0.2}'), client.calls.join("|"));
  assert.deepEqual(got.at(-1), { type: "v2_message", message: null, sequenceNumber: 9, timeoutMillis: 0, clientId: "c1" });
  out(conn, { type: "v2_message", message: { type: "SET_VOLUME", requestId: 0, sessionId: sid, volume: { muted: true } }, sequenceNumber: 10 });
  await tick();
  assert.ok(client.calls.includes('volume {"muted":true}'));
  assert.equal(got.at(-1).sequenceNumber, 10);

  out(conn, { type: "v2_message", message: { type: "STOP", requestId: 0, sessionId: sid }, sequenceNumber: 11 });
  await tick(5);
  assert.ok(client.calls.includes(`stop ${sid}`));
  const tail = got.slice(-2);
  assert.deepEqual(tail[0], { type: "v2_message", message: null, sequenceNumber: 11, timeoutMillis: 0, clientId: "c1" });
  assert.deepEqual(tail[1], { type: "remove_session", message: sid, timeoutMillis: 0, clientId: "c1" });
  assert.equal(got.filter((m) => m.type === "remove_session").length, 1);
  assert.deepEqual(closes, ["terminated"]);
});

test("leave_session is acked first, then the connection closes", async () => {
  const h = setup();
  const { conn, got, closes, sid } = await started(h);
  out(conn, { type: "leave_session", message: sid, sequenceNumber: 12 });
  await tick();
  assert.deepEqual(got.at(-1), { type: "leave_session", message: null, sequenceNumber: 12, timeoutMillis: 0, clientId: "c1" });
  assert.deepEqual(closes, ["closed"]);
  assert.equal((await h.service.handle(PAGE, "sendMessage", { sessionId: sid, namespace: MDX, message: "x" })).ok, false, "the page left the session");
});

test("receiver status changes become update_session; the receiver ending the session becomes remove_session", async () => {
  const h = setup();
  const { conn, got, closes, sid, client } = await started(h);
  client.volume.level = 0.9;
  client.pushStatus();
  await tick();
  assert.equal(got.at(-1).type, "update_session");
  assert.equal(got.at(-1).message.sessionId, sid);
  assert.equal(got.at(-1).message.receiver.volume.level, 0.9);
  client.apps = [];
  client.pushStatus();
  await tick();
  assert.deepEqual(got.at(-1), { type: "remove_session", message: sid, timeoutMillis: 0, clientId: "c1" });
  assert.deepEqual(closes, ["terminated"]);
  const n = got.length;
  out(conn, { type: "app_message", message: { sessionId: sid, namespaceName: MDX, message: "x" }, sequenceNumber: 13 });
  await tick();
  assert.equal(got.length, n, "a closed connection ignores sends");
});

test("a lost device connection becomes disconnect_session", async () => {
  const h = setup();
  const { got, closes, sid, client } = await started(h);
  client.fail();
  await tick();
  assert.deepEqual(got.at(-1), { type: "disconnect_session", message: sid, timeoutMillis: 0, clientId: "c1" });
  assert.deepEqual(closes, ["closed"]);
});

test("choosing stop in the picker sends receiver_action stop and ends the session", async () => {
  const h = setup({ pick: (l, r) => (r.session ? "stop" : (l.find((d) => d.id === TV.id) ?? null)) });
  const { got, closes, sid } = await started(h);
  await assert.rejects(h.handler.startPresentation(req()), { name: "AbortError" });
  const tail = got.slice(-2);
  assert.equal(tail[0].type, "receiver_action");
  assert.equal(tail[0].message.action, "stop");
  assert.deepEqual(tail[1], { type: "remove_session", message: sid, timeoutMillis: 0, clientId: "c1" });
  assert.deepEqual(closes, ["terminated"]);
});

test("reconnect: auto-join follows the URL's policy, cast-session_<id> joins, _receiver-action is refused", async () => {
  const h = setup();
  const { sid } = await started(h);
  await assert.rejects(h.handler.reconnectPresentation({ ...req(URL_P, PAGE2), presentationId: "auto-join" }), { name: "NotFoundError" });
  await assert.rejects(h.handler.reconnectPresentation({ ...req(URL_O, PAGE2), presentationId: "_receiver-action" }), { name: "NotFoundError" });
  const joined = await h.handler.reconnectPresentation({ ...req(URL_O, PAGE2), presentationId: "auto-join" });
  const a = open(joined);
  assert.deepEqual(a.got.map((m) => m.type), ["new_session"], "auto-join sends new_session only");
  assert.equal(a.got[0].message.sessionId, sid);

  const PAGE3 = { id: 3, origin: PAGE.origin };
  const byId = await h.handler.reconnectPresentation({ ...req(URL_P, PAGE3), presentationId: `cast-session_${sid}` });
  const b = open(byId);
  assert.deepEqual(b.got.map((m) => m.type), ["new_session"]);
  assert.equal(b.got[0].message.sessionId, sid);
  await assert.rejects(h.handler.reconnectPresentation({ ...req(URL_P, PAGE3), presentationId: "cast-session_unknown" }), { name: "NotFoundError" });
});

test("after a reload the page's auto-join gets its session back, and messages flow again", async () => {
  const h = setup();
  const { closes, transport, client } = await started(h);
  h.handler.senderGone(PAGE.id);
  h.service.senderNavigated(PAGE.id);
  assert.deepEqual(closes, ["closed"]);
  const back = await h.handler.reconnectPresentation({ ...req(URL_O, PAGE), presentationId: "auto-join" });
  const b = open(back);
  assert.deepEqual(b.got.map((m) => m.type), ["new_session"]);
  client.pushMessage(transport, MDX, '{"type":"x"}');
  await tick();
  assert.equal(b.got.at(-1)?.type, "app_message");
});

test("senderGone closes the sender's connections and later events are ignored", async () => {
  const h = setup();
  const { got, closes, transport, client } = await started(h);
  h.handler.senderGone(PAGE.id);
  h.service.senderGone(PAGE.id);
  assert.deepEqual(closes, ["closed"]);
  const n = got.length;
  client.pushMessage(transport, MDX, "late");
  await tick();
  assert.equal(got.length, n);
});
