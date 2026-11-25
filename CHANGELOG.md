# Changelog

## Unreleased

- Discovery now also runs mDNS over IPv6 (link-local, per adapter) so IPv6-only devices are found, with `fe80::` addresses carrying their scope so they can be connected to. IPv4 is still preferred. A network adapter that goes away takes its devices with it at once, and sockets are replaced after the machine wakes from sleep.

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
