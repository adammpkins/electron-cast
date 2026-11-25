# Security

This document describes what electron-cast trusts, what it checks, and what it leaves to the app. It reflects
v0.3.1. To report a vulnerability, see [Reporting a vulnerability](#reporting-a-vulnerability).

## Threat model

electron-cast lets web pages in your Electron windows talk to Cast devices on the local network. Three parties are
involved:

| Party | Trust |
|---|---|
| Your main process and preload | Trusted. electron-cast runs there. |
| The page in the window | Not trusted. It may be a third-party site, or a trusted site that has been compromised, or include third-party scripts. It can run any JavaScript in its own world. |
| Devices and everything else on the local network | Not trusted. Anyone on the same network segment can answer discovery queries, impersonate a device, or read unencrypted traffic. |

What the library tries to guarantee:

- A page can only use the narrow bridge the preload exposes. It never gets Node, sockets, `ipcRenderer` or an IPC
  handle. It works with `sandbox: true` and `contextIsolation: true`.
- A page cannot choose which device, host or port to connect to. Only a device the app's `selectDevice` returned can
  be connected to.
- A page cannot see or touch another origin's sessions.
- Malformed input from the page, a device, or the network is rejected without crashing the main process.

What it does not defend against: a compromised main process or preload, an app that auto-approves every request in
`selectDevice`, and an attacker on the local network who can impersonate a device (see
[TLS and device authentication](#tls-and-device-authentication)).

## What crosses the IPC boundary

The preload exposes one bridge object to the page's main world, and the page can call it directly. Nothing the page
sends is trusted: every call is validated in the main process, in `src/electron/main.ts`,
`src/electron/session-service.ts` and `src/electron/presentation-handler.ts`.

Channels, with the default channel name `electron-cast`:

| Channel | Direction | Used by |
|---|---|---|
| `electron-cast:presentation` (invoke) | page to main | Default mode: `getAvailability`, `stopWatching`, `start`, `reconnect`, `close`, `terminate` |
| `electron-cast:presentation:send` (send) | page to main | Default mode: one message on an open connection |
| `electron-cast:presentation:event` | main to page | Default mode: availability, messages, connection state |
| `electron-cast:call` (invoke) | page to main | `mode: "chromecast"`: `initialize`, `requestSession`, `joinSession`, `sendMessage`, `stopSession`, `leaveSession`, `setReceiverVolume`, `setReceiverMuted` |
| `electron-cast:event` | main to page | `mode: "chromecast"`: availability, session updates, messages |

How the main process validates what arrives:

- **Who is asking.** The origin comes from `event.senderFrame` in the main process, never from anything the page
  says. A call with no sender frame is refused. If the frame's URL cannot be parsed, the origin is `""` and
  `allowOrigin` decides.
- **Method names.** Only the methods above are accepted. Anything else gets an error reply.
- **Parameter types.** Every method has a parser that checks types: ids and session ids are strings, `level` is a
  finite number from 0 to 1, `muted` is a boolean, `timeoutMs` is a positive finite number. A call that does not
  match gets `invalid_parameter` (`InvalidAccessError` in default mode). Nothing page-supplied is used as a host,
  port or file path.
- **Sizes.** Connection, watch and presentation ids are at most 256 characters, a request carries at most 16 URLs,
  a presentation URL is at most 4096 characters, an app id matches `[A-Za-z0-9._-]{1,64}`, and a page-to-receiver
  message over 1,048,576 characters is dropped. The Cast wire limit of 64 KiB still applies below that, and a
  message over it fails with an error instead of being sent. Each page keeps at most 32 availability watches, and at most 100 media
  requests are tracked per connection.
- **Envelope format.** In default mode, messages on a connection must be one of eight known router message types
  with the expected fields; others are dropped. Only the media requests the Cast SDK sends (`LOAD`, `PLAY`,
  `PAUSE`, `SEEK` and the like) are forwarded on the media namespace.
- **One request at a time.** A page can have one `requestSession` or `start` pending. A second is refused.
- **Replies.** Handlers never throw or reject across the boundary; failures come back as `{ ok: false, code }`.

What goes back to the page: whether a receiver is available (a boolean), then, for a session the user started, the
device's friendly name, capabilities and volume, the receiver app's name, namespaces and icon, and the messages that
app sends. The page never gets a device's IP address or port. In default mode the receiver label is a hash of the
device id and a per-process random token, and the friendly name is HTML-escaped, because Google's SDK may put it
into markup. Treat everything a device sends as untrusted data.

## User gesture

Chrome only lets a page start a cast from a user gesture, and electron-cast follows that in default mode, in two places:

- The page-side stand-in rejects `PresentationRequest.start()` with `InvalidAccessError` ("PresentationRequest::start()
  requires user gesture.") when `navigator.userActivation.isActive` is false, as Blink's `PresentationRequest::start()`
  does. This runs in the page's own JavaScript, so it is a compatibility behaviour, not a security boundary.
- The preload reads `navigator.userActivation.isActive` itself, in its isolated world, when the page calls the bridge's
  `start`, and sends that as `hasGesture`, replacing anything the page passed. The main process refuses a `start`
  whose `hasGesture` is not `true` with `AbortError` and Chrome's message (what `PresentationServiceImpl::StartPresentation`
  reports as `PRESENTATION_REQUEST_CANCELLED`). A page script cannot forge this: it cannot reach the IPC channel, and
  overriding `navigator.userActivation` in the main world does not change the isolated world's view (smoke-tested).

Known gap: Electron has no main-process API for a frame's transient user activation (`WebFrameMain` and
`IpcMainInvokeEvent` have none; only `webContents.executeJavaScript(code, userGesture)` and the media-access
handler's `userGesture` touch the concept), so the check is made in the renderer process, by the preload, instead of
in the browser process as Chrome does. It holds against a page's scripts. It does not hold against a compromised
renderer process, which can also forge the IPC itself. An Electron-native handler would get Chromium's browser-side
check for free.

`mode: "chromecast"` has no gesture check at all. A hostile page can call that bridge without a click.

The real consent step is `selectDevice`. A session only starts if your callback resolves a device, and the callback
is your UI in the main process, so the page cannot answer it. Always show the user a prompt, show the requesting
origin (`request.origin`), and do not auto-pick a device. A page that is allowed to cast can still make the prompt
appear repeatedly, one at a time, so keep the prompt cancellable and consider rate-limiting it.

## allowOrigin

`allowOrigin(origin)` is checked on every call from a page, in both modes, using the origin of the frame that made
the call. When it returns false the call is refused. In `mode: "chromecast"` the page gets `extension_missing`, as if
electron-cast were not installed. In default mode availability reads as false and `start` fails. If `allowOrigin`
throws, the call is refused.

- **Default: no check.** Without `allowOrigin`, every page in a window that has the preload can cast.
- **Recommendation: always set it,** and compare against exact origins you control, for example
  `(origin) => origin === "https://music.example.com"`. Do not match with `endsWith`, `includes` or a prefix test.
- **Install the preload only in windows and views that show pages that should cast.** A window without the preload
  has no way to reach these channels. With `nodeIntegrationInSubFrames`, the preload also runs in iframes. Each frame
  is checked against its own origin.

`allowOrigin` is evaluated on each call, so changing what it returns takes effect on the next call. It does not end
sessions that are already open; to do that, call `dispose()` on the manager.

## Scoping of sessions and messages

A session records the origin that created it and the set of webContents that are members of it.

- **Who can act on a session.** `sendMessage`, `stopSession`, `leaveSession` and the volume calls need the caller's
  webContents to be a member of the session. Other pages, including pages of the same origin in another window,
  cannot message or stop it unless they have joined.
- **Who can join.** `joinSession` and auto-join need the caller's origin to equal the session's origin and, for
  auto-join, the same app id. `origin_scoped` joins any window of that origin; `tab_and_origin_scoped` (the default
  policy in Google's SDK) joins only the webContents that already had the session, including after a reload.
  Joining by session id from another window of the same origin is allowed, because session ids are not secret from
  that origin. A different origin cannot join, whatever it guesses.
- **Who receives events.** Events and receiver messages are sent only to the member webContents, to its main
  frame. Messages from the device are routed by the receiver app's transport id, so a session sees only its own
  app's traffic.
- **Lifetime.** A navigation of the page leaves its sessions open on the device, parked, so the next page of the
  same webContents can rejoin them (as in Chrome). A destroyed webContents leaves its sessions for good. When a
  session has no members left, electron-cast releases its connection to the app; the app keeps running on the
  device until it is stopped.
- **Per-webContents, not per-frame.** Membership is by webContents. If a window shows several frames that are all
  allowed by `allowOrigin`, they share the sessions of that webContents.

### What a page can do inside its own session

A page that holds a session can:

- Send messages on the namespaces of the receiver app. This is the point of the Cast protocol: the page and the
  receiver app define their own messages. In default mode the namespace must be one the receiver app lists in its
  status. In `mode: "chromecast"` the page can name any namespace string, including Cast system namespaces, but the
  destination is always the receiver app's own transport. It cannot send to the platform receiver that way.
- Send media requests (load, play, pause, seek, queue edits), set the device volume and mute, and stop the session.
- The volume and the stop apply to the device, so they are heard by anyone else using it, and stopping ends the app
  for other senders (phones, for example) that joined the same app.

A page cannot launch an app without a session request, cannot choose the device, and cannot reach another page's
session. It does choose the receiver app id (default mode takes it from the presentation URL, which the SDK builds
from the app id the page configures), so a page allowed to cast can launch any app on the device the user picked.

## TLS and device authentication

`CastClient` connects to a device over TLS on port 8009 (or the port advertised in mDNS) with
`rejectUnauthorized: false`. This is normal for Cast. A Cast device presents a certificate it generated itself, which
no public certificate authority has signed, so ordinary certificate validation always fails. Chrome also accepts
that certificate and instead authenticates the device with a separate challenge on the
`urn:x-cast:com.google.cast.tp.deviceauth` namespace, which checks the device's certificate chain against Google's
Cast root certificates.

In v0.3.1 electron-cast does not do that challenge. (Later releases do; see below.) The connection is encrypted but the device is not
authenticated. Anyone on the local network who can answer mDNS queries, or who can intercept traffic between your
computer and the device, can pose as a Cast device. If the user picks that device, the attacker receives whatever the
page sends it, such as media URLs and app-specific messages and tokens (YouTube's lounge tokens, for example). It
does not get cookies or anything else from the page.

`CastClientOptions.tls` is spread after the defaults, so an app that wants to pin a certificate can pass its own
`tls` options through a custom `createClient`.

**Upcoming (not in v0.3.1).** The client verifies the device's Cast certificate chain, on by default.

**Old releases and devices that send no CRL.** Revocation uses the CRL the device sends, or else a fallback CRL built
into the package that counts for 20 weeks from the package's build time. When a release is older than that and the
device sent no valid CRL, the revocation check is skipped (`CastClient.deviceAuth.revocationChecked` is `false`),
where Chromium would refuse the device; Chrome updates itself, an Electron app may not, and Chrome likewise stops
enforcing Certificate Transparency when its built-in log list is over 70 days old
(`ChromeCTPolicyEnforcer::IsLogDataTimely`). What still holds: the chain to a Cast root, the device certificate
checks, the signature over this connection's TLS certificate, revocation by a CRL the device sends, and revocation by
a fallback CRL that has not lapsed. What does not: a device Google has revoked can pass if it sends no CRL. Update
electron-cast regularly, and treat `revocationChecked: false` as a prompt to do so.

## mDNS exposure

Discovery sends multicast DNS queries for `_googlecast._tcp.local` to `224.0.0.251:5353`:

- on every non-internal, non-link-local IPv4 interface the OS reports, including VPN and virtual adapters;
- right at start, again after 1 s and 3 s, then about every 60 s;
- with the interface list re-checked every 10 s, so a new network is joined as soon as it appears.

It binds UDP port 5353 with address reuse so it can coexist with the system's mDNS responder, and falls back to an
ephemeral port if that fails. It does not advertise anything and does not answer queries; it only asks. The queries
reveal to everyone on those networks that this machine looks for Cast devices.

Answers are accepted from any host on those networks, parsed with a defensive decoder (malformed packets are dropped),
and turned into device records. A device record's address comes from the answer, so a hostile host can announce a
device name and an address of its choosing. Nothing connects to it until the user picks it in `selectDevice`. Show
the device's name as plain text in your picker, since it is attacker-controlled when the network is.

Nothing is sent and no socket is opened until you call `manager.start()`. To turn casting off:

- never create the manager, or never call `start()`, for users who disable it;
- call `await manager.dispose()` to stop discovery, close the sockets, close device connections and remove the IPC
  handlers. A disposed manager cannot be restarted; create a new one to turn casting back on.

With `presentation: false` only `mode: "chromecast"` pages are served.

## Dependencies and supply chain

electron-cast has no runtime dependencies. It uses Node's `tls`, `dgram` and `crypto`. The preload entry has no
imports of its own, so a bundler can inline it.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting: go to
[github.com/adammpkins/electron-cast](https://github.com/adammpkins/electron-cast), open the **Security** tab and
choose **Report a vulnerability**. Include the version, the Electron version, steps to reproduce, and what an attacker
gains. You will get a reply there, and a fix is released with a credit if you want one.

Fixes are made against the latest release.
