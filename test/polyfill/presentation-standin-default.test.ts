// The stand-in's navigator.presentation.defaultRequest: Blink's Presentation::setDefaultRequest reports it to the
// browser, and PresentationController::OnDefaultPresentationStarted answers with connectionavailable.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installPresentationStandIn } from "../../src/polyfill/presentation-standin.ts";

const KEY = "__electronCastPresentationBridge";
const URL1 = "https://google.com/cast#__castAppId__=CC1AD845/__castClientId__=1";
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const calls: { method: string; params: any }[] = [];
  let listener: ((e: any) => void) | null = null;
  const sandbox: any = {
    setTimeout, clearTimeout, queueMicrotask, console,
    EventTarget, Event, MessageEvent, DOMException, URL, crypto,
    navigator: { userActivation: { isActive: true } },
  };
  sandbox[KEY] = {
    call: async (method: string, params: any) => {
      calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
      return { ok: true, value: undefined };
    },
    send: () => {},
    onEvent: (l: (e: any) => void) => { listener = l; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.window = globalThis;", ctx);
  vm.runInContext(`(${installPresentationStandIn.toString()})(${JSON.stringify(KEY)})`, ctx);
  return { calls, emit: (e: any) => listener?.(e), run: (c: string) => vm.runInContext(c, ctx) };
}

test("setting defaultRequest reports its URLs, replacing and clearing it reports again", () => {
  const h = setup();
  assert.equal(h.run("navigator.presentation.defaultRequest"), null);
  h.run(`navigator.presentation.defaultRequest = new PresentationRequest([${JSON.stringify(URL1)}, "cast:A"]);`);
  h.run(`navigator.presentation.defaultRequest = new PresentationRequest("cast:B");`);
  h.run("navigator.presentation.defaultRequest = null;");
  h.run("navigator.presentation.defaultRequest = undefined;");
  assert.deepEqual(h.calls.map((c) => [c.method, c.params.urls]), [
    ["setDefaultRequest", [URL1, "cast:A"]],
    ["setDefaultRequest", ["cast:B"]],
    ["setDefaultRequest", []],
    ["setDefaultRequest", []],
  ]);
  assert.equal(h.run("navigator.presentation.defaultRequest"), null, "undefined is null for a nullable attribute");
});

test("defaultRequest takes a PresentationRequest or null, nothing else", () => {
  const h = setup();
  for (const bad of ["'cast:A'", "{ urls: ['cast:A'] }", "42"]) {
    assert.equal(h.run(`(() => { try { navigator.presentation.defaultRequest = ${bad}; } catch (e) { return e.name; } })()`), "TypeError", bad);
  }
  assert.equal(h.calls.length, 0, "a refused value is not reported");
  assert.equal(h.run("navigator.presentation.defaultRequest"), null);
});

test("connectionavailable fires on the default request, after the current task, with a connected connection", async () => {
  const h = setup();
  h.run(`window.__got = []; const r = new PresentationRequest(${JSON.stringify(URL1)});
    r.addEventListener("connectionavailable", (e) => __got.push(e.connection));
    navigator.presentation.defaultRequest = r;`);
  h.emit({ type: "connectionavailable", connectionId: "c1", id: "cast-session_s1", url: URL1 });
  assert.equal(h.run("__got.length"), 0, "enqueued, not synchronous");
  await tick(5);
  assert.equal(h.run("__got.length"), 1);
  assert.equal(h.run("__got[0] instanceof PresentationConnection"), true);
  assert.equal(h.run("__got[0].state"), "connected");
  assert.equal(h.run("__got[0].id"), "cast-session_s1");
  assert.equal(h.run("__got[0].url"), JSON.stringify(URL1).slice(1, -1));
  // the connection works like any other: its messages are buffered until a listener exists
  h.emit({ type: "message", connectionId: "c1", data: "m1" });
  h.run(`window.__m = []; __got[0].onmessage = (e) => __m.push(e.data);`);
  await tick(5);
  assert.deepEqual(Array.from(h.run("__m")), ["m1"]);
  h.run("__got[0].terminate()");
  assert.ok(h.calls.some((c) => c.method === "terminate" && c.params.connectionId === "c1"));
});

test("a connectionavailable with no default request is dropped and its connection closed, as Blink drops it", async () => {
  const h = setup();
  h.emit({ type: "connectionavailable", connectionId: "c9", id: "cast-session_s9", url: URL1 });
  await tick(5);
  assert.deepEqual(h.calls.filter((c) => c.method === "close").map((c) => c.params.connectionId), ["c9"]);
});
