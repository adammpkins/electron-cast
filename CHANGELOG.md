# Changelog

## Unreleased

- CI now runs a smoke test in a real Electron (35, 40 and the latest stable, on Linux, Windows and macOS): a sandboxed
  preload built from `electron-cast/preload`, `createCastManager` from `electron-cast/main` with a fake device, both
  modes. `npm run smoke` runs it locally.
- `package.json` declares an optional peer dependency on `electron >=35`.
- A weekly canary (`npm run canary`, `tools/sdk-canary.mjs`) fetches Google's Cast sender SDK for the current Chrome
  majors and checks it still speaks the message envelope the translator expects. A failed run opens one issue.
- Added a CommonJS build (`dist/cjs`, no new dependencies) with `import` / `require` conditions on every entry point, so a
  non-sandboxed CommonJS preload or main process can `require("electron-cast/preload")` and `require("electron-cast/main")`.
  The ESM build is unchanged.
- Presentation mode now matches Chrome's Media Router for v2 requests: `QUEUE_NEXT`, `QUEUE_PREV` and `PRECACHE` are
  forwarded to the receiver (they were dropped, so their callbacks never fired); a failed `SET_VOLUME` or `STOP`
  reports `internal_error` / "unknown error"; a media request that cannot be sent gets no reply; an app message for a
  vanished session reports `session_error` "Invalid session ID". Unknown v2 message types are still dropped, as in Chrome.
- Presentation mode: a page can rejoin a session that kept playing on the device after the app restarted, the way it
  can in Chrome: `reconnect("cast-session_<id>")` (Google's SDK `requestSessionById`) now finds sessions this run did
  not start, by asking the known devices what they run. Auto-join still does not join them, as in Chrome, and nothing
  is persisted. The service gains a `joinRunningSession` call for this; `mode: "chromecast"` is unchanged.
- Discovery now also runs mDNS over IPv6 (link-local, per adapter) so IPv6-only devices are found, with `fe80::` addresses carrying their scope so they can be connected to. IPv4 is still preferred. A network adapter that goes away takes its devices with it at once, and sockets are replaced after the machine wakes from sleep.
- Google's Cast SDK now works inside iframes in presentation mode, with Chrome's per-frame semantics: each frame has its
  own availability watches, connections and sessions, receives only its own events (`frame.send`), and uses its own
  origin. An iframe that navigates parks its sessions; a removed iframe or a navigating page ends them. Needs
  `nodeIntegrationInSubFrames: true` in the window's `webPreferences` so the preload runs in iframes; without it nothing
  changes. `mode: "chromecast"` stays main-frame only.
- **Devices are now verified, as in Chrome.** `CastClient.connect()` runs the Cast device authentication challenge
  after TLS and before CONNECT, checking the device's certificate chain against Google's Cast roots (a port of
  Chromium's checks, including revocation with the built-in fallback CRL). A device that fails makes `connect()`
  reject with the new `CastAuthError` (with a `reason`) and the page sees it as an unreachable device. Not tested yet
  against real hardware.
- New options: `verifyDevice` on `CastClient` and `verifyDevices` on `createCastManager`, both on by default. Set them
  to `false` for receivers that are not Google-certified.
- The protocol layer gains `DeviceAuthMessage` encoding and decoding.

## 0.3.1

- A page that reloads while casting now gets its session back. A navigation used to leave the page's sessions, which
  closed them on the device, so the reloaded page's auto-join found nothing. Now they stay open (parked) and the next
  page rejoins them, as in Chrome. Closing the page still leaves them.

## 0.3.0

- **Changed default: pages now run Google's own Cast SDK.** `installCastBridge` installs a stand-in Presentation API
  (`mode: "presentation"`, the new default) instead of electron-cast's `chrome.cast`, so Google's `cast_sender.js` and
  `cast.framework` load and run unmodified. The main process answers it with a translator for the message format
  Chrome's Media Router uses with that SDK. `createCastManager` serves it by default (`presentation: false` turns it
  off) and now needs `ipcMain.on` and `ipcMain.removeListener`, which Electron's `ipcMain` has.
- A cast must now start from a user gesture, as in Chrome.
- The previous behaviour is still available with `mode: "chromecast"` in `installCastBridge`.

## 0.2.0

- `chrome.cast.media` in the polyfill: `loadMedia`, `queueLoad`, playback commands (play, pause, seek, stop, volume,
  tracks), queue operations, media status updates, and media listeners, over the existing bridge.
- Google Cast Application Framework compatibility in the polyfill: `Media.getEstimatedBreakTime`,
  `getEstimatedBreakClipTime` and `getEstimatedLiveSeekableRange`; `ReceiverAction.STOP` reaching receiver action
  listeners before the session ends when the user stops casting from the picker; a session is announced to a
  `sessionListener` function only once, across repeated `initialize` calls and `requestSessionById`; ended sessions
  leave the session map (later events for them are ignored); a LOAD waits through interim LOADING statuses; and
  `MEDIA_STATUS` entries no longer reset `volume` when absent, and clear `breakStatus` and `liveSeekableRange` when
  dropped.
- The polyfill blocks Google's `cast_sender.js` loader scripts (gstatic clank and the Cast extensions) before they
  can overwrite it with a Presentation-API implementation that finds no devices in Electron.

## 0.1.1

- `electron-cast/main` re-exports `CastRequestInfo`, `DeviceChoice` and `CastDevice`, so a `selectDevice` picker can be
  typed without importing from the package root.
- Releases are published from GitHub Actions with npm trusted publishing, with a provenance attestation.

## 0.1.0

First release.

- `chrome.cast` polyfill for Electron pages: `initialize`, `requestSession`, `session.stop` and `session.leave`,
  receiver availability, volume and mute, and messages on custom namespaces.
- Device discovery over mDNS on every network interface.
- A Cast v2 client over TLS.
- The device picker is told about the sender's current session (`request.session`) and may answer `"stop"`.
