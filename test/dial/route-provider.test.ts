// The DIAL route provider: create, join, the message flow, launch and stop (dial_media_route_provider.cc,
// dial_activity_manager.cc, dial_internal_message_util.cc).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { DialSink } from "../../src/dial/dial-sink-service.ts";
import { DialRouteError, DialRouteProvider, dialEnvelope, parseDialMessage } from "../../src/dial/route-provider.ts";
import { parseAppInfo, type DialAppInfoResult } from "../../src/dial/parse.ts";
import { APP_URL, DEVICE_IP, FakeHttp, SINK_ID, appInfoXml, httpError, ok, flush } from "./fixtures.ts";

const SOURCE = "cast-dial:YouTube?dialPostData=pair%3D1&clientId=client-1";
const ORIGIN = "https://www.youtube.com";
const RUN_URL = `${APP_URL}/YouTube`;
const SINK: DialSink = { id: SINK_ID, name: "Tom & Jerry's <TV>", modelName: "Smart TV", ipAddress: DEVICE_IP, appUrl: APP_URL };

function setup(over: { appInfo?: () => DialAppInfoResult; http?: FakeHttp } = {}) {
  const http = over.http ?? new FakeHttp();
  let appInfo = over.appInfo ?? ((): DialAppInfoResult => ({ appInfo: parseAppInfo(appInfoXml("stopped")), resultCode: "ok", errorMessage: "" }));
  const provider = new DialRouteProvider({
    sinks: {
      getSink: (id) => (id === SINK_ID ? { ...SINK } : undefined),
      fetchAppInfo: async () => appInfo(),
    },
    http,
    hashToken: "tok",
  });
  const messages: Array<{ routeId: string; message: Record<string, unknown> }> = [];
  provider.on("messages", (routeId, list) => {
    for (const m of list) messages.push({ routeId, message: JSON.parse(m) as Record<string, unknown> });
  });
  const terminated: string[] = [];
  provider.on("terminated", (id) => terminated.push(id));
  const issues: string[] = [];
  provider.on("issue", (_sink, text) => issues.push(text));
  return { provider, http, messages, terminated, issues, setAppInfo: (f: () => DialAppInfoResult) => void (appInfo = f) };
}

const route = (p: DialRouteProvider, id = "mr_1") => p.createRoute(SOURCE, SINK_ID, id, ORIGIN);

test("a route has Chrome's id and starts with receiver_action cast, then new_session", () => {
  const { provider } = setup();
  const { route: r, messages } = route(provider);
  assert.equal(r.id, `urn:x-org.chromium:media:route:mr_1/${SINK_ID}/${SOURCE}`);
  assert.equal(r.appName, "YouTube");
  assert.equal(r.clientId, "client-1");
  const label = createHash("sha256").update(SINK_ID + "tok").digest("base64url");
  const receiver = {
    label, friendlyName: "Tom &amp; Jerry&#39;s &lt;TV&gt;", capabilities: [], volume: null, isActiveInput: null,
    displayStatus: null, receiverType: "dial", ipAddress: DEVICE_IP,
  };
  const [action, session] = messages.map((m) => JSON.parse(m) as Record<string, unknown>);
  assert.deepEqual(action, { type: "receiver_action", message: { receiver, action: "cast" }, clientId: "client-1", sequenceNumber: -1, timeoutMillis: 0 });
  assert.equal(session?.type, "new_session");
  assert.deepEqual(Object.keys(session ?? {}), ["type", "message", "clientId", "sequenceNumber", "timeoutMillis"]);
  const body = session?.message as Record<string, unknown>;
  assert.match(String(body.sessionId), /^\d+$/);
  assert.deepEqual({ ...body, sessionId: "n" }, {
    sessionId: "n", appId: "", displayName: "YouTube", statusText: "", appImages: [], receiver, senderApps: [],
    namespaces: [], media: [], status: "connected", transportId: "",
  });
});

test("creating a route fails for an unknown sink, a source that is not a DIAL launch and a repeated route", () => {
  const { provider } = setup();
  assert.throws(() => provider.createRoute(SOURCE, "dial:nope", "mr_1", ORIGIN), (e) => e instanceof DialRouteError && e.code === "SINK_NOT_FOUND");
  assert.throws(() => provider.createRoute("cast-dial:YouTube", SINK_ID, "mr_1", ORIGIN), (e) => e instanceof DialRouteError && e.code === "NO_SUPPORTED_PROVIDER");
  assert.throws(() => provider.createRoute("cast:233637DE", SINK_ID, "mr_1", ORIGIN), (e) => e instanceof DialRouteError && e.code === "NO_SUPPORTED_PROVIDER");
  route(provider);
  assert.throws(() => route(provider), (e) => e instanceof DialRouteError && e.code === "ROUTE_ALREADY_EXISTS");
});

test("a route can be joined by presentation id, source and origin only", () => {
  const { provider } = setup();
  const { route: r } = route(provider);
  assert.equal(provider.joinRoute("mr_1", SOURCE, ORIGIN)?.id, r.id);
  assert.equal(provider.joinRoute("mr_2", SOURCE, ORIGIN), null);
  assert.equal(provider.joinRoute("mr_1", SOURCE, "https://other.example"), null);
  assert.equal(provider.joinRoute("mr_1", "cast-dial:YouTube?clientId=client-1", ORIGIN), null);
});

test("client_connect asks the page whether to launch, with the app's state; its answer launches with the launch parameter", async () => {
  const http = new FakeHttp().reply("POST", RUN_URL, ok("", { location: `http://${DEVICE_IP}:8008/apps/YouTube/run` }, 201));
  const { provider, messages } = setup({ http });
  const { route: r } = route(provider);
  provider.sendRouteMessage(r.id, dialEnvelope("client_connect", {}, "client-1"));
  await flush();
  assert.equal(messages.length, 1);
  const ask = messages[0]!.message;
  assert.equal(ask.type, "custom_dial_launch");
  assert.equal(ask.clientId, "client-1");
  assert.equal(typeof ask.sequenceNumber, "number");
  assert.ok((ask.sequenceNumber as number) > 0);
  assert.equal((ask.message as Record<string, unknown>).appState, "stopped");
  assert.deepEqual((ask.message as Record<string, unknown>).extraData, {});

  // An answer to a number that was never asked is ignored.
  provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: true }, "client-1", 999999));
  await flush();
  assert.equal(http.calls.filter((c) => c.method === "POST").length, 0);

  provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: true, launchParameter: "v=abc" }, "client-1", ask.sequenceNumber as number));
  await flush();
  const posts = http.calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts.map((c) => [c.url, c.body]), [[RUN_URL, "v=abc"]]);

  // Answering again does nothing: the number is spent, and the app is launched.
  provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: true }, "client-1", ask.sequenceNumber as number));
  await flush();
  assert.equal(http.calls.filter((c) => c.method === "POST").length, 1);
});

test("without a launch parameter the source's dialPostData is posted as written", async () => {
  const http = new FakeHttp().reply("POST", RUN_URL, ok("", {}, 201));
  const { provider, messages } = setup({ http });
  const { route: r } = route(provider);
  provider.sendRouteMessage(r.id, dialEnvelope("client_connect", {}, "client-1"));
  await flush();
  provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", null, "client-1", messages[0]!.message.sequenceNumber as number));
  await flush();
  assert.deepEqual(http.calls.filter((c) => c.method === "POST").map((c) => c.body), ["pair%3D1"]);
});

test("doLaunch false marks the app launched without a request", async () => {
  const http = new FakeHttp().reply("DELETE", `${RUN_URL}/run`, ok());
  const { provider, messages } = setup({ http });
  const { route: r } = route(provider);
  provider.sendRouteMessage(r.id, dialEnvelope("client_connect", {}, "client-1"));
  await flush();
  provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: false }, "client-1", messages[0]!.message.sequenceNumber as number));
  await flush();
  assert.equal(http.calls.filter((c) => c.method === "POST").length, 0);
  await provider.terminateRoute(r.id);
  assert.deepEqual(http.calls.filter((c) => c.method === "DELETE").map((c) => c.url), [`${RUN_URL}/run`], "stop falls back to <app url>/run");
});

test("a failed launch removes the route, and a failed app info fetch at client_connect sends nothing", async () => {
  const http = new FakeHttp().reply("POST", RUN_URL, httpError(503));
  const first = setup({ http });
  const { route: r } = route(first.provider);
  first.provider.sendRouteMessage(r.id, dialEnvelope("client_connect", {}, "client-1"));
  await flush();
  first.provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: true }, "client-1", first.messages[0]!.message.sequenceNumber as number));
  await flush();
  assert.deepEqual(first.provider.routes(), []);

  const second = setup({ appInfo: () => ({ appInfo: null, resultCode: "network_error", errorMessage: "x" }) });
  const { route: r2 } = route(second.provider);
  second.provider.sendRouteMessage(r2.id, dialEnvelope("client_connect", {}, "client-1"));
  await flush();
  assert.deepEqual(second.messages, []);
  assert.equal(second.provider.routes().length, 1, "the route is left as it was, as in Chrome");
});

test("dial_app_info is answered with the app state, or with an error carrying the failure", async () => {
  const { provider, messages, setAppInfo } = setup();
  const { route: r } = route(provider);
  setAppInfo(() => ({ appInfo: parseAppInfo(appInfoXml("running", "<additionalData><k>v</k></additionalData>")), resultCode: "ok", errorMessage: "" }));
  provider.sendRouteMessage(r.id, dialEnvelope("dial_app_info", null, "client-1", 7));
  await flush();
  assert.equal(messages[0]?.message.type, "dial_app_info");
  assert.equal(messages[0]?.message.sequenceNumber, 7);
  assert.equal((messages[0]!.message.message as Record<string, unknown>).appState, "running");
  assert.deepEqual((messages[0]!.message.message as Record<string, unknown>).extraData, { k: "v" });

  setAppInfo(() => ({ appInfo: null, resultCode: "http_error", errorMessage: "Internal net::Error: -379", httpErrorCode: 404 }));
  provider.sendRouteMessage(r.id, dialEnvelope("dial_app_info", null, "client-1", 8));
  await flush();
  assert.deepEqual(messages[1]?.message, {
    type: "error", message: { code: "http_error", description: "Internal net::Error: -379", details: { http_error_code: 404 } },
    clientId: "client-1", sequenceNumber: 8, timeoutMillis: 0,
  });

  setAppInfo(() => ({ appInfo: null, resultCode: "network_error", errorMessage: "down" }));
  provider.sendRouteMessage(r.id, dialEnvelope("dial_app_info", null, "client-1", 9));
  await flush();
  assert.deepEqual(messages[2]?.message.message, { code: "network_error", description: "down" });
});

test("a STOP v2_message tells the page receiver_action stop, deletes the run URL and ends the route", async () => {
  const http = new FakeHttp()
    .reply("POST", RUN_URL, ok("", { location: `http://${DEVICE_IP}:8008/apps/YouTube/web-1` }, 201))
    .reply("DELETE", `http://${DEVICE_IP}:8008/apps/YouTube/web-1`, ok());
  const { provider, messages, terminated } = setup({ http });
  const { route: r } = route(provider);
  provider.sendRouteMessage(r.id, dialEnvelope("client_connect", {}, "client-1"));
  await flush();
  provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: true }, "client-1", messages[0]!.message.sequenceNumber as number));
  await flush();
  provider.sendRouteMessage(r.id, dialEnvelope("v2_message", { type: "STOP", requestId: 3 }, "client-1", 12));
  await flush();
  assert.deepEqual(http.calls.filter((c) => c.method === "DELETE").map((c) => c.url), [`http://${DEVICE_IP}:8008/apps/YouTube/web-1`], "the Location of the launch");
  const stop = messages.at(-1)?.message;
  assert.equal(stop?.type, "receiver_action");
  assert.equal((stop!.message as Record<string, unknown>).action, "stop");
  assert.deepEqual(terminated, [r.id]);
  assert.deepEqual(provider.routes(), []);
});

test("a LOCATION that is not on the device is not used as the stop target", async () => {
  const http = new FakeHttp()
    .reply("POST", RUN_URL, ok("", { location: "http://203.0.113.9/apps/YouTube/run" }, 201))
    .reply("DELETE", `${RUN_URL}/run`, ok());
  const { provider, messages } = setup({ http });
  const { route: r } = route(provider);
  provider.sendRouteMessage(r.id, dialEnvelope("client_connect", {}, "client-1"));
  await flush();
  provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: true }, "client-1", messages[0]!.message.sequenceNumber as number));
  await flush();
  await provider.terminateRoute(r.id);
  assert.deepEqual(http.calls.filter((c) => c.method === "DELETE").map((c) => c.url), [`${RUN_URL}/run`]);
});

test("a stop that fails raises an issue unless the app is already gone; the route ends either way", async () => {
  for (const state of ["running", "stopped"] as const) {
    const http = new FakeHttp().reply("POST", RUN_URL, ok("", {}, 201)).reply("DELETE", `${RUN_URL}/run`, httpError(500));
    const { provider, messages, terminated, issues, setAppInfo } = setup({ http });
    const { route: r } = route(provider);
    provider.sendRouteMessage(r.id, dialEnvelope("client_connect", {}, "client-1"));
    await flush();
    provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: true }, "client-1", messages[0]!.message.sequenceNumber as number));
    await flush();
    setAppInfo(() => ({ appInfo: parseAppInfo(appInfoXml(state)), resultCode: "ok", errorMessage: "" }));
    const result = provider.terminateRoute(r.id);
    if (state === "running") await assert.rejects(result, (e) => e instanceof DialRouteError && e.code === "UNKNOWN_ERROR");
    else await result;
    assert.equal(issues.length, state === "running" ? 1 : 0);
    assert.deepEqual(terminated, [r.id]);
    assert.deepEqual(provider.routes(), []);
  }
});

test("a route that was never launched is stopped without any request", async () => {
  const { provider, http, terminated } = setup();
  const { route: r } = route(provider);
  await provider.terminateRoute(r.id);
  assert.deepEqual(http.calls, []);
  assert.deepEqual(terminated, [r.id]);
  await assert.rejects(provider.terminateRoute(r.id), (e) => e instanceof DialRouteError && e.code === "ROUTE_NOT_FOUND");
});

test("a new route on a sink terminates the sink's earlier one", async () => {
  const { provider, terminated } = setup();
  const { route: a } = route(provider, "mr_1");
  const { route: b } = route(provider, "mr_2");
  await flush();
  assert.deepEqual(terminated, [a.id]);
  assert.deepEqual(provider.routes().map((x) => x.id), [b.id]);
});

test("router messages need a known type and a clientId, and a v2_message that is not STOP does nothing", () => {
  assert.equal(parseDialMessage("nope"), null);
  assert.equal(parseDialMessage(JSON.stringify({ type: "app_message", clientId: "c", message: {} })), null, "a Cast type is not a DIAL type");
  assert.equal(parseDialMessage(JSON.stringify({ type: "client_connect", message: {} })), null, "clientId is required");
  assert.equal(parseDialMessage(JSON.stringify({ type: "client_connect", clientId: "c" }))?.sequenceNumber, -1);
  assert.equal(parseDialMessage(JSON.stringify({ type: "v2_message", clientId: "other", message: { type: "STOP" }, sequenceNumber: 4 }))?.sequenceNumber, 4);
});

test("terminating a route whose launch POST is still in flight cancels the POST, as erasing the record does in Chrome", async () => {
  // DialActivityManager::StopApp erases a record that is not yet kLaunched; its pending launch fetcher goes with it.
  let release: (r: ReturnType<typeof ok>) => void = () => undefined;
  const http = new FakeHttp().reply("POST", RUN_URL, () => new Promise((r) => { release = r; }));
  const { provider, messages, terminated } = setup({ http });
  const { route: r } = route(provider);
  provider.sendRouteMessage(r.id, dialEnvelope("client_connect", {}, "client-1"));
  await flush();
  provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: true }, "client-1", messages[0]!.message.sequenceNumber as number));
  await flush();
  const post = http.calls.find((c) => c.method === "POST");
  assert.equal(post?.signal?.aborted, false);
  await provider.terminateRoute(r.id);
  assert.equal(post?.signal?.aborted, true, "the POST is cancelled");
  assert.deepEqual(http.calls.filter((c) => c.method === "DELETE"), [], "nothing is deleted: the launch is treated as never made");
  release(ok("", {}, 201));
  await flush();
  assert.deepEqual(terminated, [r.id]);
  assert.deepEqual(provider.routes(), []);
});

test("dispose cancels a launch POST that is in flight", async () => {
  const http = new FakeHttp().reply("POST", RUN_URL, () => new Promise(() => undefined));
  const { provider, messages } = setup({ http });
  const { route: r } = route(provider);
  provider.sendRouteMessage(r.id, dialEnvelope("client_connect", {}, "client-1"));
  await flush();
  provider.sendRouteMessage(r.id, dialEnvelope("custom_dial_launch", { doLaunch: true }, "client-1", messages[0]!.message.sequenceNumber as number));
  await flush();
  const post = http.calls.find((c) => c.method === "POST");
  provider.dispose();
  assert.equal(post?.signal?.aborted, true);
});
