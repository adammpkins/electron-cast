# Live checks

Unattended checks that run electron-cast in a real Electron on a real network, with Google's Cast sender SDK unchanged.
They are for you to run, on a device you choose. The unit tests and the smoke test never reach a real device.

```sh
npm ci                                  # once
npm run live:checks -- dial-dedup       # read-only, 60 s
npm run live:checks -- cast --sink "<device name>" --test top --yes
```

The first run installs Electron 45 into `smoke/.out/electron`, builds the package and bundles the sandboxed preload.

## `dial-dedup`: DIAL next to Cast, one entry per device (read-only)

Runs the manager with DIAL on (the default) and lists the sinks for `--secs` (default 60). It also runs a raw mDNS discovery
and a raw DIAL service next to it, so every sink can be labelled: `mdns` (a Cast sink no DIAL answer matched), `promoted`
(a Cast sink whose device also answered DIAL) or `dial` (a DIAL-only device). It sends mDNS queries and SSDP searches, and
fetches DIAL device descriptions; it launches nothing. The manager opens Cast channels to the discovered devices, as it
always does.

PASS means: no device is listed twice, a device that answers both is a Cast sink and never a DIAL sink in the steady state,
and a DIAL sink never comes back after its Cast sink is up. A DIAL sink may be listed for a moment, before the Cast channel
opens: Chrome does the same, because `CastMediaSinkServiceImpl::OnChannelOpenSucceeded` removes the DIAL sink only once the
channel is open.

## `cast`: casting to one device

`--sink` names the one device the check may select; every other device is ignored. `--yes` confirms that a short public
test video is cast to it. The check refuses to start if the device has any route (an app running, whoever started it),
ends its own session, and quits within `--secs` (default 80) whatever happens.

| `--test` | What it does |
|---|---|
| `top` | The page loads the SDK, calls `requestSession()` with a user gesture (`executeJavaScript(code, true)`), `selectDevice` picks the device, media reaches `PLAYING`, the page stops the session. The control for the iframe runs. |
| `iframe-same` | The same, with the SDK in a same-origin iframe. |
| `iframe-cross` | The same, with the SDK in an iframe on another origin (another host name and port). |
| `sandbox-no-presentation` | An `<iframe sandbox="allow-scripts allow-same-origin">`: `new PresentationRequest()` must throw Chrome's `SecurityError`. Nothing is cast. |
| `sandbox-presentation` | The same iframe with `allow-presentation`: casts as `iframe-same`. |
| `default-presentation` | Casting from the app's own UI: the main process calls `startCasting(sinkId, { webContentsId })` for the page's default `PresentationRequest` (the SDK sets it), with no click. The page gets `connectionavailable` and a started session; media plays; `terminateRoute` ends it. |

The media is a short MDN sample video. The `gtv-videos-bucket` samples answer 403 now.

## `parity`: Chrome's rules on one device

`npm run live:checks -- parity --sink "<device name>" --test <name> --yes [--secs 85] [--logdir <dir>]` takes the same
guards as `cast` (the idle guard, `--yes`, a hard time cap of 90 s) and logs the Cast channel's JSON (the AES key and IV of an
OFFER are redacted), `getLogs` and `getCastProviderState`, then writes `<logdir>/<test>.json`. Every other device is hidden.

| `--test` | What it does |
|---|---|
| `wire` | Google's SDK launches the Default Media Receiver; the CONNECT and LAUNCH JSON are logged and the device must accept them (a session starts, the sample video reaches `PLAYING`). |
| `close-leave` | `session.leave()` closes the page's connection with reason `closed`. |
| `close-stop` | `session.stop()` ends it as `terminated`. |
| `token` | With `--token-file <path>`, two runs give the same receiver label; without it they differ. Nothing is cast. |
| `sinks` | The sink list is in Chrome's order (cast, cast_audio_group, cast_audio, names by collator). Nothing is cast. |
| `issues` | A launch of app `00000000` fails and the "Failed to cast" issue reaches `registerIssuesObserver`. |
| `site-mirror` | Run with `--enable-features=AllowAllSitesToInitiateMirroring`. A page starts mirroring with `cast:0F5096E8?streamingTargetPlayoutDelayMillis=300`; the OFFER's `targetDelay` must be 300 and frames must flow; the page terminates it. |
| `nonlocal-join` | Another sender (`other-sender.mjs`, a Node script on its own connection) launches the Default Media Receiver and plays `flower.mp4`. The route must be non-local (`isLocal` false, no member, the session's status text as description); the page's auto-join must not take it; `chrome.cast.requestSessionById` must (media status reaches the page); when the other sender stops the app the route goes and the page gets `isAlive` false and a terminated connection. |
| `nonlocal-terminate` | The same start; then `terminateRoute` from Electron must stop the app on the device (the other sender's receiver status no longer lists it). |
| `fling` | A tab is mirrored, then the page's SDK auto-joins (`origin_scoped`) for the Default Media Receiver; the mirroring route must be replaced by the app session. |
