// Mirrors to a REAL Cast device. Nothing in electron-cast's tests does this; you run it, on purpose.
//   npm start                         lists the devices that can receive mirroring, then quits
//   npm run tab -- "Living Room"      mirrors an animated demo page ("Casting tab")
//   npm run desktop -- "Living Room"  mirrors the primary screen, with system audio where the OS allows ("Casting screen")
// A dialog asks before anything starts, and closing the window or pressing Ctrl+C ends the route (the TV returns to
// its idle screen). Chrome's --cast-streaming-force-{enable,disable}-hardware-{h264,hevc,vp8,vp9,av1} switches and
// --enable-features / --disable-features (CastStreamingVp9, ...) given here are honoured: the library reads them from
// app.commandLine.
// In tab mode a second, differently coloured window opens too. While casting, press in the terminal (or use the
// "Cast" menu): s = switch the mirrored tab to the other window (and back), f = freeze the picture, u = unfreeze.
//   npm run tab -- "Living Room" --stats   also prints the mirroring statistics (Chrome's media-router-internals "Mirroring
//   stats") every 5 seconds
import { app, BrowserWindow, Menu, MessageChannelMain, desktopCapturer, dialog, ipcMain, utilityProcess, webContents } from "electron";
import { createCastManager } from "electron-cast/main";

const args = process.argv.slice(app.isPackaged ? 1 : 2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = value("mode") ?? "tab";

const demo = (hue, label, tone) => `<!doctype html><meta charset=utf-8><title>electron-cast mirroring demo</title>
<body style="margin:0;background:#123"><canvas id=c width=1280 height=720 style="width:100%"></canvas>
<script>
  const g = document.getElementById("c").getContext("2d"); let n = 0;
  (function draw() { n++; g.fillStyle = "hsl(" + (${hue} + n * 2 % 90) + ",60%,40%)"; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = "#fff"; g.font = "64px sans-serif"; g.fillText("${label}", 120, 300); g.fillText("frame " + n, 120, 400);
    requestAnimationFrame(draw); })();
  document.body.addEventListener("click", () => {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); o.frequency.value = ${tone}; const gain = ctx.createGain(); gain.gain.value = 0.05;
    o.connect(gain).connect(ctx.destination); o.start();
  }, { once: true });
</script>`;

const DEMO = demo(200, "electron-cast mirroring demo (window A)", 440);
const DEMO_B = demo(0, "electron-cast mirroring demo (window B)", 660);

async function main() {
  await app.whenReady();
  const cast = createCastManager({
    ipcMain,
    presentation: false,
    selectDevice: async () => null,
    mirroring: {
      electron: { BrowserWindow, utilityProcess, MessageChannelMain, desktopCapturer, webContents, app },
      log: (level, message) => console[level === "error" ? "error" : "log"](message),
    },
  });
  await cast.start();
  // mDNS answers trickle in: wait a few seconds for the list to fill.
  await new Promise((r) => setTimeout(r, 5000));

  const query = { castMode: mode === "desktop" ? "desktop_mirror" : "tab_mirror", withAudio: mode === "desktop" };
  const sinks = await new Promise((resolve) => {
    const stop = cast.registerMediaSinksObserver({ onSinksUpdated: (s) => resolve(s) }, query);
    setTimeout(stop, 0);
  });
  if (flag("list") || value("sink") === undefined) {
    console.log(`Devices that can receive ${query.castMode}:`);
    for (const s of sinks) console.log(`  ${s.name}  (${s.description}, ${s.iconType})`);
    console.log('Start with:  npm run tab -- "<name>"   or   npm run desktop -- "<name>"');
    await cast.dispose();
    app.quit();
    return;
  }

  const name = value("sink");
  const sink = sinks.find((s) => s.name === name);
  if (sink === undefined) {
    console.error(`No device named "${name}" can receive ${query.castMode}. Run "npm start" to list them.`);
    await cast.dispose();
    app.exit(1);
    return;
  }

  const win = new BrowserWindow({ width: 960, height: 540, title: "electron-cast mirroring demo" });
  win.loadURL(`data:text/html;base64,${Buffer.from(DEMO).toString("base64")}`);
  await new Promise((r) => win.webContents.once("did-finish-load", r));

  // The tab to switch to.
  let other;
  if (mode !== "desktop") {
    other = new BrowserWindow({ width: 960, height: 540, x: 60, y: 60, title: "electron-cast mirroring demo (B)" });
    other.loadURL(`data:text/html;base64,${Buffer.from(DEMO_B).toString("base64")}`);
    await new Promise((r) => other.webContents.once("did-finish-load", r));
  }

  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    message: `Start ${mode === "desktop" ? "mirroring your screen" : "mirroring this window"} to "${sink.name}"?`,
    detail: "This starts a real Cast session on that device. Closing this window ends it.",
    buttons: ["Start", "Cancel"],
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0) {
    await cast.dispose();
    app.quit();
    return;
  }

  // Chrome reads this when a session starts, so it is switched on before startCasting.
  if (flag("stats")) cast.setMirroringStatsEnabled(true);

  let route;
  try {
    if (mode === "desktop") {
      const [screen] = await desktopCapturer.getSources({ types: ["screen"] });
      route = await cast.startCasting(sink.id, { castMode: "desktop_mirror", desktopSourceId: screen.id, withAudio: true });
    } else {
      route = await cast.startCasting(sink.id, { castMode: "tab_mirror", webContentsId: win.webContents.id });
    }
  } catch (err) {
    console.error(`Could not start: ${err.code ?? ""} ${err.message}`);
    await cast.dispose();
    app.exit(1);
    return;
  }
  console.log(`Mirroring to ${sink.name}: ${route.description} (${route.id})`);
  cast.registerMediaRoutesObserver({
    onRoutesUpdated: (routes) => {
      if (!routes.some((r) => r.id === route.id)) {
        console.log("The route ended.");
        app.quit();
      }
    },
  });

  // Switching and freezing, as Chrome's "share this tab instead" and freeze controls do them.
  let current = win;
  const switchTab = () => {
    if (other === undefined) return console.log("Only tab mode can switch.");
    const next = current === win ? other : win;
    try {
      cast.switchMirroringSourceTab(route.id, next.webContents.id);
      current = next;
      console.log(`Now mirroring window ${current === win ? "A" : "B"} (route id unchanged: ${cast.getRoutes()[0]?.id === route.id}).`);
    } catch (err) {
      console.error(`Could not switch: ${err.code ?? ""} ${err.message}`);
    }
  };
  const freeze = () => {
    console.log(`freezeInfo before: ${JSON.stringify(cast.getRoutes()[0]?.freezeInfo)}`);
    cast.freezeRoute(route.id);
    setTimeout(() => console.log(`freezeInfo after 0.7 s: ${JSON.stringify(cast.getRoutes()[0]?.freezeInfo)}`), 700);
  };
  const unfreeze = () => {
    cast.unfreezeRoute(route.id);
    console.log(`freezeInfo: ${JSON.stringify(cast.getRoutes()[0]?.freezeInfo)}`);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Cast", submenu: [
      { label: "Switch tab (s)", accelerator: "CmdOrCtrl+Shift+S", click: switchTab },
      { label: "Freeze (f)", accelerator: "CmdOrCtrl+Shift+F", click: freeze },
      { label: "Unfreeze (u)", accelerator: "CmdOrCtrl+Shift+U", click: unfreeze },
    ] },
  ]));
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (text) => {
    for (const key of text) {
      if (key === "s") switchTab();
      else if (key === "f") freeze();
      else if (key === "u") unfreeze();
    }
  });
  console.log("Keys: s = switch tab, f = freeze, u = unfreeze (or the Cast menu).");

  let statsTimer;
  if (flag("stats")) {
    statsTimer = setInterval(() => {
      const stats = cast.getMirroringStats(route.id);
      console.log(`Mirroring stats: ${JSON.stringify(stats, null, 2)}`);
    }, 5000);
  }

  const stop = async () => {
    clearInterval(statsTimer);
    await cast.terminateRoute(route.id).catch(() => {});
    await cast.dispose();
    app.quit();
  };
  win.on("closed", stop);
  other?.on("closed", () => {
    // Closing the page being mirrored ends capture in Chrome; closing the idle one changes nothing.
    if (current === other) stop();
  });
  process.on("SIGINT", stop);
  app.on("window-all-closed", () => {});
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
