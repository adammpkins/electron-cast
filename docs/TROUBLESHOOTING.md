# Troubleshooting

What to check, in order, when casting does not work: no devices, a button that never appears, a refused device, a hang at
startup, a session that drops, and how to get logs. Each section has the commands to run.

Start with [List what discovery sees](#list-what-discovery-sees). It separates "the network is the problem" from "my app is".

## List what discovery sees

This uses only the published package and Node, with no Electron, and it only **asks** (it sends mDNS queries and never
answers or advertises). Save it as `discover.mjs` in a project that has electron-cast installed:

```js
import { CastDiscovery } from "electron-cast";

const seconds = Number(process.argv[2] ?? 10);
const discovery = new CastDiscovery();
discovery.on("deviceUp", (d) => console.log(`up    ${d.name}  ${d.model}  ${d.host}:${d.port}`));
discovery.on("deviceDown", (d) => console.log(`down  ${d.name}`));
discovery.on("socketError", (iface, error) => console.log(`socket error on ${iface.name} (${iface.address}): ${error.message}`));

await discovery.start();
for (const i of discovery.interfaces()) {
  console.log(`listening on ${i.name} (${i.address}${i.family === "IPv6" ? `%${i.scopeId}` : ""})`);
}
setTimeout(() => {
  console.log(`${discovery.devices().length} device(s) found`);
  discovery.stop();
}, seconds * 1000);
```

```sh
node discover.mjs 15
```

(In a clone of the repository, `node examples/discover.ts 15` does the same on a Node that runs TypeScript, 22.18 or 24.)

Read the output:

- **No `listening on` lines.** Node sees no usable network interface: the machine is offline, or only has loopback and
  link-local addresses. Discovery uses every non-loopback, non-`169.254.` IPv4 address, plus one IPv6 link-local address per
  adapter.
- **`listening on` lines, then `0 device(s) found`.** The sockets opened but no device answered. This is the network or a
  firewall: continue with [No devices found](#no-devices-found).
- **`socket error on ...`.** One interface failed (the others carry on). The message says why: often a virtual adapter or an
  adapter that went away.
- **Devices appear here but not in your app.** The network is fine; look at your app: `manager.start()` was never called,
  `allowOrigin` refused the page, or the preload did not run. See [the button never appears](#the-cast-button-never-appears).

## No devices found

mDNS is multicast on the local link. Anything that stops multicast between the PC and the device hides the device. The usual
causes, most common first:

1. **The PC and the device are on different networks.** mDNS does not cross routers. A PC on a wired VLAN, a guest SSID or a
   different subnet from the Cast device sees nothing. Put them on one network, or run an mDNS reflector on the router
   (avahi's reflector, or the router's own "mDNS" or "Bonjour" setting).
2. **Wi-Fi client isolation** (AP isolation, "guest mode") on the access point drops traffic between wireless clients. Turn it
   off for the network the devices are on.
3. **A firewall on the PC** blocks inbound UDP 5353 (Windows, Linux) or the app is denied local network access (macOS).
4. **A VPN.** A full-tunnel VPN can route multicast away from the LAN. Disconnect it and run the script again. Adapters
   from VPNs (Tailscale, for example) still get a socket and are harmless; they just hear nothing.
5. **The wrong adapter is the active one.** Discovery listens on every non-internal IPv4 interface, so a PC with several
   adapters is covered, but check the `listening on` lines include the LAN adapter's address.
6. **Running in WSL2 in NAT mode.** See [WSL](#wsl2).

Confirm that mDNS traffic reaches the machine at all, independent of electron-cast.

### Windows

```powershell
# Which adapter is the LAN one, and is its network profile Public? (Public blocks more inbound traffic.)
Get-NetConnectionProfile
Get-NetAdapter | Where-Object Status -eq Up
# Is anything else holding UDP 5353?
netstat -ano -p UDP | findstr :5353
# Firewall rules that apply to your app (replace the name)
Get-NetFirewallApplicationFilter | Where-Object Program -like "*MyApp*"
```

If the app is not allowed through Windows Defender Firewall for the active profile, allow it (Windows Security, Firewall
and network protection, Allow an app through firewall), or run the script with Node and allow `node.exe` for the test. To
see the packets, capture in Wireshark with the display filter `mdns`: responses from the Cast devices
(`_googlecast._tcp.local` PTR records) should arrive within a few seconds of the queries.

### macOS

macOS was not tested by the author, so treat these as the general checks.

```sh
# Browse Cast devices with the system's own Bonjour tool (press Ctrl-C to stop)
dns-sd -B _googlecast._tcp local.
# Watch mDNS on the LAN interface
sudo tcpdump -ni en0 udp port 5353
```

If `dns-sd` finds devices and electron-cast does not, check System Settings, Privacy and Security, Local Network for your
app, and that a packaged app declares `NSLocalNetworkUsageDescription` and `NSBonjourServices` (see [Getting
started](GETTING-STARTED.md#macos)).

### Linux

```sh
ip -br addr                                  # interfaces and addresses
ip maddr show                                # multicast groups joined (224.0.0.251 for mDNS)
ss -ulpn 'sport = :5353'                     # who holds UDP 5353 (avahi-daemon and systemd-resolved may; sharing is fine)
avahi-browse -rt _googlecast._tcp            # what avahi sees (needs avahi-utils)
sudo tcpdump -ni any udp port 5353           # are mDNS packets arriving at all?
sudo ufw status verbose                      # a host firewall (or: sudo firewall-cmd --list-all)
```

`avahi-browse` finding devices and electron-cast not means the multicast is arriving at the machine but the app's socket is
not getting it: check `socket error` lines from the script. If `tcpdump` shows nothing, the network or a firewall is
dropping it before the app.

### WSL2

Discovery needs to see the LAN's multicast traffic. Under WSL2 that depends on the networking mode:

- **Mirrored networking** (`networkingMode=mirrored`): discovery and device authentication passed on all 8 test devices from
  Ubuntu under WSL2 in this mode on 2026-11-25. In `%UserProfile%\.wslconfig`:

  ```ini
  [wsl2]
  networkingMode=mirrored
  ```

  then run `wsl --shutdown` from Windows and start the distribution again. It needs Windows 11 22H2 or later with a current WSL
  (`wsl --version` to check).
- **NAT mode** (the default): the distribution sits behind a virtual switch on its own subnet, so the LAN's mDNS multicast
  typically does not reach it and discovery finds nothing. That is the network design and not something electron-cast can change; it was
  not measured. Use mirrored mode, or run the app on the Windows side.

### Everything checks out, still nothing

- Wait a minute, or reboot the Cast device: electron-cast queries at start, again after 1 s and 3 s, then every 60 s.
- Make sure the device is a Cast device that advertises `_googlecast._tcp` (the Linux and macOS commands above browse for it).
- Give it a few seconds: a device is listed only once its channel is open and authenticated, after a random delay of up
  to 5 s and a 3 s quiet period. One that fails authentication is never listed (see below).
- Your picker may be filtering them out. In default mode `selectDevice` receives the devices that said they have the
  page's receiver app; in `mode: "chromecast"` those with the capabilities the page asked for.

## The cast button never appears

The SDK shows its launcher only after it learns that a receiver is available. Check from the outside in. In the window's
DevTools console:

```js
typeof window.__electronCastPresentationBridge   // "object" if the preload ran (default mode)
typeof navigator.presentation                    // "object"
await new PresentationRequest(["https://google.com/cast#__castAppId__=CC1AD845/__castClientId__=probe"])
  .getAvailability().then((a) => a.value)        // true once a device is known and allowOrigin admits this origin
```

- `"undefined"` for the first line: the **preload did not run** in this frame. Check `webPreferences.preload`, that the path is
  absolute and the file exists, that a sandboxed preload is bundled (an unbundled `import "electron-cast/preload"` cannot load in a
  sandboxed preload; look for the preload error in the DevTools console), and for an iframe that
  `nodeIntegrationInSubFrames: true` is set.
- `false` from the last line with devices found by the script: **`allowOrigin` refused** this frame's origin (it reads as no
  receivers), or the manager was never started (`await cast.start()`), or the manager was disposed. In an iframe the check uses
  the iframe's own origin.
- Google's SDK did not load: look for a blocked script in the console. Your **Content Security Policy** has to allow
  `www.gstatic.com` ([Getting started](GETTING-STARTED.md#5-content-security-policy)).
- With `mode: "chromecast"`, the bridge is `window.__electronCastBridge`, and `chrome.cast.isAvailable` is true after install.

If starting a cast fails with `AbortError: PresentationRequest::start() requires user gesture.` the call did not come from a
click. Casting must start from a user gesture, as in Chrome; a call from the DevTools console or a timer does not count.

## A device is refused, or casting fails after picking it

A device that fails device authentication is never listed, as in Chrome: the channel opened to it at discovery is refused,
retried with Chrome's backoff, and then given up, so it does not reach the picker and a page that asks finds no screen.

To see the real reason in your logs, wrap `createClient` and log the `CastAuthError`: the exact snippet is in [Device
authentication](guides/device-authentication.md#what-failure-looks-like). The `reason` values, and what each usually means,
are in the [API reference](API.md#errors) and the [guide](guides/device-authentication.md#diagnosing-a-refused-device).

Other reasons a device does not show or a cast fails, from the same `createClient` wrapper:

| What you see | Meaning |
|---|---|
| `CastTimeoutError` on `connect` | The TLS handshake did not finish within `connectTimeoutMs` (10 s): the device is asleep, off, or unreachable from this machine (a different subnet, a firewall on the PC blocking outbound TCP 8009) |
| `CastConnectionError` | The TCP or TLS connection failed or was refused |
| `CastRequestError` with `LAUNCH_ERROR` | The device could not launch the receiver app: an unpublished app on a device that is not registered as a test device, a wrong app id, or the device is busy |
| A pick that never finishes | Your `selectDevice` never resolved. The time the picker is open does not count against the launch timeout, so resolve `null` on cancel |

A device is connected over IPv4 when it has an address, else IPv6 (link-local ones with the interface's zone, `fe80::1%12`). IPv6
discovery, and TLS and device authentication over unique-local and link-local addresses, were verified on real devices.

## The app hangs at top-level `await app.whenReady()` (Electron 45)

In an ES module main process (`"type": "module"`, or an `.mjs` main), a top-level `await app.whenReady()` never resolves on
Electron 45 (reproduced on 45.5.0 on Windows): the app logs the line before it and then hangs. It is Electron's ESM startup,
not electron-cast. Diagnose it with two log lines either side of the `await`:

```js
console.log("before whenReady");
await app.whenReady();          // hangs here on Electron 45 in an ES module main
console.log("after whenReady"); // never printed
```

Use `then` instead, or put the work in a function that is not awaited at the top level:

```js
app.whenReady().then(async () => {
  await cast.start();
  // create windows
});
```

Related report: [electron/electron#40719](https://github.com/electron/electron/issues/40719) (closed; a comment there describes the
top-level await form of the same hang). A CommonJS main is not affected.

## Sessions that drop

A session is the app running on the device plus a TLS connection from your main process. The connection is kept alive by
heartbeat: the client pings after 5 s of silence and fails the connection when 10 s pass with no message from the device (a completed ping restarts that count, as in Chrome). When it fails, the
session ends for the page: in the default mode the page's `PresentationConnection` closes after a `disconnect_session`
message; with `mode: "chromecast"` it gets `sessionEnded` with status `disconnected`.

What is behind a drop, and what each looks like:

| Cause | Looks like | What to do |
|---|---|---|
| The device slept, rebooted or lost Wi-Fi | `disconnected` after about 10 s of silence | Rejoin by id once it is back ([guide](guides/restart-rejoin.md)); the app may be gone |
| Someone stopped the cast on a phone or the device | `stopped`, not `disconnected` | Nothing to fix |
| Your PC slept or changed network | `disconnected`; discovery replaces its sockets after wake and removes devices of a vanished adapter at once | Reconnect after discovery finds the device again |
| The receiver app ended (a crash, or its own timeout) | `stopped` | Check the receiver |

A **navigation** of the page is not a drop: it parks the session and the next page rejoins by auto-join. Closing the page
leaves the session without stopping playback.

To watch it happen, log the client's lifecycle (next section).

## Mirroring is laggy or blocky, or the sound glitches

Pass a `log` in the `mirroring` option to see what the sender sees. Every 5 s it writes a line for each stage of the
pipeline and the device's feedback:

```js
mirroring: { electron: { /* ... */ }, log: (level, message) => console.log(message) }
```

Read the lines in this order:

| Line | Healthy | When it is not |
|---|---|---|
| `video feedback: ... N over 100 ms, measured round trips: min / median / max` | No gaps over 100 ms, a median of a few ms | Feedback stops for 100 to 300 ms at a time. That comes from the network or the device: on the Ultra where this was measured, Chrome's audio glitched the same way |
| `video frames: inserted N, dropped M (kInFlightDurationTooHigh=...)` | Few drops | Frames waited too long for their acknowledgment, the result of the gaps above. Each drop also lowers the bitrate (`bandwidth a -> b ... frames dropped`) |
| `latency stages ... video QP` | Well under 51 | At 51 the encoder is at its coarsest. The capture should get smaller within a few seconds (`capture size -> WxH`), as Chrome's does |
| `timers: ... late by mean / max` | A mean under 1 ms | The sender's tasks ran late; report it |

What helps:

- **Keep the network quiet.** With a VPN client connected on the sending PC, the idle ping to a Cast device on the same
  network doubled (from about 9 ms to about 20 ms), even though the cast traffic stayed on the local network.
- **A longer playout delay.** `targetPlayoutDelayMs` in `startCasting`, or the `CHROME_MIRRORING_PLAYOUT_DELAY`
  environment variable (1 to 65535 ms), as in Chrome. With 400 ms, a laggy link drops fewer frames and keeps a higher
  bitrate. The picture then trails the source by about 0.2 s more than at the default 200 ms.
- **A smaller picture is expected.** Under load the tab's capture can drop well below the window's size, and it grows back
  only after about 30 s of headroom while content moves. That is Chrome's `VideoCaptureOracle`.

## Logging

electron-cast has **no logging switch**, no debug flag and no environment variable. It writes to the console only when a listener
you gave it throws (`electron-cast: a media router observer failed`, and similar). It leaves visibility to you, through the seams it
exposes:

```ts
import { ipcMain } from "electron";
import { CastClient, type CastDevice } from "electron-cast";
import { createCastManager, type ChannelParams } from "electron-cast/main";

function createClient(device: CastDevice, params: ChannelParams): CastClient {
  const client = new CastClient({
    host: device.host,
    port: device.port,
    connectTimeoutMs: params.connectTimeoutMs,
    heartbeatTimeoutMs: params.livenessTimeoutMs,
  });
  const tag = `cast[${device.name}]`;
  client.on("message", (m) => console.log(tag, m.namespace, m.sourceId, "->", m.destinationId, typeof m.data === "string" ? m.data.slice(0, 200) : `<${m.data.length} bytes>`));
  client.on("receiverStatus", (s) => console.log(tag, "status", s.applications.map((a) => a.displayName), s.volume));
  client.on("transportClosed", (id) => console.log(tag, "transport closed", id));
  client.on("close", (error) => console.log(tag, "closed", error?.message ?? "on purpose"));
  return client;
}

export const cast = createCastManager({
  ipcMain,
  selectDevice: async () => null, // your picker
  createClient,
});

cast.registerMediaRoutesObserver({ onRoutesUpdated: (routes) => console.log("routes", routes.map((r) => [r.id, r.description, r.parked])) });
cast.registerMediaSinksObserver({ onSinksUpdated: (sinks) => console.log("sinks", sinks.map((s) => s.name)) });
```

Heartbeat PING and PONG are handled inside the client and not reported as messages. For the layers below that:

- **Discovery:** the script at the top of this page, with `deviceUp`, `deviceChanged`, `deviceDown` and `socketError`.
- **The network:** Wireshark with `mdns` (discovery) or `tcp.port == 8009` (the connection; it is TLS, so you see timing and sizes,
  not content).
- **TLS and sockets:** Node's own `NODE_DEBUG=tls,net` prints handshakes and socket events to stderr.
- **The page:** the DevTools console of the window. The preload's `console.error` appears there when a bridge listener throws.

## Still stuck

Open an issue at [github.com/adammpkins/electron-cast/issues](https://github.com/adammpkins/electron-cast/issues) with: the
electron-cast and Electron versions, the OS, whether `discover.mjs` finds devices, the `CastAuthError` reason or the page's error
name and message, and what you tried above. For a vulnerability, use [private reporting](../SECURITY.md#reporting-a-vulnerability).
