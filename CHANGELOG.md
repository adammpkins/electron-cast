# Changelog

## Unreleased

- **Tab and desktop mirroring.** `createCastManager({ mirroring })` enables `startCasting(sinkId, { castMode:
  "tab_mirror" | "desktop_mirror", webContentsId, desktopSourceId, withAudio })` in the main process, with `castMode`
  and `withAudio` filters on `registerMediaSinksObserver`. It is a TypeScript port of Chrome's Cast Streaming sender
  (openscreen's sender session, Chromium's frame sender policy and Mirroring Service host, and the MirroringActivity
  routing): OFFER/ANSWER, VP8 (VP9 opt-in) and Opus, AES encryption, RTCP, NACK retransmission and bitrate adaptation.
  Capture and WebCodecs encoding run in a hidden window; the sender runs in a utility process per route. No new
  dependencies. Tested end to end against a fake receiver (unit, integration and an Electron smoke test); not yet
  tried on a real device. `examples/live-mirroring/` is the harness for that. Not ported: remoting, tab switching,
  pause and resume, hardware codecs.

## 0.4.0

- **Devices are now verified, as in Chrome.** `CastClient.connect()` runs the Cast device authentication challenge
  after TLS and before CONNECT: it checks the device's certificate chain against Google's Cast roots (a port of
  Chromium's checks, with no new dependencies), revocation, and a signature tied to the connection's TLS certificate.
  A device that fails makes `connect()` reject with the new `CastAuthError` (with a `reason`), and the page sees an
  unreachable device. It is on by default. Set `verifyDevices: false` on `createCastManager`, or `verifyDevice: false`
  on `CastClient`, for receivers that are not Google-certified. `CastClient` also gains `authTimeoutMs`, `deviceAuth`
  (trust roots and clock, for tests and private deployments) and a `deviceAuth` result (`policy`, `hashAlgorithm`,
  `nonceEchoed`, `usedFallbackCrl`, `revocationChecked`). The protocol layer gains `DeviceAuthMessage` encoding and
  decoding. Tested on 8 real devices, which all passed.
- Device authentication does not start refusing devices that send no CRL once the built-in fallback CRL is past its 20
  weeks: with a lapsed fallback and no valid CRL from the device, the revocation check is skipped and
  `deviceAuth.revocationChecked` is `false` (Chromium fails closed; Chrome updates itself, an app may not). All other
  checks, the device's own CRL, and revocation by a still-valid fallback CRL are unchanged. The fallback window starts
  at the package's build time, stamped by `npm run build`.
- Presentation mode: `start()` now needs transient user activation in the main process too, not only in the page's
  stand-in. The preload reads `navigator.userActivation.isActive` in its isolated world and the main process refuses
  a start without it (`AbortError`, "PresentationRequest::start() requires user gesture.", as Chrome's browser-side
  check). The stand-in's own refusal now throws Blink's `InvalidAccessError` instead of `AbortError`. Electron has no
  main-process API for activation, so a compromised renderer could still forge it (see SECURITY.md).
- Presentation mode: a page can rejoin a session that kept playing on the device after the app restarted, the way it
  can in Chrome. The library persists nothing: the app keeps the session id, the page calls
  `chrome.cast.requestSessionById`, Google's SDK turns that into `reconnect("cast-session_<id>")`, and electron-cast
  finds the session by asking the known devices what they run (the new `joinRunningSession` service call). Auto-join
  still does not join such sessions, as in Chrome. Joining by id no longer checks the origin, also for a session this
  run holds, as in Chrome (`AppActivity::CanJoinSession`); `allowOrigin` still applies. `mode: "chromecast"` is
  unchanged.
- Google's Cast SDK now works inside iframes in presentation mode, with Chrome's per-frame semantics: each frame has its
  own availability watches, connections and sessions, receives only its own events, and uses its own origin. An iframe
  that navigates parks its sessions; a removed iframe or a navigating page ends them. Needs
  `nodeIntegrationInSubFrames: true` in the window's `webPreferences` so the preload runs in iframes; without it nothing
  changes. `mode: "chromecast"` stays main-frame only.
- Discovery also runs mDNS over IPv6 (link-local, per adapter), so IPv6-only devices are found; `fe80::` addresses carry
  their scope so they can be connected to, and IPv4 is still preferred. A network adapter that goes away takes its
  devices with it at once, and sockets are replaced after the machine wakes from sleep.
- Main-process API on the cast manager, modelled on Chrome's Media Router: sinks and routes observers, `getRoutes`,
  `terminateRoute`, `detachRoute`, route volume control, and a third `selectDevice` argument that streams devices
  found while the picker is open. Sink icon types follow Chrome's `GetCastSinkIconType`, and a route's `members` are
  `webContents.id`s, also for iframes. See docs/MAIN-API.md.
- Presentation mode matches Chrome's Media Router for v2 requests: `QUEUE_NEXT`, `QUEUE_PREV` and `PRECACHE` are
  forwarded to the receiver (they were dropped, so their callbacks never fired); a failed `SET_VOLUME` or `STOP`
  reports `internal_error` / "unknown error"; a media request that cannot be sent gets no reply; an app message for a
  vanished session reports `session_error` "Invalid session ID". Unknown v2 message types are still dropped, as in Chrome.
- Added a CommonJS build (`dist/cjs`, no new dependencies) with `import` / `require` conditions on every entry point, so a
  non-sandboxed CommonJS preload or main process can `require("electron-cast/preload")` and `require("electron-cast/main")`.
  The ESM build is unchanged. `package.json` declares an optional peer dependency on `electron >=35`.
- CI runs a smoke test in a real Electron (35, 40 and the latest stable, on Linux, Windows and macOS): a sandboxed
  preload built from `electron-cast/preload`, `createCastManager` from `electron-cast/main` with a fake device, both
  modes. `npm run smoke` runs it locally. A weekly canary (`npm run canary`) fetches Google's Cast sender SDK for the
  current Chrome majors and checks it still speaks the message envelope the translator expects; a failed run opens one
  issue.
- The `DeviceAuthResult`, `DeviceAuthOptions`, `CastCertError` and `CastDeviceCertPolicy` types are exported.
- The page's IPC channel accepts only the bridge's own methods. `joinRunningSession`, which only main calls, is refused
  from a page as an unknown method.
- Thanks to Michael Arthur (@mikey0000). Restart rejoin was proposed by him in
  [#1](https://github.com/adammpkins/electron-cast/pull/1) (an optional `sessionStore`); 0.4.0 does it the way Chrome
  does instead, as described above. His [#2](https://github.com/adammpkins/electron-cast/pull/2) arrived independently
  at the presentation-mode design that 0.3.0 shipped.

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
