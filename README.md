# electron-cast

Chromecast for Electron. Web pages that use Google's Cast SDK (`chrome.cast`, `cast.framework`) can cast, running
Google's own SDK, while your main process handles device discovery and the Cast v2 protocol. No native modules, no
runtime dependencies, and it works with `sandbox: true` and `contextIsolation: true`.

Electron has the Presentation API but no Media Router behind it, and electron/electron#869 was closed in 2025 with no
plans to add one. This library fills that gap: a page's own cast button (YouTube Music's, for example) works
unchanged.

## Install

```sh
npm install electron-cast
```

Requires Electron 35 or later (for `contextBridge.executeInMainWorld`; the preload fails on 34). CI loads the built
package in a real Electron 35, 40 and the latest stable on Linux, Windows and macOS (`npm run smoke` runs it locally
once you have installed Electron).

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
Node's `tls` and `dgram` and cannot load in a sandboxed preload. The preload entry imports nothing Node-only, but a
sandboxed preload cannot load other files either, so bundle it into your preload (esbuild, for example, as
`smoke/build-preloads.mjs` does). A non-sandboxed CommonJS preload can `require("electron-cast/preload")` directly:
the package ships a CommonJS build next to the ESM one.

That's all. The page loads Google's Cast SDK as usual, and its cast button drives sessions through IPC to the main
process.

### How the page gets its Cast SDK

Electron has the Presentation API (`navigator.presentation`, `PresentationRequest`) but nothing behind it, so in
Electron Google's Cast SDK finds no devices. By default electron-cast fills in that missing piece: the page gets a
stand-in Presentation API backed by the main process, and **Google's own `cast_sender.js` and `cast.framework` load
and run unmodified**, as they do in Chrome. electron-cast never replaces Google's SDK.

A cast has to start from a user gesture (a click on the page's cast button), as in Chrome. As in Chrome, a session
belongs to the app rather than the page, so a page that reloads gets its session back through auto-join.

After the Electron app itself restarts, a session may still be playing on the device. As in Chrome, nothing is saved
for that and auto-join does not find it (Chrome's auto-join only joins sessions started by that browser run).
A page rejoins it only when it knows the session id, which Google's SDK exposes as `session.sessionId`: the page keeps
the id (in `localStorage`, say) and calls `chrome.cast.requestSessionById(id)` (or `cast.framework`'s equivalent) at
startup. electron-cast then asks the known devices which one runs that session and joins it if the app matches, with
no origin check, exactly as Chrome does. If the device no longer runs the session, the call fails like in Chrome.
`mode: "chromecast"` is unchanged and does not do this.

**Iframes (presentation mode only).** Google's SDK also works inside an iframe (an embedded player, say). As in Chrome,
each frame is its own controlling context: its availability watches, connections and sessions belong to that frame, its
events reach only that frame, and it can't read, close or message another frame's connections. The origin electron-cast
uses (for `allowOrigin`, the device picker and origin-scoped auto-join) is the sending frame's own, so a cross-origin
iframe is its own origin. An iframe that navigates parks its sessions as a reloading page does, and is left for good when
it is removed or its page navigates. Electron only runs a preload in subframes if the app opts in:

```js
new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, "preload.js"),
    sandbox: true,
    contextIsolation: true,
    nodeIntegrationInSubFrames: true,  // run the preload in iframes too
  },
});
```

Without `nodeIntegrationInSubFrames`, nothing changes: the preload runs only in the main frame, an iframe has no stand-in
and no cast, and its SDK finds no devices. With it, the preload (and so the cast bridge) runs in every iframe of every
origin, so keep `allowOrigin` strict. `nodeIntegration` stays `false`; Electron's docs describe the option as giving
preloads to every iframe, and the iframe's page still gets no Node, but not tested here with a sandbox, which this
project could not run live. `mode: "chromecast"` stays main-frame only: a call from an iframe is refused.

**Fallback: `mode: "chromecast"`.** This installs electron-cast's own implementation of `chrome.cast` and
`chrome.cast.media` and blocks Google's loader scripts. Use it for pages that call `chrome.cast` without loading
Google's script, or if Google's script ever stops working on the stand-in:

```ts
installCastBridge({ contextBridge, ipcRenderer, mode: "chromecast" });
```

The main process serves both modes. `createCastManager({ ..., presentation: false })` serves only `"chromecast"`.

## What works

- Device discovery over mDNS on every network interface, with devices coming and going live.
- Several pages or windows at once. A page that reloads keeps its sessions open on the device and rejoins them
  (auto-join, `origin_scoped` or `tab_and_origin_scoped`). A page that closes leaves its sessions without stopping
  playback.

**Default mode (Google's SDK):**

- Google's SDK gets what Chrome would give it: receiver availability, the device picker, sessions and joining them,
  messages on any namespace, volume, and media commands with their status replies.
- Tested end to end with YouTube Music (YouTube Music Desktop, Electron 45) casting to speaker groups, a Nest Hub
  and several Chromecasts, and with `cast.framework` on a Nest Hub: session start, volume, HLS load, play, pause,
  seek, resume and stop.

**`mode: "chromecast"`:**

- `chrome.cast.initialize`, `requestSession`, `session.stop`, `session.leave`, receiver availability, volume and
  mute, and messages on custom namespaces (`sendMessage` and `addMessageListener`).
- `chrome.cast.media`: load and queue media (`loadMedia`, `queueLoad`), control playback (play, pause, seek, stop,
  volume, tracks, queue operations), receive media status updates, and watch for media with media listeners.
- `cast.framework` (`CastContext`, `RemotePlayer`, `RemotePlayerController`) on top of the polyfill. Google's
  loader scripts are blocked so they can't overwrite it.
- Tested end to end with a Chromecast (YouTube Music), and with `cast.framework` media on a Nest Hub (load, play,
  pause, seek, volume, and stopping from the picker).

Discovery and connections are tested with Chromecast Ultra, Google Home Mini, Nest Hub, Nest Hub Max and speaker groups.

## Staying compatible with Google's SDK

In the default mode the page runs Google's SDK, which Google can change per Chrome major without an electron-cast
release. `npm run canary` (also a weekly GitHub Actions job) downloads the SDK for Chrome stable, beta and dev and for
the Chromium that Electron 45 ships, and checks as text, without running it, that it still uses the message types,
fields, request types and presentation URLs electron-cast translates. A missing one fails; a new message type is a
warning. `tools/sdk-canary-baseline.json` records what the SDK looked like when it last worked; refresh it with
`node tools/sdk-canary.mjs --update-baseline`. Options: `--majors 158,159`, `--electron <major>|none`.

## Lower layers

The package root exports every layer, if you want to use them without Electron:

- `CastDiscovery`: mDNS discovery of Cast devices.
- `CastClient`: a Cast v2 connection over TLS (connect, heartbeat, launch, stop, volume, app messages).
- `CastSessionService`: the session logic behind the Electron layer, with no Electron dependency.

See [docs/DESIGN.md](docs/DESIGN.md) for how the pieces fit.

## License

MIT
