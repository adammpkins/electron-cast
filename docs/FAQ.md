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

No, and nothing YouTube-specific is in the library. YouTube Music Desktop is the first app to use it, and the one casting was
tested end to end in; the example app casts to the Default Media Receiver from its own page. Any page that uses Google's Cast
SDK should work ([custom receivers](guides/custom-receivers.md)); what has been tested is stated in the [README](../README.md#platforms-and-what-was-tested).

## Which Electron, Node and operating systems?

Electron 35 or later (the preload needs `contextBridge.executeInMainWorld`), Node 20 or later. Real devices have been used from
Windows (end to end, Electron 45) and Linux (discovery and device authentication, Ubuntu under WSL2 with mirrored networking).
macOS has not been tried against a real device. The [README](../README.md#platforms-and-what-was-tested) lists exactly what was
run.

## Does it work with `sandbox: true` and `contextIsolation: true`?

Yes, that is the supported configuration. The page never gets Node, sockets or an IPC handle. A sandboxed preload cannot load
other files, so you have to bundle `electron-cast/preload` into it ([how](GETTING-STARTED.md#2-the-preload)).

## What network access does it use?

Multicast DNS queries on your local networks (UDP 5353) to find devices, and a TCP connection (usually port 8009) to the device a
user picks. Device authentication needs no network: Google's Cast roots and a fallback revocation list ship in the package. It
makes no other connection, advertises nothing, and answers no queries. `manager.start()` is what opens the sockets; nothing
happens before it. See [SECURITY.md](../SECURITY.md#mdns-exposure).

## Can I start a cast from my app's menu or tray?

Not directly. A cast needs the page's own SDK state and a user gesture, as in Chrome. Tell the page to press its own Cast button
(for example by sending it a message it listens for); the route then appears in your observers. See the
[main-process API](MAIN-API.md#starting-a-cast-from-main). App-initiated casting through the page's default presentation request
is in progress.

## Can I control playback (play, pause, seek) from the main process?

Observing and controlling the **session** is supported: list devices and sessions, stop or detach a session, set the device
volume ([MAIN-API](MAIN-API.md)). Play, pause and seek are media commands, which the page's SDK sends; from Node you can send them
yourself with [`CastClient`](guides/low-level-client.md) on the media namespace.

## Can it mirror a tab or the desktop?

No. Tab, desktop and file mirroring are Chrome features electron-cast does not implement, and neither is the Remote Playback API.
See the [parity table](../README.md#chrome-parity).

## Why does my picker list a device that then fails?

Devices are authenticated when connected, not when discovered, so a device that is not Google-certified, or has been revoked,
still shows in the picker and fails when picked. See [Device authentication](guides/device-authentication.md).

## The app restarted and the cast was still playing. Why did it not come back by itself?

Like Chrome, auto-join only joins sessions this run started. After a restart the app has to give the page the old session id and
the page calls `chrome.cast.requestSessionById`. [Recipe](guides/restart-rejoin.md), with YouTube Music Desktop as the worked example.

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
