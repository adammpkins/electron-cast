// Acceptance tests for the CAF compatibility fixes (written before the implementation; do not edit to make them pass).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, tick, plain, snapshot, type Harness } from "./harness.ts";

const MEDIA = "urn:x-cast:com.google.cast.media";

async function init(h: Harness, listener = "__sl") {
  h.handlers.initialize = () => ({ ok: true, value: { available: true, sessions: [snapshot()] } });
  h.run(`
    window.__ann = window.__ann || [];
    window.${listener} = window.${listener} || ((s) => __ann.push(["${listener}", s.sessionId]));
    { const c = chrome.cast;
      c.initialize(new c.ApiConfig(new c.SessionRequest("CC1AD845"), ${listener}, () => {}), () => {}, () => {}); }`);
  await tick(5);
}
function receive(h: Harness, msg: object) {
  h.emit({ type: "message", sessionId: "session-1", namespace: MEDIA, message: JSON.stringify(msg) });
}
const entry = (over: object = {}) => ({ mediaSessionId: 7, playbackRate: 1, playerState: "PLAYING", currentTime: 0, supportedMediaCommands: 15, volume: { level: 1, muted: false }, ...over });

async function withMedia(h: Harness, status: object) {
  await init(h);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot() });
  h.run(`chrome.cast.requestSession((s) => { window.__s = s; }, () => {});`);
  await tick(5);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry(status)] });
  await tick(5);
  h.run(`window.__m = __s.media[0];`);
  assert.ok(h.win.__m, "media present");
}

test("break and live-range estimates advance while playing and freeze otherwise", async () => {
  const h = createHarness();
  await withMedia(h, { breakStatus: { currentBreakTime: 4, currentBreakClipTime: 2 }, liveSeekableRange: { start: 10, end: 100, isMovingWindow: true, isLiveDone: false } });
  await tick(60);
  const bt = h.run(`__m.getEstimatedBreakTime()`), ct = h.run(`__m.getEstimatedBreakClipTime()`);
  const r = plain(h.run(`__m.getEstimatedLiveSeekableRange()`));
  assert.ok(bt > 4.03 && bt < 4.6, `break time ${bt}`);
  assert.ok(ct > 2.03 && ct < 2.6, `break clip time ${ct}`);
  assert.ok(r.start > 10.03 && r.start < 10.6 && r.end > 100.03 && r.end < 100.6, JSON.stringify(r));
  assert.equal(h.run(`__m.liveSeekableRange.end`), 100, "the stored range is not mutated");
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ playerState: "PAUSED", liveSeekableRange: { start: 10, end: 100, isMovingWindow: false, isLiveDone: false } })] });
  await tick(30);
  assert.equal(h.run(`__m.getEstimatedBreakTime()`), undefined, "breakStatus cleared when the status drops it");
  assert.deepEqual(plain(h.run(`__m.getEstimatedLiveSeekableRange()`)), { start: 10, end: 100, isMovingWindow: false, isLiveDone: false });
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ playerState: "PLAYING", liveSeekableRange: { start: 10, end: 100, isMovingWindow: false, isLiveDone: false } })] });
  await tick(60);
  const r2 = plain(h.run(`__m.getEstimatedLiveSeekableRange()`));
  assert.equal(r2.start, 10, "start stays put without a moving window");
  assert.ok(r2.end > 100.03, "end advances");
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ playerState: "PLAYING" })] });
  await tick(5);
  assert.equal(h.run(`__m.getEstimatedLiveSeekableRange()`), undefined, "range cleared when the status drops it");
  assert.equal(h.run(`__m.volume.level`), 1);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [{ mediaSessionId: 7, playbackRate: 1, playerState: "PLAYING", currentTime: 3 }] });
  await tick(5);
  assert.equal(h.run(`__m.volume.level`), 1, "a status without volume keeps the volume");
});

test("a receiverAction event reaches receiver action listeners before the session ends", async () => {
  const h = createHarness();
  await init(h);
  h.handlers.joinSession = (p) => ({ ok: true, value: snapshot({ sessionId: p.sessionId }) });
  h.run(`window.__ra = [];
    chrome.cast.addReceiverActionListener((r, a) => __ra.push([r.friendlyName, a]));`);
  h.handlers.requestSession = () => {
    h.emit({ type: "receiverAction", sessionId: "session-1", action: "stop" } as any);
    h.emit({ type: "sessionEnded", sessionId: "session-1", status: "stopped" });
    return { ok: false, code: "cancel" };
  };
  h.run(`chrome.cast.requestSession(() => __ra.push("ok"), (e) => __ra.push(["err", e.code]));`);
  await tick(5);
  assert.deepEqual(plain(h.win.__ra), [["Lounge Cast TV", "stop"], ["err", "cancel"]]);
  h.run(`window.__ra = [];`);
  h.emit({ type: "receiverAction", sessionId: "unknown", action: "stop" } as any);
  h.emit({ type: "receiverAction", sessionId: "session-1", action: "stop" } as any);
  await tick(5);
  assert.deepEqual(plain(h.win.__ra), [], "unknown and ended sessions are ignored");
});

test("a LOAD stays pending through interim LOADING statuses", async () => {
  const h = createHarness();
  await init(h);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot() });
  h.run(`window.__r = [];
    chrome.cast.requestSession((s) => { window.__s = s; }, () => {});`);
  await tick(5);
  h.run(`const mi = new chrome.cast.media.MediaInfo("https://x.test/a.m3u8", "application/x-mpegurl");
    __s.loadMedia(new chrome.cast.media.LoadRequest(mi), (m) => __r.push(["ok", m.playerState]), (e) => __r.push(["err", e.code]));`);
  await tick(5);
  const load = h.calls.filter((c) => c.method === "sendMessage" && c.params.namespace === MEDIA)
    .map((c) => JSON.parse(c.params.message)).filter((m) => m.type === "LOAD").at(-1);
  assert.ok(load, "LOAD sent");
  receive(h, { type: "MEDIA_STATUS", requestId: load.requestId, status: [entry({ mediaSessionId: 1, playerState: "IDLE", extendedStatus: { playerState: "LOADING", mediaSessionId: 1 } })] });
  await tick(5);
  assert.deepEqual(plain(h.win.__r), [], "interim status does not settle the LOAD");
  receive(h, { type: "LOAD_FAILED", requestId: load.requestId });
  await tick(5);
  assert.deepEqual(plain(h.win.__r), [["err", "load_media_failed"]]);
  h.run(`__s.loadMedia(new chrome.cast.media.LoadRequest(mi), (m) => __r.push(["ok", m.playerState]), (e) => __r.push(["err", e.code]));`);
  await tick(5);
  const load2 = h.calls.filter((c) => c.method === "sendMessage" && c.params.namespace === MEDIA)
    .map((c) => JSON.parse(c.params.message)).filter((m) => m.type === "LOAD").at(-1);
  receive(h, { type: "MEDIA_STATUS", requestId: load2.requestId, status: [entry({ mediaSessionId: 2, playerState: "IDLE", extendedStatus: { playerState: "LOADING", mediaSessionId: 2 } })] });
  receive(h, { type: "MEDIA_STATUS", requestId: load2.requestId, status: [entry({ mediaSessionId: 2, playerState: "BUFFERING" })] });
  await tick(5);
  assert.deepEqual(plain(h.win.__r), [["err", "load_media_failed"], ["ok", "BUFFERING"]]);
});

test("a session is announced to a sessionListener function only once", async () => {
  const h = createHarness();
  await init(h);
  await init(h);
  assert.deepEqual(plain(h.win.__ann), [["__sl", "session-1"]]);
  h.handlers.joinSession = (p) => ({ ok: true, value: snapshot({ sessionId: p.sessionId }) });
  h.run(`chrome.cast.requestSessionById("session-1");`);
  await tick(5);
  assert.deepEqual(plain(h.win.__ann), [["__sl", "session-1"]]);
  await init(h, "__sl2");
  assert.deepEqual(plain(h.win.__ann), [["__sl", "session-1"], ["__sl2", "session-1"]]);
});

test("an ended session ignores later messages", async () => {
  const h = createHarness();
  await init(h);
  h.run(`window.__got = [];`);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot() });
  h.run(`chrome.cast.requestSession((s) => { window.__s = s; s.addMessageListener("urn:x-cast:x", (ns, m) => __got.push(m)); }, () => {});`);
  await tick(5);
  h.emit({ type: "sessionEnded", sessionId: "session-1", status: "stopped" });
  await tick(5);
  h.emit({ type: "message", sessionId: "session-1", namespace: "urn:x-cast:x", message: "late" });
  await tick(5);
  assert.deepEqual(plain(h.win.__got), []);
});
