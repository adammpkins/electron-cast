// PresentationRequest::Create keeps only URLs of a known protocol (http, https, cast, cast-dial), so a page cannot
// make a remote-playback: request; only HTMLMediaElement.remote does, inside Blink.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installPresentationStandIn } from "../../src/polyfill/presentation-standin.ts";

const KEY = "__electronCastPresentationBridge";
function run(code: string): any {
  const calls: string[] = [];
  const sandbox: any = {
    setTimeout, clearTimeout, queueMicrotask, console, EventTarget, Event, MessageEvent, DOMException, URL, crypto,
    navigator: { userActivation: { isActive: true } },
    [KEY]: { call: async (m: string) => { calls.push(m); return { ok: true, value: { available: false } }; }, send() {}, onEvent() {} },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.window = globalThis;", ctx);
  vm.runInContext(`(${installPresentationStandIn.toString()})(${JSON.stringify(KEY)})`, ctx);
  return vm.runInContext(code, ctx);
}
const REMOTE = "remote-playback:media-element?source=aHR0cHM6Ly9leGFtcGxlLnRlc3Qv";

test("a remote-playback: URL alone is refused like an empty list", () => {
  assert.equal(run(`(() => { try { new PresentationRequest(${JSON.stringify(REMOTE)}); } catch (e) { return e.name + ": " + e.message; } })()`),
    "NotSupportedError: An empty sequence of URLs is not supported.");
});

test("unknown protocols are dropped and the known ones kept", () => {
  assert.deepEqual(Array.from(run(`new PresentationRequest([${JSON.stringify(REMOTE)}, "dial:YouTube", "cast:A", "cast-dial:B", "https://x.test/"]).urls`)),
    ["cast:A", "cast-dial:B", "https://x.test/"]);
});
