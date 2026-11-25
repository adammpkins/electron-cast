// Binary messages on both stand-ins' PresentationConnection (send(ArrayBuffer | ArrayBufferView | Blob), binaryType),
// after Blink's presentation_connection.cc: sends leave in order, a Blob being read holds back the ones behind it, and
// a received message is an ArrayBuffer or a Blob by binaryType. Run from the installers' source text in a vm realm.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installPresentationStandIn } from "../../src/polyfill/presentation-standin.ts";
import { installPresentationReceiver } from "../../src/polyfill/presentation-receiver.ts";
import { MAX_MESSAGE_SIZE } from "../../src/electron/wired-display/local-presentation.ts";

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
type Sent = [string, string | number[]];

function make(kind: "controller" | "receiver", local = true) {
  const KEY = "__bridge";
  const sent: Sent[] = [];
  let listener: ((e: any) => void) | null = null;
  const sandbox: any = {
    setTimeout, clearTimeout, queueMicrotask, console, Promise,
    EventTarget, Event, MessageEvent, DOMException, URL, crypto, Blob,
    navigator: { userAgent: "Mozilla/5.0 Chrome/140", userActivation: { isActive: true } },
  };
  sandbox[KEY] = {
    call: async (method: string) => (method === "start" ? { ok: true, value: { id: "mr_1", url: "https://example.com/r", ...(local ? { local: true } : {}) } } : { ok: true }),
    send: (id: string, data: unknown) => { sent.push([id, typeof data === "string" ? data : Array.from(data as Uint8Array)]); },
    onEvent: (l: (e: any) => void) => { listener = l; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.window = globalThis;", ctx);
  const install = kind === "controller" ? installPresentationStandIn : installPresentationReceiver;
  vm.runInContext(`(${install.toString()})(${JSON.stringify(KEY)})`, ctx);
  const run = (c: string): any => vm.runInContext(c, ctx);
  const emit = (e: any): void => listener?.(e);
  const json = (c: string): any => JSON.parse(JSON.stringify(run(c)));
  return { ctx, sent, run, emit, json, kind, async connect() {
    if (kind === "controller") {
      run(`globalThis.conn = null; new PresentationRequest(["https://example.com/r"]).start().then((c) => { globalThis.conn = c; });`);
    } else {
      run(`globalThis.conn = null; navigator.presentation.receiver.connectionList.then((l) => { globalThis.conn = l.connections[0]; });`);
      emit({ type: "connection", connectionId: "c1", id: "mr_1", url: "https://example.com/r" });
    }
    await tick(5);
    assert.equal(run("conn.state"), "connected");
    return kind === "controller" ? (run("conn.connectionId") as string) : "c1";
  } };
}

for (const kind of ["controller", "receiver"] as const) {
  const emitMessage = (h: ReturnType<typeof make>, id: string, extra: object) => h.emit({ type: "message", connectionId: id, ...extra });

  test(`${kind}: send() takes an ArrayBuffer, a view (only its own bytes) and a Blob, and converts anything else to a string`, async () => {
    const h = make(kind);
    const id = await h.connect();
    h.run("conn.send(new Uint8Array([1, 2, 3]).buffer)");
    h.run("conn.send(new Uint8Array([9, 8, 7, 6, 5]).subarray(1, 4))");
    h.run("conn.send(new Uint16Array([258]))");
    h.run("conn.send(42)");
    assert.deepEqual(h.sent, [[id, [1, 2, 3]], [id, [8, 7, 6]], [id, [2, 1]], [id, "42"]]);
    h.ctx.blob = new Blob([new Uint8Array([4, 5])]);
    h.run("conn.send(blob)");
    await tick(10);
    assert.deepEqual(h.sent.at(-1), [id, [4, 5]]);
    h.run("globalThis.mine = new Uint8Array([1, 2]); conn.send(mine); mine[0] = 99;");
    assert.deepEqual(h.sent.at(-1), [id, [1, 2]], "the bytes are copied at send time");
  });

  test(`${kind}: while a Blob is being read the sends behind it wait, in order (HandleMessageQueue)`, async () => {
    const h = make(kind);
    const id = await h.connect();
    let finish!: (b: ArrayBuffer) => void;
    h.ctx.slow = { [Symbol.toStringTag]: "Blob", arrayBuffer: () => new Promise((r) => { finish = r; }) };
    h.run("conn.send('first'); conn.send(slow); conn.send('after'); conn.send(new Uint8Array([7]));");
    assert.deepEqual(h.sent, [[id, "first"]]);
    finish(new Uint8Array([5, 5]).buffer);
    await tick(5);
    assert.deepEqual(h.sent, [[id, "first"], [id, [5, 5]], [id, "after"], [id, [7]]]);
  });

  test(`${kind}: a Blob that cannot be read is skipped and the queue goes on; closing drops what was waiting`, async () => {
    const h = make(kind);
    const id = await h.connect();
    h.ctx.bad = { [Symbol.toStringTag]: "Blob", arrayBuffer: () => Promise.reject(new Error("read failed")) };
    h.run("conn.send(bad); conn.send('next');");
    await tick(5);
    assert.deepEqual(h.sent, [[id, "next"]]);
    let finish!: (b: ArrayBuffer) => void;
    h.ctx.slow = { [Symbol.toStringTag]: "Blob", arrayBuffer: () => new Promise((r) => { finish = r; }) };
    h.run("conn.send(slow); conn.send('queued'); conn.close();");
    finish(new Uint8Array([1]).buffer);
    await tick(5);
    assert.equal(h.sent.length, 1, "nothing leaves a connection that closed (TearDown)");
  });

  test(`${kind}: send() on a closed connection throws InvalidStateError, also with binary`, async () => {
    const h = make(kind);
    await h.connect();
    h.run("conn.close()");
    assert.equal(h.run("(() => { try { conn.send(new ArrayBuffer(1)); } catch (e) { return e.name; } })()"), "InvalidStateError");
  });

  test(`${kind}: binaryType is arraybuffer by default, takes blob or arraybuffer and ignores anything else`, async () => {
    const h = make(kind);
    await h.connect();
    assert.equal(h.run("conn.binaryType"), "arraybuffer");
    h.run("conn.binaryType = 'blob'");
    assert.equal(h.run("conn.binaryType"), "blob");
    h.run("conn.binaryType = 'text'");
    assert.equal(h.run("conn.binaryType"), "blob");
    h.run("conn.binaryType = 'arraybuffer'");
    assert.equal(h.run("conn.binaryType"), "arraybuffer");
  });

  test(`${kind}: received bytes arrive as an ArrayBuffer, or as a Blob when binaryType is blob; text stays text`, async () => {
    const h = make(kind);
    const id = await h.connect();
    h.run("globalThis.got = []; conn.onmessage = (e) => got.push(e.data);");
    emitMessage(h, id, { bytes: new Uint8Array([1, 2, 3]) });
    emitMessage(h, id, { data: "text" });
    await tick(5);
    assert.equal(h.run("Object.prototype.toString.call(got[0])"), "[object ArrayBuffer]");
    assert.deepEqual(h.json("Array.from(new Uint8Array(got[0]))"), [1, 2, 3]);
    assert.equal(h.run("got[1]"), "text");
    h.run("conn.binaryType = 'blob'");
    emitMessage(h, id, { bytes: new Uint8Array([9, 9]).subarray(1) });
    await tick(5);
    assert.equal(h.run("Object.prototype.toString.call(got[2])"), "[object Blob]");
    assert.deepEqual(Array.from(new Uint8Array(await (h.run("got[2]") as Blob).arrayBuffer())), [9], "only the viewed bytes");
  });
}

test("the stand-ins carry the same size cap as main (MAX_MESSAGE_SIZE)", () => {
  for (const install of [installPresentationStandIn, installPresentationReceiver]) {
    const m = /const MAX_MESSAGE_SIZE = (\d+) \* 1024 \* 1024;/.exec(install.toString());
    assert.ok(m, "the literal is there");
    assert.equal(Number(m[1]) * 1024 * 1024, MAX_MESSAGE_SIZE);
  }
});

for (const kind of ["controller", "receiver"] as const) {
  const rangeError = (h: ReturnType<typeof make>, code: string) =>
    h.run(`(() => { try { ${code}; return "sent"; } catch (e) { return e.name + ": " + e.message; } })()`);

  test(`${kind}: send() past the cap throws RangeError for text, ArrayBuffer, view and Blob, and nothing is queued`, async () => {
    const h = make(kind);
    const id = await h.connect();
    const expected = `RangeError: Message size exceeds the maximum supported size (${MAX_MESSAGE_SIZE})`;
    h.ctx.big = new ArrayBuffer(MAX_MESSAGE_SIZE + 1);
    h.ctx.bigText = "x".repeat(MAX_MESSAGE_SIZE + 1);
    h.ctx.bigBlob = { [Symbol.toStringTag]: "Blob", size: MAX_MESSAGE_SIZE + 1, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
    assert.equal(rangeError(h, "conn.send(bigText)"), expected);
    assert.equal(rangeError(h, "conn.send(big)"), expected);
    assert.equal(rangeError(h, "conn.send(new Uint8Array(big))"), expected);
    assert.equal(rangeError(h, "conn.send(bigBlob)"), expected);
    assert.equal(h.sent.length, 0);
    h.run("conn.send('still works')");
    assert.deepEqual(h.sent, [[id, "still works"]]);
  });

  test(`${kind}: a detached ArrayBuffer is a TypeError at the call and the queue is left as it was`, async () => {
    const h = make(kind);
    const id = await h.connect();
    const buf = new ArrayBuffer(8);
    structuredClone(buf, { transfer: [buf] });
    h.ctx.dead = buf;
    h.ctx.deadView = new Uint8Array(new ArrayBuffer(8));
    structuredClone(h.ctx.deadView.buffer, { transfer: [h.ctx.deadView.buffer] });
    assert.match(rangeError(h, "conn.send(dead)"), /^TypeError/);
    assert.match(rangeError(h, "conn.send(deadView)"), /^TypeError/);
    h.run("conn.send('after')");
    assert.deepEqual(h.sent, [[id, "after"]]);
  });
}

test("controller: only a local connection is capped by the stand-in; a Cast message is main's to limit", async () => {
  const h = make("controller", false);
  const id = await h.connect();
  h.ctx.bigText = "x".repeat(MAX_MESSAGE_SIZE + 1);
  h.run("conn.send(bigText)");
  assert.equal((h.sent[0]![1] as string).length, MAX_MESSAGE_SIZE + 1);
  assert.equal(h.sent[0]![0], id);
});
