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

### Presentation mode (opt-in): Google's own Cast SDK

By default the page gets electron-cast's own `chrome.cast`. In presentation mode it gets a stand-in for the
Presentation API (`PresentationRequest`) instead, and **Google's own `cast_sender.js` and `cast.framework` load and run
unmodified** on top of it, as they do in Chrome. Electron has `navigator.presentation` but nothing behind it, so this
fills in the missing piece rather than replacing Google's SDK.

```ts
// main
const cast = createCastManager({ ipcMain, selectDevice, allowOrigin, presentation: true });
// preload
installCastBridge({ contextBridge, ipcRenderer, mode: "presentation" });
```

A cast must start from a user gesture (a click on the page's cast button), as in Chrome. Known limits, for now:

- A session doesn't survive a page reload, so auto-join after a reload starts fresh.
- Google's SDK running inside an iframe gets no events: messages go to the main frame.

Tested end to end with `cast.framework` on a Nest Hub (Electron 45): session, volume, HLS load, play, pause, seek and
stop.

## What works

- Device discovery over mDNS on every network interface, with devices coming and going live.
- `chrome.cast.initialize`, `requestSession`, `session.stop`, `session.leave`, receiver availability, volume and
  mute, and messages on custom namespaces (`sendMessage` and `addMessageListener`). That is all YouTube
  Music's cast button needs, and it works end to end.
- `chrome.cast.media`: load and queue media (`loadMedia`, `queueLoad`), control playback (play, pause, seek, stop,
  volume, tracks, queue operations), receive media status updates, and watch for media with media listeners. Pages
  can drive the Default Media Receiver.
- Google's Cast Application Framework (`cast.framework`, loaded by `cast_sender.js?loadCastFramework=1`): `CastContext`,
  sessions, `RemotePlayer` and `RemotePlayerController`. Electron exposes
  `navigator.presentation`, so Google's loader would normally inject its own Presentation API based `chrome.cast`,
  which overwrites the polyfill and finds no devices in Electron; the polyfill blocks that script and tells the page's
  `__onGCastApiAvailable` callback once.
- Several pages or windows at once; a page that reloads or closes leaves its sessions without stopping playback.

Casting is tested end to end with a Chromecast (YouTube Music), and media through `cast.framework` with a Nest Hub
(load, play, pause, seek, volume, and stopping from the picker). Discovery and connections are tested with Chromecast
Ultra, Google Home Mini, Nest Hub, Nest Hub Max and speaker groups.

## Lower layers

The package root exports every layer, if you want to use them without Electron:

- `CastDiscovery`: mDNS discovery of Cast devices.
- `CastClient`: a Cast v2 connection over TLS (connect, heartbeat, launch, stop, volume, app messages).
- `CastSessionService`: the session logic behind the Electron layer, with no Electron dependency.

See [docs/DESIGN.md](docs/DESIGN.md) for how the pieces fit.

## License

MIT
