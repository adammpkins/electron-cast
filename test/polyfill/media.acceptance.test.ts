// Acceptance tests for chrome.cast.media (written before the implementation; do not edit to make them pass).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, tick, plain, snapshot, type Harness } from "./harness.ts";

const MEDIA = "urn:x-cast:com.google.cast.media";

async function withSession(h: Harness) {
  h.handlers.initialize = () => ({ ok: true, value: { available: true, sessions: [] } });
  h.run(`
    window.__ml = [];
    const c = chrome.cast;
    const cfg = new c.ApiConfig(new c.SessionRequest("CC1AD845"), () => {}, () => {});
    c.initialize(cfg, () => {}, () => {});
  `);
  await tick(5);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot({ appId: "CC1AD845", displayName: "Default Media Receiver" }) });
  h.run(`chrome.cast.requestSession((s) => { window.__s = s; s.addMediaListener((m) => __ml.push(m)); }, () => {});`);
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

test("media enums match Chrome's values", () => {
  const h = createHarness();
  const m = h.win.chrome.cast.media;
  assert.equal(m.DEFAULT_MEDIA_RECEIVER_APP_ID, "CC1AD845");
  assert.deepEqual(plain(m.PlayerState), { IDLE: "IDLE", PLAYING: "PLAYING", PAUSED: "PAUSED", BUFFERING: "BUFFERING" });
  assert.deepEqual(plain(m.MediaCommand), { PAUSE: "pause", SEEK: "seek", STREAM_VOLUME: "stream_volume", STREAM_MUTE: "stream_mute" });
  assert.deepEqual(plain(m.MetadataType), { GENERIC: 0, MOVIE: 1, TV_SHOW: 2, MUSIC_TRACK: 3, PHOTO: 4 });
  assert.deepEqual(plain(m.RepeatMode), { OFF: "REPEAT_OFF", ALL: "REPEAT_ALL", SINGLE: "REPEAT_SINGLE", ALL_AND_SHUFFLE: "REPEAT_ALL_AND_SHUFFLE" });
  assert.deepEqual(plain(m.ResumeState), { PLAYBACK_START: "PLAYBACK_START", PLAYBACK_PAUSE: "PLAYBACK_PAUSE" });
  assert.deepEqual(plain(m.StreamType), { BUFFERED: "BUFFERED", LIVE: "LIVE", OTHER: "OTHER" });
  assert.deepEqual(plain(m.IdleReason), { CANCELLED: "CANCELLED", INTERRUPTED: "INTERRUPTED", FINISHED: "FINISHED", ERROR: "ERROR" });
  assert.deepEqual(plain(m.TrackType), { TEXT: "TEXT", AUDIO: "AUDIO", VIDEO: "VIDEO" });
  assert.deepEqual(plain(m.TextTrackType), { SUBTITLES: "SUBTITLES", CAPTIONS: "CAPTIONS", DESCRIPTIONS: "DESCRIPTIONS", CHAPTERS: "CHAPTERS", METADATA: "METADATA" });
  assert.deepEqual(plain(m.TextTrackEdgeType), { NONE: "NONE", OUTLINE: "OUTLINE", DROP_SHADOW: "DROP_SHADOW", RAISED: "RAISED", DEPRESSED: "DEPRESSED" });
  assert.deepEqual(plain(m.TextTrackWindowType), { NONE: "NONE", NORMAL: "NORMAL", ROUNDED_CORNERS: "ROUNDED_CORNERS" });
  assert.deepEqual(plain(m.TextTrackFontStyle), { NORMAL: "NORMAL", BOLD: "BOLD", BOLD_ITALIC: "BOLD_ITALIC", ITALIC: "ITALIC" });
  assert.equal(m.TextTrackFontGenericFamily.MONOSPACED_SANS_SERIF, "MONOSPACED_SANS_SERIF");
});

test("media request and info classes apply Chrome's defaults", () => {
  const h = createHarness();
  const r = plain(h.run(`(() => {
    const m = chrome.cast.media;
    const mi = new m.MediaInfo("id", "video/mp4");
    return {
      mi, load: new m.LoadRequest(mi), qi: new m.QueueItem(mi), ql: new m.QueueLoadRequest([]),
      seek: new m.SeekRequest(), vol: new m.VolumeRequest(new chrome.cast.Volume(0.5, false)),
      track: new m.Track(1, "TEXT"), music: new m.MusicTrackMediaMetadata(), generic: new m.GenericMediaMetadata(),
      media: new m.Media("s", 3), play: new m.PlayRequest(), edit: new m.EditTracksInfoRequest([1]),
      isMedia: typeof m.Media === "function" && new m.Media("s", 3) instanceof m.Media,
    };
  })()`));
  assert.deepEqual(r.mi, { contentId: "id", streamType: "BUFFERED", contentType: "video/mp4", metadata: null, duration: null, tracks: null, textTrackStyle: null, customData: null });
  assert.deepEqual({ ...r.load, media: undefined }, { type: "LOAD", requestId: 0, sessionId: null, media: undefined, activeTrackIds: null, autoplay: true, currentTime: null, customData: null });
  assert.deepEqual({ ...r.qi, media: undefined }, { itemId: null, media: undefined, autoplay: true, startTime: 0, playbackDuration: null, preloadTime: 0, activeTrackIds: null, customData: null });
  assert.deepEqual(r.ql, { type: "QUEUE_LOAD", requestId: null, sessionId: null, items: [], startIndex: 0, repeatMode: "REPEAT_OFF", customData: null });
  assert.deepEqual(r.seek, { currentTime: null, resumeState: null, customData: null });
  assert.deepEqual(r.vol, { volume: { level: 0.5, muted: false }, customData: null });
  assert.deepEqual(r.track, { trackId: 1, trackContentId: null, trackContentType: null, type: "TEXT", name: null, language: null, subtype: null, customData: null });
  assert.equal(r.music.metadataType, 3);
  assert.equal(r.music.type, 3);
  assert.equal(r.generic.metadataType, 0);
  assert.deepEqual(r.play, { customData: null });
  assert.deepEqual(r.edit, { requestId: 0, activeTrackIds: [1], textTrackStyle: null });
  assert.equal(r.isMedia, true);
  assert.equal(r.media.sessionId, "s");
  assert.equal(r.media.mediaSessionId, 3);
  assert.equal(r.media.playerState, "IDLE");
  assert.equal(r.media.currentTime, 0);
  assert.equal(r.media.playbackRate, 1);
  assert.equal(r.media.repeatMode, "REPEAT_OFF");
  assert.deepEqual(r.media.supportedMediaCommands, []);
  assert.equal(r.media.idleReason, null);
});

test("loadMedia sends LOAD without null fields and resolves the Media from the matching MEDIA_STATUS", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`
    const mi = new chrome.cast.media.MediaInfo("https://x.test/a.mp3", "audio/mpeg");
    mi.metadata = new chrome.cast.media.MusicTrackMediaMetadata();
    mi.metadata.title = "Song";
    __s.loadMedia(new chrome.cast.media.LoadRequest(mi), (m) => { window.__media = m; }, (e) => { window.__lerr = e.code; });`);
  await tick(5);
  const load = lastSent(h, "LOAD");
  assert.ok(Number.isInteger(load.requestId) && load.requestId > 0, "positive integer requestId");
  assert.deepEqual({ ...load, requestId: undefined }, {
    type: "LOAD", requestId: undefined, sessionId: "session-1", autoplay: true,
    media: { contentId: "https://x.test/a.mp3", streamType: "BUFFERED", contentType: "audio/mpeg", metadata: { type: 3, metadataType: 3, title: "Song" } },
  });
  assert.equal(h.win.__media, undefined, "no success before the reply");
  receive(h, { type: "MEDIA_STATUS", requestId: load.requestId + 1000, status: [entry({ mediaSessionId: 99 })] });
  await tick(5);
  receive(h, { type: "MEDIA_STATUS", requestId: load.requestId, status: [entry({
    playerState: "BUFFERING", media: { contentId: "https://x.test/a.mp3", streamType: "BUFFERED", contentType: "audio/mpeg", duration: 200 },
  })] });
  await tick(5);
  const m = h.win.__media;
  assert.ok(m, "success called");
  assert.equal(h.run(`__media instanceof chrome.cast.media.Media`), true);
  assert.equal(m.sessionId, "session-1");
  assert.equal(m.mediaSessionId, 7);
  assert.equal(m.playerState, "BUFFERING");
  assert.equal(m.media.duration, 200);
  assert.deepEqual(plain(m.supportedMediaCommands), ["pause", "seek", "stream_volume", "stream_mute"]);
  assert.equal(h.run(`__media.volume instanceof chrome.cast.Volume`), true);
  assert.deepEqual(plain(m.volume), { level: 1, muted: false });
  assert.equal(h.run(`__s.media.includes(__media)`), true);
  assert.equal(h.run(`__ml.includes(__media)`), false, "media listeners are not called for the sender's own load");
  assert.equal(h.win.__lerr, undefined);
});

test("load failures map to chrome.cast error codes; a bad request fails locally", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__e = [];
    const mi = new chrome.cast.media.MediaInfo("u", "video/mp4");
    __s.loadMedia(new chrome.cast.media.LoadRequest(mi), () => __e.push("ok"), (e) => __e.push(["a", e.code]));
    __s.loadMedia(new chrome.cast.media.LoadRequest(mi), () => __e.push("ok"), (e) => __e.push(["b", e.code]));`);
  await tick(5);
  const [a, b] = mediaSent(h).filter((x) => x.type === "LOAD");
  assert.notEqual(a.requestId, b.requestId, "each request gets its own requestId");
  receive(h, { type: "LOAD_FAILED", requestId: a.requestId });
  receive(h, { type: "INVALID_REQUEST", requestId: b.requestId, reason: "INVALID_COMMAND" });
  await tick(5);
  const before = mediaSent(h).length;
  h.run(`__s.loadMedia(null, () => __e.push("ok"), (e) => __e.push(["c", e.code]));
    __s.loadMedia(new chrome.cast.media.LoadRequest(null), () => __e.push("ok"), (e) => __e.push(["d", e.code]));`);
  await tick(5);
  assert.deepEqual(plain(h.win.__e), [["a", "load_media_failed"], ["b", "session_error"], ["c", "invalid_parameter"], ["d", "invalid_parameter"]]);
  assert.equal(mediaSent(h).length, before, "invalid requests are not sent");
});

test("a media request times out with timeout after chrome.cast.media.timeout.load ms", async () => {
  const h = createHarness();
  await withSession(h);
  assert.equal(typeof h.win.chrome.cast.media.timeout.load, "number");
  h.run(`chrome.cast.media.timeout.load = 30;
    __s.loadMedia(new chrome.cast.media.LoadRequest(new chrome.cast.media.MediaInfo("u", "video/mp4")), () => { window.__t = "ok"; }, (e) => { window.__t = e.code; });`);
  await tick(80);
  assert.equal(h.win.__t, "timeout");
});

test("Media commands send the documented messages with mediaSessionId and resolve on the reply", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h);
  const cases: [string, string, object][] = [
    [`__media.play(null, ok, err)`, "PLAY", {}],
    [`__media.pause(new chrome.cast.media.PauseRequest(), ok, err)`, "PAUSE", {}],
    [`(() => { const r = new chrome.cast.media.SeekRequest(); r.currentTime = 42; r.resumeState = "PLAYBACK_START"; __media.seek(r, ok, err); })()`, "SEEK", { currentTime: 42, resumeState: "PLAYBACK_START" }],
    [`__media.stop(null, ok, err)`, "STOP", {}],
    [`__media.setVolume(new chrome.cast.media.VolumeRequest(new chrome.cast.Volume(0.3, null)), ok, err)`, "SET_VOLUME", { volume: { level: 0.3 } }],
    [`__media.getStatus(null, ok, err)`, "GET_STATUS", {}],
    [`__media.editTracksInfo(new chrome.cast.media.EditTracksInfoRequest([1]), ok, err)`, "EDIT_TRACKS_INFO", { activeTrackIds: [1] }],
    [`(() => { const r = new chrome.cast.media.PlayRequest(); r.customData = { a: 1 }; __media.play(r, ok, err); })()`, "PLAY", { customData: { a: 1 } }],
  ];
  for (const [code, type, extra] of cases) {
    h.run(`window.__r = []; var ok = (...a) => __r.push(["ok", a.length]); var err = (e) => __r.push(["err", e.code]); ${code};`);
    await tick(5);
    const msg = lastSent(h, type);
    assert.ok(Number.isInteger(msg.requestId) && msg.requestId > 0, `${type} requestId`);
    assert.deepEqual({ ...msg, requestId: undefined }, { type, requestId: undefined, mediaSessionId: 7, ...extra }, code);
    assert.deepEqual(plain(h.win.__r), [], `${type}: nothing before the reply`);
    receive(h, { type: "MEDIA_STATUS", requestId: msg.requestId, status: [entry()] });
    await tick(5);
    assert.deepEqual(plain(h.win.__r), [["ok", 0]], `${type}: success with no arguments`);
  }
});

test("queue operations send QUEUE_* messages", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h, entry({ items: [{ itemId: 1 }, { itemId: 2 }, { itemId: 3 }], currentItemId: 1 }));
  assert.deepEqual(plain(h.win.__media.items).map((i: any) => i.itemId), [1, 2, 3]);
  const cases: [string, string, object][] = [
    [`__media.queueNext(ok, err)`, "QUEUE_UPDATE", { jump: 1 }],
    [`__media.queuePrev(ok, err)`, "QUEUE_UPDATE", { jump: -1 }],
    [`__media.queueJumpToItem(3, ok, err)`, "QUEUE_UPDATE", { currentItemId: 3 }],
    [`__media.queueSetRepeatMode("REPEAT_ALL", ok, err)`, "QUEUE_UPDATE", { repeatMode: "REPEAT_ALL" }],
    [`__media.queueRemoveItem(2, ok, err)`, "QUEUE_REMOVE", { itemIds: [2] }],
    [`__media.queueAppendItem(new chrome.cast.media.QueueItem(new chrome.cast.media.MediaInfo("u2", "audio/mpeg")), ok, err)`, "QUEUE_INSERT",
      { items: [{ media: { contentId: "u2", streamType: "BUFFERED", contentType: "audio/mpeg" }, autoplay: true, startTime: 0, preloadTime: 0 }] }],
    [`__media.queueMoveItemToNewIndex(1, 2, ok, err)`, "QUEUE_REORDER", { itemIds: [1] }],
    [`__media.queueMoveItemToNewIndex(3, 0, ok, err)`, "QUEUE_REORDER", { itemIds: [3], insertBefore: 1 }],
  ];
  for (const [code, type, extra] of cases) {
    const n = mediaSent(h).length;
    h.run(`var ok = () => {}; var err = () => {}; ${code};`);
    await tick(5);
    const sent = mediaSent(h);
    assert.equal(sent.length, n + 1, `${code} sent one message`);
    const msg = sent.at(-1);
    assert.deepEqual({ ...msg, requestId: undefined }, { type, requestId: undefined, mediaSessionId: 7, ...extra }, code);
  }
  h.run(`window.__qe = null; __media.queueMoveItemToNewIndex(42, 0, () => {}, (e) => { __qe = e.code; });`);
  await tick(5);
  assert.equal(h.win.__qe, "invalid_parameter");
});

test("Session.queueLoad sends QUEUE_LOAD and resolves the Media", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`
    const items = [new chrome.cast.media.QueueItem(new chrome.cast.media.MediaInfo("a", "audio/mpeg"))];
    __s.queueLoad(new chrome.cast.media.QueueLoadRequest(items), (m) => { window.__qm = m; }, () => {});`);
  await tick(5);
  const msg = lastSent(h, "QUEUE_LOAD");
  assert.deepEqual({ ...msg, requestId: undefined }, {
    type: "QUEUE_LOAD", requestId: undefined, sessionId: "session-1", startIndex: 0, repeatMode: "REPEAT_OFF",
    items: [{ media: { contentId: "a", streamType: "BUFFERED", contentType: "audio/mpeg" }, autoplay: true, startTime: 0, preloadTime: 0 }],
  });
  receive(h, { type: "MEDIA_STATUS", requestId: msg.requestId, status: [entry({ mediaSessionId: 12 })] });
  await tick(5);
  assert.equal(h.win.__qm.mediaSessionId, 12);
  assert.equal(h.run(`__s.media.includes(__qm)`), true);
});

test("unsolicited MEDIA_STATUS updates the Media; an idle media with an idleReason is dead and removed", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h, entry({ playerState: "BUFFERING" }));
  h.run(`window.__u = []; __media.addUpdateListener((alive) => __u.push([alive, __media.playerState, __media.currentTime, __media.idleReason]));`);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ playerState: "PLAYING", currentTime: 5 })] });
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ playerState: "PAUSED", currentTime: 6 })] }, "other-session");
  await tick(5);
  assert.deepEqual(plain(h.win.__u), [[true, "PLAYING", 5, null]], "only this session's status applies");
  assert.equal(h.run(`__media.supportsCommand("seek")`), true);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ playerState: "IDLE", idleReason: "FINISHED", currentTime: 200 })] });
  await tick(5);
  assert.deepEqual(plain(h.win.__u).at(-1), [false, "IDLE", 200, "FINISHED"]);
  assert.equal(h.run(`__s.media.length`), 0);
});

test("supportsCommand and getEstimatedTime follow the latest status", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h, entry({ supportedMediaCommands: 3, playerState: "PLAYING", currentTime: 10, playbackRate: 1 }));
  assert.equal(h.run(`__media.supportsCommand(chrome.cast.media.MediaCommand.PAUSE)`), true);
  assert.equal(h.run(`__media.supportsCommand("stream_volume")`), false);
  await tick(60);
  const t = h.run(`__media.getEstimatedTime()`);
  assert.ok(t > 10.03 && t < 10.6, `estimated time advances while playing (got ${t})`);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ playerState: "PAUSED", currentTime: 20 })] });
  await tick(30);
  assert.equal(h.run(`__media.getEstimatedTime()`), 20);
});

test("media loaded by another sender reaches the session's media listeners", async () => {
  const h = createHarness();
  await withSession(h);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ mediaSessionId: 99, media: { contentId: "x", streamType: "LIVE", contentType: "video/mp4" } })] });
  await tick(5);
  assert.equal(h.win.__ml.length, 1);
  assert.equal(h.win.__ml[0].mediaSessionId, 99);
  assert.equal(h.run(`__s.media.includes(__ml[0])`), true);
  receive(h, { type: "MEDIA_STATUS", requestId: 0, status: [entry({ mediaSessionId: 99, currentTime: 3 })] });
  await tick(5);
  assert.equal(h.win.__ml.length, 1, "a known media is not announced twice");
  assert.equal(h.win.__ml[0].currentTime, 3);
});

test("joining an existing session asks the receiver for its media status", async () => {
  const h = createHarness();
  h.handlers.initialize = () => ({ ok: true, value: { available: true, sessions: [] } });
  h.run(`window.__joined = [];
    const c = chrome.cast;
    c.initialize(new c.ApiConfig(new c.SessionRequest("CC1AD845"), (s) => { __joined.push(s); s.addMediaListener((m) => { window.__jm = m; }); }, () => {}), () => {}, () => {});`);
  await tick(5);
  h.handlers.joinSession = (p) => ({ ok: true, value: snapshot({ sessionId: p.sessionId }) });
  h.run(`chrome.cast.requestSessionById("session-1");`);
  await tick(5);
  const gs = lastSent(h, "GET_STATUS");
  assert.deepEqual({ ...gs, requestId: undefined }, { type: "GET_STATUS", requestId: undefined });
  receive(h, { type: "MEDIA_STATUS", requestId: gs.requestId, status: [entry({ mediaSessionId: 5 })] });
  await tick(5);
  assert.equal(h.win.__jm?.mediaSessionId, 5);
});

test("a session that ends kills its media and fails pending media requests", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h);
  h.run(`window.__u = []; __media.addUpdateListener((alive) => __u.push(alive)); __media.play(null, () => { window.__p = "ok"; }, (e) => { window.__p = e.code; });`);
  await tick(5);
  h.emit({ type: "sessionEnded", sessionId: "session-1", status: "stopped" });
  await tick(5);
  assert.equal(h.win.__p, "session_error");
  assert.deepEqual(plain(h.win.__u), [false]);
  assert.equal(h.run(`__s.media.length`), 0);
});

test("a bridge failure while sending fails the media request with the bridge's code", async () => {
  const h = createHarness();
  await withSession(h);
  await loaded(h);
  h.handlers.sendMessage = () => ({ ok: false, code: "channel_error", description: "gone" });
  h.run(`__media.play(null, () => { window.__p = "ok"; }, (e) => { window.__p = e.code; });`);
  await tick(5);
  assert.equal(h.win.__p, "channel_error");
});
