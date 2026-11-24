# electron-cast

Chromecast for Electron. Web pages that use the Google Cast sender API (`chrome.cast`) get a working
implementation, and your main process handles device discovery and the Cast v2 protocol. No native modules, no
runtime dependencies, and it works with `sandbox: true` and `contextIsolation: true`.

Electron has no Presentation API or Media Router, and electron/electron#869 was closed in 2025 with no plans to add
one. This library fills that gap: a page's own cast button (YouTube Music's, for example) works unchanged.

## Install

```sh
npm install electron-cast
```

Requires Electron 35 or later (for `contextBridge.executeInMainWorld`).

## Use

**Main process.** Create one manager, start discovery, and decide how the user picks a device:

```ts
import { app, ipcMain, Menu } from "electron";
import { createCastManager } from "electron-cast/main";

const cast = createCastManager({
  ipcMain,
  // Only these pages may cast.
  allowOrigin: (origin) => origin === "https://music.youtube.com",
  // Called when the page asks to start a session. Resolve a device, or null to cancel.
  selectDevice: (devices) =>
    new Promise((resolve) => {
      let picked = false;
      Menu.buildFromTemplate(
        devices.map((d) => ({ label: d.name, sublabel: d.model, click: () => ((picked = true), resolve(d)) })),
      ).popup({ callback: () => setTimeout(() => picked || resolve(null), 100) });
    }),
});

await cast.start();
app.on("will-quit", () => void cast.dispose());
```

**Preload script** of the window or view that shows the page:

```ts
import { contextBridge, ipcRenderer } from "electron";
import { installCastBridge } from "electron-cast/preload";

installCastBridge({ contextBridge, ipcRenderer });
```

Import from `electron-cast/preload`, not the package root: the root also exports the main-process code, which needs
Node's `tls` and `dgram` and cannot load in a sandboxed preload. The preload entry has no imports of its own, so a
bundler can inline it.

That's all. The page sees `chrome.cast.isAvailable === true` before its scripts run, and its cast button drives
sessions through IPC to the main process.

## What works

- Device discovery over mDNS on every network interface, with devices coming and going live.
- `chrome.cast.initialize`, `requestSession`, `session.stop`, `session.leave`, receiver availability, volume and
  mute, and messages on custom namespaces (`sendMessage` and `addMessageListener`). That is all YouTube
  Music's cast button needs, and it works end to end.
- Several pages or windows at once; a page that reloads or closes leaves its sessions without stopping playback.
- Rejoining after a restart: pass `sessionStore` (a `get` and a `set` over wherever your app keeps its state) and the
  page is handed the session it left playing, as long as the device still runs that same session.

Not yet: `chrome.cast.media` (`loadMedia` fails with `session_error`), and the newer `cast.framework` API. Pages
that load media through the Default Media Receiver need those.

Casting is tested end to end with a Chromecast (YouTube Music). Discovery and connections are tested with Chromecast
Ultra, Google Home Mini, Nest Hub, Nest Hub Max and speaker groups.

## Lower layers

The package root exports every layer, if you want to use them without Electron:

- `CastDiscovery`: mDNS discovery of Cast devices.
- `CastClient`: a Cast v2 connection over TLS (connect, heartbeat, launch, stop, volume, app messages).
- `CastSessionService`: the session logic behind the Electron layer, with no Electron dependency.

See [docs/DESIGN.md](docs/DESIGN.md) for how the pieces fit.

## License

MIT
