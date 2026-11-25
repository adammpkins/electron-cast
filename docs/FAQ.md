# FAQ

Short answers to the questions people ask first, with links to the page that has the detail.

## What is electron-cast, in one paragraph?

Chrome can cast because it has a Media Router behind the Presentation API. Electron has the API but no router, so Google's Cast
sender SDK finds no devices. electron-cast supplies the missing router: a stand-in Presentation API in the page, and in your main
process mDNS discovery, a picker hook, the Cast v2 channel, device authentication and the message envelope Chrome's Media Router
speaks to the SDK. The page runs Google's own, unmodified SDK. [Architecture](ARCHITECTURE.md) draws it.

## Does the page need electron-cast code or a special SDK?

No. The page loads Google's `cast_sender.js` from `www.gstatic.com` as it would in Chrome. electron-cast never replaces or bundles
Google's SDK; it only provides what the SDK expects to find. That also means the SDK needs internet access, and your
[CSP](GETTING-STARTED.md#5-content-security-policy) has to allow it.

## Does it only work for YouTube Music?

No, and nothing YouTube-specific is in the library. Casting was tested end to end in an Electron 45 app that loads
YouTube Music; the example app casts to the Default Media Receiver from its own page. Any page that uses Google's Cast
SDK should work ([custom receivers](guides/custom-receivers.md)); what has been tested is stated in the [README](../README.md#platforms-and-what-was-tested).

## Which Electron, Node and operating systems?

Electron 35 or later (the preload needs `contextBridge.executeInMainWorld`), Node 20 or later. Real devices have been used end
to end from Windows and from Linux (Ubuntu under WSL2 with mirrored networking), with Electron 45: casting, rejoin after the app
was force-killed, and stop, in dev and packaged builds. macOS has not been tried against a real device. The [README](../README.md#platforms-and-what-was-tested) lists exactly what was
run.

## Does it work with `sandbox: true` and `contextIsolation: true`?

Yes, that is the supported configuration. The page never gets Node, sockets or an IPC handle. A sandboxed preload cannot load
other files, so you have to bundle `electron-cast/preload` into it ([how](GETTING-STARTED.md#2-the-preload)).

## What network access does it use?

Multicast DNS queries on your local networks (UDP 5353) to find devices, and, as in Chrome, one TLS connection (usually port 8009)
to each device found at a private or link-local address, kept open with a ping every 5 s, so the device can be authenticated
before it is listed and its sessions followed. Device authentication needs no network: Google's Cast roots and a fallback revocation list ship in the package. It
makes no other connection, advertises nothing, and answers no queries. `manager.start()` is what opens the sockets; nothing
happens before it. See [SECURITY.md](../SECURITY.md#mdns-exposure).

## Can I start a cast from my app's menu or tray?

Yes, the way Chrome's Cast dialog does it: when the page has set `navigator.presentation.defaultRequest`, the app calls
`manager.startCasting(sinkId, { webContentsId })` from its menu or tray, with no picker and no user gesture, and the page gets
`connectionavailable` (Google's SDK adopts the session). A page that sets no default request has nothing to start; tell it to
press its own Cast button instead. See the [main-process API](MAIN-API.md#casting-from-the-apps-own-ui).

## Can I control playback (play, pause, seek) from the main process?

Yes. `manager.getMediaController(routeId, observer?)` is Chrome's `MediaController` for a route: `play`, `pause`, `seek`,
`nextTrack`, `previousTrack`, `setVolume`, `setMute`, and the media status (title, play state, position, what the media can do).
It works on sessions other senders started too. That is also how to build your own version of Chrome's toolbar media panel
(Global Media Controls, browser UI that electron-cast leaves to the app): `registerMediaRoutesObserver` for the list,
`getMediaController` for each route, `terminateRoute` for Stop. See [MAIN-API](MAIN-API.md#media-control).

## Can it mirror a tab or the desktop?

Not yet. Mirroring is in progress; until it lands, a mirroring source is reported unavailable. The Remote Playback API
(`video.remote`) needs support in Electron itself, so `remote-playback:` sources are reported unavailable. See the
[parity table](../README.md#chrome-parity).

## Why is the device list empty right after `start()`?

As in Chrome, a device is listed only once a channel to it is open and has passed device authentication. Channels open after a
random delay of up to 5 s, and the list is reported once it has been quiet for 3 s, so it fills in a few seconds after
`start()`. A device that is not Google-certified, or has been revoked, is never listed. A picker that
[updates live](guides/device-picker.md#a-picker-window-with-live-updates) shows devices as they come. See [Device authentication](guides/device-authentication.md).

## The app restarted and the cast was still playing. Why did it not come back by itself?

Like Chrome, auto-join only joins sessions this run started. The session is listed as a non-local route as soon as its device's
channel is open, but the page has to ask for it: after a restart the app gives the page the old session id and the page calls
`chrome.cast.requestSessionById`. [Recipe](guides/restart-rejoin.md), with a worked example.

## What is `mode: "chromecast"`?

The original design, kept as a **frozen** fallback: electron-cast's own implementation of `chrome.cast`, `chrome.cast.media` and
`cast.framework`, which blocks Google's loader scripts so they cannot replace it. It gets no new features and is not recommended
for new code. Use it only for a page that calls `chrome.cast` without loading Google's script, or if Google's script ever stops
working on the stand-in.

```ts
import { contextBridge, ipcRenderer } from "electron";
import { installCastBridge } from "electron-cast/preload";

installCastBridge({ contextBridge, ipcRenderer, mode: "chromecast" });
```

How it differs from the default: no user-gesture check, main frame only (a call from an iframe is refused), no rejoin by id after a
restart, and its errors are `chrome.cast.ErrorCode` values. It was tested end to end with a Chromecast (YouTube Music) and with
`cast.framework` media on a Nest Hub (load, play, pause, seek, volume, and stopping from the picker). The manager serves both modes;
`createCastManager({ presentation: false })` serves only this one. The [API reference](API.md#installchromecastbridgekey) documents
what it installs.

## How do I know electron-cast matches Chrome?

Where it copies a rule, the code and the docs cite the Chromium source it comes from, and the citations are checked against the
Chromium tree. [The Chromium map](CHROMIUM-MAP.md) lists each module with the files and functions it mirrors, and the places it
differs on purpose.

## What happens when Google changes the SDK?

The page runs Google's SDK, which Google can change per Chrome major without an electron-cast release. A weekly job (`npm run canary`)
downloads the SDK for Chrome stable, beta and dev, and the Chromium in Electron 45, and checks as text, without running it, that it
still uses what electron-cast translates. A failure opens an issue. See [CONTRIBUTING](../CONTRIBUTING.md#the-sdk-canary).

## Is it safe to let a page cast?

The model is: the page is not trusted, the main process is. A page can only use a narrow bridge; it cannot choose a device, host or
port; only a device your `selectDevice` returned can be connected to; and a device must prove it is Google-certified first. Set
`allowOrigin`. Read [SECURITY.md](../SECURITY.md).

## What does it cost to add?

No runtime dependencies and no native modules. The package ships TypeScript sources, ES module and CommonJS builds and type
declarations.

## It does not work. Where do I start?

[Troubleshooting](TROUBLESHOOTING.md), beginning with the script that lists what discovery sees.
