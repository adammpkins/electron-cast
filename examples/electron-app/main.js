import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, screen, session } from "electron";
import { createCastManager, createReceiverWindows } from "electron-cast/main";

const here = (name) => fileURLToPath(new URL(name, import.meta.url));

// The page is served over http on loopback so it has a real origin that allowOrigin can name. (A file: page has an
// opaque origin, and Google's Cast SDK is meant to run on http(s) pages.)
const files = {
  "/": ["index.html", "text/html"],
  "/page.js": ["page.js", "text/javascript"],
  "/receiver.html": ["receiver.html", "text/html"],
  "/receiver.js": ["receiver.js", "text/javascript"],
};
const server = createServer(async (req, res) => {
  const entry = files[req.url ?? ""];
  if (entry === undefined) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": `${entry[1]}; charset=utf-8` }).end(await readFile(here(entry[0])));
});

let win;
let pageOrigin;

let cast;

// Not a top-level `await app.whenReady()`: in an ESM main that never lets Electron finish starting up.
app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  pageOrigin = `http://127.0.0.1:${server.address().port}`;

  cast = createCastManager({
    ipcMain,
    // Only our own page may cast.
    allowOrigin: (origin) => origin === pageOrigin,
    // Called when the page asks to start a session. Resolve a device, "stop" or null (cancel).
    async selectDevice(devices, request) {
      const buttons = devices.map((d) => `${d.name} (${d.model})`);
      if (request.session) buttons.push("Stop casting");
      buttons.push("Cancel");
      const { response } = await dialog.showMessageBox(win, {
        type: "question",
        message: "Cast to",
        buttons,
        cancelId: buttons.length - 1,
        noLink: true,
      });
      if (response < devices.length) return devices[response];
      if (request.session && response === devices.length) return "stop";
      return null;
    },
    // Wired displays: a presentation page (receiver.html) is shown fullscreen on another screen, as Chrome does. The
    // receiver preload is generated into a folder the app owns, because a sandboxed preload must be a real file.
    wiredDisplay: {
      screen,
      // Finds the display of the page's window, so the picker leaves that display out, as Chrome's does
      BrowserWindow,
      createReceiverWindow: createReceiverWindows({
        BrowserWindow,
        session,
        ipcMain,
        preloadDir: join(app.getPath("userData"), "electron-cast-receiver"),
      }).factory,
      async selectDisplay(sinks) {
        if (sinks.length === 0) return null;
        const { response } = await dialog.showMessageBox(win, {
          type: "question",
          message: "Present on",
          buttons: [...sinks.map((s) => s.name), "Cancel"],
          cancelId: sinks.length,
          noLink: true,
        });
        return response < sinks.length ? sinks[response].id : null;
      },
    },
  });
  await cast.start();

  win = new BrowserWindow({
    width: 700,
    height: 500,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: here("preload.bundle.cjs"),
    },
  });
  await win.loadURL(pageOrigin);
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  server.close();
  void cast?.dispose();
});
