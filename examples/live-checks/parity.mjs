// Live checks of the Chrome-parity features, on ONE named device, no key presses.
//   electron parity.mjs --sink "<device name>" --test wire|close-leave|close-stop|token|sinks|issues|site-mirror|fling --yes [--secs 85]
//        [--token-file <path>] [--logdir <dir>]
// Same rules as cast.mjs: the only device ever selected is --sink, a casting run discovers nothing else (the other devices are
// never even asked), the run refuses to start unless the device is idle, ends its own session and quits within --secs.
// `sinks` is the one test that discovers every device (a sink exists only once its channel is open, as in Chrome); it launches
// and selects nothing.
import { app, BrowserWindow, MessageChannelMain, ipcMain, utilityProcess, webContents } from "electron";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CastClient, CastDiscovery } from "electron-cast";
import { createCastManager } from "electron-cast/main";

const args = process.argv.slice(2);
const value = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const test = value("test", "");
const SINK = value("sink", "");
const secs = Number(value("secs", "85"));
const logdir = value("logdir", "");
const t0 = Date.now();
const out = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}] ${m}`);
const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TESTS = ["wire", "close-leave", "close-stop", "token", "sinks", "issues", "site-mirror", "fling"];
if (!TESTS.includes(test)) { console.error(`pass --test ${TESTS.join("|")}`); process.exit(2); }
if (SINK === "") { console.error("pass --sink <device name>: the one device this will cast to"); process.exit(2); }
if (!args.includes("--yes")) { console.error("pass --yes: this casts to " + SINK); process.exit(2); }
if (!(secs > 0 && secs <= 90)) { console.error("--secs must be 1 to 90"); process.exit(2); }
app.on("window-all-closed", () => {});

const APP_ID = "CC1AD845";
const STREAMING_APP = "0F5096E8";
const casting = test !== "sinks";
const mirrors = test === "site-mirror" || test === "fling";

// What goes over the wire to and from the device, so a run can show the JSON that was sent. Heartbeats and device
// authentication are left out; nothing here is a credential.
const SKIP_NS = /heartbeat|deviceauth/;
const wire = [];
// The OFFER carries the stream's AES key and IV mask: ephemeral, but not for a log.
const scrub = (t) => t.replace(/"(aesKey|aesIvMask)":"[^"]*"/g, '"$1":"[REDACTED]"');
const trim = (s) => (s.length > 1500 ? `${s.slice(0, 1500)}...(${s.length} chars)` : s);
if (casting) {
  const write = CastClient.prototype.write;
  CastClient.prototype.write = function (msg, done) {
    try {
      if (!SKIP_NS.test(msg.namespace) && typeof msg.payloadUtf8 === "string") {
        const ns = msg.namespace.replace("urn:x-cast:com.google.cast.", "");
        const payload = scrub(msg.payloadUtf8);
        const rec = { dir: "send", ns, dest: msg.destinationId, payload };
        wire.push(rec);
        out(`WIRE > ${ns} -> ${msg.destinationId} ${trim(payload)}`);
      }
    } catch { /* logging only */ }
    return write.call(this, msg, done);
  };
  const emit = CastClient.prototype.emit;
  CastClient.prototype.emit = function (ev, ...a) {
    try {
      const m = a[0];
      if (ev === "message" && m && !SKIP_NS.test(m.namespace)) {
        const text = typeof m.data === "string" ? m.data : Buffer.isBuffer(m.data) ? `<${m.data.length} bytes>` : JSON.stringify(m.data);
        const ns = m.namespace.replace("urn:x-cast:com.google.cast.", "");
        wire.push({ dir: "recv", ns, src: m.sourceId, payload: scrub(text) });
        if (!/"type":"(MEDIA_STATUS|PING|PONG)"/.test(text)) out(`WIRE < ${ns} <- ${m.sourceId} ${trim(scrub(text))}`);
      }
    } catch { /* logging only */ }
    return emit.call(this, ev, ...a);
  };
}

// A casting run sees only the named device: this wraps discovery so every other device is never reported to the manager.
class OnlyDevice {
  constructor(inner, name) { this.inner = inner; this.name = name; this.wrapped = new Map(); }
  start() { return this.inner.start(); }
  stop() { this.inner.stop(); }
  devices() { return this.inner.devices().filter((d) => d.name === this.name); }
  on(ev, l) { const w = (d) => { if (d.name === this.name) l(d); }; this.wrapped.set(`${ev}`, [...(this.wrapped.get(`${ev}`) ?? []), [l, w]]); this.inner.on(ev, w); }
  off(ev, l) { const list = this.wrapped.get(`${ev}`) ?? []; const e = list.find(([x]) => x === l); if (e) { this.inner.off(ev, e[1]); this.wrapped.set(`${ev}`, list.filter((x) => x !== e)); } }
}

const pageHtml = (kind, q) => `<!doctype html><meta charset=utf-8><title>${kind}</title><body style="margin:0;font:16px sans-serif;background:#123;color:#fff">
<canvas id=c width=1280 height=720 style="width:100%"></canvas>
<script>
  const g = document.getElementById("c").getContext("2d"); let n = 0;
  (function draw() { n++; g.fillStyle = "hsl(" + (200 + n * 2 % 90) + ",60%,40%)"; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = "#fff"; g.font = "64px sans-serif"; g.fillText("electron-cast live check: ${kind}", 80, 300); g.fillText("frame " + n, 80, 400); requestAnimationFrame(draw); })();
</script>
<script src="/${q.get("script") ?? "sender.js"}"></script>`;
const serve = () => createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/sender.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(here("pages/sender.js")));
  if (u.pathname === "/chromecast.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(here("pages/chromecast.js")));
  if (u.pathname === "/page.html") return res.writeHead(200, { "content-type": "text/html" }).end(pageHtml(test, u.searchParams));
  res.writeHead(404).end();
});
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

// The token store of the receiver-id test: a file the harness is given (a random salt for labels, not a credential).
const tokenFile = value("token-file", "");
let tokenLoaded = null, tokenSaved = null;
const store = tokenFile === "" ? undefined : {
  load: () => { const t = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8") : undefined; tokenLoaded = t === undefined ? null : t; return t; },
  save: (t) => { tokenSaved = t; writeFileSync(tokenFile, t); },
};
const fingerprint = (t) => (t === null ? null : createHash("sha256").update(t).digest("hex").slice(0, 12));

const origins = new Set();
const selects = [];
const raw = new CastDiscovery();
const cast = createCastManager({
  ipcMain,
  allowOrigin: (o) => origins.has(o),
  ...(casting ? { discovery: new OnlyDevice(new CastDiscovery(), SINK) } : {}),
  ...(store ? { receiverIdHashToken: store } : {}),
  ...(mirrors ? { mirroring: { electron: { BrowserWindow, utilityProcess, MessageChannelMain, webContents, app }, log: (level, m) => out(`mirroring ${level}: ${m}`) } } : {}),
  selectDevice: async (devices, request) => {
    const d = devices.find((x) => x.name === SINK);
    selects.push({ origin: request.origin, appId: request.appId, picked: d ? d.name : null, offered: devices.length });
    out(`selectDevice origin=${request.origin} appId=${request.appId} offered=${devices.length} -> ${d ? d.name : "none"}`);
    return d ?? null;
  },
});
let finished = false, sink = null;
const issuesSeen = [];
cast.registerIssuesObserver({
  onIssue: (i) => { issuesSeen.push({ at: Date.now() - t0, id: i.id, ...i.info }); out(`ISSUE onIssue ${JSON.stringify({ id: i.id, ...i.info })}`); },
  onIssuesCleared: () => { issuesSeen.push({ at: Date.now() - t0, cleared: true }); out("ISSUE onIssuesCleared"); },
});
const routeLog = [];
cast.registerMediaRoutesObserver({ onRoutesUpdated: (rs) => {
  const view = rs.map((r) => ({ id: r.id.slice(0, 14), source: r.mediaSource.slice(0, 60), app: r.appId, desc: r.description, sink: r.sinkName, local: r.isLocal, members: r.members, volume: r.volume }));
  routeLog.push({ at: Date.now() - t0, routes: view });
  out(`routes: ${JSON.stringify(view)}`);
} });

const result = { test, checks: {} };
const ok = (name, pass, detail) => { result.checks[name] = pass; out(`CHECK ${pass ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`); };
const end = async (code, why) => {
  if (finished) return; finished = true;
  out(`ending: ${why}`);
  try { for (const r of cast.getRoutes().filter((r) => sink && r.sinkId === sink.id)) { out(`terminating route ${r.id.slice(0, 14)}`); await cast.terminateRoute(r.id); } } catch (e) { out(`terminate: ${e.message}`); }
  await sleep(1500);
  const left = cast.getRoutes().filter((r) => sink && r.sinkId === sink.id);
  out(`routes left on ${SINK} at exit: ${left.length}`);
  try { out(`getLogs (${cast.getLogs().length} entries, last 40): ${JSON.stringify(cast.getLogs().slice(-40))}`); } catch (e) { out(`getLogs: ${e.message}`); }
  try { out(`getCastProviderState: ${JSON.stringify(cast.getCastProviderState())}`); } catch (e) { out(`getCastProviderState: ${e.message}`); }
  out(`SUMMARY ${JSON.stringify(result)}`);
  const pass = Object.values(result.checks).length > 0 && Object.values(result.checks).every(Boolean) && left.length === 0;
  out(`RESULT ${pass ? "PASS" : "FAIL"} ${test}`);
  if (logdir !== "") {
    try { mkdirSync(logdir, { recursive: true }); writeFileSync(`${logdir}/${test}${value("tag", "")}.json`, JSON.stringify({ result, wire, issues: issuesSeen, routeLog, selects }, null, 1)); } catch (e) { out(`logdir: ${e.message}`); }
  }
  await cast.dispose();
  raw.stop?.();
  app.exit(code ?? (pass ? 0 : 1));
};
setTimeout(() => end(1, `time cap ${secs}s`), secs * 1000);

const pollFor = async (fn, ms, step = 250) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };
const sinksNow = (query) => new Promise((resolve) => { const stop = cast.registerMediaSinksObserver({ onSinksUpdated: resolve }, query); setTimeout(stop, 0); });

app.whenReady().then(async () => {
  const a = serve();
  const pa = await listen(a);
  const oa = `http://127.0.0.1:${pa}`;
  origins.add(oa);
  // Site-initiated mirroring from a page of this origin needs Chrome's feature; it is read from app.commandLine
  if (test === "site-mirror") {
    const feat = app.commandLine.getSwitchValue("enable-features");
    out(`app.commandLine enable-features="${feat}"`);
    if (!feat.includes("AllowAllSitesToInitiateMirroring")) { out("the switch was not on the command line; appending it"); app.commandLine.appendSwitch("enable-features", "AllowAllSitesToInitiateMirroring"); }
  }
  const sinkLog = [];
  if (test === "sinks") {
    cast.registerMediaSinksObserver({ onSinksUpdated: (s) => { const v = s.map((x) => `${x.iconType}|${x.name}|${x.id.slice(0, 8)}|${x.providerId}`); sinkLog.push({ at: Date.now() - t0, v }); out(`SINKS (${s.length}) ${JSON.stringify(v)}`); } });
    await raw.start();
  }
  await cast.start();
  sink = await pollFor(async () => (await sinksNow()).find((s) => s.name === SINK), 25000, 1000);
  if (!sink) { out(`no sink ${SINK}`); await end(2, "device not found"); return; }
  out(`sink ${sink.name} id=${sink.id} model=${sink.description} icon=${sink.iconType} statusText="${sink.device.statusText ?? ""}"`);
  await sleep(4000); // the session tracker needs the receiver status
  const busy = cast.getRoutes().filter((r) => r.sinkId === sink.id);
  out(`guard: ${busy.length} route(s) on ${SINK}: ${JSON.stringify(busy.map((r) => ({ app: r.appId, desc: r.description })))}`);
  if (busy.length > 0) { console.error(`refusing: ${SINK} is busy`); finished = true; await cast.dispose(); app.exit(2); return; }
  out("guard: idle");

  if (test === "sinks") return sinksTest(sinkLog);

  const chromecastMode = test === "issues";
  const win = new BrowserWindow({ width: 640, height: 400, show: mirrors, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: here(chromecastMode ? ".out/preload-chromecast.cjs" : ".out/preload.cjs"), backgroundThrottling: false } });
  win.webContents.on("console-message", (...a) => { const m = typeof a[0]?.message === "string" ? a[0].message : String(a[2] ?? ""); if (m.startsWith("LIVE ")) out(`page ${m}`); });
  win.webContents.on("preload-error", (_e, p, e) => out(`PRELOAD ERROR ${p} ${e?.message}`));
  const q = new URLSearchParams();
  if (chromecastMode) q.set("script", "chromecast.js");
  if (mirrors) q.set("sdk", "0");
  await win.loadURL(`${oa}/page.html?${q}`);
  const wcId = win.webContents.id;
  const ev = (code, gesture = false) => win.webContents.mainFrame.executeJavaScript(code, gesture);
  const ready = await pollFor(async () => { try { return await ev("window.__live && (window.__live.ready || window.__live.error)"); } catch { return null; } }, mirrors ? 3000 : 20000);
  const live = async () => JSON.parse(await ev("JSON.stringify({ready:__live.ready,error:__live.error,standIn:__live.standIn,session:__live.session,requestResult:__live.requestResult??null,result:__live.result??null,state:__live.playerState&&__live.playerState(),media:__live.mediaSessionState&&__live.mediaSessionState(),players:__live.players,site:__live.siteResult??null,conns:__live.conns??[]})"));
  out(`page ready=${ready}`);
  const playing = async (ms) => pollFor(async () => { const s = await live(); return s.state === "PLAYING" || s.media === "PLAYING" || s.players.includes("playerState=PLAYING"); }, ms);
  const sessionUp = (ms) => pollFor(async () => { const s = await live(); return s.session && s.session.state === "SESSION_STARTED" ? s : (s.requestResult && s.requestResult !== "ok" ? s : null); }, ms);
  const routesOnSink = () => cast.getRoutes().filter((x) => x.sinkId === sink.id);
  const goneFromSink = (ms) => pollFor(async () => routesOnSink().length === 0, ms);

  if (test === "wire" || test === "token" || test === "close-leave" || test === "close-stop") {
    ok("SDK ready", (await live()).ready === true);
    const autoload = test === "wire";
    out(`requestSession from the page with a user gesture (autoload media: ${autoload})`);
    await ev(`liveCast(${autoload})`, true);
    const st = await sessionUp(30000);
    ok("session started on " + SINK, st?.session?.state === "SESSION_STARTED" && st.session.device === SINK, JSON.stringify(st?.session));
    if (st?.session?.state !== "SESSION_STARTED") return end(1, "no session");
    const route = routesOnSink()[0];
    ok("one route on the device for the Default Media Receiver", routesOnSink().length === 1 && route?.appId === APP_ID, JSON.stringify(routesOnSink().map((r) => ({ app: r.appId, desc: r.description, volume: r.volume }))));
    const receiver = JSON.parse(await ev("liveReceiver()"));
    out(`receiver as the page sees it: ${JSON.stringify(receiver)}`);

    if (test === "wire") {
      const sent = wire.filter((m) => m.dir === "send");
      const conn = sent.filter((m) => m.ns === "tp.connection" && /"CONNECT"/.test(m.payload)).map((m) => ({ dest: m.dest, ...JSON.parse(m.payload) }));
      const launch = sent.filter((m) => m.ns === "receiver" && /"LAUNCH"/.test(m.payload)).map((m) => JSON.parse(m.payload));
      out(`CONNECT messages: ${JSON.stringify(conn)}`);
      out(`LAUNCH messages: ${JSON.stringify(launch)}`);
      const c0 = conn.find((c) => c.dest === "receiver-0");
      ok("CONNECT to receiver-0 carries userAgent, connType 0, origin {} and senderInfo", !!c0 && typeof c0.userAgent === "string" && c0.connType === 0 && JSON.stringify(c0.origin) === "{}" && typeof c0.senderInfo === "object" && c0.senderInfo.sdkType === 2 && c0.senderInfo.platform === 3 && c0.senderInfo.connectionType === 1, JSON.stringify(c0?.senderInfo));
      const cApp = conn.find((c) => c.dest !== "receiver-0");
      ok("CONNECT to the app transport is a strong connection (connType 0) with the same fields", !!cApp && cApp.connType === 0 && typeof cApp.userAgent === "string" && !!cApp.senderInfo, cApp ? `dest=${cApp.dest}` : "none");
      ok("LAUNCH names CC1AD845 with language and supportedAppTypes [WEB]", launch.length === 1 && launch[0].appId === APP_ID && typeof launch[0].language === "string" && JSON.stringify(launch[0].supportedAppTypes) === '["WEB"]', JSON.stringify(launch[0]));
      const status = wire.find((m) => m.dir === "recv" && m.ns === "receiver" && m.payload.includes(APP_ID) && m.payload.includes("RECEIVER_STATUS"));
      ok("the device accepted it: RECEIVER_STATUS lists the running app CC1AD845", !!status, status ? trim(status.payload).slice(0, 300) : "none");
      const pl = await playing(30000);
      out(`playing? ${!!pl} ${JSON.stringify(await live())}`);
      ok("flower.mp4 reached PLAYING", !!pl);
      const load = wire.find((m) => m.dir === "send" && m.ns === "media" && m.payload.includes('"LOAD"'));
      ok("the LOAD named MDN's flower.mp4", !!load && load.payload.includes("interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4"), load ? trim(load.payload).slice(0, 300) : "none");
      await sleep(3000);
      await ev("liveStop()", true);
      ok("route gone after the page stopped the session", !!(await goneFromSink(10000)));
      return end(null, "done");
    }

    if (test === "token") {
      out(`TOKEN ${JSON.stringify({ store: tokenFile === "" ? "none" : "file", loaded: fingerprint(tokenLoaded), saved: fingerprint(tokenSaved), label: receiver.label })}`);
      result.label = receiver.label;
      result.tokenFingerprint = fingerprint(tokenLoaded ?? tokenSaved);
      ok("the page got a receiver label", typeof receiver.label === "string" && receiver.label.length > 0);
      await ev("liveStop()", true);
      ok("route gone after the page stopped the session", !!(await goneFromSink(10000)));
      return end(null, "done");
    }

    // close reasons: the page's own view of its PresentationConnection
    await sleep(2500);
    out(`ending the session from the page with Session.${test === "close-leave" ? "leave()" : "stop()"}`);
    await ev(test === "close-leave" ? "liveLeave()" : "liveStopSession()", true);
    await pollFor(async () => (await live()).conns.some((c) => c.events.some((e) => e.type === "close" || e.type === "terminate")), 10000);
    await sleep(1000);
    const s2 = await live();
    out(`connections the page saw: ${JSON.stringify(s2.conns)}`);
    const events = s2.conns.flatMap((c) => c.events);
    if (test === "close-leave") {
      const sent = s2.conns.flatMap((c) => c.sent);
      ok("the page sent leave_session", sent.includes("leave_session"), JSON.stringify(sent));
      const close = events.find((e) => e.type === "close");
      ok('the PresentationConnection closed with reason "closed" (state closed, no terminate event)', !!close && close.reason === "closed" && close.state === "closed" && !events.some((e) => e.type === "terminate"), JSON.stringify(events));
      // The Default Media Receiver quits by itself when its last sender disconnects, so the route may or may not be seen
      // as a non-local one for a moment; either is the device, not the library.
      const became = routeLog.filter((r) => r.at > Date.now() - t0 - 3000).flatMap((r) => r.routes);
      out(`routes after leave: ${JSON.stringify(became)}`);
    } else {
      const term = events.find((e) => e.type === "terminate");
      ok("the PresentationConnection ended as terminated (terminate event, state terminated)", !!term && term.state === "terminated", JSON.stringify(events));
      ok("stop() did not close the connection with a reason", !events.some((e) => e.type === "close"), JSON.stringify(events));
      ok("route gone after stop()", !!(await goneFromSink(10000)));
    }
    return end(null, "done");
  }

  if (test === "issues") {
    ok("page's chrome.cast is initialized", (await live()).ready === true, JSON.stringify(await live()));
    ok(`${SINK} is a sink`, !!sink);
    out("requestSession for the bogus app 00000000 (chrome.cast, no availability check)");
    await ev("liveRequest()", true);
    const res = await pollFor(async () => (await live()).result, 40000);
    out(`page result: ${res}`);
    ok("the launch failed", typeof res === "string" && res.startsWith("error"), String(res));
    const issue = issuesSeen.find((i) => i.title);
    ok('"Failed to cast. Please try again." reached registerIssuesObserver', !!issue && issue.title === "Failed to cast. Please try again.", JSON.stringify(issue));
    ok("with Chrome's severity (warning, kWarningAutoDismissMins)", issue?.severity === "warning", issue?.severity);
    ok("and the sink it is about", issue?.sinkId === sink.id, issue?.sinkId);
    const { IssueManager } = await import(pathToFileURL(here("../../dist/electron/issues.js")).href).catch(() => ({}));
    if (IssueManager) out(`autoDismissTimeoutMs for a warning: ${IssueManager.autoDismissTimeoutMs({ severity: "warning" })}`);
    const sent = wire.filter((m) => m.dir === "send" && m.ns === "receiver" && /"LAUNCH"/.test(m.payload));
    out(`LAUNCH sent: ${JSON.stringify(sent.map((m) => m.payload))}`);
    const err = wire.find((m) => m.dir === "recv" && m.ns === "receiver" && /LAUNCH_ERROR|INVALID_REQUEST/.test(m.payload));
    out(`device answered: ${err ? trim(err.payload) : "nothing"}`);
    ok("the device refused the launch (LAUNCH_ERROR)", !!err);
    ok("no route was left on the device", routesOnSink().length === 0);
    return end(null, "done");
  }

  if (test === "site-mirror") {
    const url = `cast:${STREAMING_APP}?streamingTargetPlayoutDelayMillis=300`;
    out(`switches: ${JSON.stringify({ enableFeatures: app.commandLine.getSwitchValue("enable-features") })}`);
    cast.setMirroringStatsEnabled(true);
    const avail = await ev(`liveAvailability(${JSON.stringify(url)})`);
    out(`getAvailability for ${url}: ${avail}`);
    ok("the page sees the device as available for the streaming URL", avail === true);
    await ev(`liveSiteStart(${JSON.stringify(url)})`, true);
    const route = await pollFor(async () => routesOnSink().find((r) => r.mediaSource.includes(STREAMING_APP)) ?? routesOnSink()[0], 30000);
    const site = (await live()).site;
    out(`start() -> ${site}; routes ${JSON.stringify(routesOnSink().map((r) => ({ id: r.id.slice(0, 14), src: r.mediaSource, desc: r.description })))}`);
    if (!route) { ok("a mirroring route started", false, String(site)); return end(1, "no route"); }
    ok("a mirroring route started from the page", true, `${route.mediaSource} "${route.description}"`);
    await sleep(2000);
    const offers = wire.filter((m) => m.dir === "send" && m.ns === "webrtc" && /"OFFER"/.test(m.payload)).map((m) => JSON.parse(m.payload));
    const streams = offers.flatMap((o) => o.offer?.supportedStreams ?? []);
    out(`OFFER streams: ${JSON.stringify(streams.map((s) => ({ type: s.type, codecName: s.codecName, targetDelay: s.targetDelay })))}`);
    ok("the OFFER's targetDelay is 300 on every stream", streams.length > 0 && streams.every((s) => s.targetDelay === 300), JSON.stringify(streams.map((s) => s.targetDelay)));
    const answer = wire.find((m) => m.dir === "recv" && m.ns === "webrtc" && m.payload.includes('"ANSWER"'));
    ok("the device answered the OFFER", !!answer && /"result":"ok"/.test(answer.payload), answer ? trim(answer.payload).slice(0, 200) : "none");
    out("mirroring for 30 s");
    for (let i = 0; i < 6; i++) { await sleep(5000); const s = cast.getMirroringStats(route.id); out(`stats ${JSON.stringify({ video: s.video && { ENQUEUE_FPS: s.video.ENQUEUE_FPS, NUM_FRAMES_CAPTURED: s.video.NUM_FRAMES_CAPTURED, NUM_PACKETS_SENT: s.video.NUM_PACKETS_SENT, NUM_PACKETS_RECEIVED: s.video.NUM_PACKETS_RECEIVED, NUM_FRAMES_LATE: s.video.NUM_FRAMES_LATE } })}`); }
    const s = cast.getMirroringStats(route.id);
    ok("mirroring frames flow (video packets sent and acknowledged)", Number(s.video?.NUM_PACKETS_SENT) > 100 && Number(s.video?.NUM_PACKETS_RECEIVED) > 0, JSON.stringify({ sent: s.video?.NUM_PACKETS_SENT, received: s.video?.NUM_PACKETS_RECEIVED, captured: s.video?.NUM_FRAMES_CAPTURED }));
    out("terminating from the page (connection.terminate())");
    await ev("liveSiteTerminate()", true);
    ok("route gone after the page terminated it", !!(await goneFromSink(10000)));
    const s3 = await live();
    out(`connections the page saw: ${JSON.stringify(s3.conns)}`);
    ok("the page's connection ended as terminated", s3.conns.flatMap((c) => c.events).some((e) => e.type === "terminate"), JSON.stringify(s3.conns.flatMap((c) => c.events)));
    return end(null, "done");
  }

  if (test === "fling") {
    cast.setMirroringStatsEnabled(true);
    out("mirroring the page's tab to the device");
    let mirror;
    try { mirror = await cast.startCasting(sink.id, { castMode: "tab_mirror", webContentsId: wcId }); } catch (e) { ok("tab mirroring started", false, `${e.code} ${e.message}`); return end(1, "no mirroring"); }
    out(`ROUTES BEFORE ${JSON.stringify(cast.getRoutes().map((r) => ({ id: r.id.slice(0, 14), src: r.mediaSource, app: r.appId, desc: r.description, members: r.members })))}`);
    ok("a tab mirroring route is up", routesOnSink().length === 1 && routesOnSink()[0].id === mirror.id, `${mirror.description}`);
    await sleep(8000);
    const s = cast.getMirroringStats(mirror.id);
    ok("mirroring frames flow before the join", Number(s.video?.NUM_PACKETS_SENT) > 0, JSON.stringify({ sent: s.video?.NUM_PACKETS_SENT, received: s.video?.NUM_PACKETS_RECEIVED }));
    out("the page loads Google's SDK, which auto-joins (ORIGIN_SCOPED) for CC1AD845");
    await ev("liveLoadSdk()");
    const flung = await pollFor(async () => routesOnSink().find((r) => r.appId === APP_ID), 40000);
    const page = await live();
    out(`ROUTES AFTER ${JSON.stringify(cast.getRoutes().map((r) => ({ id: r.id.slice(0, 14), src: r.mediaSource, app: r.appId, desc: r.description, members: r.members })))}`);
    out(`page after the join: ${JSON.stringify(page)}`);
    ok("an app route for CC1AD845 replaced the mirroring on the device", !!flung && !routesOnSink().some((r) => r.id === mirror.id), flung ? flung.description : "none");
    ok("exactly one route is left on the device", routesOnSink().length === 1);
    ok("the page's SDK has a session on the device", !!page.session && /SESSION_(STARTED|RESUMED)/.test(page.session.state) && page.session.device === SINK, JSON.stringify(page.session));
    const reconnect = page.conns.find((c) => c.how === "reconnect");
    ok("the join came through PresentationRequest.reconnect", !!reconnect, JSON.stringify(reconnect));
    return end(null, "done");
  }
}).catch((e) => { console.error(e); end(1, String(e)); });

// Sink order and validation: what the observer listed against what mDNS announced, read-only.
async function sinksTest(sinkLog) {
  out("watching the sinks for 45 s");
  await sleep(45000);
  const sinks = await sinksNow();
  const cast_ = sinks.filter((s) => s.providerId === "cast");
  const iconRank = { cast: 0, cast_audio_group: 1, cast_audio: 2, generic: 7 };
  const icon = (caps) => ((caps & 1) !== 0 ? "cast" : (caps & 32) !== 0 ? "cast_audio_group" : "cast_audio");
  const collator = new Intl.Collator();
  const expected = [...sinks].sort((x, y) => (iconRank[x.iconType] - iconRank[y.iconType]) || collator.compare(x.name, y.name) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  out(`FINAL SINKS ${JSON.stringify(sinks.map((s) => ({ icon: s.iconType, name: s.name, id: s.id.slice(0, 8), provider: s.providerId, model: s.description, ca: s.device.capabilities })))}`);
  out(`EXPECTED ORDER ${JSON.stringify(expected.map((s) => `${s.iconType}|${s.name}`))}`);
  ok("the observer's list is in Chrome's order (cast, cast_audio_group, cast_audio, then names by collator, then ids)", JSON.stringify(sinks.map((s) => s.id)) === JSON.stringify(expected.map((s) => s.id)));
  ok("every Cast sink's icon follows GetCastSinkIconType from its capabilities", cast_.every((s) => s.iconType === icon(s.device.capabilities)));
  const rank = sinks.map((s) => iconRank[s.iconType]);
  ok("icon types never go backwards", rank.every((r, i) => i === 0 || rank[i - 1] <= r), JSON.stringify(sinks.map((s) => s.iconType)));
  const rawDevices = raw.devices();
  out(`RAW mDNS ${JSON.stringify(rawDevices.map((d) => ({ instance: d.instanceName, fn: d.txt.fn ?? null, id: d.txt.id ? `${d.txt.id.slice(0, 8)}...` : null, md: d.txt.md ?? null, ca: d.txt.ca ?? null, name: d.name })))}`);
  const invalid = rawDevices.filter((d) => !d.txt.id || !d.txt.fn);
  out(`mDNS devices with no id or fn (must not be sinks): ${JSON.stringify(invalid.map((d) => d.instanceName))}`);
  ok("a device with no id or fn is not a sink", invalid.every((d) => !cast_.some((s) => s.id === d.id)), `${invalid.length} such device(s) heard`);
  ok("every Cast sink is named by its fn", cast_.every((s) => rawDevices.some((d) => d.id === s.id && d.txt.fn === s.name)));
  ok(`${SINK} is listed`, sinks.some((s) => s.name === SINK));
  result.sinkLog = sinkLog.length;
  return end(null, "done");
}
