# electron-cast

Chrome's Cast support for Electron: pages run Google's own, unmodified Cast SDK, and your main process supplies the
Media Router that Electron lacks.

Electron has the Presentation API but nothing behind it, and electron/electron#869 (a Media Router for Electron) was
closed in 2025 with no plans to add one. electron-cast fills that gap from scratch: a stand-in Presentation API in the
page, and in the main process mDNS discovery, a device picker hook, the Cast v2 channel, device authentication with
Chrome's certificate checks, and the message envelope Chrome's Media Router speaks to the SDK. A site's own cast
button (YouTube Music's, for example) works unchanged. No native modules, no runtime dependencies, and it works with
`sandbox: true` and `contextIsolation: true`.

```sh
npm install electron-cast
```

- [Getting started](docs/GETTING-STARTED.md): from zero to casting, with packaging notes for each OS.
- [Guides](docs/guides/index.md): a device picker, restart rejoin, iframes, custom receivers, testing.
- [API reference](docs/API.md), [main-process API](docs/MAIN-API.md), [architecture](docs/ARCHITECTURE.md),
  [troubleshooting](docs/TROUBLESHOOTING.md), [FAQ](docs/FAQ.md), [security](SECURITY.md), [changelog](CHANGELOG.md).

## Quick start

Four small pieces. Needs Electron 35 or later and Node 20 or later.

**1. Main process.** Create one manager, say which pages may cast, and show a picker when the page asks:

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

// Not a top-level `await app.whenReady()`: see the Electron 45 note in docs/TROUBLESHOOTING.md.
app.whenReady().then(async () => {
  await cast.start();
  // create your windows here
});
app.on("will-quit", () => void cast.dispose());
```

**2. Preload** of the window or view that shows the page:

```ts
import { contextBridge, ipcRenderer } from "electron";
import { installCastBridge } from "electron-cast/preload";

installCastBridge({ contextBridge, ipcRenderer });
```

A sandboxed preload cannot load other files, so bundle it (esbuild, for example). Import from `electron-cast/preload`,
not the package root, which needs Node's `tls` and `dgram`. Why and how: [Getting started](docs/GETTING-STARTED.md#2-the-preload).

**3. The page** loads Google's Cast SDK as it would in Chrome. Nothing electron-cast specific:

```html
<google-cast-launcher></google-cast-launcher>
<script>
  window.__onGCastApiAvailable = (available) => {
    if (!available) return;
    cast.framework.CastContext.getInstance().setOptions({
      receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
  };
</script>
<script src="https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1"></script>
```

**4. Run it.** The [example app](examples/electron-app) is exactly this, runnable: clone the repository, then

```sh
npm install && npm run build
cd examples/electron-app && npm install && npm start
```

Click the cast button, pick a device, then "Play sample video". With no Cast device on the network the button stays
hidden.

## What you get

- **Google's own SDK, unmodified.** The page's `cast_sender.js` and `cast.framework` run as in Chrome. electron-cast
  never replaces them.
- **Discovery** over mDNS (`_googlecast._tcp`) on every network interface, IPv4 and IPv6 link-local, with devices
  coming and going live and recovery after sleep.
- **Device authentication** as Chrome does it: a device is used only after it proves it is a Google-certified Cast
  device, with Google's Cast roots built in ([details](docs/guides/device-authentication.md)).
- **Sessions the Chrome way:** auto-join after a reload, rejoin after an app restart by session id, several windows,
  and iframes.
- **A picker hook, not a picker.** You decide which pages may cast and show whatever UI you like
  ([guide](docs/guides/device-picker.md)).
- **A main-process API** modelled on Chrome's Media Router: observe devices (sinks) and sessions (routes), stop or
  detach a session, set its volume ([docs](docs/MAIN-API.md)).
- **Every layer is exported** if you want them without Electron: `CastDiscovery`, `CastClient` and the protocol code
  run in plain Node ([guide](docs/guides/low-level-client.md)).
- **Documented against Chromium.** Where electron-cast copies a rule, the code and docs name the Chromium source it
  comes from ([map](docs/CHROMIUM-MAP.md)).

## Chrome parity

electron-cast does what Chrome does on the Presentation API path. Where it does not yet, or never will, this says so.

| Feature | Chrome | electron-cast | Notes |
|---|---|---|---|
| Google's Cast sender SDK on the page (`chrome.cast`, `cast.framework`) | Yes | Yes | Unmodified, over a stand-in Presentation API |
| Device discovery (mDNS `_googlecast._tcp`) | Yes | Yes | IPv4 on every interface, IPv6 link-local per adapter. IPv6 is covered by unit tests only so far |
| Device picker | Chrome's dialog | Your UI through `selectDevice` | By design: the app owns the UI |
| Device authentication | Yes | Yes | A port of Chromium's checks. One deliberate difference: a stale built-in fallback CRL skips revocation instead of refusing ([why](SECURITY.md#tls-and-device-authentication)) |
| Start requires a user gesture | Checked in the browser process | Checked by the preload in the renderer | Electron has no main-process API for it ([SECURITY.md](SECURITY.md#user-gesture)) |
| Sessions: launch an app, app messages, media commands, volume, stop | Yes | Yes | |
| Auto-join after a reload (`origin_scoped`, `tab_and_origin_scoped`) | Yes | Yes | |
| Rejoin a session after the browser or app restarts, by id | Yes (`reconnect("cast-session_<id>")`) | Yes | The app stores the session id ([guide](docs/guides/restart-rejoin.md)). The lookup runs on request; Chrome tracks continuously |
| Several windows | Yes | Yes | |
| Iframes (each frame is its own sender) | Yes | Yes | Needs `nodeIntegrationInSubFrames: true`. Unit tests only so far |
| Audio-only devices and speaker groups | Yes | Yes | Tested on a Google Home Mini and two groups |
| Observe sinks and routes, stop a route, set volume from the app | Internal | Yes ([MAIN-API](docs/MAIN-API.md)) | Modelled on `MediaRouter`; no play, pause or seek from main |
| Sessions started by other senders listed as routes (non-local routes) | Yes | In progress | |
| App-initiated casting through the page's default presentation request (`connectionavailable`) | Yes | In progress | |
| DIAL discovery and launch | Yes | In progress | |
| Tab, desktop and file mirroring | Yes | No | Not implemented |
| Remote Playback API (`video.remote`) | Yes | No | Not implemented |
| Cast from Chrome's media controls UI | Yes | No | The app has its own UI |
| `mode: "chromecast"`, a legacy `chrome.cast` polyfill | n/a | Frozen | Gets no new features; use the default mode ([notes](docs/FAQ.md#what-is-mode-chromecast)) |

## Platforms and what was tested

Say what was run, not what should work.

| | Discovery and device authentication | Casting end to end | Notes |
|---|---|---|---|
| Windows 11 | 8 real devices, all passed | Session, playback, restart rejoin and stop, on real devices, in YouTube Music Desktop (dev and packaged builds, Electron 45) | The devices: Chromecast, Chromecast Ultra, Google Home Mini (audio-only), Nest Hub, Nest Hub Max and two Cast groups |
| Linux | All 8 devices passed on 2026-11-25 (Ubuntu under WSL2 with mirrored networking) | Not tested | |
| macOS | Not tested | Not tested | CI loads the package in a real Electron on macOS with a fake device and no real network |

The end-to-end runs were YouTube Music (YouTube Music Desktop) casting to speaker groups, a Nest Hub and several
Chromecasts, and `cast.framework` on a Nest Hub: session start, volume, HLS load, play, pause, seek, resume and stop.

Electron: the CI smoke test loads the built package in a real Electron 35, 40 and the latest stable on Linux, Windows
and macOS. Its network is faked: no real device. Real-device runs used Electron 45. Electron 35 is the oldest supported
(the preload needs `contextBridge.executeInMainWorld`). Node 20 or later.

Iframes and IPv6 are covered by unit tests only. The smoke test does not load an iframe.

## Staying compatible with Google's SDK

The page runs Google's SDK, which Google can change per Chrome major without an electron-cast release. `npm run canary`
(also a weekly GitHub Actions job) downloads the SDK for Chrome stable, beta and dev and for the Chromium that
Electron 45 ships, and checks as text, without running it, that it still uses the message types, fields, request
types and presentation URLs electron-cast translates. See [CONTRIBUTING.md](CONTRIBUTING.md#the-sdk-canary).

## Known issue: top-level `await app.whenReady()` on Electron 45

In an ES module main process, a top-level `await app.whenReady()` never resolves on Electron 45 (reproduced on 45.5.0
on Windows). It is Electron's ESM startup, not electron-cast. Use `app.whenReady().then(...)`, as above.
[Details](docs/TROUBLESHOOTING.md#the-app-hangs-at-top-level-await-appwhenready-electron-45).

## Documentation

| | |
|---|---|
| [Getting started](docs/GETTING-STARTED.md) | Main, preload, sandboxing, CSP, iframes, packaging per OS |
| [Guides](docs/guides/index.md) | Recipes: picker, restart rejoin, windows and iframes, custom receivers, audio devices, device authentication, low-level client, testing |
| [Troubleshooting](docs/TROUBLESHOOTING.md) and [FAQ](docs/FAQ.md) | No devices, auth failures, hangs, dropped sessions, with commands |
| [API reference](docs/API.md) and [main-process API](docs/MAIN-API.md) | Every export |
| [Architecture](docs/ARCHITECTURE.md), [design](docs/DESIGN.md), [Chromium map](docs/CHROMIUM-MAP.md) | How it works and which Chromium code it mirrors |
| [Security](SECURITY.md) | Threat model, what crosses IPC, how to report a vulnerability |
| [Contributing](CONTRIBUTING.md) | Setup, tests, the Chrome rule, releases |

## License

MIT
