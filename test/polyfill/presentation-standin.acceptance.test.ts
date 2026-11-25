// Acceptance tests for the page-side Presentation API stand-in (written before the implementation; do not edit to
// make them pass). Spec: docs/upstream/research/presentation-mode-spec.md, section 4.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installPresentationStandIn } from "../../src/polyfill/presentation-standin.ts";

const KEY = "__electronCastPresentationBridge";

function setup(opts: { bridge?: boolean; active?: boolean } = {}) {
  const calls: { method: string; params: any }[] = [];
  const sent: [string, string][] = [];
  const handlers: Record<string, (p: any) => any> = {};
  let listener: ((e: any) => void) | null = null;
  const sandbox: any = {
    setTimeout, clearTimeout, queueMicrotask, console,
    EventTarget, Event, MessageEvent, DOMException, URL, crypto,
    navigator: { userAgent: "Mozilla/5.0 Chrome/140.0.0.0", userActivation: { isActive: opts.active !== false }, presentation: { native: true } },
  };
  if (opts.bridge !== false) {
    sandbox[KEY] = {
      call: async (method: string, params: any) => {
        calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
        return handlers[method] ? handlers[method](params) : { ok: true, value: undefined };
      },
      send: (id: string, data: string) => { sent.push([id, data]); },
      onEvent: (l: (e: any) => void) => { listener = l; },
    };
  }
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.window = globalThis;", ctx);
  const installed = vm.runInContext(`(${installPresentationStandIn.toString()})(${JSON.stringify(KEY)})`, ctx);
  return { ctx, calls, sent, handlers, installed, emit: (e: any) => listener?.(e), run: (c: string) => vm.runInContext(c, ctx) };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const URL1 = "https://google.com/cast#__castAppId__=CC1AD845/__castClientId__=1";

test("installs PresentationRequest and replaces navigator.presentation", () => {
  const h = setup();
  assert.equal(h.installed, true);
  assert.equal(typeof h.ctx.PresentationRequest, "function");
  assert.equal(h.run("navigator.presentation.native"), undefined, "the native object is shadowed");
  assert.equal(h.run("navigator.presentation.receiver"), null);
  assert.equal(h.run("navigator.presentation.defaultRequest"), null);
  h.run(`navigator.presentation.defaultRequest = new PresentationRequest(${JSON.stringify(URL1)});`);
  assert.ok(h.run("navigator.presentation.defaultRequest instanceof PresentationRequest"));
  assert.ok(h.run("!!window.chrome"), "window.chrome exists for Google's loader");
  assert.equal(setup({ bridge: false }).installed, false);
});

test("PresentationRequest validates URLs", () => {
  const h = setup();
  assert.deepEqual(Array.from(h.run(`new PresentationRequest(${JSON.stringify(URL1)}).urls`)), [URL1]);
  assert.deepEqual(Array.from(h.run(`new PresentationRequest(["cast:A", ${JSON.stringify(URL1)}]).urls`)), ["cast:A", URL1]);
  assert.equal(h.run(`(() => { try { new PresentationRequest("not a url"); } catch (e) { return e.name; } })()`), "SyntaxError");
  assert.equal(h.run(`(() => { try { new PresentationRequest([]); } catch (e) { return e.name; } })()`), "NotSupportedError");
});

test("getAvailability reports the main process value and its changes", async () => {
  const h = setup();
  h.handlers.getAvailability = () => ({ ok: true, value: { available: false } });
  h.run(`window.__ch = 0; new PresentationRequest(${JSON.stringify(URL1)}).getAvailability().then((a) => { window.__a = a; a.onchange = () => __ch++; });`);
  await tick(5);
  const call = h.calls.find((c) => c.method === "getAvailability");
  assert.ok(call && typeof call.params.watchId === "string" && call.params.urls[0] === URL1);
  assert.equal(h.run("__a.value"), false);
  h.emit({ type: "availability", watchId: call.params.watchId, value: true });
  await tick(5);
  assert.equal(h.run("__a.value"), true);
  assert.equal(h.run("__ch"), 1);
  h.emit({ type: "availability", watchId: "other", value: false });
  await tick(5);
  assert.equal(h.run("__a.value"), true, "other watches do not change it");
});

test("start() opens a connection; messages are buffered until onmessage is set, then delivered in order", async () => {
  const h = setup();
  h.handlers.start = (p: any) => {
    h.emit({ type: "message", connectionId: p.connectionId, data: "m1" });
    h.emit({ type: "message", connectionId: p.connectionId, data: "m2" });
    return { ok: true, value: { id: "pres-1", url: URL1 } };
  };
  h.run(`window.__got = []; new PresentationRequest(${JSON.stringify(URL1)}).start().then((c) => { window.__c = c; setTimeout(() => { c.onmessage = (e) => __got.push(e.data); }, 20); });`);
  await tick(5);
  const call = h.calls.find((c) => c.method === "start");
  assert.ok(call && typeof call.params.connectionId === "string");
  assert.equal(h.run("__c.id"), "pres-1");
  assert.equal(h.run("__c.url"), URL1);
  assert.equal(h.run("__c.state"), "connected");
  h.emit({ type: "message", connectionId: call.params.connectionId, data: "m3" });
  await tick(40);
  assert.deepEqual(Array.from(h.run("__got")), ["m1", "m2", "m3"]);
  h.emit({ type: "message", connectionId: call.params.connectionId, data: "m4" });
  await tick(5);
  assert.deepEqual(Array.from(h.run("__got")), ["m1", "m2", "m3", "m4"]);
  h.run(`__c.send('{"type":"client_connect"}')`);
  assert.deepEqual(h.sent, [[call.params.connectionId, '{"type":"client_connect"}']]);
  // Binary is sent as bytes (presentation_connection.cc send(ArrayBuffer)); presentation-binary.test.ts covers it in full
  h.run("__c.send(new ArrayBuffer(1))");
  assert.deepEqual(h.sent.map(([, d]) => (typeof d === "string" ? d : Array.from(d as any))).at(-1), [0]);
});

test("start() needs a user gesture, rejects with the main process DOMException name, and allows one at a time", async () => {
  const idle = setup({ active: false });
  idle.run(`new PresentationRequest(${JSON.stringify(URL1)}).start().catch((e) => { window.__e = e.name; });`);
  await tick(5);
  assert.equal(idle.run("__e"), "InvalidAccessError");
  assert.equal(idle.calls.length, 0);

  const h = setup();
  let release: (v: any) => void = () => {};
  h.handlers.start = () => new Promise((r) => { release = r; });
  h.run(`window.__r = []; const pr = new PresentationRequest(${JSON.stringify(URL1)});
    pr.start().catch((e) => __r.push(["first", e.name, e.message]));
    pr.start().catch((e) => __r.push(["second", e.name]));`);
  await tick(5);
  assert.equal(h.calls.filter((c) => c.method === "start").length, 1);
  release({ ok: false, code: "AbortError", description: "Dialog closed" });
  await tick(5);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("__r"))), [["second", "OperationError"], ["first", "AbortError", "Dialog closed"]]);
});

test("reconnect() passes the presentation id and rejects with NotFoundError", async () => {
  const h = setup();
  h.handlers.reconnect = (p: any) => (p.presentationId === "auto-join"
    ? { ok: true, value: { id: "auto-join", url: URL1 } }
    : { ok: false, code: "NotFoundError", description: "No matching route" });
  h.run(`window.__r = []; const pr = new PresentationRequest(${JSON.stringify(URL1)});
    pr.reconnect("auto-join").then((c) => __r.push(["ok", c.id, c.state]));
    pr.reconnect("_receiver-action").catch((e) => __r.push(["err", e.name]));`);
  await tick(5);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("__r"))), [["ok", "auto-join", "connected"], ["err", "NotFoundError"]]);
  const calls = h.calls.filter((c) => c.method === "reconnect");
  assert.deepEqual(calls.map((c) => c.params.presentationId), ["auto-join", "_receiver-action"]);
  assert.ok(calls.every((c) => typeof c.params.connectionId === "string" && c.params.urls[0] === URL1));
});

test("state changes from the main process close or terminate the connection", async () => {
  const h = setup();
  h.handlers.start = () => ({ ok: true, value: { id: "p", url: URL1 } });
  h.run(`window.__ev = []; new PresentationRequest(${JSON.stringify(URL1)}).start().then((c) => { window.__c = c;
    c.onclose = (e) => __ev.push(["close", c.state]); c.onterminate = () => __ev.push(["terminate", c.state]); });`);
  await tick(5);
  const id = h.calls.find((c) => c.method === "start")!.params.connectionId;
  h.emit({ type: "statechange", connectionId: id, state: "closed" });
  await tick(5);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("__ev"))), [["close", "closed"]]);
  assert.equal(h.run(`(() => { try { __c.send("x"); return "sent"; } catch (e) { return e.name; } })()`), "InvalidStateError");
  h.run(`__c.close()`);
  await tick(5);
  assert.equal(h.calls.filter((c) => c.method === "close").length, 0, "closing a closed connection does nothing");
});

test("close() and terminate() tell the main process", async () => {
  const h = setup();
  h.handlers.start = () => ({ ok: true, value: { id: "p", url: URL1 } });
  h.run(`new PresentationRequest(${JSON.stringify(URL1)}).start().then((c) => { window.__c = c; });`);
  await tick(5);
  const id = h.calls.find((c) => c.method === "start")!.params.connectionId;
  h.run(`__c.terminate()`);
  await tick(5);
  assert.deepEqual(h.calls.filter((c) => c.method === "terminate").map((c) => c.params), [{ connectionId: id }]);
});
