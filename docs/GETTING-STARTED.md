# Getting started

A step-by-step setup of electron-cast in an Electron app, from install to a packaged build on Windows, macOS and Linux.

If you would rather read a working app first, [examples/electron-app](../examples/electron-app) is the same setup in
about 100 lines: a manager, a bundled sandboxed preload, and a page that loads Google's Cast SDK.

## 0. Before you start

- **Electron 35 or later.** The preload uses `contextBridge.executeInMainWorld`, added in Electron 35 (the preload
  fails on 34). Electron is an optional peer dependency: electron-cast never imports it, you pass `ipcMain`,
  `contextBridge` and `ipcRenderer` in.
- **Node 20 or later.** No native modules and no runtime dependencies, so there is nothing to rebuild per platform.
- **A page that uses Google's Cast sender SDK.** That is a site you load (YouTube Music, say) or your own page. electron-cast
  does not ship a cast button or UI; the SDK's `<google-cast-launcher>` is the button and you supply the device picker.
- **A Cast device on the same network** to try it. Without one the SDK's button stays hidden.

```sh
npm install electron-cast
```

The package ships an ES module build and a CommonJS build. `import` and `require` both work for every entry point
(`electron-cast/main`, `electron-cast/preload`, `electron-cast/polyfill` and the root).

## 1. The main process

Create one manager per app, before any window that should cast. It registers the IPC handlers and creates discovery;
nothing touches the network until you call `start()`.

```ts
import { app, ipcMain, Menu } from "electron";
import { createCastManager } from "electron-cast/main";

const cast = createCastManager({
  ipcMain,
  allowOrigin: (origin) => origin === "https://music.youtube.com",
  selectDevice: (devices) =>
    new Promise((resolve) => {
      let picked = false;
      Menu.buildFromTemplate(
        devices.map((d) => ({ label: d.name, sublabel: d.model, click: () => ((picked = true), resolve(d)) })),
      ).popup({ callback: () => setTimeout(() => picked || resolve(null), 100) });
    }),
});

app.whenReady().then(async () => {
  await cast.start();
  // create your windows
});
app.on("will-quit", () => void cast.dispose());
```

Three decisions are yours here:

- **Which pages may cast: `allowOrigin`.** It is checked on every call from a page, with the origin of the calling
  frame. Without it every page in a window that has the preload can cast. Compare exact origins, never `endsWith` or
  `includes` ([SECURITY.md](../SECURITY.md#alloworigin)). A page loaded from `file:` has an opaque origin that
  `allowOrigin` cannot name usefully; serve it over `http://127.0.0.1` or a custom standard scheme, as the example app
  does.
- **How the user picks a device: `selectDevice`.** Called when the page asks to start a session, with the devices that
  can serve the request. Resolve a `CastDevice`, `null` to cancel, or `"stop"` to stop the sender's current session.
  The menu above is the smallest possible picker; [Building your own device picker](guides/device-picker.md) shows a
  window with live updates.
- **When discovery runs.** `await cast.start()` opens an mDNS socket on each network interface, then, as in Chrome, a
  kept-open channel to each device found; a device is listed once its channel is open and authenticated, so the list
  fills in a few seconds after `start()`. Call it at startup, or later if casting is a setting that is off by default. `await cast.dispose()` stops everything and cannot be undone;
  create a new manager to turn casting back on.

Do not write a top-level `await app.whenReady()` in an ES module main process: on Electron 45 it never resolves
([why](TROUBLESHOOTING.md#the-app-hangs-at-top-level-await-appwhenready-electron-45)). Use `.then(...)` as above.

A CommonJS main works the same way:

```js
const { app, ipcMain } = require("electron");
const { createCastManager } = require("electron-cast/main");
```

## 2. The preload

The preload is the page's only way to reach the main process. Call `installCastBridge` once:

```ts
import { contextBridge, ipcRenderer } from "electron";
import { installCastBridge } from "electron-cast/preload";

installCastBridge({ contextBridge, ipcRenderer });
```

It exposes a small bridge object to the page's main world and, before the page's scripts run, installs a stand-in
Presentation API (`PresentationRequest`, `PresentationConnection`, `PresentationAvailability`,
`navigator.presentation`) backed by that bridge. Google's `cast_sender.js` then finds what it finds in Chrome.

Three rules:

1. **Import `electron-cast/preload`, never the package root.** The root also exports the main-process code, which needs
   Node's `tls` and `dgram`; a sandboxed preload cannot load those.
2. **Bundle the preload if it is sandboxed.** A sandboxed preload can `require` only a few built-in modules
   (`electron`, `events`, `timers`, `url`) and cannot load other files, so `import "electron-cast/preload"` has to be
   inlined into your preload file. esbuild does it in one command; leave `electron` external:

   ```sh
   esbuild preload.ts --bundle --platform=node --format=cjs --external:electron --outfile=preload.bundle.cjs
   ```

   The repository's [smoke/build-preloads.mjs](../smoke/build-preloads.mjs) and the example app's `build:preload` script
   do the same.
3. **A non-sandboxed CommonJS preload can `require("electron-cast/preload")` directly.** The package ships a CommonJS
   build for that.

## 3. The page

The page loads Google's SDK exactly as it would in Chrome. There is nothing to import from electron-cast:

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

Casting starts from a user gesture, as in Chrome: the click on the launcher. The preload reads
`navigator.userActivation.isActive` itself when the page asks to start, and the main process refuses a start without it
([SECURITY.md](../SECURITY.md#user-gesture)). Loading media afterwards needs no gesture.

## 4. Window settings

```ts
import { BrowserWindow } from "electron";

const win = new BrowserWindow({
  webPreferences: {
    preload: "/absolute/path/to/preload.bundle.cjs",
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
  },
});
```

- **`sandbox: true` and `contextIsolation: true` are supported and recommended.** The page never gets Node, sockets or an
  IPC handle; it only sees the Presentation API stand-in and a bridge object. `contextIsolation: false` is not a
  configuration electron-cast is designed for: it uses `contextBridge`, which needs isolation.
- **Install the preload only in windows and views that show pages that should cast.** A window without the preload has
  no way to reach the IPC channels.
- **`nodeIntegrationInSubFrames: true` makes it work in iframes.** Electron runs a preload in subframes only if the app
  opts in. With it, the preload (and so the cast bridge) runs in every iframe of every origin, so keep `allowOrigin`
  strict. `nodeIntegration` stays `false`, so an iframe's page still gets no Node. Without it nothing changes: the
  preload runs only in the main frame and an iframe's SDK finds no devices. See
  [Multiple windows and iframes](guides/windows-and-iframes.md).
- **`BrowserView` and `WebContentsView` work like a window** as long as the preload is in their `webPreferences` and
  `allowOrigin` names the page they show. The library only needs `webContents`, which they all have.

## 5. Content Security Policy

electron-cast adds no `<script>` element and no inline script to your page: the preload installs the stand-in with
`contextBridge.executeInMainWorld`. What your CSP has to allow is Google's SDK, which loads from `www.gstatic.com`
(the loader at `/cv/js/sender/v1/cast_sender.js`, then the Presentation API based SDK from `/eureka/clank/<chrome
major>/` and `cast_framework.js`). The example app's page uses

```
default-src 'self'; script-src 'self' https://www.gstatic.com http://www.gstatic.com;
style-src 'self' 'unsafe-inline'; img-src * data:; connect-src *; media-src *; frame-src *
```

and works. That policy is permissive on purpose, and it has not been reduced to a minimum. Google's SDK pulls in scripts
over `http` as well as `https` (the example lists both), and the launcher and receiver icons come from other hosts. Tighten
it for your site, test with a real device, and expect to find a few more hosts. A site you do not control (YouTube Music)
already has its own CSP, and casting works with it.

## 6. Run it

Start the app and open the page. The launcher appears when a device that has the page's receiver app is listed, a few
seconds after `start()`. Click it, pick a device from
your `selectDevice`, and the receiver app launches. For the first run, the default media receiver (`CC1AD845`, the
`DEFAULT_MEDIA_RECEIVER_APP_ID` above) plays any media URL the device can reach; see
[Custom receivers](guides/custom-receivers.md).

If nothing shows, the [troubleshooting guide](TROUBLESHOOTING.md#no-devices-found) has the checks in order, starting with a
three-line script that lists what discovery sees.

## 7. Packaging

electron-cast is plain JavaScript, so it packs like any dependency: inside an ASAR archive, with no `asarUnpack` entry and
nothing to rebuild per platform. The OS decides whether the packaged app may use the local network.

### Windows

Windows Defender Firewall may ask the first time the app opens a UDP socket. If the user denies it, discovery finds
nothing. The fix is Windows Security, Firewall, "Allow an app through firewall", with the app ticked for the network
profile in use (a network classified Public is the usual blocker; see
[Troubleshooting](TROUBLESHOOTING.md#windows)). An installer can add a rule instead, with administrator rights:

```
netsh advfirewall firewall add rule name="MyApp mDNS" dir=in action=allow program="C:\Program Files\MyApp\MyApp.exe" protocol=UDP localport=5353 profile=private
```

Windows is the platform casting was tested end to end on, in a packaged build.

### macOS

**Not tested by the author.** CI loads the package in a real Electron on macOS with a fake device, so the code runs; no
real device has been discovered from a Mac. What follows is Apple's documented requirement for local network access,
which you should verify with a packaged, signed build on a real network.

macOS 15 and later show a Local Network privacy prompt, and Apple asks apps that browse Bonjour services to declare them
in `Info.plist`. Declare Cast's service type and a usage string:

```xml
<key>NSLocalNetworkUsageDescription</key>
<string>MyApp finds Chromecast devices on your network so you can cast to them.</string>
<key>NSBonjourServices</key>
<array>
  <string>_googlecast._tcp</string>
</array>
```

With electron-builder these go in `mac.extendInfo`; with Electron Forge in `packagerConfig.extendInfo`; with
`@electron/packager` in the `extendInfo` option. electron-cast uses its own UDP multicast socket on port 5353 rather than
the system's Bonjour browser. Whether macOS requires anything beyond the keys above for that is the open question; if
discovery finds nothing in a packaged build, check System Settings, Privacy and Security, Local Network for your app,
and report what you find.

### Linux

No special packaging. `.deb`, `.rpm`, AppImage and Snap all work as far as electron-cast is concerned, except where the
package format confines network access (a confined Snap or Flatpak needs network permissions for multicast; that is
your package's policy, not the library's).

**Coexisting with avahi.** electron-cast binds UDP 5353 with address reuse, which is how a second mDNS client shares the
port with `avahi-daemon` or `systemd-resolved`. If that bind fails it falls back to a socket on an ephemeral port that
receives unicast replies (mDNS "legacy unicast"). electron-cast only asks: it never advertises and never answers mDNS queries. Discovery, device authentication and casting end to end were tested from
Ubuntu under WSL2 with mirrored networking (see [Platforms](../README.md#platforms-and-what-was-tested)); they were not
tested next to a running `avahi-daemon`. If a host firewall (`ufw`, `firewalld`) drops inbound multicast, devices will not
appear; [Troubleshooting](TROUBLESHOOTING.md#linux) lists the commands.

## Next

- [Guides](guides/index.md): a custom picker, restart rejoin, iframes, custom receivers, testing your app.
- [API reference](API.md): every option and type.
- [Troubleshooting](TROUBLESHOOTING.md) when something does not work.
