import { test } from "node:test";
import assert from "node:assert/strict";
import { createHarness, install, tick, plain, snapshot, BRIDGE_KEY, type Harness } from "./harness.ts";
import type { BridgeResult } from "../../src/polyfill/bridge-types.ts";
import { installChromeCast } from "../../src/polyfill/install.ts";

const MDX = "urn:x-cast:com.google.youtube.mdx";

/** Initialize with a standard config inside the page realm; collects listener calls on window.__log. */
async function initialized(h: Harness, initValue: unknown = { available: true, sessions: [] }) {
  h.handlers.initialize = () => ({ ok: true, value: initValue });
  h.run(`
    window.__log = [];
    window.__sessions = [];
    const c = chrome.cast;
    const req = new c.SessionRequest("233637DE", [c.Capability.AUDIO_OUT]);
    const cfg = new c.ApiConfig(req,
      (s) => { __sessions.push(s); __log.push(["session", s.sessionId]); },
      (a) => __log.push(["receiver", a]),
      c.AutoJoinPolicy.ORIGIN_SCOPED);
    c.initialize(cfg, () => __log.push(["init-ok"]), (e) => __log.push(["init-err", e.code]));
  `);
  await tick(5);
}

async function withSession(h: Harness) {
  await initialized(h);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot() });
  h.run(`chrome.cast.requestSession((s) => { window.__s = s; }, (e) => { window.__reqErr = e; });`);
  await tick(5);
  assert.ok(h.win.__s, "session established");
}

test("install defines chrome.cast with the API version, availability and enums", () => {
  const h = createHarness();
  const c = h.win.chrome.cast;
  assert.equal(c.isAvailable, true);
  assert.deepEqual(plain(c.VERSION), [1, 2]);
  assert.deepEqual(plain(c.AutoJoinPolicy), { TAB_AND_ORIGIN_SCOPED: "tab_and_origin_scoped", ORIGIN_SCOPED: "origin_scoped", PAGE_SCOPED: "page_scoped" });
  assert.deepEqual(plain(c.Capability), { VIDEO_OUT: "video_out", AUDIO_OUT: "audio_out", VIDEO_IN: "video_in", AUDIO_IN: "audio_in", MULTIZONE_GROUP: "multizone_group" });
  assert.deepEqual(plain(c.DefaultActionPolicy), { CREATE_SESSION: "create_session", CAST_THIS_TAB: "cast_this_tab" });
  assert.deepEqual(plain(c.ErrorCode), {
    CANCEL: "cancel", TIMEOUT: "timeout", API_NOT_INITIALIZED: "api_not_initialized", INVALID_PARAMETER: "invalid_parameter",
    EXTENSION_NOT_COMPATIBLE: "extension_not_compatible", EXTENSION_MISSING: "extension_missing",
    RECEIVER_UNAVAILABLE: "receiver_unavailable", SESSION_ERROR: "session_error", CHANNEL_ERROR: "channel_error",
    LOAD_MEDIA_FAILED: "load_media_failed",
  });
  assert.deepEqual(plain(c.ReceiverAction), { CAST: "cast", STOP: "stop" });
  assert.deepEqual(plain(c.ReceiverAvailability), { AVAILABLE: "available", UNAVAILABLE: "unavailable" });
  assert.deepEqual(plain(c.ReceiverType), { CAST: "cast", DIAL: "dial", HANGOUT: "hangout", CUSTOM: "custom" });
  assert.deepEqual(plain(c.SenderPlatform), { CHROME: "chrome", IOS: "ios", ANDROID: "android" });
  assert.deepEqual(plain(c.SessionStatus), { CONNECTED: "connected", DISCONNECTED: "disconnected", STOPPED: "stopped" });
  assert.deepEqual(plain(c.VolumeControlType), { ATTENUATION: "attenuation", FIXED: "fixed", MASTER: "master" });
  assert.deepEqual(plain(c.DialAppState), { RUNNING: "running", STOPPED: "stopped", ERROR: "error" });
  assert.deepEqual(plain(c.timeout), { requestSession: 60000, leaveSession: 3000, stopSession: 3000, setReceiverVolume: 3000, sendCustomMessage: 3000 });
  assert.equal(c.media.DEFAULT_MEDIA_RECEIVER_APP_ID, "CC1AD845");
});

test("class constructors apply the documented defaults", () => {
  const h = createHarness();
  const r = plain(h.run(`(() => {
    const c = chrome.cast;
    const req = new c.SessionRequest("APP");
    const cfg = new c.ApiConfig(req, () => {}, () => {});
    return {
      req, cfg: { ...cfg, sessionRequest: undefined },
      err: new c.Error("cancel"),
      err2: new c.Error("timeout", "desc", { a: 1 }),
      rcv: new c.Receiver("label", "Name"),
      vol: new c.Volume(),
      vol2: new c.Volume(0.4, true),
      img: new c.Image("https://x/i.png"),
      sess: new c.Session("sid", "APP", "Display", [], new c.Receiver("l", "n")),
      sender: new c.SenderApplication("chrome"),
      isErr: new c.Error("cancel") instanceof c.Error,
    };
  })()`));
  assert.deepEqual(r.req, {
    appId: "APP", capabilities: ["video_out", "audio_out"], requestSessionTimeout: 60000, language: null,
    dialRequest: null, androidReceiverCompatible: false, credentialsData: null,
  });
  assert.deepEqual(r.cfg, {
    autoJoinPolicy: "tab_and_origin_scoped", defaultActionPolicy: "create_session", additionalSessionRequests: [],
    customDialLaunchCallback: null, invisibleSender: false,
  });
  assert.deepEqual(r.err, { code: "cancel", description: null, details: null });
  assert.deepEqual(r.err2, { code: "timeout", description: "desc", details: { a: 1 } });
  assert.deepEqual(r.rcv, { label: "label", friendlyName: "Name", capabilities: [], volume: null, receiverType: "cast", isActiveInput: null, displayStatus: null });
  assert.deepEqual(r.vol, { level: null, muted: null });
  assert.deepEqual(r.vol2, { level: 0.4, muted: true });
  assert.deepEqual(r.img, { url: "https://x/i.png", height: null, width: null });
  assert.equal(r.sess.sessionId, "sid");
  assert.equal(r.sess.status, "connected");
  assert.equal(r.sess.transportId, "sid");
  assert.deepEqual(r.sess.namespaces, []);
  assert.deepEqual(r.sess.senderApps, []);
  assert.deepEqual(r.sess.media, []);
  assert.equal(r.sess.statusText, null);
  assert.deepEqual(r.sender, { platform: "chrome", url: null, packageId: null });
  assert.equal(r.isErr, true);
});

test("the install function is self-contained and returns true once, false on a repeat", () => {
  const h = createHarness();
  const first = h.win.chrome.cast;
  assert.equal(install(h), false);
  assert.equal(h.win.chrome.cast, first);
  assert.ok(!/\brequire\(|\bimport\(/.test(installChromeCast.toString()));
});

test("without the bridge nothing is installed", () => {
  const h = createHarness({ withBridge: false, install: false });
  assert.equal(install(h), false);
  assert.equal(h.win.chrome?.cast, undefined);
});

test("keeps existing window.chrome properties", () => {
  const h = createHarness({ before: "window.chrome = { runtime: { id: 'x' } };" });
  assert.equal(h.win.chrome.runtime.id, "x");
  assert.ok(h.win.chrome.cast);
});

test("calls a __onGCastApiAvailable defined before install, asynchronously, with true", async () => {
  const h = createHarness({ install: false, before: "window.__calls = []; window.__onGCastApiAvailable = (ok, info) => __calls.push([ok, info === undefined]);" });
  install(h);
  assert.deepEqual(plain(h.win.__calls), [], "not called synchronously");
  await tick(5);
  assert.deepEqual(plain(h.win.__calls), [[true, true]]);
});

test("calls a __onGCastApiAvailable assigned after install", async () => {
  const h = createHarness();
  h.run("window.__calls = []; window.__onGCastApiAvailable = (ok) => __calls.push(ok);");
  assert.equal(typeof h.win.__onGCastApiAvailable, "function", "the assigned function can be read back");
  await tick(5);
  assert.deepEqual(plain(h.win.__calls), [true]);
});

test("initialize reports success, then receiver availability, then auto-joined sessions", async () => {
  const h = createHarness();
  await initialized(h, { available: true, sessions: [snapshot()] });
  assert.deepEqual(plain(h.calls[0]), {
    method: "initialize",
    params: { appId: "233637DE", capabilities: ["audio_out"], autoJoinPolicy: "origin_scoped" },
  });
  assert.deepEqual(plain(h.win.__log), [["init-ok"], ["receiver", "available"], ["session", "session-1"]]);
  const s = h.win.__sessions[0];
  assert.ok(h.run("__sessions[0] instanceof chrome.cast.Session"));
  assert.equal(s.appId, "233637DE");
  assert.equal(s.displayName, "YouTube");
  assert.equal(s.statusText, "YouTube");
  assert.equal(s.transportId, "transport-1");
  assert.equal(s.status, "connected");
  assert.deepEqual(plain(s.namespaces), [{ name: MDX }, { name: "urn:x-cast:com.google.cast.media" }]);
  assert.ok(h.run("__sessions[0].receiver instanceof chrome.cast.Receiver"));
  assert.equal(s.receiver.friendlyName, "Lounge Cast TV");
  assert.equal(s.receiver.receiverType, "cast");
  assert.ok(h.run("__sessions[0].receiver.volume instanceof chrome.cast.Volume"));
  assert.equal(s.receiver.volume.level, 0.5);
  assert.ok(h.run("__sessions[0].appImages[0] instanceof chrome.cast.Image"));
});

test("initialize with no receivers reports unavailable", async () => {
  const h = createHarness();
  await initialized(h, { available: false, sessions: [] });
  assert.deepEqual(plain(h.win.__log), [["init-ok"], ["receiver", "unavailable"]]);
});

test("initialize rejects an invalid config with invalid_parameter and calls nothing", async () => {
  const h = createHarness();
  h.run(`window.__e = []; chrome.cast.initialize({}, () => __e.push("ok"), (e) => __e.push(e.code));
         chrome.cast.initialize(new chrome.cast.ApiConfig(new chrome.cast.SessionRequest("A"), null, () => {}), () => __e.push("ok"), (e) => __e.push(e.code));`);
  await tick(5);
  assert.deepEqual(plain(h.win.__e), ["invalid_parameter", "invalid_parameter"]);
  assert.equal(h.calls.length, 0);
});

test("a failed bridge initialize passes the error code through", async () => {
  const h = createHarness();
  h.handlers.initialize = () => ({ ok: false, code: "extension_missing", description: "origin not allowed" });
  h.run(`window.__e = null; chrome.cast.initialize(new chrome.cast.ApiConfig(new chrome.cast.SessionRequest("A"), () => {}, () => {}), () => {}, (e) => { __e = e; });`);
  await tick(5);
  assert.equal(h.win.__e.code, "extension_missing");
  assert.equal(h.win.__e.description, "origin not allowed");
  assert.ok(h.run("__e instanceof chrome.cast.Error"));
});

test("receiver availability events reach the listener only when the value changes", async () => {
  const h = createHarness();
  await initialized(h);
  h.emit({ type: "receiverAvailability", available: true });
  h.emit({ type: "receiverAvailability", available: false });
  h.emit({ type: "receiverAvailability", available: false });
  h.emit({ type: "receiverAvailability", available: true });
  await tick(5);
  assert.deepEqual(plain(h.win.__log).filter((x: string[]) => x[0] === "receiver"), [["receiver", "available"], ["receiver", "unavailable"], ["receiver", "available"]]);
});

test("requestSession before initialize fails with api_not_initialized", async () => {
  const h = createHarness();
  h.run(`window.__e = null; chrome.cast.requestSession(() => {}, (e) => { __e = e; });`);
  await tick(5);
  assert.equal(h.win.__e.code, "api_not_initialized");
  assert.equal(h.calls.length, 0);
});

test("requestSession resolves a Session, notifies receiver action listeners, and never calls back synchronously", async () => {
  const h = createHarness();
  await initialized(h);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot() });
  h.run(`window.__order = [];
    chrome.cast.addReceiverActionListener((r, action) => __order.push(["action", r.friendlyName, action]));
    chrome.cast.requestSession((s) => __order.push(["ok", s.sessionId]), (e) => __order.push(["err", e.code]));
    __order.push(["returned"]);`);
  await tick(5);
  assert.deepEqual(plain(h.win.__order), [["returned"], ["action", "Lounge Cast TV", "cast"], ["ok", "session-1"]]);
  assert.deepEqual(plain(h.calls.at(-1)), { method: "requestSession", params: { appId: "233637DE", capabilities: ["audio_out"], timeoutMs: 60000 } });
});

test("requestSession uses opt_sessionRequest when given", async () => {
  const h = createHarness();
  await initialized(h);
  h.handlers.requestSession = (p) => ({ ok: true, value: snapshot({ appId: p.appId }) });
  h.run(`chrome.cast.requestSession((s) => { window.__app = s.appId; }, () => {}, new chrome.cast.SessionRequest("CC1AD845", ["video_out"], 5000));`);
  await tick(5);
  assert.equal(h.win.__app, "CC1AD845");
  assert.deepEqual(plain(h.calls.at(-1)?.params), { appId: "CC1AD845", capabilities: ["video_out"], timeoutMs: 5000 });
});

test("a cancelled picker reports cancel", async () => {
  const h = createHarness();
  await initialized(h);
  h.handlers.requestSession = () => ({ ok: false, code: "cancel", description: "User closed the picker" });
  h.run(`window.__e = null; chrome.cast.requestSession(() => {}, (e) => { __e = e; });`);
  await tick(5);
  assert.equal(h.win.__e.code, "cancel");
  assert.equal(h.win.__e.description, "User closed the picker");
});

test("a second requestSession while one is pending fails with invalid_parameter", async () => {
  const h = createHarness();
  await initialized(h);
  let release!: () => void;
  h.handlers.requestSession = () => new Promise((r) => { release = () => r({ ok: true, value: snapshot() }); });
  h.run(`window.__r = [];
    chrome.cast.requestSession((s) => __r.push("first-ok"), (e) => __r.push("first-" + e.code));
    chrome.cast.requestSession((s) => __r.push("second-ok"), (e) => __r.push("second-" + e.code));`);
  await tick(5);
  assert.deepEqual(plain(h.win.__r), ["second-invalid_parameter"]);
  release();
  await tick(5);
  assert.deepEqual(plain(h.win.__r), ["second-invalid_parameter", "first-ok"]);
  assert.equal(h.calls.filter((c) => c.method === "requestSession").length, 1);
});

test("removeReceiverActionListener stops notifications", async () => {
  const h = createHarness();
  await initialized(h);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot() });
  h.run(`window.__n = 0; window.__l = () => __n++; chrome.cast.addReceiverActionListener(__l); chrome.cast.removeReceiverActionListener(__l);
         chrome.cast.requestSession(() => {}, () => {});`);
  await tick(5);
  assert.equal(h.win.__n, 0);
});

test("sendMessage serializes objects to JSON, passes strings through, and reports errors", async () => {
  const h = createHarness();
  await withSession(h);
  h.handlers.sendMessage = (p) => (p.namespace === "urn:x-cast:bad" ? { ok: false, code: "channel_error", description: "nope" } : { ok: true, value: undefined });
  h.run(`window.__m = [];
    __s.sendMessage("${MDX}", { type: "getMdxSessionStatus" }, () => __m.push("ok1"), (e) => __m.push(e.code));
    __s.sendMessage("${MDX}", "plain text", () => __m.push("ok2"), (e) => __m.push(e.code));
    __s.sendMessage("urn:x-cast:bad", {}, () => __m.push("ok3"), (e) => __m.push(e.code));`);
  await tick(5);
  assert.deepEqual(plain(h.win.__m).sort(), ["channel_error", "ok1", "ok2"]);
  const sent = h.calls.filter((c) => c.method === "sendMessage").map((c) => c.params);
  assert.deepEqual(sent.slice(0, 2), [
    { sessionId: "session-1", namespace: MDX, message: '{"type":"getMdxSessionStatus"}' },
    { sessionId: "session-1", namespace: MDX, message: "plain text" },
  ]);
});

test("message listeners receive messages for their session and namespace only", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__got = []; window.__ml = (ns, msg) => __got.push([ns, msg]); __s.addMessageListener("${MDX}", __ml);`);
  h.emit({ type: "message", sessionId: "session-1", namespace: MDX, message: '{"type":"mdxSessionStatus"}' });
  h.emit({ type: "message", sessionId: "other", namespace: MDX, message: "x" });
  h.emit({ type: "message", sessionId: "session-1", namespace: "urn:x-cast:other", message: "y" });
  await tick(5);
  assert.deepEqual(plain(h.win.__got), [[MDX, '{"type":"mdxSessionStatus"}']]);
  h.run(`__s.removeMessageListener("${MDX}", __ml);`);
  h.emit({ type: "message", sessionId: "session-1", namespace: MDX, message: "z" });
  await tick(5);
  assert.equal(h.win.__got.length, 1);
});

test("session updates refresh the Session in place; an ended session notifies with false", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__u = []; __s.addUpdateListener((alive) => __u.push([alive, __s.status, __s.statusText, __s.receiver.volume.level]));`);
  h.emit({ type: "sessionUpdated", session: snapshot({ statusText: "Now playing", receiver: { ...snapshot().receiver, volume: { level: 0.8, muted: false } } }) });
  h.emit({ type: "sessionUpdated", session: snapshot({ sessionId: "unrelated", statusText: "ignored" }) });
  await tick(5);
  assert.deepEqual(plain(h.win.__u), [[true, "connected", "Now playing", 0.8]]);
  h.emit({ type: "sessionEnded", sessionId: "session-1", status: "stopped" });
  await tick(5);
  assert.deepEqual(plain(h.win.__u).at(-1), [false, "stopped", "Now playing", 0.8]);
});

test("removeUpdateListener stops update notifications", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__n = 0; window.__ul = () => __n++; __s.addUpdateListener(__ul); __s.removeUpdateListener(__ul);`);
  h.emit({ type: "sessionUpdated", session: snapshot({ statusText: "x" }) });
  await tick(5);
  assert.equal(h.win.__n, 0);
});

test("stop ends the session as stopped", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__r = []; __s.addUpdateListener((alive) => __r.push(["update", alive]));
         __s.stop(() => __r.push(["ok", __s.status]), (e) => __r.push(["err", e.code]));`);
  await tick(5);
  assert.deepEqual(plain(h.calls.at(-1)), { method: "stopSession", params: { sessionId: "session-1" } });
  assert.deepEqual(plain(h.win.__r), [["update", false], ["ok", "stopped"]]);
});

test("leave disconnects without stopping the receiver app", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__r = null; __s.leave(() => { __r = __s.status; }, () => {});`);
  await tick(5);
  assert.deepEqual(plain(h.calls.at(-1)), { method: "leaveSession", params: { sessionId: "session-1" } });
  assert.equal(h.win.__r, "disconnected");
});

test("receiver volume and mute go to the bridge; an out-of-range level is rejected locally", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__r = [];
    __s.setReceiverVolumeLevel(0.3, () => __r.push("vol-ok"), (e) => __r.push(e.code));
    __s.setReceiverMuted(true, () => __r.push("mute-ok"), (e) => __r.push(e.code));
    __s.setReceiverVolumeLevel(1.5, () => __r.push("bad-ok"), (e) => __r.push("bad-" + e.code));`);
  await tick(5);
  assert.deepEqual(plain(h.win.__r).sort(), ["bad-invalid_parameter", "mute-ok", "vol-ok"]);
  assert.deepEqual(h.calls.filter((c) => c.method.startsWith("setReceiver")).map((c) => [c.method, c.params]), [
    ["setReceiverVolume", { sessionId: "session-1", level: 0.3 }],
    ["setReceiverMuted", { sessionId: "session-1", muted: true }],
  ]);
});

test("requestSessionById joins through the bridge and reports via the session listener", async () => {
  const h = createHarness();
  await initialized(h);
  h.handlers.joinSession = (p) => ({ ok: true, value: snapshot({ sessionId: p.sessionId }) });
  h.run(`chrome.cast.requestSessionById("session-42");`);
  await tick(5);
  assert.deepEqual(plain(h.calls.at(-1)), { method: "joinSession", params: { sessionId: "session-42" } });
  assert.deepEqual(plain(h.win.__log).at(-1), ["session", "session-42"]);
});

test("unimplemented media calls fail cleanly through the error callback", async () => {
  const h = createHarness();
  await withSession(h);
  h.run(`window.__e = []; __s.loadMedia({}, () => __e.push("ok"), (e) => __e.push(e.code)); __s.queueLoad({}, () => __e.push("ok"), (e) => __e.push(e.code));`);
  await tick(5);
  assert.deepEqual(plain(h.win.__e), ["session_error", "session_error"]);
});

test("setCustomReceivers, setReceiverDisplayStatus, logMessage, precache and unescape are harmless", async () => {
  const h = createHarness();
  await initialized(h);
  h.run(`window.__r = [];
    chrome.cast.setCustomReceivers([], () => __r.push("custom-ok"), () => __r.push("custom-err"));
    chrome.cast.setReceiverDisplayStatus(new chrome.cast.Receiver("l", "n"), () => __r.push("display-ok"), () => __r.push("display-err"));
    chrome.cast.logMessage("hello");
    chrome.cast.precache("x");
    window.__u = chrome.cast.unescape("a%20b");`);
  await tick(5);
  assert.deepEqual(plain(h.win.__r).sort(), ["custom-ok", "display-ok"]);
  assert.equal(h.win.__u, "a b");
});

test("callbacks are optional and throwing callbacks do not break later events", async () => {
  const h = createHarness();
  await initialized(h);
  h.handlers.requestSession = () => ({ ok: true, value: snapshot() });
  h.run(`chrome.cast.requestSession((s) => { window.__s = s; s.addMessageListener("${MDX}", () => { throw new Error("page bug"); });
                                                  s.addMessageListener("${MDX}", (ns, m) => { window.__last = m; }); });`);
  await tick(5);
  h.emit({ type: "message", sessionId: "session-1", namespace: MDX, message: "one" });
  h.emit({ type: "message", sessionId: "session-1", namespace: MDX, message: "two" });
  await tick(5);
  assert.equal(h.win.__last, "two");
  assert.ok(h.errors.length >= 1, "listener errors are reported to console.error");
  h.run(`__s.sendMessage("${MDX}", "x"); __s.stop(); chrome.cast.requestSession();`);
  await tick(5);
});

test("a YouTube-style sender flow works end to end", async () => {
  const h = createHarness({ install: false, before: `
    window.__trace = [];
    window.__onGCastApiAvailable = (ok) => {
      if (!ok) return;
      const c = chrome.cast;
      const cfg = new c.ApiConfig(new c.SessionRequest("233637DE", [c.Capability.AUDIO_OUT]),
        (s) => __trace.push("join " + s.sessionId), (a) => __trace.push("receivers " + a), c.AutoJoinPolicy.ORIGIN_SCOPED);
      c.initialize(cfg, () => __trace.push("initialized"), (e) => __trace.push("init error " + e.code));
    };` });
  h.handlers.initialize = () => ({ ok: true, value: { available: true, sessions: [] } });
  h.handlers.requestSession = () => ({ ok: true, value: snapshot() });
  install(h);
  await tick(5);
  h.run(`chrome.cast.requestSession((s) => {
      window.__s = s;
      __trace.push("connected to " + s.receiver.friendlyName);
      s.addUpdateListener((alive) => __trace.push("alive " + alive));
      s.addMessageListener("${MDX}", (ns, m) => __trace.push("mdx " + JSON.parse(m).type));
      s.sendMessage("${MDX}", { type: "getMdxSessionStatus" }, () => __trace.push("sent"), () => {});
    }, (e) => __trace.push("request error " + e.code));`);
  await tick(5);
  h.emit({ type: "message", sessionId: "session-1", namespace: MDX, message: JSON.stringify({ type: "mdxSessionStatus", data: { screenId: "s1" } }) });
  await tick(5);
  h.run(`__s.stop(() => __trace.push("stopped"));`);
  await tick(5);
  assert.deepEqual(plain(h.win.__trace), [
    "initialized", "receivers available", "connected to Lounge Cast TV", "sent", "mdx mdxSessionStatus", "alive false", "stopped",
  ]);
  assert.equal(BRIDGE_KEY, "__electronCastBridge");
});

test("a session the main process rejoined is handed to the sessionListener and is usable", async () => {
  const h = createHarness();
  await initialized(h);
  h.emit({ type: "sessionJoined", session: snapshot({ statusText: "Rejoined" }) });
  await tick(5);
  assert.deepEqual(plain(h.win.__sessions.map((s: any) => [s.sessionId, s.status, s.statusText])), [["session-1", "connected", "Rejoined"]]);
  h.run(`window.__u = []; __sessions[0].addUpdateListener((alive) => __u.push(alive));`);
  h.emit({ type: "sessionEnded", sessionId: "session-1", status: "stopped" });
  await tick(5);
  assert.deepEqual(plain(h.win.__u), [false]);
});

test("a session rejoined before the initialize reply arrives is handed over once initialize succeeds", async () => {
  const h = createHarness();
  let reply: (r: BridgeResult) => void = () => {};
  h.handlers.initialize = () => new Promise<BridgeResult>((resolve) => (reply = resolve));
  h.run(`
    window.__sessions = [];
    const c = chrome.cast;
    c.initialize(new c.ApiConfig(new c.SessionRequest("233637DE"), (s) => __sessions.push(s.sessionId), () => {}), () => {}, () => {});
  `);
  await tick(5);
  h.emit({ type: "sessionJoined", session: snapshot() });
  await tick(5);
  assert.deepEqual(plain(h.win.__sessions), []);
  reply({ ok: true, value: { available: true, sessions: [] } });
  await tick(5);
  assert.deepEqual(plain(h.win.__sessions), ["session-1"]);
});
