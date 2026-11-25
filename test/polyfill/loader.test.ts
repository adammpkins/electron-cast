// Extra tests for cooperating with Google's cast_sender.js loader, beyond loader.acceptance.test.ts: the
// wrapped src accessor keeps the original getter, setAttribute keeps its return value and works on
// non-script elements, install stays self-contained in a vm without any DOM, near-miss URLs are not
// blocked, and a callback replaced before DOMContentLoaded is never called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, tick, plain } from "./harness.ts";

/** A minimal DOM: Element.setAttribute, HTMLScriptElement.src, document.readyState and DOMContentLoaded. */
const DOM = `
  class Element { constructor() { this.attrs = {}; } setAttribute(n, v) { this.attrs[n] = String(v); } }
  class HTMLScriptElement extends Element {}
  Object.defineProperty(HTMLScriptElement.prototype, "src", {
    configurable: true, enumerable: true,
    get() { return this._src ?? ""; },
    set(v) { this._src = String(v); },
  });
  globalThis.Element = Element;
  globalThis.HTMLScriptElement = HTMLScriptElement;
  const dcl = [];
  globalThis.document = {
    readyState: "loading",
    addEventListener(t, f) { if (t === "DOMContentLoaded") dcl.push(f); },
    removeEventListener(t, f) { const i = dcl.indexOf(f); if (i >= 0) dcl.splice(i, 1); },
  };
  globalThis.__fireDCL = () => { document.readyState = "interactive"; for (const f of dcl.splice(0)) f(); };
  globalThis.__calls = [];
`;

/** Same fake, but setAttribute returns a marker so the wrapper's return value can be checked. */
const DOM_RET = `
  class Element { constructor() { this.attrs = {}; } setAttribute(n, v) { this.attrs[n] = String(v); return ["set", n]; } }
  class HTMLScriptElement extends Element {}
  Object.defineProperty(HTMLScriptElement.prototype, "src", {
    configurable: true, enumerable: true,
    get() { return this._src ?? ""; },
    set(v) { this._src = String(v); },
  });
  globalThis.Element = Element;
  globalThis.HTMLScriptElement = HTMLScriptElement;
  const dcl = [];
  globalThis.document = {
    readyState: "loading",
    addEventListener(t, f) { if (t === "DOMContentLoaded") dcl.push(f); },
    removeEventListener(t, f) { const i = dcl.indexOf(f); if (i >= 0) dcl.splice(i, 1); },
  };
  globalThis.__fireDCL = () => { document.readyState = "interactive"; for (const f of dcl.splice(0)) f(); };
  globalThis.__calls = [];
`;

test("the original src getter still works after the polyfill wraps the setter", () => {
  const h = createHarness({ before: DOM });
  const r = plain(h.run(`(() => {
    const s = new HTMLScriptElement();
    s.src = "https://example.test/app.js";
    const first = s.src;
    s.src = "//www.gstatic.com/eureka/clank/156/cast_sender.js"; // blocked: must not touch the stored value
    const desc = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype, "src");
    return {
      first,
      after: s.src,
      hasGet: typeof desc.get === "function",
      hasSet: typeof desc.set === "function",
      configurable: desc.configurable,
      enumerable: desc.enumerable,
    };
  })()`));
  assert.equal(r.first, "https://example.test/app.js");
  assert.equal(r.after, "https://example.test/app.js", "a blocked assignment leaves the previous src in place");
  assert.equal(r.hasGet, true, "the original getter is kept");
  assert.equal(r.hasSet, true);
  assert.equal(r.configurable, true);
  assert.equal(r.enumerable, true);
});

test("setAttribute returns the original's return value and works on non-script elements", () => {
  const h = createHarness({ before: DOM_RET });
  const r = plain(h.run(`(() => {
    const s = new HTMLScriptElement();
    const ok = s.setAttribute("src", "https://example.test/app.js");
    const blocked = s.setAttribute("src", "//www.gstatic.com/eureka/clank/156/cast_sender.js");
    const other = s.setAttribute("id", "x");
    const e = new Element();
    const onPlain = e.setAttribute("src", "//www.gstatic.com/eureka/clank/156/cast_sender.js");
    return { ok, blocked, other, onPlain, s: s.attrs, e: e.attrs };
  })()`));
  assert.deepEqual(r.ok, ["set", "src"], "allowed values go through the original and its result is returned");
  assert.equal(r.blocked, undefined, "blocked values are dropped");
  assert.deepEqual(r.other, ["set", "id"], "other attributes are untouched");
  assert.deepEqual(r.onPlain, ["set", "src"], "non-script elements are untouched");
  assert.deepEqual(r.s, { src: "https://example.test/app.js", id: "x" });
  assert.deepEqual(r.e, { src: "//www.gstatic.com/eureka/clank/156/cast_sender.js" });
});

test("install works in a vm without HTMLScriptElement, Element or document", async () => {
  const h = createHarness();
  assert.equal(h.win.chrome?.cast?.isAvailable, true, "the polyfill is installed");
  assert.equal(h.errors.length, 0, "no DOM access may throw");
  h.run(`window.__calls = []; window.__onGCastApiAvailable = (ok) => __calls.push(ok);`);
  assert.deepEqual(plain(h.win.__calls), [], "never synchronously");
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), [true], "without a document the callback is called asynchronously, as today");
});

test("near-miss URLs are not blocked", () => {
  const h = createHarness({ before: DOM });
  const urls = [
    "https://www.gstatic.com/eureka/clank/156/other.js",
    "https://www.gstatic.com/eureka/clank/156/cast_sender2.js",
    "https://www.gstatic.com/eureka/clank/cast_framework.js",
    "chrome-extension://pkedcjkdefgpdelpbcmbmeomcjbeemfn/cast_sender.js",
    "https://evil.test/www.gstatic.com/eureka/clank/cast_sender.js",
  ];
  for (const url of urls) {
    const r = plain(h.run(`(() => {
      const a = new HTMLScriptElement(); a.src = ${JSON.stringify(url)};
      const b = new HTMLScriptElement(); b.setAttribute("src", ${JSON.stringify(url)});
      return [a.src, b.attrs.src ?? null];
    })()`));
    assert.deepEqual(r, [url, url], url);
  }
});

test("a callback assigned while loading and replaced before DOMContentLoaded is never called", async () => {
  const h = createHarness({ before: DOM });
  h.run(`
    window.__onGCastApiAvailable = (ok) => __calls.push(["one", ok]);
    window.__onGCastApiAvailable = (ok) => __calls.push(["two", ok]);
  `);
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), [], "nothing is called while loading");
  h.run(`__fireDCL();`);
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), [["two", true]], "only the function stored at DOMContentLoaded is called");
});
