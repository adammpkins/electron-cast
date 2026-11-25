// The receiver half of the Presentation API in a receiver window (src/polyfill/presentation-receiver.ts), run from its
// source text in a fresh vm realm like the page's main world.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installPresentationReceiver } from "../../src/polyfill/presentation-receiver.ts";

const KEY = "__electronCastReceiverBridge";
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const calls: { method: string; params: any }[] = [];
  const sent: [string, string][] = [];
  let listener: ((e: any) => void) | null = null;
  const sandbox: any = {
    setTimeout, clearTimeout, queueMicrotask, console,
    EventTarget, Event, MessageEvent, DOMException,
    navigator: { userAgent: "Mozilla/5.0 Chrome/140" },
  };
  sandbox[KEY] = {
    call: async (method: string, params: any) => {
      calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
      return { ok: true };
    },
    send: (id: string, data: string) => { sent.push([id, data]); },
    onEvent: (l: (e: any) => void) => { listener = l; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.window = globalThis;", ctx);
  const installed = vm.runInContext(`(${installPresentationReceiver.toString()})(${JSON.stringify(KEY)})`, ctx);
  return { ctx, calls, sent, installed, emit: (e: any) => listener?.(e), run: (c: string) => vm.runInContext(c, ctx) };
}
const connect = (id = "c1") => ({ type: "connection", connectionId: id, id: "mr_abc", url: "https://example.com/r" });

test("installs only with a bridge", () => {
  const ctx = vm.createContext({ setTimeout, EventTarget, Event, navigator: {} });
  assert.equal(vm.runInContext(`(${installPresentationReceiver.toString()})("nope")`, ctx), false);
  assert.equal(setup().installed, true);
});

test("nothing registers until navigator.presentation is used, then once (Presentation::MaybeInitReceiver)", () => {
  const h = setup();
  assert.equal(h.calls.length, 0);
  h.run("navigator.presentation");
  h.run("navigator.presentation.receiver");
  h.run("navigator.presentation.receiver");
  assert.deepEqual(h.calls.map((c) => c.method), ["register"]);
  assert.equal(h.run("navigator.presentation.defaultRequest"), null);
});

test("connectionList resolves with the list when the first connection arrives, without an event", async () => {
  const h = setup();
  h.run(`globalThis.events = []; globalThis.list = null;
    navigator.presentation.receiver.connectionList.then((l) => { globalThis.list = l; l.onconnectionavailable = (e) => globalThis.events.push(e.connection.id); });`);
  assert.equal(h.run("list"), null);
  h.emit(connect());
  await tick();
  assert.equal(h.run("list.connections.length"), 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("events"))), [], "the first connection is in the resolved list, not announced");
  h.emit(connect("c2"));
  assert.equal(h.run("list.connections.length"), 2);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("events"))), ["mr_abc"]);
  assert.equal(h.run("navigator.presentation.receiver.connectionList === navigator.presentation.receiver.connectionList"), true, "SameObject");
});

test("connections that arrived before connectionList was read are in the list it resolves with", async () => {
  const h = setup();
  h.run("navigator.presentation");
  h.emit(connect());
  h.run("globalThis.list = null; navigator.presentation.receiver.connectionList.then((l) => { globalThis.list = l; });");
  await tick();
  assert.equal(h.run("list.connections.length"), 1);
  assert.equal(h.run("Object.isFrozen(list.connections)"), true);
  assert.equal(h.run("list.connections === list.connections"), true, "a FrozenArray is the same array until it changes");
});

test("a receiver connection is connected, fires connect, has id and url, and exchanges strings", async () => {
  const h = setup();
  h.run(`globalThis.log = []; globalThis.conn = null;
    navigator.presentation.receiver.connectionList.then((l) => {
      const c = l.connections[0]; globalThis.conn = c;
      c.onmessage = (e) => log.push("m:" + e.data); c.onconnect = () => log.push("connect");
    });`);
  h.emit(connect());
  await tick(5);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("[conn.id, conn.url, conn.state]"))), ["mr_abc", "https://example.com/r", "connected"]);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("log"))), ["connect"]);
  h.emit({ type: "message", connectionId: "c1", data: "ping" });
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("log"))), ["connect", "m:ping"]);
  h.run("conn.send('pong')");
  assert.deepEqual(h.sent, [["c1", "pong"]]);
  assert.throws(() => h.run("conn.send(new ArrayBuffer(2))"), { name: "TypeError" });
});

test("close(): tells the controller, closes with reason closed, leaves the list; later sends throw InvalidStateError", async () => {
  const h = setup();
  h.run("globalThis.log = []; globalThis.list = null; navigator.presentation.receiver.connectionList.then((l) => { globalThis.list = l; });");
  h.emit(connect());
  await tick();
  h.run("list.connections[0].addEventListener('close', (e) => log.push('close:' + e.reason)); globalThis.conn = list.connections[0]; conn.close(); conn.close();");
  assert.deepEqual(h.calls.map((c) => c.method), ["register", "close"], "close() twice tells the controller once");
  assert.equal(h.run("conn.state"), "closed");
  assert.equal(h.run("list.connections.length"), 0);
  await tick(5);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("log"))), ["close:closed"]);
  assert.throws(() => h.run("conn.send('x')"), /not connected/);
});

test("the controller closing closes the receiver's connection the same way", async () => {
  const h = setup();
  h.run("globalThis.log = []; navigator.presentation.receiver.connectionList.then((l) => { globalThis.conn = l.connections[0]; conn.onclose = (e) => log.push(e.reason); });");
  h.emit(connect());
  await tick();
  h.emit({ type: "closed", connectionId: "c1" });
  await tick(5);
  assert.equal(h.run("conn.state"), "closed");
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("log"))), ["closed"]);
});

test("terminate(): asks main to close the window, state terminated, and no event fires on the receiver (TerminateInternal)", async () => {
  const h = setup();
  h.run("globalThis.log = []; navigator.presentation.receiver.connectionList.then((l) => { globalThis.conn = l.connections[0]; conn.onterminate = () => log.push('t'); conn.onclose = () => log.push('c'); });");
  h.emit(connect());
  await tick();
  h.run("conn.terminate()");
  assert.deepEqual(h.calls.map((c) => c.method), ["register", "terminate"]);
  assert.equal(h.run("conn.state"), "terminated");
  await tick(5);
  assert.deepEqual(JSON.parse(JSON.stringify(h.run("log"))), []);
});

test("dialogs are suppressed (kModals)", () => {
  const h = setup();
  assert.equal(h.run("alert('x')"), undefined);
  assert.equal(h.run("confirm('x')"), false);
  assert.equal(h.run("prompt('x')"), null);
});
