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
- **Discovery and device tracking as in Chrome's Media Router.** mDNS (`_googlecast._tcp`) on every network
  interface, IPv4 and IPv6, then a kept-open channel to each device found. A device is listed once that channel is open
  and authenticated, so the list fills in a few seconds after `start()`; it stays through mDNS silence and recovers
  after sleep.
- **DIAL next to Cast**, as Chrome runs both: SSDP discovery, availability, the picker and launch over HTTP for the
  `cast-dial:` sources Google's SDK adds for a `dialRequest`. On by default; `dial: false` turns it off.
- **Device authentication** as Chrome does it: a device is listed only after it proves it is a Google-certified Cast
  device, with Google's Cast roots built in ([details](docs/guides/device-authentication.md)).
- **Sessions the Chrome way:** auto-join after a reload, rejoin after an app restart by session id, several windows,
  and iframes.
- **A picker hook, not a picker.** You decide which pages may cast and show whatever UI you like
  ([guide](docs/guides/device-picker.md)).
- **A main-process API** modelled on Chrome's Media Router: observe devices (sinks) and sessions (routes), including
  sessions other senders started; stop or detach a session, set its volume; play, pause and seek its media; and start
  a cast from your own menu on the page's default presentation request ([docs](docs/MAIN-API.md)).
- **Every layer is exported** if you want them without Electron: `CastDiscovery`, `CastClient` and the protocol code
  run in plain Node ([guide](docs/guides/low-level-client.md)).
- **Documented against Chromium.** Where electron-cast copies a rule, the code and docs name the Chromium source it
  comes from ([map](docs/CHROMIUM-MAP.md)).

## Chrome parity

electron-cast does what Chrome does on the Presentation API path. Where it does not yet, or never will, this says so.

| Feature | Chrome | electron-cast | Notes |
|---|---|---|---|
| Google's Cast sender SDK on the page (`chrome.cast`, `cast.framework`) | Yes | Yes | Unmodified, over a stand-in Presentation API |
| Device discovery (mDNS `_googlecast._tcp`) | Yes | Yes | IPv4 on every interface, IPv6 link-local per adapter. IPv6 discovery verified on real devices |
| Devices listed once their channel is open and authenticated, kept open, retried, reopened after a failure | Yes | Yes | Chrome's delays and backoff (`CastMediaSinkServiceImpl`); the list fills in a few seconds after `start()` |
| No channel to a publicly routable or loopback address | Yes (unless `MediaRouterCastAllowAllIPs`) | Yes (unless `sinks.allowAllIps`) | Checked on the address a channel is opened to, when it is opened |
| Device picker | Chrome's dialog | Your UI through `selectDevice` | By design: the app owns the UI |
| Device authentication | Yes | Yes | A port of Chromium's checks, verified on real devices over IPv4, IPv6 unique-local and IPv6 link-local. One deliberate difference: a stale built-in fallback CRL skips revocation instead of refusing ([why](SECURITY.md#tls-and-device-authentication)) |
| App availability (`GET_APP_AVAILABILITY`) for a page's `getAvailability()` and the devices its `start()` offers | Yes | Yes | Asked over the open channels, with Chrome's refresh rules. `mode: "chromecast"` still goes by capabilities |
| Start requires a user gesture | Checked in the browser process | Checked by the preload in the renderer | Electron has no main-process API for it ([SECURITY.md](SECURITY.md#user-gesture)) |
| Sessions: launch an app, app messages, media commands, volume, stop | Yes | Yes | |
| Auto-join after a reload (`origin_scoped`, `tab_and_origin_scoped`) | Yes | Yes | |
| Rejoin a session after the browser or app restarts, by id | Yes (`reconnect("cast-session_<id>")`) | Yes | The app stores the session id ([guide](docs/guides/restart-rejoin.md)); the session tracker knows which device runs it |
| Several windows | Yes | Yes | |
| Iframes (each frame is its own sender) | Yes | Yes | Needs `nodeIntegrationInSubFrames: true`. Unit tests only so far |
| Audio-only devices and speaker groups | Yes | Yes | Tested on a Google Home Mini and two groups |
| Observe sinks and routes, stop a route, set volume from the app | Internal | Yes ([MAIN-API](docs/MAIN-API.md)) | Modelled on `MediaRouter` |
| Media control of a route from the app (play, pause, seek, tracks, volume, media status) | Internal (`MediaController`) | Yes (`getMediaController`) | Fed by the session tracker, as `CastMediaController` is; works on non-local routes too |
| Sessions started by other senders listed as routes (non-local routes), tracked live | Yes | Yes | From each device's receiver status (`CastSessionTracker`) |
| App-initiated casting through the page's default presentation request (`connectionavailable`) | Yes | Yes (`startCasting`) | The app's menu or tray plays Chrome's Cast dialog ([MAIN-API](docs/MAIN-API.md#casting-from-the-apps-own-ui)) |
| Global Media Controls (the toolbar's media and Cast panel) | Browser UI | Out of scope: the app builds its own | Chrome's panel lists the routes and controls them ([`cast_media_notification_producer.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/global_media_controls/cast_media_notification_producer.cc), [`cast_media_notification_item.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/ui/global_media_controls/cast_media_notification_item.cc)); the same calls are here: `registerMediaRoutesObserver` or `getRoutes`, `getMediaController`, `terminateRoute` |
| DIAL discovery and launch (`cast-dial:` sources from the SDK's `dialRequest`) | Yes | Yes | SSDP, availability, the picker, launch and stop over HTTP ([DESIGN](docs/DESIGN.md#dial-srcdial)). A device that is also a Cast sink is listed as Cast only, as in Chrome; a DIAL-only device gets a Cast channel opened to port 8009 and is a Cast sink if that works, as in Chrome (`TryConnectDialDiscoveredSink`), and is left a DIAL sink after ten failed attempts. `dial: false` turns it off. Unit tests only so far |
| Tab, desktop and file mirroring | Yes | In progress | Mirroring sources are reported unavailable until then |
| Remote Playback API (`video.remote`) | Yes | Not done: needs Electron | Blink's `RemotePlayback` needs support in Electron; electron-cast reports `remote-playback:` sources unavailable |
| Wired display (presenting to a second monitor) and the Presentation Receiver API | Yes | In progress (`feat/wired-display`) | |
| Access-code casting | Yes | Under study (`feat/access-code`) | |
| `mode: "chromecast"`, a legacy `chrome.cast` polyfill | n/a | Frozen | Gets no new features; use the default mode ([notes](docs/FAQ.md#what-is-mode-chromecast)) |

## Platforms and what was tested

Say what was run, not what should work.

| | Discovery and device authentication | Casting end to end | Notes |
|---|---|---|---|
| Windows 11 | 8 real devices, all passed | Session, playback, restart rejoin and stop, on real devices, in an Electron 45 app (dev and packaged builds) | The devices: Chromecast, Chromecast Ultra, Google Home Mini (audio-only), Nest Hub, Nest Hub Max and two Cast groups |
| Linux | All 8 devices passed on 2026-11-25 (Ubuntu under WSL2 with mirrored networking) | Session, playback, rejoin after a force-kill and stop, on real devices, in an Electron 45 app (Ubuntu under WSL2, dev and packaged builds) | |
| macOS | Not tested | Not tested | CI loads the package in a real Electron on macOS with a fake device and no real network |

The end-to-end runs were an Electron 45 app loading YouTube Music, casting to speaker groups, a Nest Hub and several
Chromecasts, and `cast.framework` on a Nest Hub: session start, volume, HLS load, play, pause, seek, resume and stop.

Electron: the CI smoke test loads the built package in a real Electron 35, 40 and the latest stable on Linux, Windows
and macOS. Its network is faked: no real device. Real-device runs used Electron 45. Electron 35 is the oldest supported
(the preload needs `contextBridge.executeInMainWorld`). Node 20 or later.

IPv6 discovery, and the Cast channel with TLS and device authentication over IPv6 unique-local (ULA) and link-local
addresses, were verified on real devices. Iframes are covered by unit tests only; the smoke test does not load an iframe.

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
