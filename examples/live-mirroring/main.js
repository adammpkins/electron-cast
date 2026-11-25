// Mirrors to a REAL Cast device. Nothing in electron-cast's tests does this; you run it, on purpose.
//   npm start                         lists the devices that can receive mirroring, then quits
//   npm run tab -- "Living Room"      mirrors an animated demo page ("Casting tab")
//   npm run desktop -- "Living Room"  mirrors the primary screen, with system audio where the OS allows ("Casting screen")
// A dialog asks before anything starts, and closing the window or pressing Ctrl+C ends the route (the TV returns to
// its idle screen). Add --extra-codecs to let the sender offer VP9 as well as VP8.
import { app, BrowserWindow, MessageChannelMain, desktopCapturer, dialog, ipcMain, utilityProcess, webContents } from "electron";
import { createCastManager } from "electron-cast/main";

const args = process.argv.slice(app.isPackaged ? 1 : 2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = value("mode") ?? "tab";

const DEMO = `<!doctype html><meta charset=utf-8><title>electron-cast mirroring demo</title>
<body style="margin:0;background:#123"><canvas id=c width=1280 height=720 style="width:100%"></canvas>
<script>
  const g = document.getElementById("c").getContext("2d"); let n = 0;
  (function draw() { n++; g.fillStyle = "hsl(" + (n * 2 % 360) + ",60%,40%)"; g.fillRect(0, 0, 1280, 720);
    g.fillStyle = "#fff"; g.font = "64px sans-serif"; g.fillText("electron-cast mirroring demo", 120, 300); g.fillText("frame " + n, 120, 400);
    requestAnimationFrame(draw); })();
  document.body.addEventListener("click", () => {
    const ctx = new AudioContext(); const o = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.05;
    o.connect(gain).connect(ctx.destination); o.start();
  }, { once: true });
</script>`;

async function main() {
  await app.whenReady();
  const cast = createCastManager({
    ipcMain,
    presentation: false,
    selectDevice: async () => null,
    mirroring: {
      electron: { BrowserWindow, utilityProcess, MessageChannelMain, desktopCapturer, webContents },
      extraVideoCodecs: flag("extra-codecs") ? ["vp9"] : [],
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

  const stop = async () => {
    await cast.terminateRoute(route.id).catch(() => {});
    await cast.dispose();
    app.quit();
  };
  win.on("closed", stop);
  process.on("SIGINT", stop);
  app.on("window-all-closed", () => {});
}

main().catch((err) => {
  console.error(err);
  app.exit(1);
});
