import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { CastClient, NS, PLATFORM_RECEIVER_ID, CastConnectionError, CastRequestError, CastTimeoutError } from "../../src/client/index.ts";
import { PayloadType } from "../../src/protocol/index.ts";
import { FakeReceiver, NS_CONNECTION, NS_HEARTBEAT, NS_RECEIVER } from "./fake-receiver.ts";

const APP_NS = "urn:x-cast:com.example.test";
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

async function setup(opts: Partial<ConstructorParameters<typeof CastClient>[0]> = {}) {
  const fake = new FakeReceiver();
  const port = await fake.listen();
  const client = new CastClient({ host: "127.0.0.1", port, ...opts });
  cleanups.push(() => fake.close(), () => client.close());
  return { fake, client, port };
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("namespace constants", () => {
  assert.equal(NS.CONNECTION, NS_CONNECTION);
  assert.equal(NS.HEARTBEAT, NS_HEARTBEAT);
  assert.equal(NS.RECEIVER, NS_RECEIVER);
  assert.equal(NS.DEVICE_AUTH, "urn:x-cast:com.google.cast.tp.deviceauth");
  assert.equal(PLATFORM_RECEIVER_ID, "receiver-0");
});

test("error classes carry their names", () => {
  assert.equal(new CastConnectionError("x").name, "CastConnectionError");
  assert.equal(new CastTimeoutError("x").name, "CastTimeoutError");
  const e = new CastRequestError({ type: "LAUNCH_ERROR", requestId: 3, reason: "NOT_FOUND" });
  assert.equal(e.name, "CastRequestError");
  assert.equal(e.type, "LAUNCH_ERROR");
  assert.equal(e.reason, "NOT_FOUND");
  assert.deepEqual(e.response, { type: "LAUNCH_ERROR", requestId: 3, reason: "NOT_FOUND" });
  assert.ok(e instanceof Error);
});

test("connect opens a virtual connection to receiver-0 with a random sender id", async () => {
  const { fake, client } = await setup({ connectPayload: { userAgent: "electron-cast-test" } });
  assert.match(client.senderId, /^sender-[0-9a-f]{8}$/);
  assert.equal(client.connected, false);
  await client.connect();
  assert.equal(client.connected, true);
  const m = await fake.waitFor((x) => x.namespace === NS_CONNECTION);
  assert.equal(m.sourceId, client.senderId);
  assert.equal(m.destinationId, "receiver-0");
  assert.equal(m.payloadType, PayloadType.STRING);
  assert.deepEqual(m.json, { type: "CONNECT", userAgent: "electron-cast-test" });
});

test("a custom sender id is used", async () => {
  const { fake, client } = await setup({ senderId: "sender-custom" });
  await client.connect();
  const m = await fake.waitFor((x) => x.namespace === NS_CONNECTION);
  assert.equal(m.sourceId, "sender-custom");
});

test("connect twice rejects; a closed client cannot reconnect", async () => {
  const { client } = await setup();
  await client.connect();
  await assert.rejects(client.connect(), CastConnectionError);
  client.close();
  await assert.rejects(client.connect(), CastConnectionError);
});

test("getStatus sends GET_STATUS with increasing request ids and normalizes the reply", async () => {
  const { fake, client } = await setup();
  await client.connect();
  const status = await client.getStatus();
  assert.deepEqual(status, { applications: [], volume: { level: 0.5, muted: false, controlType: "attenuation", stepInterval: 0.05 } });
  await client.getStatus();
  const reqs = fake.received.filter((m) => m.json?.type === "GET_STATUS");
  assert.deepEqual(reqs.map((m) => [m.destinationId, m.json?.requestId]), [["receiver-0", 1], ["receiver-0", 2]]);
});

test("a RECEIVER_STATUS without applications normalizes to an empty list", async () => {
  const { fake, client } = await setup();
  fake.onMessage = (m) => {
    if (m.json?.type !== "GET_STATUS") return false;
    fake.sendJson(NS_RECEIVER, "receiver-0", m.sourceId, { type: "RECEIVER_STATUS", requestId: m.json.requestId, status: { volume: { level: 1 } } });
    return true;
  };
  await client.connect();
  assert.deepEqual(await client.getStatus(), { applications: [], volume: { level: 1 } });
});

test("launch resolves with the launched app, then app messages flow over its transport", async () => {
  const { fake, client } = await setup();
  await client.connect();
  const app = await client.launch("233637DE");
  assert.equal(app.appId, "233637DE");
  assert.equal(app.sessionId, "session-1");
  assert.equal(app.transportId, "transport-1");
  assert.deepEqual(app.namespaces, [{ name: APP_NS }]);
  const launch = fake.received.find((m) => m.json?.type === "LAUNCH");
  assert.deepEqual(launch?.json, { type: "LAUNCH", appId: "233637DE", requestId: 1 });

  client.connectTransport(app.transportId);
  client.connectTransport(app.transportId); // idempotent
  await fake.waitFor((m) => m.namespace === NS_CONNECTION && m.destinationId === "transport-1");
  await delay(30);
  assert.equal(fake.received.filter((m) => m.namespace === NS_CONNECTION && m.destinationId === "transport-1").length, 1);

  client.send(APP_NS, app.transportId, { type: "getMdxSessionStatus" });
  const sent = await fake.waitFor((m) => m.namespace === APP_NS);
  assert.equal(sent.destinationId, "transport-1");
  assert.equal(sent.sourceId, client.senderId);
  assert.equal(sent.payloadUtf8, '{"type":"getMdxSessionStatus"}');
});

test("launch waits for a later RECEIVER_STATUS when the reply does not list the app yet", async () => {
  const { fake, client } = await setup();
  fake.onMessage = (m) => {
    if (m.json?.type !== "LAUNCH") return false;
    fake.sendJson(NS_RECEIVER, "receiver-0", m.sourceId, fake.status(m.json.requestId as number));
    setTimeout(() => {
      fake.apps = [{ appId: "CC1AD845", displayName: "Default Media Receiver", sessionId: "s-9", transportId: "t-9", statusText: "", namespaces: [], isIdleScreen: false }];
      fake.sendJson(NS_RECEIVER, "receiver-0", "*", fake.status(0));
    }, 50);
    return true;
  };
  await client.connect();
  const app = await client.launch("CC1AD845");
  assert.equal(app.transportId, "t-9");
});

test("LAUNCH_ERROR rejects with CastRequestError", async () => {
  const { fake, client } = await setup();
  fake.launchError = "NOT_FOUND";
  await client.connect();
  const err = await client.launch("DEADBEEF").then(() => null, (e: unknown) => e);
  assert.ok(err instanceof CastRequestError);
  assert.equal(err.type, "LAUNCH_ERROR");
  assert.equal(err.reason, "NOT_FOUND");
});

test("INVALID_REQUEST rejects a generic request", async () => {
  const { client } = await setup();
  await client.connect();
  await assert.rejects(client.request(NS.RECEIVER, PLATFORM_RECEIVER_ID, { type: "BOGUS" }), (e: unknown) => {
    assert.ok(e instanceof CastRequestError);
    assert.equal(e.type, "INVALID_REQUEST");
    assert.equal(e.reason, "INVALID_COMMAND");
    return true;
  });
});

test("stop and setVolume send the right payloads", async () => {
  const { fake, client } = await setup();
  await client.connect();
  const app = await client.launch("233637DE");
  const afterVolume = await client.setVolume({ level: 0.25 });
  assert.equal(afterVolume.volume.level, 0.25);
  await client.setVolume({ muted: true });
  const afterStop = await client.stop(app.sessionId);
  assert.deepEqual(afterStop.applications, []);
  const payloads = fake.received.filter((m) => m.namespace === NS_RECEIVER).map((m) => m.json);
  assert.deepEqual(payloads.slice(1), [
    { type: "SET_VOLUME", volume: { level: 0.25 }, requestId: 2 },
    { type: "SET_VOLUME", volume: { muted: true }, requestId: 3 },
    { type: "STOP", sessionId: "session-1", requestId: 4 },
  ]);
});

test("getAppAvailability maps availability to booleans", async () => {
  const { fake, client } = await setup();
  await client.connect();
  assert.deepEqual(await client.getAppAvailability(["233637DE", "BADAPP00"]), { "233637DE": true, BADAPP00: false });
  const req = fake.received.find((m) => m.json?.type === "GET_APP_AVAILABILITY");
  assert.deepEqual(req?.json?.appId, ["233637DE", "BADAPP00"]);
});

test("replies are matched by request id, namespace and source", async () => {
  const { fake, client } = await setup();
  fake.autoReply = false;
  await client.connect();
  const app = { transportId: "transport-7" };
  client.connectTransport(app.transportId);
  let settled = false;
  const p = client.request(APP_NS, app.transportId, { type: "PING_APP" }).then((r) => {
    settled = true;
    return r;
  });
  const req = await fake.waitFor((m) => m.namespace === APP_NS);
  const requestId = req.json?.requestId;
  fake.sendJson(APP_NS, "receiver-0", client.senderId, { type: "WRONG_SOURCE", requestId });
  fake.sendJson(NS_RECEIVER, "transport-7", client.senderId, { type: "WRONG_NAMESPACE", requestId });
  await delay(50);
  assert.equal(settled, false);
  fake.sendJson(APP_NS, "transport-7", client.senderId, { type: "PONG_APP", requestId, extra: 1 });
  assert.deepEqual(await p, { type: "PONG_APP", requestId, extra: 1 });
});

test("request rejects for reply types ending in _ERROR and for LOAD_FAILED", async () => {
  const { fake, client } = await setup();
  fake.autoReply = false;
  fake.onMessage = (m) => {
    if (m.namespace !== APP_NS) return false;
    const type = m.json?.kind === "a" ? "CUSTOM_ERROR" : "LOAD_FAILED";
    fake.sendJson(APP_NS, m.destinationId, m.sourceId, { type, requestId: m.json?.requestId });
    return true;
  };
  await client.connect();
  await assert.rejects(client.request(APP_NS, "t", { type: "X", kind: "a" }), CastRequestError);
  await assert.rejects(client.request(APP_NS, "t", { type: "X", kind: "b" }), CastRequestError);
});

test("request times out with CastTimeoutError and forgets the request", async () => {
  const { fake, client } = await setup();
  fake.autoReply = false;
  await client.connect();
  await assert.rejects(client.request(NS.RECEIVER, PLATFORM_RECEIVER_ID, { type: "GET_STATUS" }, { timeoutMs: 50 }), CastTimeoutError);
  const req = fake.received.find((m) => m.json?.type === "GET_STATUS");
  fake.sendJson(NS_RECEIVER, "receiver-0", client.senderId, fake.status(req?.json?.requestId as number));
  await delay(30); // a late reply must not throw
  assert.equal(client.connected, true);
});

test("the requestTimeoutMs option sets the default timeout", async () => {
  const { fake, client } = await setup({ requestTimeoutMs: 40 });
  fake.autoReply = false;
  await client.connect();
  const t0 = Date.now();
  await assert.rejects(client.getStatus(), CastTimeoutError);
  assert.ok(Date.now() - t0 < 1000);
});

test("emits message events for app traffic with string or Buffer data", async () => {
  const { fake, client } = await setup();
  await client.connect();
  const got: { namespace: string; sourceId: string; destinationId: string; data: string | Buffer }[] = [];
  client.on("message", (m) => got.push(m));
  fake.sendJson(APP_NS, "transport-1", client.senderId, { type: "mdxSessionStatus", data: { screenId: "abc" } });
  fake.send({ namespace: APP_NS, sourceId: "transport-1", destinationId: "*", payloadType: PayloadType.BINARY, payloadBinary: Buffer.from([1, 2, 3]) });
  await delay(50);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { namespace: APP_NS, sourceId: "transport-1", destinationId: client.senderId, data: '{"type":"mdxSessionStatus","data":{"screenId":"abc"}}' });
  assert.ok(Buffer.isBuffer(got[1]?.data));
  assert.equal((got[1]?.data as Buffer).toString("hex"), "010203");
});

test("heartbeat and connection traffic is not emitted as message events", async () => {
  const { fake, client } = await setup();
  await client.connect();
  const got: unknown[] = [];
  client.on("message", (m) => got.push(m));
  fake.sendJson(NS_HEARTBEAT, "receiver-0", client.senderId, { type: "PONG" });
  fake.sendJson(NS_CONNECTION, "transport-x", client.senderId, { type: "CLOSE" });
  await delay(50);
  assert.deepEqual(got, []);
});

test("emits receiverStatus for unsolicited status updates", async () => {
  const { fake, client } = await setup();
  await client.connect();
  const statuses: unknown[] = [];
  client.on("receiverStatus", (s) => statuses.push(s));
  fake.volume.level = 0.9;
  fake.sendJson(NS_RECEIVER, "receiver-0", "*", fake.status(0));
  await delay(50);
  assert.equal(statuses.length, 1);
  assert.equal((statuses[0] as { volume: { level: number } }).volume.level, 0.9);
});

test("pings on the heartbeat interval and answers the device's PING with PONG", async () => {
  const { fake, client } = await setup({ heartbeatIntervalMs: 30 });
  await client.connect();
  await delay(120);
  const pings = fake.received.filter((m) => m.namespace === NS_HEARTBEAT && m.json?.type === "PING");
  assert.ok(pings.length >= 2, `expected >= 2 pings, got ${pings.length}`);
  assert.ok(pings.every((p) => p.destinationId === "receiver-0" && p.sourceId === client.senderId));
  fake.sendJson(NS_HEARTBEAT, "receiver-0", client.senderId, { type: "PING" });
  await fake.waitFor((m) => m.namespace === NS_HEARTBEAT && m.json?.type === "PONG");
});

test("closes with an error when the device goes silent, rejecting pending requests", async () => {
  const { fake, client } = await setup({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 100, requestTimeoutMs: 5000 });
  fake.autoPong = false;
  fake.autoReply = false;
  await client.connect();
  const pending = client.getStatus();
  const [err] = (await once(client, "close")) as [Error | undefined];
  assert.ok(err instanceof CastConnectionError);
  assert.match(err.message, /heartbeat/i);
  assert.equal(client.connected, false);
  await assert.rejects(pending, CastConnectionError);
});

test("inbound traffic of any kind keeps the connection alive", async () => {
  const { fake, client } = await setup({ heartbeatIntervalMs: 20, heartbeatTimeoutMs: 80 });
  fake.autoPong = false;
  await client.connect();
  const keepAlive = setInterval(() => fake.sendJson(APP_NS, "transport-1", client.senderId, { type: "tick" }), 20);
  cleanups.push(() => clearInterval(keepAlive));
  await delay(250);
  assert.equal(client.connected, true);
});

test("CLOSE from receiver-0 closes the client; CLOSE from a transport emits transportClosed", async () => {
  const { fake, client } = await setup();
  await client.connect();
  client.connectTransport("transport-1");
  const closedTransports: string[] = [];
  client.on("transportClosed", (id) => closedTransports.push(id));
  fake.sendJson(NS_CONNECTION, "transport-1", client.senderId, { type: "CLOSE" });
  await delay(50);
  assert.deepEqual(closedTransports, ["transport-1"]);
  assert.equal(client.connected, true);
  const closed = once(client, "close");
  fake.sendJson(NS_CONNECTION, "receiver-0", client.senderId, { type: "CLOSE" });
  const [err] = (await closed) as [Error | undefined];
  assert.ok(err instanceof CastConnectionError);
});

test("a dropped socket closes the client with an error", async () => {
  const { fake, client } = await setup();
  await client.connect();
  const closed = once(client, "close");
  fake.kill();
  const [err] = (await closed) as [Error | undefined];
  assert.ok(err instanceof CastConnectionError);
  assert.equal(client.connected, false);
});

test("a protocol violation closes the client with an error", async () => {
  const { fake, client } = await setup();
  await client.connect();
  const closed = once(client, "close");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(70000);
  fake.writeRaw(header);
  const [err] = (await closed) as [Error | undefined];
  assert.ok(err instanceof CastConnectionError);
});

test("close() says goodbye, emits close once without an error, and is idempotent", async () => {
  const { fake, client } = await setup();
  fake.autoReply = false;
  await client.connect();
  client.connectTransport("transport-1");
  const pending = client.getStatus();
  const events: unknown[] = [];
  client.on("close", (e) => events.push(e));
  client.close();
  client.close();
  await assert.rejects(pending, CastConnectionError);
  await fake.waitFor((m) => m.namespace === NS_CONNECTION && m.json?.type === "CLOSE" && m.destinationId === "receiver-0");
  await fake.waitFor((m) => m.namespace === NS_CONNECTION && m.json?.type === "CLOSE" && m.destinationId === "transport-1");
  await delay(50);
  assert.deepEqual(events, [undefined]);
  assert.equal(client.connected, false);
  assert.throws(() => client.send(APP_NS, "transport-1", { type: "x" }), CastConnectionError);
  await assert.rejects(client.getStatus(), CastConnectionError);
});

test("send encodes strings as STRING, objects as JSON and Buffers as BINARY", async () => {
  const { fake, client } = await setup();
  await client.connect();
  client.send(APP_NS, "t", "raw text");
  client.send(APP_NS, "t", { a: 1 });
  client.send(APP_NS, "t", Buffer.from([9, 8]));
  client.send(APP_NS, "t", new Uint8Array([7]));
  await delay(80);
  const app = fake.received.filter((m) => m.namespace === APP_NS);
  assert.deepEqual(app.map((m) => [m.payloadType, m.payloadUtf8 ?? m.payloadBinary?.toString("hex")]), [
    [PayloadType.STRING, "raw text"],
    [PayloadType.STRING, '{"a":1}'],
    [PayloadType.BINARY, "0908"],
    [PayloadType.BINARY, "07"],
  ]);
});

test("send before connect throws", async () => {
  const { client } = await setup();
  assert.throws(() => client.send(APP_NS, "t", "x"), CastConnectionError);
});

test("connect rejects with CastConnectionError when nothing listens", async () => {
  const probe = net.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const client = new CastClient({ host: "127.0.0.1", port });
  await assert.rejects(client.connect(), CastConnectionError);
  assert.equal(client.connected, false);
});

test("connect times out when the TLS handshake never completes", async () => {
  const sockets: net.Socket[] = [];
  const silent = net.createServer((s) => sockets.push(s));
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => {
    for (const s of sockets) s.destroy();
    silent.close(() => r());
  }));
  const client = new CastClient({ host: "127.0.0.1", port: (silent.address() as net.AddressInfo).port, connectTimeoutMs: 100 });
  const t0 = Date.now();
  await assert.rejects(client.connect(), CastTimeoutError);
  assert.ok(Date.now() - t0 < 2000);
});
