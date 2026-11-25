// Acceptance tests for cooperating with Google's cast_sender.js loader (written before the implementation; do not
// edit to make them pass). Background: Electron exposes navigator.presentation, so the loader takes its desktop
// Chrome path, injects //www.gstatic.com/eureka/clank/<version>/cast_sender.js (an implementation of chrome.cast on the
// Presentation API, which overwrites ours and finds no devices in Electron) and wraps window.__onGCastApiAvailable in
// a counter that fires the page's callback once both cast_framework.js and a chrome.cast implementation reported in.
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

const BLOCKED = [
  "//www.gstatic.com/eureka/clank/156/cast_sender.js",
  "//www.gstatic.com/eureka/clank/155/cast_sender.js",
  "//www.gstatic.com/eureka/clank/cast_sender.js",
  "https://www.gstatic.com/eureka/clank/156/cast_sender.js",
  "http://www.gstatic.com/eureka/clank/cast_sender.js",
  "chrome-extension://pkedcjkdefgpdelpbcmbmeomcjbeemfm/cast_sender.js",
  "chrome-extension://enhhojjnijigcajfphajepfemndkmdlo/cast_sender.js",
];
const ALLOWED = [
  "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1",
  "//www.gstatic.com/cast/sdk/libs/sender/1.0/cast_framework.js",
  "https://example.test/app.js",
  "https://example.test/eureka/clank/156/cast_sender.js",
];

test("Google's own chrome.cast implementations are never loaded; other scripts are untouched", () => {
  const h = createHarness({ before: DOM });
  for (const url of BLOCKED) {
    const r = plain(h.run(`(() => {
      const a = new HTMLScriptElement(); a.src = ${JSON.stringify(url)};
      const b = new HTMLScriptElement(); b.setAttribute("src", ${JSON.stringify(url)});
      const c = new HTMLScriptElement(); c.src = { toString: () => ${JSON.stringify(url)} }; // a TrustedScriptURL
      return [a.src, b.attrs.src ?? null, c.src];
    })()`));
    assert.deepEqual(r, ["", null, ""], url);
  }
  for (const url of ALLOWED) {
    const r = plain(h.run(`(() => {
      const a = new HTMLScriptElement(); a.src = ${JSON.stringify(url)};
      const b = new HTMLScriptElement(); b.setAttribute("src", ${JSON.stringify(url)});
      const c = new HTMLScriptElement(); c.src = { toString: () => ${JSON.stringify(url)} };
      return [a.src, b.attrs.src ?? null, c.src];
    })()`));
    assert.deepEqual(r, [url, url, url], url);
  }
  const other = plain(h.run(`(() => { const e = new Element(); e.setAttribute("src", ${JSON.stringify(BLOCKED[0])}); e.setAttribute("id", "x"); return e.attrs; })()`));
  assert.deepEqual(other, { src: BLOCKED[0], id: "x" }, "only script elements are filtered");
});

test("a callback assigned while the document is loading is called once, after DOMContentLoaded", async () => {
  const h = createHarness({ before: DOM });
  h.run(`window.__onGCastApiAvailable = (ok) => __calls.push(["page", ok]);`);
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), [], "not while loading");
  h.run(`__fireDCL();`);
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), [["page", true]]);
});

test("a callback defined before install while loading also waits for DOMContentLoaded", async () => {
  const h = createHarness({ before: DOM + `window.__onGCastApiAvailable = (ok) => __calls.push(["early", ok]);` });
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), []);
  h.run(`__fireDCL();`);
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), [["early", true]]);
});

test("with Google's loader the page's callback fires exactly once, after the framework loaded", async () => {
  const h = createHarness({ before: DOM });
  // The page's own callback, then what cast_sender.js does when asked to load the framework.
  h.run(`
    window.__onGCastApiAvailable = (ok) => __calls.push(["page", ok, !!window.__frameworkLoaded]);
    (() => {
      let pending = 2;
      const pageCallback = window.__onGCastApiAvailable;
      window.__onGCastApiAvailable = () => { pending--; if (pending === 0) pageCallback(true); };
      window.__frameworkOnload = () => { window.__frameworkLoaded = true; window.__onGCastApiAvailable(); };
      const s = new HTMLScriptElement(); s.src = "//www.gstatic.com/eureka/clank/156/cast_sender.js"; // blocked: never runs
    })();`);
  await tick(10);
  h.run(`__fireDCL();`);
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), [], "the polyfill reported in, the framework has not");
  h.run(`__frameworkOnload();`);
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), [["page", true, true]]);
  assert.equal(h.run(`!!chrome.cast.initialize`), true, "chrome.cast is still ours");
});

test("after the document has loaded, an assigned callback is called asynchronously, once per function", async () => {
  const h = createHarness({ before: DOM });
  h.run(`__fireDCL();`);
  h.run(`window.__f = (ok) => __calls.push(["f", ok]); window.__onGCastApiAvailable = __f;`);
  assert.deepEqual(plain(h.win.__calls), [], "never synchronously");
  await tick(10);
  h.run(`window.__onGCastApiAvailable = __f;`);
  await tick(10);
  h.run(`window.__onGCastApiAvailable = (ok) => __calls.push(["g", ok]);`);
  await tick(10);
  assert.deepEqual(plain(h.win.__calls), [["f", true], ["g", true]]);
});
