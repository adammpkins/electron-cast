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

const entry = (over: object = {}) => ({
  mediaSessionId: 7, playbackRate: 1, playerState: "PLAYING", currentTime: 0, supportedMediaCommands: 15,
  volume: { level: 1, muted: false }, ...over,
});

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

test("the break and live-range estimates advance while playing and freeze otherwise", async () => {
  const h = createHarness();
  await withMedia(h, {
    breakStatus: { currentBreakTime: 4, currentBreakClipTime: 2 },
    liveSeekableRange: { start: 10, end: 100, isMovingWindow: true, isLiveDone: false },
  });
  await tick(60);
  const bt = h.run(`__m.getEstimatedBreakTime()`);
  const ct = h.run(`__m.getEstimatedBreakClipTime()`);
  const r = plain(h.run(`__m.getEstimatedLiveSeekableRange()`));
  assert.ok(bt > 4.03 && bt < 4.6, `break time ${bt}`);
  assert.ok(ct > 2.03 && ct < 2.6, `break clip time ${ct}`);
  assert.ok(r.start > 10.03 && r.start < 10.6 && r.end > 100.03 && r.end < 100.6, JSON.stringify(r));
  assert.equal(h.run(`__m.liveSeekableRange.end`), 100, "the stored range is not mutated");
  assert.equal(h.run(`__m.liveSeekableRange.start`), 10);

  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ playerState: "PAUSED" })] });
  await tick(30);
  assert.equal(h.run(`__m.getEstimatedBreakTime()`), undefined, "breakStatus cleared when the status drops it");
  assert.equal(h.run(`__m.getEstimatedBreakClipTime()`), undefined);
  assert.equal(h.run(`__m.getEstimatedLiveSeekableRange()`), undefined, "range cleared when the status drops it");

  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({
    playerState: "PAUSED",
    breakStatus: { currentBreakTime: 4, currentBreakClipTime: 2 },
    liveSeekableRange: { start: 10, end: 100, isMovingWindow: true, isLiveDone: false },
  })] });
  await tick(30);
  assert.equal(h.run(`__m.getEstimatedBreakTime()`), 4, "frozen while paused");
  assert.equal(h.run(`__m.getEstimatedBreakClipTime()`), 2);
  assert.deepEqual(plain(h.run(`__m.getEstimatedLiveSeekableRange()`)), { start: 10, end: 100, isMovingWindow: true, isLiveDone: false });
});

test("isLiveDone freezes the range and a non-moving window keeps start", async () => {
  const h = createHarness();
  await withMedia(h, { liveSeekableRange: { start: 10, end: 100, isMovingWindow: true, isLiveDone: true } });
  await tick(60);
  assert.deepEqual(plain(h.run(`__m.getEstimatedLiveSeekableRange()`)), { start: 10, end: 100, isMovingWindow: true, isLiveDone: true });

  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ liveSeekableRange: { start: 10, end: 100, isMovingWindow: false, isLiveDone: false } })] });
  await tick(60);
  const r = plain(h.run(`__m.getEstimatedLiveSeekableRange()`));
  assert.equal(r.start, 10, "start stays put without a moving window");
  assert.ok(r.end > 100.03, "end still advances");
});

test("a receiverAction event reports ReceiverAction.STOP to the listener", async () => {
  const h = createHarness();
  await init(h);
  h.run(`window.__ra = []; chrome.cast.addReceiverActionListener((r, a) => __ra.push([r.friendlyName, a]));`);
  h.emit({ type: "receiverAction", sessionId: "session-1", action: "stop" } as any);
  await tick(5);
  assert.deepEqual(plain(h.win.__ra), [["Lounge Cast TV", "stop"]]);
});

test("a receiverAction event ignores an unknown session id", async () => {
  const h = createHarness();
  await init(h);
  h.run(`window.__ra = []; chrome.cast.addReceiverActionListener((r, a) => __ra.push([r.friendlyName, a]));`);
  h.emit({ type: "receiverAction", sessionId: "unknown", action: "stop" } as any);
  await tick(5);
  assert.deepEqual(plain(h.win.__ra), []);
});

test("a receiverAction event for an ended session is ignored", async () => {
  const h = createHarness();
  await init(h);
  h.run(`window.__ra = []; chrome.cast.addReceiverActionListener((r, a) => __ra.push([r.friendlyName, a]));`);
  h.emit({ type: "sessionEnded", sessionId: "session-1", status: "stopped" });
  await tick(5);
  h.emit({ type: "receiverAction", sessionId: "session-1", action: "stop" } as any);
  await tick(5);
  assert.deepEqual(plain(h.win.__ra), []);
});

test("a session is announced to a sessionListener function only once", async () => {
  const h = createHarness();
  await init(h);
  await init(h);
  assert.deepEqual(plain(h.win.__ann), [["__sl", "session-1"]], "a second initialize does not re-announce");
  h.handlers.joinSession = (p) => ({ ok: true, value: snapshot({ sessionId: p.sessionId }) });
  h.run(`chrome.cast.requestSessionById("session-1");`);
  await tick(5);
  assert.deepEqual(plain(h.win.__ann), [["__sl", "session-1"]], "requestSessionById does not re-announce");
  await init(h, "__sl2");
  assert.deepEqual(plain(h.win.__ann), [["__sl", "session-1"], ["__sl2", "session-1"]], "a different listener still gets it");
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

test("a status without volume keeps the volume", async () => {
  const h = createHarness();
  await withMedia(h, {});
  assert.equal(h.run(`__m.volume.level`), 1);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [{ mediaSessionId: 7, playbackRate: 1, playerState: "PLAYING", currentTime: 3 }] });
  await tick(5);
  assert.equal(h.run(`__m.volume.level`), 1, "not reset to nulls");
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ volume: { level: 0.5, muted: true } })] });
  await tick(5);
  assert.equal(h.run(`__m.volume.level`), 0.5, "a volume object replaces it");
  assert.equal(h.run(`__m.volume.muted`), true);
});
