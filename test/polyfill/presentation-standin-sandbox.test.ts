// PresentationRequest::Create throws a SecurityError in a document sandboxed without allow-presentation
// (presentation_request.cc, WebSandboxFlags::kPresentationController). A page can see its own sandbox only through the
// embedding iframe element, which `frameElement` gives a same-origin parent's child.
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { installPresentationStandIn } from "../../src/polyfill/presentation-standin.ts";

const KEY = "__electronCastPresentationBridge";
function run(code: string, frameElement: unknown): any {
  const sandbox: any = {
    setTimeout, clearTimeout, queueMicrotask, console, EventTarget, Event, MessageEvent, DOMException, URL, crypto,
    navigator: { userActivation: { isActive: true } },
    [KEY]: { call: async () => ({ ok: true, value: { available: false } }), send() {}, onEvent() {} },
  };
  if (frameElement !== undefined) Object.defineProperty(sandbox, "frameElement", { get: () => { if (frameElement instanceof Error) throw frameElement; return frameElement; } });
  const ctx = vm.createContext(sandbox);
  vm.runInContext("globalThis.window = globalThis;", ctx);
  vm.runInContext(`(${installPresentationStandIn.toString()})(${JSON.stringify(KEY)})`, ctx);
  return vm.runInContext(code, ctx);
}
const iframe = (tokens: string | null) => ({
  tagName: "IFRAME",
  hasAttribute: (n: string) => n === "sandbox" && tokens !== null,
  sandbox: { contains: (t: string) => (tokens ?? "").split(" ").includes(t) },
});
const construct = `(() => { try { new PresentationRequest("cast:A"); return "constructed"; } catch (e) { return e.name + ": " + e.message; } })()`;

test("a sandboxed iframe without allow-presentation gets Blink's SecurityError", () => {
  assert.equal(run(construct, iframe("allow-scripts allow-same-origin")), "SecurityError: The document is sandboxed and lacks the 'allow-presentation' flag.");
  assert.equal(run(construct, iframe("")), "SecurityError: The document is sandboxed and lacks the 'allow-presentation' flag.");
});

test("allow-presentation, no sandbox attribute, no frame element and an unreadable parent all construct", () => {
  assert.equal(run(construct, iframe("allow-scripts allow-presentation")), "constructed");
  assert.equal(run(construct, iframe(null)), "constructed");
  assert.equal(run(construct, null), "constructed");
  assert.equal(run(construct, undefined), "constructed");
  assert.equal(run(construct, new DOMException("blocked", "SecurityError")), "constructed");
});
