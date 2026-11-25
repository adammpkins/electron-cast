// Which displays are sinks, and which URLs they serve. Each rule is Chromium's (see src/electron/wired-display/displays.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  availableDisplays, isWiredDisplaySource, routeDescription, sinkIdForDisplay, wiredDisplaySinks, type DisplayLike,
} from "../../src/electron/wired-display/displays.ts";

const d = (id: number, x: number, y: number, w = 1920, h = 1080): DisplayLike => ({ id, bounds: { x, y, width: w, height: h } });

test("one display, or none, gives no sinks (GetAvailableDisplays)", () => {
  assert.deepEqual(availableDisplays([], d(1, 0, 0)), []);
  assert.deepEqual(availableDisplays([d(1, 0, 0)], d(1, 0, 0)), []);
});

test("two displays are two sinks, the primary first, named Display 1, Display 2 (CreateSinkForDisplay)", () => {
  const primary = d(7, 0, 0);
  const sinks = wiredDisplaySinks([d(9, 1920, 0), primary], primary);
  assert.deepEqual(sinks.map((s) => [s.id, s.name, s.iconType, s.providerId]), [
    ["wired_display_7", "Display 1", "wired_display", "wired_display"],
    ["wired_display_9", "Display 2", "wired_display", "wired_display"],
  ]);
  assert.equal(sinkIdForDisplay(primary), "wired_display_7");
});

test("the others sort top to bottom, then left to right (CompareDisplays)", () => {
  const primary = d(1, 100, 100);
  const order = availableDisplays([d(2, 2000, 0), d(3, 0, 0), d(4, 0, 2000), primary, d(5, 1000, 0)], primary).map((x) => x.id);
  assert.deepEqual(order, [1, 3, 5, 2, 4]);
});

test("a display that mirrors the primary (same bounds) is not a sink, and all-mirrored gives none", () => {
  const primary = d(1, 0, 0);
  assert.deepEqual(availableDisplays([primary, d(2, 0, 0), d(3, 1920, 0)], primary).map((x) => x.id), [1, 3]);
  assert.deepEqual(availableDisplays([primary, d(2, 0, 0)], primary), []);
  // same position but another size is not a mirror
  assert.deepEqual(availableDisplays([primary, d(2, 0, 0, 1280, 720)], primary).map((x) => x.id), [1, 2]);
});

test("only standard presentation sources are served (IsValidStandardPresentationSource)", () => {
  assert.equal(isWiredDisplaySource("https://example.com/receiver.html"), true);
  assert.equal(isWiredDisplaySource("http://localhost:8080/r"), true);
  assert.equal(isWiredDisplaySource("http://127.0.0.1/r"), true);
  assert.equal(isWiredDisplaySource("http://[::1]:3000/r"), true);
  assert.equal(isWiredDisplaySource("http://app.localhost/r"), true);
  assert.equal(isWiredDisplaySource("http://localhost./r"), true);
  assert.equal(isWiredDisplaySource("http://example.com/r"), false, "plain http is not served");
  assert.equal(isWiredDisplaySource("file:///tmp/r.html"), false);
  assert.equal(isWiredDisplaySource("cast:233637DE"), false);
  assert.equal(isWiredDisplaySource("https://google.com/cast#__castAppId__=233637DE"), false, "a legacy Cast URL is not a web page");
  assert.equal(isWiredDisplaySource("HTTPS://GOOGLE.COM/cast#__castAppId__=233637DE"), false);
  assert.equal(isWiredDisplaySource("https://google.com/cast"), true, "only the full legacy prefix is excluded");
  assert.equal(isWiredDisplaySource("not a url"), false);
});

test("the route description is Presenting (host)", () => {
  assert.equal(routeDescription("https://example.com:8443/a?b#c"), "Presenting (example.com)");
});
