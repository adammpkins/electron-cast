// Live iframe harness: electron-cast in a real Electron window with a same-origin and a cross-origin iframe, each
// running Google's real Cast sender SDK. Nothing here casts by itself: a session starts only when a person clicks
// "Cast" in a frame and picks a device in the dialog.
//
// Environment: LIVE_IFRAME_NO_SUBFRAMES=1 turns nodeIntegrationInSubFrames off (negative control).
// Argument:    --selftest   load the page, wait for both iframes to report the SDK state, print PASS/FAIL, quit.
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createCastManager } from "electron-cast/main";

const SELFTEST = process.argv.includes("--selftest");
const SUBFRAMES = process.env.LIVE_IFRAME_NO_SUBFRAMES !== "1";
const here = (name) => fileURLToPath(new URL(name, import.meta.url));
const log = (...parts) => console.log("[main]", ...parts);

// Two servers on two ports and two host names, so the top page, the same-origin iframe (same origin as the top page)
// and the cross-origin iframe (a different site, so a different renderer process too) are two real origins.
const FILES = {
  "/": ["top.html", "text/html"],
  "/top.html": ["top.html", "text/html"],
  "/top.js": ["top.js", "text/javascript"],
  "/frame.html": ["frame.html", "text/html"],
  "/frame.js": ["frame.js", "text/javascript"],
};
const serve = () =>
  createServer(async (req, res) => {
    const entry = FILES[new URL(req.url ?? "/", "http://x").pathname];
    if (entry === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": `${entry[1]}; charset=utf-8`, "cache-control": "no-store" }).end(await readFile(here(entry[0])));
  });
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

let win;
const origins = new Set();
const seenOrigins = new Set();
const selectRequests = [];

const toPage = (kind, data) => {
  if (win === undefined || win.isDestroyed()) return;
  win.webContents.mainFrame
    .executeJavaScript(`window.liveMain && window.liveMain(${JSON.stringify(kind)}, ${JSON.stringify(data)})`)
    .catch(() => {});
};

const cast = createCastManager({
  ipcMain,
  // Only the harness's own origins may cast; a refusal is logged so a wrong origin is visible
  allowOrigin(origin) {
    const ok = origins.has(origin);
    if (!seenOrigins.has(`${origin} ${ok}`)) {
      seenOrigins.add(`${origin} ${ok}`);
      log(`allowOrigin(${origin}) -> ${ok}`);
    }
    return ok;
  },
  // Called only after a person clicks Cast in a frame. The dialog says which frame asked, from main's own view.
  async selectDevice(devices, request) {
    const info = { origin: request.origin, senderId: request.senderId, appId: request.appId, existingSession: request.session?.sessionId ?? null };
    selectRequests.push(info);
    log("selectDevice", JSON.stringify(info), `devices=${devices.length}`);
    toPage("selectDevice", info);
    const buttons = devices.map((d) => `${d.name} (${d.model})`);
    if (request.session) buttons.push("Stop casting");
    buttons.push("Cancel");
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      title: "Cast to",
      message: "Cast to which device?",
      detail: `Asked by origin ${request.origin}\nsender id ${request.senderId} (${request.senderId >= 2 ** 30 ? "an iframe" : "the main frame"})`,
      buttons,
      cancelId: buttons.length - 1,
      noLink: true,
    });
    if (response < devices.length) return devices[response];
    if (request.session && response === devices.length) return "stop";
    return null;
  },
});

cast.registerMediaRoutesObserver({
  onRoutesUpdated(routes) {
    const summary = routes.map((r) => ({
      id: r.id,
      app: r.appId,
      origin: r.origin,
      members: r.members,
      parked: r.parked,
      parkedSenders: r.parkedSenders,
    }));
    log("routes", JSON.stringify(summary));
    toPage("routes", summary);
  },
});

// Frames log "LIVE_STATE {json}" whenever their SDK state changes; --selftest waits for one from each iframe.
const states = new Map();
const onConsole = (...args) => {
  const message = typeof args[0]?.message === "string" ? args[0].message : String(args[2] ?? "");
  console.log("[renderer]", message);
  if (!message.startsWith("LIVE_STATE ")) return;
  try {
    const state = JSON.parse(message.slice("LIVE_STATE ".length));
    states.set(state.frame, state);
  } catch {
    // not ours
  }
};

async function selftest() {
  const deadline = Date.now() + 40_000;
  const ready = () => ["same", "cross"].every((f) => states.get(f)?.reported === true);
  while (!ready() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  for (const f of ["same", "cross"]) log(`selftest ${f}:`, JSON.stringify(states.get(f) ?? null));
  const problems = [];
  if (selectRequests.length > 0) problems.push("selectDevice was called without a click");
  if (SUBFRAMES) {
    for (const f of ["same", "cross"]) {
      const s = states.get(f);
      if (s === undefined) problems.push(`${f}: no report from the frame`);
      else {
        if (s.presentationStandIn !== true) problems.push(`${f}: no Presentation API stand-in (the preload did not run in the iframe)`);
        if (s.sdkLoaded !== true) problems.push(`${f}: the Cast SDK did not load (${s.error ?? "no error"})`);
        if (typeof s.castState !== "string") problems.push(`${f}: no cast state`);
      }
    }
    const a = states.get("same")?.origin;
    const b = states.get("cross")?.origin;
    if (a === undefined || b === undefined || a === b) problems.push(`origins are not distinct: ${a} / ${b}`);
    if (problems.length > 0) console.log(`live-iframe selftest: FAIL\n  ${problems.join("\n  ")}`);
    else console.log("live-iframe selftest: PASS (SDK loaded and reported a cast state in both iframes; no cast was started)");
    app.exit(problems.length > 0 ? 1 : 0);
  } else {
    // Negative control: without nodeIntegrationInSubFrames an iframe must have no Presentation stand-in
    const noCast = ["same", "cross"].every((f) => states.get(f)?.presentationStandIn === false) && problems.length === 0;
    console.log(`live-iframe selftest (no subframes): ${noCast ? "PASS (the iframes have no Presentation stand-in, as documented)" : "FAIL"}`);
    app.exit(noCast ? 0 : 1);
  }
}

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => void cast.dispose());

app.whenReady().then(async () => {
  const top = serve();
  const other = serve();
  const topPort = await listen(top);
  const otherPort = await listen(other);
  const topOrigin = `http://127.0.0.1:${topPort}`;
  const crossOrigin = `http://localhost:${otherPort}`;
  origins.add(topOrigin).add(crossOrigin);
  log("origins:", `top page and same-origin iframe ${topOrigin};`, `cross-origin iframe ${crossOrigin};`, `nodeIntegrationInSubFrames=${SUBFRAMES}`);
  await cast.start();

  win = new BrowserWindow({
    width: 1200,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: SUBFRAMES,
      preload: here(".out/preload.cjs"),
    },
  });
  win.webContents.on("console-message", onConsole);
  win.webContents.on("preload-error", (_e, path, error) => log("PRELOAD ERROR", path, error?.stack ?? error));
  win.webContents.on("render-process-gone", (_e, d) => log("renderer gone:", d.reason));
  await win.loadURL(`${topOrigin}/top.html?cross=${encodeURIComponent(crossOrigin)}`);
  if (SELFTEST) await selftest();
});
