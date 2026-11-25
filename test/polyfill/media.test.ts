// Additional chrome.cast.media tests for behaviour the acceptance suite does not cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, tick, plain, snapshot, type Harness } from "./harness.ts";

const MEDIA = "urn:x-cast:com.google.cast.media";

async function withSession(h: Harness) {
  h.handlers.initialize = () => ({ ok: true, value: { available: true, sessions: [] } });
  h.run(`
    const c = chrome.cast;
    const cfg = new c.ApiConfig(new c.SessionRequest("CC1AD845"), () => {}, () => {});
    c.initialize(cfg, () => {}, () => {});
  `);
  await tick(5);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot({ appId: "CC1AD845", displayName: "Default Media Receiver" }) });
  h.run(`chrome.cast.requestSession((s) => { window.__s = s; }, () => {});`);
  await tick(5);
  assert.ok(h.win.__s, "session established");
}

/** Media-namespace messages the page sent, parsed. */
function mediaSent(h: Harness): any[] {
  return h.calls
    .filter((c) => c.method === "sendMessage" && c.params.namespace === MEDIA)
    .map((c) => JSON.parse(c.params.message));
}
function lastSent(h: Harness, type: string): any {
  const m = mediaSent(h).filter((x) => x.type === type).at(-1);
  assert.ok(m, `a ${type} message was sent`);
  return m;
}
function receive(h: Harness, msg: object, sessionId = "session-1") {
  h.emit({ type: "message", sessionId, namespace: MEDIA, message: JSON.stringify(msg) });
}
const entry = (over: object = {}) => ({
  mediaSessionId: 7, playbackRate: 1, playerState: "PLAYING", currentTime: 0, supportedMediaCommands: 15,
  volume: { level: 1, muted: false }, ...over,
});

/** Load one media item and answer it; leaves it on window.__media. */
async function loaded(h: Harness, status: object = entry()) {
  h.run(`
    const mi = new chrome.cast.media.MediaInfo("https://x.test/a.mp3", "audio/mpeg");
    __s.loadMedia(new chrome.cast.media.LoadRequest(mi), (m) => { window.__media = m; }, (e) => { window.__lerr = e.code; });`);
  await tick(5);
  receive(h, { type: "MEDIA_STATUS", requestId: lastSent(h, "LOAD").requestId, status: [status] });
  await tick(5);
  assert.ok(h.win.__media, "loadMedia succeeded");
}

test("LOAD_CANCELLED fails the pending load with cancel", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__e = null;
    __s.loadMedia(new chrome.cast.media.LoadRequest(new chrome.cast.media.MediaInfo("u", "video/mp4")),
      () => { __e = "ok"; }, (e) => { __e = [e.code, e.description]; });`);
  await tick(5);
  const load = lastSent(h, "LOAD");
  receive(h, { type: "LOAD_CANCELLED", requestId: load.requestId });
  await tick(5);
  assert.deepEqual(plain(h.win.__e), ["cancel", null]);
});

test("INVALID_PLAYER_STATE fails with session_error and the reply's reason as description", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h);
  h.run(`window.__e = null; __media.play(null, () => { __e = "ok"; }, (e) => { __e = [e.code, e.description]; });`);
  await tick(5);
  const play = lastSent(h, "PLAY");
  receive(h, { type: "INVALID_PLAYER_STATE", requestId: play.requestId, reason: "player is idle" });
  await tick(5);
  assert.deepEqual(plain(h.win.__e), ["session_error", "player is idle"]);
});

test("an empty status array kills every Media of the session", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h);
  h.run(`window.__ml = []; __s.addMediaListener((m) => __ml.push(m.mediaSessionId));`);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ mediaSessionId: 9, playerState: "PAUSED" })] });
  await tick(5);
  assert.equal(h.run(`__s.media.length`), 2);
  assert.deepEqual(plain(h.win.__ml), [9], "the second media was announced");
  h.run(`window.__u = []; __s.media.forEach((m) => m.addUpdateListener((alive) => __u.push([m.mediaSessionId, alive])));`);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [] });
  await tick(5);
  assert.deepEqual(plain(h.win.__u).sort(), [[7, false], [9, false]]);
  assert.equal(h.run(`__s.media.length`), 0);
});

test("queue insert, update, remove and reorder send their documented payloads", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h, entry({ items: [{ itemId: 1 }, { itemId: 2 }, { itemId: 3 }], currentItemId: 1 }));
  const cases: [string, string, object][] = [
    [`(() => { const r = new chrome.cast.media.QueueInsertItemsRequest([new chrome.cast.media.QueueItem(new chrome.cast.media.MediaInfo("n", "audio/mpeg"))]); r.insertBefore = 2; __media.queueInsertItems(r, ok, err); })()`, "QUEUE_INSERT",
      { items: [{ media: { contentId: "n", streamType: "BUFFERED", contentType: "audio/mpeg" }, autoplay: true, startTime: 0, preloadTime: 0 }], insertBefore: 2 }],
    [`(() => { const r = new chrome.cast.media.QueueUpdateItemsRequest([{ itemId: 2, media: { contentId: "u2", streamType: "BUFFERED", contentType: "audio/mpeg" } }]); __media.queueUpdateItems(r, ok, err); })()`, "QUEUE_UPDATE",
      { items: [{ itemId: 2, media: { contentId: "u2", streamType: "BUFFERED", contentType: "audio/mpeg" } }] }],
    [`(() => { const r = new chrome.cast.media.QueueRemoveItemsRequest([1, 3]); __media.queueRemoveItems(r, ok, err); })()`, "QUEUE_REMOVE",
      { itemIds: [1, 3] }],
    [`(() => { const r = new chrome.cast.media.QueueReorderItemsRequest([2, 3]); r.insertBefore = 1; __media.queueReorderItems(r, ok, err); })()`, "QUEUE_REORDER",
      { itemIds: [2, 3], insertBefore: 1 }],
  ];
  for (const [code, type, extra] of cases) {
    h.run(`var ok = () => {}; var err = (e) => { window.__qe = e.code; }; ${code};`);
    await tick(5);
    const msg = lastSent(h, type);
    assert.deepEqual({ ...msg, requestId: undefined }, { type, requestId: undefined, mediaSessionId: 7, ...extra }, code);
  }
  assert.equal(h.win.__qe, undefined);
});

test("getEstimatedTime is capped at media.duration while playing", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h, entry({
    playerState: "PLAYING", currentTime: 99, playbackRate: 100,
    media: { contentId: "x", streamType: "BUFFERED", contentType: "video/mp4", duration: 100 },
  }));
  await tick(60);
  const t = h.run(`__media.getEstimatedTime()`);
  assert.equal(t, 100, `estimated time is capped at the duration (got ${t})`);
});

test("a timeout value of 0 disables the timeout", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h);
  h.run(`chrome.cast.media.timeout.play = 0;
    __media.play(null, () => { window.__p = "ok"; }, (e) => { window.__p = e.code; });`);
  await tick(200);
  assert.equal(h.win.__p, undefined, "no timeout fired");
  receive(h, { type: "MEDIA_STATUS", requestId: lastSent(h, "PLAY").requestId, status: [entry()] });
  await tick(5);
  assert.equal(h.win.__p, "ok");
});

test("Session.stop() kills the session's media and fails its pending requests", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h);
  h.run(`window.__u = []; __media.addUpdateListener((alive) => __u.push(alive));
    __media.pause(null, () => { window.__p = "ok"; }, (e) => { window.__p = e.code; });`);
  await tick(5);
  h.run(`__s.stop(() => {}, () => {});`);
  await tick(5);
  assert.deepEqual(plain(h.win.__u), [false]);
  assert.equal(h.win.__p, "session_error");
  assert.equal(h.run(`__s.media.length`), 0);
  assert.equal(h.run(`__s.status`), "stopped");
});

test("null stripping recurses into nested objects and arrays", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`
    const mi = new chrome.cast.media.MediaInfo("u", "video/mp4");
    mi.customData = { list: [{ a: 1, b: null }, null, { c: [null, 2, { d: undefined }] }], flag: false, zero: 0 };
    const req = new chrome.cast.media.LoadRequest(mi);
    req.customData = { outer: [null, { inner: { x: null, y: 3 } }] };
    __s.loadMedia(req, () => {}, () => {});`);
  await tick(5);
  const load = lastSent(h, "LOAD");
  assert.deepEqual(load.customData, { outer: [{ inner: { y: 3 } }] });
  assert.deepEqual(load.media.customData, { list: [{ a: 1 }, { c: [2, {}] }], flag: false, zero: 0 });
});

test("page listeners on the media namespace still receive the raw messages", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h);
  h.run(`window.__raw = []; __s.addMessageListener("${MEDIA}", (ns, m) => __raw.push(m));`);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ currentTime: 11 })] });
  await tick(5);
  assert.equal(h.win.__raw.length, 1);
  assert.equal(typeof h.win.__raw[0], "string");
  assert.equal(h.run(`__media.currentTime`), 11);
});

test("a LOAD waits through interim LOADING statuses and settles once with the final state", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__r = []; window.__ml = [];
    __s.addMediaListener((m) => __ml.push(m.mediaSessionId));
    const mi = new chrome.cast.media.MediaInfo("https://x.test/a.m3u8", "application/x-mpegurl");
    __s.loadMedia(new chrome.cast.media.LoadRequest(mi), (m) => __r.push(["ok", m.playerState]), (e) => __r.push(["err", e.code]));`);
  await tick(5);
  const load = lastSent(h, "LOAD");
  receive(h, { type: "MEDIA_STATUS", requestId: load.requestId, status: [entry({ mediaSessionId: 42, playerState: "IDLE", extendedStatus: { playerState: "LOADING", mediaSessionId: 42 } })] });
  await tick(5);
  assert.deepEqual(plain(h.win.__r), [], "the interim LOADING status does not settle the LOAD");
  assert.equal(h.run(`__s.media.length`), 1, "the interim status still created the Media");
  receive(h, { type: "MEDIA_STATUS", requestId: load.requestId, status: [entry({ mediaSessionId: 42, playerState: "BUFFERING" })] });
  await tick(5);
  assert.deepEqual(plain(h.win.__r), [["ok", "BUFFERING"]], "the final status settles the LOAD once");
  assert.equal(h.run(`__s.media.length`), 1);
  assert.deepEqual(plain(h.win.__ml), [], "the media created by the LOAD's statuses is not announced to media listeners");
});
