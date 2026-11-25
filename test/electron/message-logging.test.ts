// CastMessageLogging (media_router_feature.cc kCastMessageLogging): the messages of a Cast route in the media router log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MediaRouterLogger } from "../../src/electron/logger.ts";
import { CastMessageLog, castMessageToDebugString, isCastReservedNamespace, writeJson } from "../../src/electron/message-logging.ts";
import { castMessageLogging, type CommandLineLike } from "../../src/electron/switches.ts";
import { CastSessionService } from "../../src/electron/session-service.ts";
import { CastPresentationHandler, type PresentationConnectionHandle } from "../../src/electron/presentation-handler.ts";
import { MEDIA_NAMESPACE } from "../../src/electron/presentation-envelope.ts";
import { FakeDevices, FakeClient, TV, tick, FAST_SINKS, waitForSinks } from "./fakes.ts";

const RECEIVER_NS = "urn:x-cast:com.google.cast.receiver";
const MDX = "urn:x-cast:com.google.youtube.mdx";
const YT = "233637DE";
const URL1 = `https://google.com/cast#__castAppId__=${YT}/__castClientId__=c1/__castAutoJoinPolicy__=origin_scoped`;

const line = (values: Record<string, string>): CommandLineLike => ({
  hasSwitch: (name) => name in values,
  getSwitchValue: (name) => values[name] ?? "",
});

test("the CastMessageLogging feature is off by default, on with --enable-features, and off again when disabled too", () => {
  assert.equal(castMessageLogging(undefined), false);
  assert.equal(castMessageLogging(line({})), false);
  assert.equal(castMessageLogging(line({ "enable-features": "Other,CastMessageLogging" })), true);
  assert.equal(castMessageLogging(line({ "enable-features": "CastMessageLogging", "disable-features": "CastMessageLogging" })), false);
});

test("writeJson writes what base::WriteJson does: sorted keys, < escaped, at most 10 containers deep", () => {
  assert.equal(writeJson({ b: 1, a: "x<y", c: [true, null, 1.5, 3000000000] }), '{"a":"x\\u003Cy","b":1,"c":[true,null,1.5,3000000000.0]}');
  assert.equal(writeJson("a \n"), '"a\\u2028\\n"');
  let ok: unknown = 1;
  for (let i = 0; i < 10; i++) ok = [ok];
  assert.equal(writeJson(ok), `${"[".repeat(10)}1${"]".repeat(10)}`);
  assert.equal(writeJson([ok]), undefined);
});

test("reserved namespaces are the exact ones and their dotted extensions", () => {
  assert.equal(isCastReservedNamespace(MEDIA_NAMESPACE), true);
  assert.equal(isCastReservedNamespace(`${MEDIA_NAMESPACE}.extra`), true);
  assert.equal(isCastReservedNamespace(`${MEDIA_NAMESPACE}x`), false);
  assert.equal(isCastReservedNamespace("urn:x-cast:com.google.cast.other"), false);
  assert.equal(isCastReservedNamespace(MDX), false);
});

test("received messages: an app message, an internal message of a known type, and what is dropped", () => {
  const logger = new MediaRouterLogger();
  const log = new CastMessageLog(logger);
  const activity = { sinkId: "dev-tv-123456789", appId: YT, sessionId: "session-1234567" };
  const base = { sourceId: "tr-1", destinationId: "sender-0" };
  log.received(activity, { ...base, namespace: MDX, data: "hello" });
  log.received(activity, { ...base, namespace: MDX, data: Buffer.from([1]) });
  log.received(activity, { ...base, namespace: RECEIVER_NS, data: '{"type":"RECEIVER_STATUS","b":2,"a":1}' });
  log.received(activity, { ...base, namespace: RECEIVER_NS, data: '{"type":"CLOSE"}' });
  log.received(activity, { ...base, namespace: RECEIVER_NS, data: '{"type":"NOT_A_TYPE"}' });
  log.received(activity, { ...base, namespace: RECEIVER_NS, data: "not json" });
  log.received(activity, { ...base, namespace: RECEIVER_NS, data: Buffer.from([1]) });
  const entries = logger.getLogs();
  assert.deepEqual(entries.map((e) => [e.severity, e.category, e.component]), [
    ["Info", "Route", "CastActivityManager::OnAppMessage"],
    ["Info", "Route", "CastActivityManager::OnAppMessage"],
    ["Info", "Route", "CastActivityManager::OnInternalMessage"],
  ]);
  assert.equal(entries[0]!.message, 'source_id = tr-1; destination_id = sender-0; namespace = urn:x-cast:com.google.youtube.mdx; payload = "hello"');
  assert.equal(entries[1]!.message.endsWith('payload = "<BINARY>"'), true);
  assert.equal(entries[2]!.message, `type = RECEIVER_STATUS; source_id = tr-1; destination_id = sender-0; namespace = ${RECEIVER_NS}; payload = "{"a":1,"b":2,"type":"RECEIVER_STATUS"}"`);
  // the logger's own truncation: ids to 9 characters
  assert.deepEqual([entries[0]!.sinkId, entries[0]!.mediaSource, entries[0]!.sessionId], ["dev-tv-12", YT, "session-1"]);
  assert.equal(castMessageToDebugString({ sourceId: "a", destinationId: "b", namespace: "n", data: "p" }), 'source_id = a; destination_id = b; namespace = n; payload = "p"');
});

test("messages to and from a page, and to and from the receiver, are logged when a log is given and not otherwise", async () => {
  for (const logging of [true, false]) {
    const logger = new MediaRouterLogger();
    const devices = new FakeDevices();
    const clients: FakeClient[] = [];
    let handler: CastPresentationHandler | undefined;
    const messageLog = logging ? new CastMessageLog(logger) : undefined;
    const service = waitForSinks(new CastSessionService({
      sinks: { ...FAST_SINKS, retry: { maxAttempts: 1 } },
      devices,
      createClient: (d) => {
        const c = new FakeClient(d);
        clients.push(c);
        return c;
      },
      selectDevice: async (list) => list.find((d) => d.id === TV.id) ?? null,
      emit: (id, ev) => handler?.onServiceEvent(id, ev),
      ...(messageLog !== undefined ? { messageLog } : {}),
    }));
    handler = new CastPresentationHandler({ service, token: "tok", ...(messageLog !== undefined ? { messageLog } : {}) });
    const conn: PresentationConnectionHandle = await handler.startPresentation({ urls: [URL1], origin: "https://music.youtube.com", senderId: 1 });
    const got: any[] = [];
    conn.onmessage = (data: string) => got.push(JSON.parse(data));
    const session = got.find((m) => m.type === "new_session").message;
    const client = clients[0]!;
    const namespace = session.namespaces[0].name as string;
    conn.send(JSON.stringify({ type: "client_connect", clientId: "c1", message: "c1" }));
    conn.send(JSON.stringify({ type: "app_message", clientId: "c1", sequenceNumber: 7, message: { sessionId: session.sessionId, namespaceName: namespace, message: { z: 1, a: null } } }));
    // a wrong client id and a wrong session id are dropped before the log, as in Chrome
    conn.send(JSON.stringify({ type: "app_message", clientId: "other", message: { sessionId: session.sessionId, namespaceName: namespace, message: "no" } }));
    conn.send(JSON.stringify({ type: "app_message", clientId: "c1", message: { sessionId: "other", namespaceName: namespace, message: "no" } }));
    await tick(5);
    client.emit("message", { namespace: MDX, sourceId: session.transportId, destinationId: "sender-0", data: "from receiver" });
    client.emit("message", { namespace: RECEIVER_NS, sourceId: "receiver-0", destinationId: "sender-0", data: '{"type":"RECEIVER_STATUS","status":{}}' });
    const entries = logger.getLogs();
    if (!logging) {
      assert.deepEqual(entries, []);
      continue;
    }
    const byComponent = (c: string) => entries.filter((e) => e.component === c);
    // from the page: the connect message (empty body) and the app message (body only, nulls removed); nothing for the dropped ones
    assert.deepEqual(byComponent("Cast::HandleParsedClientMessage").map((e) => [e.message, e.sinkId, e.mediaSource, e.sessionId]), [
      ["", "c1", "client_connect", ""],
      ['{"z":1}', "c1", namespace.slice(0, 64), (session.sessionId as string).slice(0, 9)],
    ]);
    // to the page: every envelope, with the client id, origin and session
    const toPage = byComponent("Cast::SendMessageToClient");
    assert.equal(toPage.length, got.length);
    assert.equal(toPage[0]!.message, JSON.stringify(got[0]));
    assert.deepEqual([toPage[0]!.sinkId, toPage[0]!.mediaSource], ["c1", "https://music.youtube.com/"]);
    // to the receiver: the app message the page sent
    const sent = byComponent("CastActivityManager::MessageSent");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.message, `source_id = ${client.senderId}; destination_id = ${session.transportId}; namespace = ${namespace}; payload = "{"z":1}"`);
    assert.deepEqual([sent[0]!.sinkId, sent[0]!.mediaSource], [TV.id.slice(0, 9), YT]);
    // from the receiver
    assert.equal(byComponent("CastActivityManager::OnAppMessage").length, 1);
    assert.equal(byComponent("CastActivityManager::OnInternalMessage").length, 1);
    assert.equal(entries.every((e) => e.severity === "Info" && e.category === "Route"), true);
  }
});
