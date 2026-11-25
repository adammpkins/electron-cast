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
