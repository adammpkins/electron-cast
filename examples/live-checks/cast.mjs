// Live check of casting to ONE named device, no key presses.
//   electron cast.mjs --sink "<device name>" --test top|iframe-same|iframe-cross|sandbox-no-presentation|sandbox-presentation|default-presentation [--secs 80] --yes
// Refuses to start unless the device is idle (no route with its sinkId, no app but Backdrop). Always ends its own session.
import { app, BrowserWindow, ipcMain } from "electron";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCastManager } from "electron-cast/main";

const args = process.argv.slice(2);
const value = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const test = value("test", "top");
const SINK = value("sink", ""); // the only device this file will ever select
const secs = Number(value("secs", "80"));
const t0 = Date.now();
const out = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}] ${m}`);
const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (SINK === "") { console.error("pass --sink <device name>: the one device this will cast to"); process.exit(2); }
if (!args.includes("--yes")) { console.error("pass --yes: this casts a short test video to " + SINK); process.exit(2); }
app.on("window-all-closed", () => {});

const pageHtml = (kind, q) => `<!doctype html><meta charset=utf-8><title>${kind}</title><body style="font:16px sans-serif"><h3>${kind}</h3>
${q.get("iframe") ? `<iframe id=f src="${q.get("iframe")}" ${q.get("sandbox") !== null ? `sandbox="${q.get("sandbox")}"` : ""} ${q.get("allow") ? `allow="${q.get("allow")}"` : ""} width=500 height=200></iframe>` : ""}
<script src="/sender.js"></script>`;
const serve = () => createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/sender.js") return res.writeHead(200, { "content-type": "text/javascript" }).end(readFileSync(here("pages/sender.js")));
  if (u.pathname === "/frame.html") return res.writeHead(200, { "content-type": "text/html" }).end(pageHtml("frame", u.searchParams));
  if (u.pathname === "/top.html") return res.writeHead(200, { "content-type": "text/html" }).end(pageHtml("top", u.searchParams));
  res.writeHead(404).end();
});
const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

const origins = new Set();
const selects = [];
const cast = createCastManager({
  ipcMain,
  allowOrigin: (o) => origins.has(o),
  selectDevice: async (devices, request) => {
    const d = devices.find((x) => x.name === SINK);
    selects.push({ origin: request.origin, senderId: request.senderId, appId: request.appId, picked: d ? d.name : null, offered: devices.length });
    out(`selectDevice origin=${request.origin} senderId=${request.senderId} (${request.senderId >= 2 ** 30 ? "iframe" : "main frame"}) appId=${request.appId} offered=${devices.length} -> ${d ? d.name : "none"}`);
    return d ?? null;
  },
});
let finished = false, sink = null, route = null;
cast.registerMediaRoutesObserver({ onRoutesUpdated: (rs) => { out(`routes: ${JSON.stringify(rs.map((r) => ({ id: r.id.slice(0, 12), app: r.appId, sink: r.sinkName, origin: r.origin, local: r.isLocal, members: r.members, desc: r.description })))}`); } });

const result = { test, checks: {} };
const ok = (name, pass, detail) => { result.checks[name] = pass; out(`CHECK ${pass ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`); };
const end = async (code, why) => {
  if (finished) return; finished = true;
  out(`ending: ${why}`);
  try { for (const r of cast.getRoutes().filter((r) => sink && r.sinkId === sink.id)) { out(`terminating route ${r.id.slice(0, 12)}`); await cast.terminateRoute(r.id); } } catch (e) { out(`terminate: ${e.message}`); }
  await sleep(1500);
  const left = cast.getRoutes().filter((r) => sink && r.sinkId === sink.id);
  out(`routes left on ${SINK} at exit: ${left.length}`);
  out(`SUMMARY ${JSON.stringify(result)}`);
  const pass = Object.values(result.checks).length > 0 && Object.values(result.checks).every(Boolean) && left.length === 0;
  out(`RESULT ${pass ? "PASS" : "FAIL"} ${test}`);
  await cast.dispose();
  app.exit(code ?? (pass ? 0 : 1));
};
// Hard cap: stop and quit whatever happens
setTimeout(() => end(1, `time cap ${secs}s`), secs * 1000);

const pollFor = async (fn, ms, step = 250) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(step); } return null; };

app.whenReady().then(async () => {
  const a = serve(), b = serve();
  const pa = await listen(a), pb = await listen(b);
  const oa = `http://127.0.0.1:${pa}`, ob = `http://localhost:${pb}`;
  origins.add(oa).add(ob);
  await cast.start();
  // find the device, then require idle
  sink = await pollFor(async () => (await new Promise((resolve) => { const stop = cast.registerMediaSinksObserver({ onSinksUpdated: resolve }); setTimeout(stop, 0); })).find((s) => s.name === SINK), 25000, 1000);
  if (!sink) { out(`no sink ${SINK}`); await end(2, "device not found"); return; }
  out(`sink ${sink.name} id=${sink.id} model=${sink.description} statusText="${sink.device.statusText ?? ""}"`);
  await sleep(4000); // the session tracker needs the receiver status
  const busy = cast.getRoutes().filter((r) => r.sinkId === sink.id);
  out(`guard: ${busy.length} route(s) on ${SINK}: ${JSON.stringify(busy.map((r) => ({ app: r.appId, desc: r.description })))}`);
  if (busy.length > 0) { console.error(`refusing: ${SINK} is busy`); finished = true; await cast.dispose(); app.exit(2); return; }

  const win = new BrowserWindow({ width: 900, height: 600, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, preload: here(".out/preload.cjs"), backgroundThrottling: false } });
  win.webContents.on("console-message", (...a) => { const m = typeof a[0]?.message === "string" ? a[0].message : String(a[2] ?? ""); if (m.startsWith("LIVE ")) out(`page ${m}`); });
  win.webContents.on("preload-error", (_e, p, e) => out(`PRELOAD ERROR ${p} ${e?.message}`));
  const iframeUrl = test === "iframe-cross" ? `${ob}/frame.html` : `${oa}/frame.html`;
  const q = new URLSearchParams();
  const inIframe = test.startsWith("iframe") || test.startsWith("sandbox");
  if (inIframe) {
    q.set("iframe", iframeUrl + "?sdk=1");
    q.set("sdk", "0"); // the top page does not load the SDK, so the sender is the iframe alone
    if (test === "sandbox-no-presentation") q.set("sandbox", "allow-scripts allow-same-origin");
    if (test === "sandbox-presentation") q.set("sandbox", "allow-scripts allow-same-origin allow-presentation");
    if (args.includes("--allow")) q.set("allow", value("allow"));
  }
  await win.loadURL(`${oa}/top.html?${q}`);
  const wcId = win.webContents.id;
  const frame = () => (inIframe ? win.webContents.mainFrame.frames.find((f) => f.url.startsWith(test === "iframe-cross" ? ob : oa)) : win.webContents.mainFrame);
  const ev = async (code, gesture = false) => { const f = frame(); if (!f) throw new Error("frame not found"); return f.executeJavaScript(code, gesture); };
  const ready = await pollFor(async () => { try { const f = frame(); return f && await f.executeJavaScript("window.__live && (window.__live.ready || window.__live.error)"); } catch { return null; } }, 20000);
  const live = async () => JSON.parse(await ev("JSON.stringify({ready:__live.ready,error:__live.error,standIn:__live.standIn,states:__live.states,players:__live.players,session:__live.session,requestResult:__live.requestResult??null,state:__live.playerState&&__live.playerState(),media:__live.mediaSessionState&&__live.mediaSessionState(),dr:__live.defaultRequest})"));
  out(`frame: ${frame()?.url} origin=${frame()?.origin} ready=${ready}`);
  let st = await live();
  out(`sdk state ${JSON.stringify(st)}`);
  ok("stand-in installed in the casting frame", st.standIn === true);

  if (test.startsWith("sandbox")) {
    const r = await ev("liveProbeConstructor()");
    out(`new PresentationRequest in the frame: ${r}`);
    result.constructor = r;
    ok(test === "sandbox-no-presentation" ? "constructor throws SecurityError without allow-presentation (Chrome)" : "constructor works with allow-presentation", test === "sandbox-no-presentation" ? r.startsWith("threw SecurityError") : r === "constructed");
    if (test === "sandbox-no-presentation") return end(null, "no cast attempted for the sandbox-without-presentation control");
  }
  ok("SDK ready", st.ready === true && !st.error, st.error ?? "");

  if (test === "default-presentation") {
    // Casting from the app's own UI: no gesture, no page click
    await sleep(1500);
    const has = cast.hasDefaultPresentationRequest(wcId);
    const dr = cast.getDefaultPresentationRequest(wcId);
    out(`default request: has=${has} ${JSON.stringify(dr)}`);
    ok("page set a default PresentationRequest (the SDK does)", has === true && dr?.presentationUrls?.length > 0);
    await win.webContents.mainFrame.executeJavaScript(`window.__connAvail = []; navigator.presentation.defaultRequest && navigator.presentation.defaultRequest.addEventListener("connectionavailable", (e) => { window.__connAvail.push({ id: e.connection.id.slice(0,8), state: e.connection.state }); console.log("LIVE connectionavailable " + e.connection.state); });`);
    const query = { presentationUrls: dr?.presentationUrls ?? [], origin: dr?.frameOrigin };
    // The device is listed for these URLs once it has answered GET_APP_AVAILABILITY
    const listed = await pollFor(async () => (await new Promise((resolve) => { const stop = cast.registerMediaSinksObserver({ onSinksUpdated: resolve }, query); setTimeout(stop, 0); })).find((s) => s.name === SINK), 15000, 1000);
    ok(`${SINK} is listed for the default request`, !!listed);
    if (!listed) return end(1, "not listed");
    await win.webContents.mainFrame.executeJavaScript("__live.autoload = true; 0");
    out("startCasting from the main process (no page click)");
    try { route = await cast.startCasting(listed.id, { webContentsId: wcId }); } catch (e) { ok("startCasting resolved", false, `${e.code} ${e.message}`); return end(1, "startCasting failed"); }
    ok("startCasting resolved with a route", !!route, `${route.id.slice(0, 12)} app=${route.appId} sink=${route.sinkName} local=${route.isLocal} members=${JSON.stringify(route.members)}`);
    const sess = await pollFor(async () => { const s = await live(); return s.session && s.session.state === "SESSION_STARTED" ? s : null; }, 15000);
    out(`page after startCasting: ${JSON.stringify(sess ?? await live())}`);
    const conn = await win.webContents.mainFrame.executeJavaScript("JSON.stringify(window.__connAvail)");
    out(`connectionavailable events seen by my listener: ${conn}`);
    ok("page got connectionavailable", JSON.parse(conn).length >= 1);
    ok("SDK in the page has a started session on the device", !!sess && sess.session.device === SINK, sess ? JSON.stringify(sess.session) : "none");
    const playing = await pollFor(async () => { const s = await live(); return s.state === "PLAYING" || s.media === "PLAYING" || s.players.includes("playerState=PLAYING"); }, 25000);
    out(`playing? ${playing} ${JSON.stringify(await live())}`);
    ok("media reached PLAYING (the SDK adopted the session and loaded media)", !!playing);
    await sleep(3000);
    await cast.terminateRoute(route.id);
    const gone = await pollFor(async () => cast.getRoutes().filter((r) => r.sinkId === sink.id).length === 0, 10000);
    ok("route gone after terminateRoute", !!gone);
    await sleep(1000);
    const after = await live();
    out(`page after terminate: ${JSON.stringify(after.session)}`);
    ok("page's session ended", after.session?.state === "SESSION_ENDED" || after.session?.state === "NO_SESSION");
    return end(null, "done");
  }

  // iframe / top: the page requests the session (user gesture via executeJavaScript), selectDevice picks the device
  out("requestSession from the page with a user gesture");
  const r = await ev("liveCast(true)", true);
  out(`liveCast -> ${r}`);
  const started = await pollFor(async () => { const s = await live(); return s.session && s.session.state === "SESSION_STARTED" ? s : (s.requestResult && s.requestResult !== "ok" ? s : null); }, 30000);
  st = await live();
  out(`after requestSession: ${JSON.stringify(st)}`);
  ok("selectDevice was asked with this frame's own origin", selects.length > 0 && selects[0].origin === frame().origin, JSON.stringify(selects[0] ?? null));
  ok("session started on " + SINK, st.session?.state === "SESSION_STARTED" && st.session.device === SINK);
  const routeNow = cast.getRoutes().filter((x) => x.sinkId === sink.id);
  ok("one route on the device, owned by this frame's origin", routeNow.length === 1 && routeNow[0].origin === frame().origin, JSON.stringify(routeNow.map((x) => ({ origin: x.origin, members: x.members, local: x.isLocal }))));
  if (!started || st.session?.state !== "SESSION_STARTED") return end(1, "no session");
  const playing = await pollFor(async () => { const s = await live(); return s.state === "PLAYING" || s.media === "PLAYING" || s.players.includes("playerState=PLAYING"); }, 30000);
  st = await live();
  out(`playing? ${playing} ${JSON.stringify(st)}`);
  ok("media status reached PLAYING", !!playing);
  await sleep(4000);
  out("stopping the session from the page (endCurrentSession(true))");
  await ev("liveStop()", true);
  const gone = await pollFor(async () => cast.getRoutes().filter((x) => x.sinkId === sink.id).length === 0, 10000);
  ok("route gone after the page stopped the session", !!gone);
  end(null, "done");
}).catch((e) => { console.error(e); end(1, String(e)); });
