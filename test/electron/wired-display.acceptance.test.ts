// Acceptance tests for wired display presentations: the provider, the local presentation manager and the controller
// connections, with a fake screen and fake receiver windows. Each case names the Chromium code it follows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { WiredDisplayProvider } from "../../src/electron/wired-display/provider.ts";
import { WiredDisplayControllers } from "../../src/electron/wired-display/controller.ts";
import type { WiredDisplaySink } from "../../src/electron/wired-display/displays.ts";
import { FakeScreen, disp, windowFactory } from "./wired-fakes.ts";

const URL1 = "https://example.com/receiver.html";
const ORIGIN = "https://controller.test";
const SINK2 = "wired_display_2";

function setup(screen = new FakeScreen()) {
  const f = windowFactory();
  const provider = new WiredDisplayProvider({ screen, createReceiverWindow: f.create });
  const controllers = new WiredDisplayControllers(provider);
  return { screen, f, provider, controllers };
}

/** A controller connection's events, recorded. */
function watch(conn: ReturnType<WiredDisplayControllers["start"]>) {
  const log: string[] = [];
  const got: string[] = [];
  conn.onconnect = () => log.push("connect");
  conn.onclose = (r) => log.push(r);
  conn.onmessage = (m) => got.push(m);
  return { log, got };
}

test("sinks follow the screen: added, removed and moved displays are reported (OnDisplayAdded / OnDisplaysRemoved / OnDisplayMetricsChanged)", () => {
  const s = setup(new FakeScreen([disp(1, 0, 0)]));
  const seen: string[][] = [];
  const stop = s.provider.observeSinks((sinks: WiredDisplaySink[]) => seen.push(sinks.map((x) => x.name)));
  assert.deepEqual(seen, [[]], "one display: no sinks");
  s.screen.add(disp(2, 1920, 0));
  s.screen.move(2, 1920, 100);
  s.screen.remove(2);
  assert.deepEqual(seen, [[], ["Display 1", "Display 2"], ["Display 1", "Display 2"], []]);
  stop();
  s.screen.add(disp(3, 0, 1080));
  assert.equal(seen.length, 4, "nothing after the observer is removed");
  assert.equal(s.screen.listenerCount("display-added"), 0, "the screen is no longer watched");
});

test("start: a window opens on the display, the connection is connecting until the receiver page registers (CreateRoute, RegisterLocalPresentationController)", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { log } = watch(conn);
  const w = s.f.windows[0]!;
  assert.deepEqual(w.request.bounds, { x: 1920, y: 0, width: 1920, height: 1080 });
  assert.equal(w.started?.url, URL1);
  assert.match(conn.id, /^mr_[0-9a-f-]{36}$/);
  assert.equal(conn.url, URL1);
  assert.equal(conn.connecting, true);
  const [route] = s.provider.routes();
  assert.deepEqual([route!.id, route!.sinkId, route!.description, route!.isLocalPresentation], [conn.id, SINK2, "Presenting (example.com)", true]);
  w.register();
  assert.equal(conn.connecting, false);
  assert.deepEqual(log, ["connect"]);
  assert.equal(w.ends.length, 1);
  assert.equal(w.ends[0]!.id, conn.id);
  assert.equal(w.ends[0]!.url, URL1);
});

test("start on an unknown display fails with the provider's SINK_NOT_FOUND message", () => {
  const s = setup();
  assert.throws(() => s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, "wired_display_99"), /Display not found/);
  assert.equal(s.f.windows.length, 0);
});

test("messages go both ways in process, in order, and only once connected", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { got } = watch(conn);
  conn.send("too early");
  const w = s.f.windows[0]!;
  w.register();
  const end = w.ends[0]!;
  const rx: string[] = [];
  end.onmessage = (m) => rx.push(m);
  conn.send("a");
  conn.send("b");
  end.send("x");
  end.send("y");
  assert.deepEqual(rx, ["a", "b"]);
  assert.deepEqual(got, ["x", "y"]);
});

test("a controller that registers after the receiver page is delivered at once (reconnect from another page)", () => {
  const s = setup();
  const first = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const w = s.f.windows[0]!;
  w.register();
  const again = s.controllers.reconnect({ urls: [URL1], senderId: 2 }, first.id);
  const l2 = watch(again);
  assert.equal(again.connecting, false, "the receiver was ready");
  assert.equal(w.ends.length, 2, "the receiver's connectionList gets a second connection");
  w.ends[1]!.send("hello");
  assert.deepEqual(l2.got, ["hello"]);
  assert.equal(again.id, first.id);
});

test("reconnect: another URL, or an id that is not local, is NotFound (ReconnectPresentation / JoinRoute)", () => {
  const s = setup();
  const first = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  s.f.windows[0]!.register();
  assert.throws(() => s.controllers.reconnect({ urls: ["https://example.com/other"], senderId: 2 }, first.id), { name: "NotFoundError" });
  assert.throws(() => s.controllers.reconnect({ urls: [URL1], senderId: 2 }, "mr_nope"), { name: "NotFoundError" });
});

test("controller close(): the receiver's connection closes, the presentation and its window stay (CloseConnection)", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { log } = watch(conn);
  const w = s.f.windows[0]!;
  w.register();
  const closed: string[] = [];
  w.ends[0]!.onclose = () => closed.push("closed");
  conn.close();
  assert.deepEqual(closed, ["closed"]);
  assert.deepEqual(log, ["connect", "closed"]);
  assert.equal(w.closed, false);
  assert.equal(s.provider.routes().length, 1);
  const again = s.controllers.reconnect({ urls: [URL1], senderId: 1 }, conn.id);
  assert.equal(again.connecting, false, "the presentation can be joined again");
});

test("receiver close(): the controller's connection closes; the presentation stays", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { log } = watch(conn);
  const w = s.f.windows[0]!;
  w.register();
  w.ends[0]!.close();
  assert.deepEqual(log, ["connect", "closed"]);
  assert.equal(s.provider.routes().length, 1);
  conn.send("ignored after close");
});

test("receiver terminate(): the window closes and every controller sees terminated (TerminateInternal, RemovePresentationById)", () => {
  const s = setup();
  const a = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const la = watch(a);
  const w = s.f.windows[0]!;
  w.register();
  const b = s.controllers.reconnect({ urls: [URL1], senderId: 2 }, a.id);
  const lb = watch(b);
  w.ends[0]!.terminate();
  assert.equal(w.closed, true);
  assert.deepEqual(la.log, ["connect", "terminated"]);
  assert.deepEqual(lb.log, ["terminated"]);
  assert.deepEqual(s.provider.routes(), []);
  assert.throws(() => s.controllers.reconnect({ urls: [URL1], senderId: 3 }, a.id), { name: "NotFoundError" });
});

test("controller terminate(): only when connected, and the route ends through the provider", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { log } = watch(conn);
  conn.terminate();
  assert.equal(s.f.windows[0]!.closed, false, "terminate() on a connecting connection does nothing (Blink needs CONNECTED)");
  s.f.windows[0]!.register();
  conn.terminate();
  assert.equal(s.f.windows[0]!.closed, true);
  assert.deepEqual(log, ["connect", "terminated"]);
});

test("the receiver window closing (the user, or its page) terminates the presentation for its controllers", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { log } = watch(conn);
  s.f.windows[0]!.register();
  const routeUpdates: number[] = [];
  s.provider.on("routes", (r) => routeUpdates.push(r.length));
  s.f.windows[0]!.close();
  assert.deepEqual(log, ["connect", "terminated"]);
  assert.deepEqual(routeUpdates, [0]);
});

test("a window closed before the receiver page registered ends a connecting connection as terminated", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { log } = watch(conn);
  s.f.windows[0]!.close();
  assert.deepEqual(log, ["terminated"]);
});

test("display removal leaves fullscreen on the receiver window and does not terminate (OnDisplaysRemoved)", () => {
  const s = setup(new FakeScreen([disp(1, 0, 0), disp(2, 1920, 0), disp(3, 3840, 0)]));
  const stop = s.provider.observeSinks(() => {});
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { log } = watch(conn);
  s.screen.remove(3);
  assert.equal(s.f.windows[0]!.fullscreen, true, "another display going away changes nothing");
  s.screen.remove(2);
  assert.equal(s.f.windows[0]!.fullscreen, false);
  assert.equal(s.f.windows[0]!.closed, false);
  assert.deepEqual(log, []);
  stop();
});

test("a second presentation on one display terminates the first (TerminatePresentationsOnDisplay)", () => {
  const s = setup();
  const first = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const l1 = watch(first);
  s.f.windows[0]!.register();
  const second = s.controllers.start({ urls: ["https://example.com/two"], origin: ORIGIN, senderId: 1 }, SINK2);
  assert.equal(s.f.windows[0]!.closed, true);
  assert.deepEqual(l1.log, ["connect", "terminated"]);
  assert.equal(s.provider.routes().length, 1);
  assert.equal(s.provider.routes()[0]!.id, second.id);
});

test("terminateRoute: a known route closes its window, an unknown one is ROUTE_NOT_FOUND (TerminateRoute)", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  assert.throws(() => s.provider.terminateRoute("mr_x"), { code: "ROUTE_NOT_FOUND" });
  s.provider.terminateRoute(conn.id);
  assert.equal(s.f.windows[0]!.closed, true);
  assert.deepEqual(s.provider.routes(), []);
});

test("the controller page going away only unregisters it: the window, route and receiver connection stay (PresentationFrame::Reset)", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { log } = watch(conn);
  const w = s.f.windows[0]!;
  w.register();
  s.controllers.senderGone(1);
  assert.equal(w.closed, false);
  assert.equal(s.provider.routes().length, 1);
  assert.deepEqual(log, ["connect"], "no close or terminate is delivered to a page that is gone");
  const again = s.controllers.reconnect({ urls: [URL1], senderId: 5 }, conn.id);
  assert.equal(again.connecting, false, "a new page can still join it");
});

test("a controller that was waiting when its page went away is dropped; a receiver that registers later gets none", () => {
  const s = setup();
  s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  s.controllers.senderGone(1);
  s.f.windows[0]!.register();
  assert.equal(s.f.windows[0]!.ends.length, 0);
});

test("a receiver that registers with a URL of another origin gets no connection (OnLocalPresentationReceiverCreated origin check)", () => {
  const s = setup();
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  s.f.windows[0]!.register("https://elsewhere.example/page");
  assert.equal(s.f.windows[0]!.ends.length, 0);
  assert.equal(conn.connecting, true);
});

test("route observers hear of routes starting, changing title and ending", () => {
  const s = setup();
  const seen: string[] = [];
  s.provider.on("routes", (r) => seen.push(r.map((x) => `${x.id.slice(0, 3)}:${x.title}`).join(",")));
  s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  s.f.windows[0]!.request.onTitle("Slides");
  s.f.windows[0]!.close();
  assert.deepEqual(seen, ["mr_:", "mr_:Slides", ""]);
});

test("dispose terminates every presentation and stops watching the screen", () => {
  const s = setup();
  s.provider.observeSinks(() => {});
  const conn = s.controllers.start({ urls: [URL1], origin: ORIGIN, senderId: 1 }, SINK2);
  const { log } = watch(conn);
  s.provider.dispose();
  assert.equal(s.f.windows[0]!.closed, true);
  assert.deepEqual(log, ["terminated"]);
  assert.equal(s.screen.listenerCount("display-removed"), 0);
});
