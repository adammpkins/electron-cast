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

Requires Electron 35 or later (for `contextBridge.executeInMainWorld`; the preload fails on 34). Electron is an
optional peer dependency (`electron >=35`): the library never imports it, you pass `ipcMain`, `contextBridge` and
`ipcRenderer` in. Node 20 or later. The package ships ES modules and a CommonJS build, so `import` and `require` both
work. CI loads the built package in a real Electron 35, 40 and the latest stable on Linux, Windows and macOS
(`npm run smoke` runs it locally once you have installed Electron).

electron-cast behaves as Chrome does on the Presentation API path, which is the default; `mode: "chromecast"` is a
frozen fallback (see below).

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

A cast has to start from a user gesture (a click on the page's cast button), as in Chrome. Chrome checks that in the
browser process; Electron has no main-process API for it, so the preload reads `navigator.userActivation.isActive` in
its own isolated world when the page asks to start, and the main process refuses a start without it. A page's scripts
cannot forge that, a compromised renderer could (see [SECURITY.md](SECURITY.md#user-gesture)). `mode: "chromecast"` has
no gesture check.

**Reloads and restarts.** As in Chrome, a session belongs to the app rather than the page, so a page that reloads gets
its session back through auto-join.

After the Electron app itself restarts, a session may still be playing on the device. electron-cast saves nothing for
that, and auto-join does not find it (Chrome's auto-join only joins sessions started by that browser run). The app
persists the session id and the page reconnects with it: Google's SDK exposes the id as `session.sessionId`, so the page
keeps it (in `localStorage`, say) and calls `chrome.cast.requestSessionById(id)` (or `cast.framework`'s equivalent) at
startup. The SDK turns that into `PresentationRequest.reconnect("cast-session_<id>")`, which reaches electron-cast's
`joinRunningSession`: it looks the session up among what the devices run (electron-cast follows every device's receiver status, as Chrome does) and joins it if the app matches, with no
origin check (Chrome's `AppActivity::CanJoinSession` checks only the app id and that the client is not already
connected), also when this run already holds the session; `allowOrigin` still applies first. If the device no longer
runs the session, the call fails like in Chrome. Discovery has to have found the device by then, so the page may need
to retry for a few seconds after startup. `mode: "chromecast"` does not do this.

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
origin, so keep `allowOrigin` strict. `nodeIntegration` stays `false`, so an iframe's page still gets no Node. The
frame handling is covered by unit tests against fake frames; the real-Electron smoke test does not load an iframe.
`mode: "chromecast"` stays main-frame only: a call from an iframe is refused.

**Fallback: `mode: "chromecast"`.** This installs electron-cast's own implementation of `chrome.cast` and
`chrome.cast.media` and blocks Google's loader scripts. Use it for pages that call `chrome.cast` without loading
Google's script, or if Google's script ever stops working on the stand-in:

```ts
installCastBridge({ contextBridge, ipcRenderer, mode: "chromecast" });
```

The main process serves both modes. `createCastManager({ ..., presentation: false })` serves only `"chromecast"`.

## Device authentication

Like Chrome, electron-cast checks that a device is a genuine Google-certified Cast device before using it (the
`deviceauth` challenge, with Google's Cast root certificates built in and no dependencies). Like Chrome,
electron-cast opens a channel to every device it finds, and a device is listed (in the picker, `devices()` and the
sinks observers) only once that channel is open and the check has passed, so a device that fails is never shown.

On by default; receivers that are not Google-certified (open-source ones, for example) need it off:

```js
createCastManager({ ipcMain, selectDevice, verifyDevices: false });   // CastClient: { verifyDevice: false }
```

A device that fails makes `CastClient.connect()` reject with a `CastAuthError` whose `reason` says why (for example
`untrusted_chain` or `revoked`). With the default client, `client.deviceAuth` holds what was established.

Like Chrome's own built-in security data, the built-in fallback CRL goes stale: it counts for 20 weeks from the build
time stamped by `npm run build`. A device that sends no CRL of its own is then accepted without a revocation check
(`deviceAuth.revocationChecked` is `false`) instead of refused. Everything else is still checked; update the package
to get a fresh fallback CRL. Details: [docs/DESIGN.md](docs/DESIGN.md) and [SECURITY.md](SECURITY.md).

Tested on 8 real devices on a home network, which all passed (an audio-only Google Home Mini got the `audio_only`
policy). How it works and what it leaves out: [docs/DESIGN.md](docs/DESIGN.md).

## Known issue: top-level `await app.whenReady()` in an ESM main process

In an ES module main process (`"type": "module"`, or an `.mjs` main), a top-level `await app.whenReady()` never
resolves on Electron 45 (reproduced on 45.5.0 on Windows): the app logs the line before it and then hangs. It is
Electron's ESM startup, not electron-cast. Use `app.whenReady().then(...)` or put the work in a function that is not
awaited at the top level:

```js
app.whenReady().then(async () => {
  await cast.start();
  // create windows
});
```

Related report: [electron/electron#40719](https://github.com/electron/electron/issues/40719) (closed; a comment
there describes the top-level await form of the same hang).

## What works

- Device discovery over mDNS on every IPv4 network interface and over IPv6 link-local on each adapter, with devices
  coming and going live. A network that goes away takes its devices with it, and discovery recovers after the machine
  wakes from sleep.
- Devices are verified as genuine Google-certified Cast devices, as Chrome does (on by default, see above).
- Several pages or windows at once, and iframes (with `nodeIntegrationInSubFrames`). A page that reloads keeps its
  sessions open on the device and rejoins them (auto-join, `origin_scoped` or `tab_and_origin_scoped`). A page that
  closes leaves its sessions without stopping playback. After an app restart a page rejoins a session by id (above).
- Devices that mDNS does not reach, added by address as Chrome's access code casting adds them: `addSinkByAddress` opens a
  channel to a device the app knows and lists it for a set time. Resolving the code the device shows is Google's service and
  is not included ([why](docs/DESIGN.md#access-code-casting-access-codets)).
- A main-process API modelled on Chrome's Media Router: observe devices and sessions, stop or detach a session, set
  its volume, and keep a picker up to date while it is open ([docs/MAIN-API.md](docs/MAIN-API.md)).

**Default mode (Google's SDK):**

- Google's SDK gets what Chrome would give it: receiver availability, the device picker, sessions and joining them
  (including by id after a restart), messages on any namespace, volume, and media commands with their status replies.
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

- `CastDiscovery`: mDNS discovery of Cast devices (IPv4 and IPv6).
- `CastClient`: a Cast v2 connection over TLS (device authentication, connect, heartbeat, launch, stop, volume, app
  messages).
- `CastSessionService`: the session logic behind the Electron layer, with no Electron dependency.

See [docs/DESIGN.md](docs/DESIGN.md) for how the pieces fit.

To observe and control casting from the main process (devices, sessions, volume, a live picker), see [docs/MAIN-API.md](docs/MAIN-API.md).
More docs: [API reference](docs/API.md), [security notes](SECURITY.md), [changelog](CHANGELOG.md) and a
[runnable example app](examples/electron-app).

## License

MIT
