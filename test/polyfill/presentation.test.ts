import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, install, tick, plain, snapshot, type Harness } from "./harness.ts";
import { installPresentation } from "../../src/polyfill/presentation.ts";

const MDX = "urn:x-cast:com.google.youtube.mdx";
const URLS = [
  "cast:233637DE?capabilities=video_out%2Caudio_out&clientId=client-1&autoJoinPolicy=origin_scoped&defaultActionPolicy=create_session&launchTimeout=30000&supportedAppTypes=WEB",
  "cast-dial:YouTube?clientId=client-1",
];

/**
 * A page that uses the API the way Google's Cast SDK does: one request for availability and rejoining, a new one
 * per session request, and JSON envelopes over the connection. Everything observable lands on `window.__log`.
 */
function page(initValue: unknown = { available: true, sessions: [] }): Harness {
  const h = createHarness({ install: installPresentation });
  h.handlers.initialize = () => ({ ok: true, value: initValue });
  h.handlers.requestSession = () => ({ ok: true, value: snapshot() });
  h.run(`
    window.__log = [];
    window.request = () => new PresentationRequest(${JSON.stringify(URLS)});
    window.adopt = (connection) => {
      window.connection = connection;
      connection.onmessage = (e) => __log.push(["message", JSON.parse(e.data)]);
      connection.onclose = (e) => __log.push(["close", e.reason]);
      connection.onterminate = () => __log.push(["terminate"]);
      send("client_connect", "client-1");
    };
    window.send = (type, message, sequenceNumber = -1) =>
      connection.send(JSON.stringify({ type, message, sequenceNumber, timeoutMillis: 0, clientId: "client-1" }));
    window.settle = (name, promise) => promise.then(adopt, (e) => __log.push([name + "-rejected", e.name]));
  `);
  return h;
}

/** The log so far, emptied; envelopes are reduced to what the SDK reads. */
function log(h: Harness): unknown[] {
  return plain(h.win.__log.splice(0)).map(([name, value]: [string, any]) =>
    name === "message" ? [value.type, value.sequenceNumber, value.message, value.clientId] : value === undefined ? [name] : [name, value]);
}

async function connected(h: Harness): Promise<void> {
  h.run(`settle("start", request().start());`);
  await tick(5);
  assert.equal(h.win.connection?.state, "connected");
  log(h);
  h.calls.length = 0;
}

test("install replaces the Presentation API and is self-contained", () => {
  const h = createHarness({ install: false, before: "window.chrome = { runtime: { id: 'x' } };" });
  assert.equal(install(h, installPresentation), true);
  assert.equal(h.run(`typeof PresentationRequest === "function" && navigator.presentation.defaultRequest === null`), true);
  assert.equal(h.win.chrome.runtime.id, "x");
  assert.equal(h.win.chrome.cast, undefined, "chrome.cast is left for Google's SDK to define");
  assert.ok(!/\brequire\(|\bimport\(/.test(installPresentation.toString()));
});

test("without the bridge nothing is installed", () => {
  const h = createHarness({ withBridge: false, install: false });
  assert.equal(install(h, installPresentation), false);
  assert.equal(h.win.PresentationRequest, undefined);
  assert.equal(h.win.navigator.presentation, undefined);
});

test("availability comes from the main process and follows its events", async () => {
  const h = page({ available: false, sessions: [] });
  h.run(`request().getAvailability().then((a) => { window.a = a; a.onchange = () => __log.push(["change", a.value]); });`);
  await tick(5);
  assert.deepEqual(h.calls, [{ method: "initialize", params: { appId: "233637DE", capabilities: ["video_out", "audio_out"], autoJoinPolicy: "origin_scoped" } }]);
  assert.equal(h.win.a.value, false);
  h.emit({ type: "receiverAvailability", available: true });
  h.emit({ type: "receiverAvailability", available: true });
  h.emit({ type: "receiverAvailability", available: false });
  assert.deepEqual(log(h), [["change", true], ["change", false]]);
});

test("the app is registered once, however many requests the page builds", async () => {
  const h = page();
  h.run(`request().getAvailability(); request().reconnect("auto-join").catch(() => {}); settle("start", request().start());`);
  await tick(5);
  assert.deepEqual(h.calls.map((c) => c.method), ["initialize", "requestSession"]);
});

test("a failed registration reports no receivers and is tried again by the next request", async () => {
  const h = page();
  h.handlers.initialize = () => ({ ok: false, code: "extension_missing" });
  h.run(`request().getAvailability().then((a) => __log.push(["value", a.value]));`);
  await tick(5);
  h.handlers.initialize = () => ({ ok: true, value: { available: true, sessions: [] } });
  h.run(`request().getAvailability().then((a) => __log.push(["value", a.value]));`);
  await tick(5);
  assert.deepEqual(log(h), [["value", false], ["value", true]]);
  assert.equal(h.calls.length, 2);
});

test("a request without a cast: URL finds nothing and never reaches the main process", async () => {
  const h = page();
  h.run(`
    const other = new PresentationRequest("https://example.test/receiver.html");
    other.getAvailability().then((a) => __log.push(["value", a.value]));
    settle("start", other.start());
    settle("reconnect", other.reconnect("auto-join"));
  `);
  await tick(5);
  assert.deepEqual(log(h), [["value", false], ["start-rejected", "NotFoundError"], ["reconnect-rejected", "NotFoundError"]]);
  assert.deepEqual(h.calls, []);
});

test("start asks for a session and the connection answers client_connect like the media router", async () => {
  const h = page();
  h.run(`settle("start", request().start());`);
  await tick(5);
  assert.deepEqual(h.calls[1], { method: "requestSession", params: { appId: "233637DE", capabilities: ["video_out", "audio_out"], timeoutMs: 30000 } });
  assert.equal(h.win.connection.id, "cast-session_session-1");
  assert.equal(h.win.connection.url, URLS[0]);
  assert.equal(h.run(`connection instanceof PresentationConnection`), true);
  const session = { ...snapshot(), media: [], status: "connected", receiver: { receiverType: "cast", ...snapshot().receiver } };
  assert.deepEqual(log(h), [
    ["receiver_action", -1, { receiver: session.receiver, action: "cast" }, "client-1"],
    ["new_session", -1, session, "client-1"],
  ]);
});

for (const [code, name] of [["cancel", "NotAllowedError"], ["receiver_unavailable", "NotFoundError"], ["timeout", "OperationError"]] as const) {
  test(`start rejects with ${name} when the request ends in ${code}`, async () => {
    const h = page();
    h.handlers.requestSession = () => ({ ok: false, code });
    h.run(`settle("start", request().start());`);
    await tick(5);
    assert.deepEqual(log(h), [["start-rejected", name]]);
  });
}

test("app_message goes to the device and is acknowledged under its sequence number", async () => {
  const h = page();
  await connected(h);
  h.run(`send("app_message", { sessionId: "session-1", namespaceName: ${JSON.stringify(MDX)}, message: { type: "getNowPlaying" } }, 7);`);
  await tick(5);
  assert.deepEqual(h.calls, [{ method: "sendMessage", params: { sessionId: "session-1", namespace: MDX, message: '{"type":"getNowPlaying"}' } }]);
  assert.deepEqual(log(h), [["app_message", 7, null, "client-1"]]);
});

test("a failed request is answered with an error the SDK can hand to the page", async () => {
  const h = page();
  await connected(h);
  h.handlers.sendMessage = () => ({ ok: false, code: "channel_error", description: "socket closed" });
  h.run(`send("app_message", { sessionId: "session-1", namespaceName: ${JSON.stringify(MDX)}, message: "x" }, 8);`);
  await tick(5);
  assert.deepEqual(log(h), [["error", 8, { code: "channel_error", description: "socket closed", details: null }, "client-1"]]);
});

test("messages and updates from the device reach the page", async () => {
  const h = page();
  await connected(h);
  h.emit({ type: "message", sessionId: "session-1", namespace: MDX, message: '{"type":"nowPlaying"}' });
  const louder = snapshot({ receiver: { ...snapshot().receiver, volume: { level: 0.8, muted: false } } });
  h.emit({ type: "sessionUpdated", session: louder });
  h.emit({ type: "message", sessionId: "someone-else", namespace: MDX, message: "ignored" });
  const [message, update] = log(h) as any[][];
  assert.deepEqual(message, ["app_message", -1, { sessionId: "session-1", namespaceName: MDX, message: '{"type":"nowPlaying"}' }, "client-1"]);
  assert.equal(update![0], "update_session");
  assert.deepEqual(update![2].receiver.volume, { level: 0.8, muted: false });
});

test("SET_VOLUME sets the level or the mute, whichever the SDK sent", async () => {
  const h = page();
  await connected(h);
  h.run(`
    send("v2_message", { type: "SET_VOLUME", volume: { level: 0.3, muted: null }, expectedVolume: null, sessionId: "session-1" }, 1);
    send("v2_message", { type: "SET_VOLUME", volume: { level: null, muted: true }, expectedVolume: null, sessionId: "session-1" }, 2);
  `);
  await tick(5);
  assert.deepEqual(h.calls, [
    { method: "setReceiverVolume", params: { sessionId: "session-1", level: 0.3 } },
    { method: "setReceiverMuted", params: { sessionId: "session-1", muted: true } },
  ]);
  assert.deepEqual(log(h), [["v2_message", 1, null, "client-1"], ["v2_message", 2, null, "client-1"]]);
});

test("media and DIAL requests are refused instead of left to time out", async () => {
  const h = page();
  await connected(h);
  h.run(`send("v2_message", { type: "LOAD", sessionId: "session-1" }, 3); send("dial_app_info", undefined, 4);`);
  await tick(5);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(log(h), [
    ["error", 3, { code: "session_error", description: "LOAD is not supported", details: null }, "client-1"],
    ["error", 4, { code: "session_error", description: "dial_app_info is not supported", details: null }, "client-1"],
  ]);
});

test("STOP stops the app, then terminates the connection once", async () => {
  const h = page();
  await connected(h);
  // The device's own report of the stop may arrive before the reply does.
  h.handlers.stopSession = () => {
    h.emit({ type: "sessionEnded", sessionId: "session-1", status: "stopped" });
    return { ok: true, value: undefined };
  };
  h.run(`send("v2_message", { type: "STOP", requestId: 0, sessionId: "session-1" }, 5);`);
  await tick(5);
  assert.deepEqual(h.calls, [{ method: "stopSession", params: { sessionId: "session-1" } }]);
  assert.deepEqual(log(h), [["terminate"], ["v2_message", 5, null, "client-1"]]);
  assert.equal(h.win.connection.state, "terminated");
});

test("a STOP that fails leaves the connection open", async () => {
  const h = page();
  await connected(h);
  h.handlers.stopSession = () => ({ ok: false, code: "session_error" });
  h.run(`send("v2_message", { type: "STOP", requestId: 0, sessionId: "session-1" }, 5);`);
  await tick(5);
  assert.deepEqual(log(h), [["error", 5, { code: "session_error", description: null, details: null }, "client-1"]]);
  assert.equal(h.win.connection.state, "connected");
});

test("leave_session leaves the app running and closes the connection", async () => {
  const h = page();
  await connected(h);
  h.run(`send("leave_session", "session-1", 6);`);
  await tick(5);
  assert.deepEqual(h.calls, [{ method: "leaveSession", params: { sessionId: "session-1" } }]);
  assert.deepEqual(log(h), [["leave_session", 6, null, "client-1"], ["close", "closed"]]);
  // The SDK closes the connection again from its close handler.
  h.run(`connection.close();`);
  assert.equal(h.calls.length, 1);
  assert.throws(() => h.run(`send("app_message", {}, 9);`), { name: "InvalidStateError" });
});

test("close() leaves and terminate() stops", async () => {
  const h = page();
  await connected(h);
  h.run(`connection.close();`);
  assert.deepEqual(log(h), [["close", "closed"]]);
  await connected(h);
  h.run(`connection.terminate();`);
  await tick(5);
  assert.deepEqual(h.calls.map((c) => c.method), ["stopSession"]);
  assert.deepEqual(log(h), [["terminate"]]);
});

test("a session ended elsewhere terminates or closes the connection", async () => {
  const h = page();
  await connected(h);
  h.emit({ type: "sessionEnded", sessionId: "session-1", status: "stopped" });
  assert.deepEqual(log(h), [["terminate"]]);
  await connected(h);
  h.emit({ type: "sessionEnded", sessionId: "session-1", status: "disconnected" });
  h.emit({ type: "sessionEnded", sessionId: "session-1", status: "disconnected" });
  assert.deepEqual(log(h), [["close", "closed"]]);
});

test("reconnect(\"auto-join\") hands out a session the main process already joined, without a receiver action", async () => {
  const h = page({ available: true, sessions: [snapshot()] });
  h.run(`settle("reconnect", request().reconnect("auto-join"));`);
  await tick(5);
  assert.deepEqual((log(h) as any[][]).map((entry) => entry[0]), ["new_session"]);
  h.run(`settle("reconnect", request().reconnect("auto-join"));`);
  await tick(5);
  assert.deepEqual(log(h), [["reconnect-rejected", "NotFoundError"]]);
});

test("a session rejoined later arrives on the default request", async () => {
  const h = page();
  h.run(`
    const first = request();
    first.onconnectionavailable = (e) => adopt(e.connection);
    navigator.presentation.defaultRequest = first;
    settle("reconnect", first.reconnect("auto-join"));
  `);
  // The rejoin can beat the reply to the registration.
  h.emit({ type: "sessionJoined", session: snapshot() });
  await tick(5);
  assert.deepEqual((log(h) as any[][]).map((entry) => entry[0]), ["new_session", "reconnect-rejected"]);
  assert.equal(h.win.connection.id, "cast-session_session-1");
});

test("without a default request a rejoined session waits for the next reconnect", async () => {
  const h = page();
  h.emit({ type: "sessionJoined", session: snapshot() });
  h.run(`settle("reconnect", request().reconnect("auto-join"));`);
  await tick(5);
  assert.deepEqual((log(h) as any[][]).map((entry) => entry[0]), ["new_session"]);
});

test("reconnect by session id joins that session, or returns the connection the page already has", async () => {
  const h = page();
  h.handlers.joinSession = () => ({ ok: true, value: snapshot({ sessionId: "session-2" }) });
  h.run(`settle("reconnect", request().reconnect("cast-session_session-2"));`);
  await tick(5);
  assert.deepEqual(h.calls[1], { method: "joinSession", params: { sessionId: "session-2" } });
  assert.equal(h.win.connection.id, "cast-session_session-2");
  h.run(`request().reconnect("cast-session_session-2").then((again) => __log.push(["same", again === connection]));`);
  await tick(5);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(log(h).at(-1), ["same", true]);

  h.handlers.joinSession = () => ({ ok: false, code: "session_error" });
  h.run(`settle("reconnect", request().reconnect("cast-session_gone"));`);
  await tick(5);
  assert.deepEqual(log(h), [["reconnect-rejected", "NotFoundError"]]);
});

test("a session the user starts replaces the one before it, which is stopped and terminated first", async () => {
  const h = page();
  await connected(h);
  h.run(`window.first = connection; first.onterminate = () => __log.push(["first-terminated", connection === first]);`);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot({ sessionId: "session-2" }) });
  h.run(`settle("start", request().start());`);
  await tick(5);
  assert.deepEqual(h.calls.map((c) => [c.method, c.params.sessionId]), [["requestSession", undefined], ["stopSession", "session-1"]]);
  assert.deepEqual((log(h) as any[][]).map((entry) => entry.slice(0, 2)), [["first-terminated", true], ["receiver_action", -1], ["new_session", -1]]);
  assert.equal(h.win.connection.id, "cast-session_session-2");
});

test("choosing the device already in use hands back the same connection", async () => {
  const h = page();
  await connected(h);
  h.run(`request().start().then((again) => __log.push(["same", again === connection]));`);
  await tick(5);
  assert.deepEqual(h.calls.map((c) => c.method), ["requestSession"]);
  assert.deepEqual(log(h), [["same", true]]);
});

test("a request that names another session acts on that session, not on the connection's", async () => {
  const h = page();
  await connected(h);
  h.handlers.stopSession = () => ({ ok: false, code: "session_error" });
  h.run(`send("v2_message", { type: "STOP", requestId: 0, sessionId: "replaced" }, 5);`);
  await tick(5);
  assert.deepEqual(h.calls, [{ method: "stopSession", params: { sessionId: "replaced" } }]);
  h.handlers.stopSession = () => ({ ok: true, value: undefined });
  h.run(`send("v2_message", { type: "STOP", requestId: 0, sessionId: "replaced" }, 6);`);
  await tick(5);
  assert.equal(h.win.connection.state, "connected");
  assert.deepEqual((log(h) as any[][]).map((entry) => entry.slice(0, 2)), [["error", 5], ["v2_message", 6]]);
});
