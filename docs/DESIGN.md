# electron-cast design

Electron exposes the Presentation API but has no Chrome Media Router behind it, so web pages that use the Google Cast
sender SDK (`chrome.cast`) cannot find or talk to Cast devices. Electron closed the upstream request
(electron/electron#869) in 2025 with no plans to implement it. electron-cast fills the gap from scratch. By default
the page keeps Google's own SDK, and electron-cast supplies the missing Media Router: a stand-in Presentation API in
the page, and in the main process a translator for the router's message format plus device discovery and the Cast v2
protocol. The older alternative (`mode: "chromecast"`) gives the page electron-cast's own `chrome.cast`
implementation instead.

The first app built on it loads YouTube Music's web player, which uses the legacy `chrome.cast` API with the YouTube
receiver `233637DE` and the `urn:x-cast:com.google.youtube.mdx` namespace. The library is generic: nothing YouTube-specific
lives in it.

## Goals

- Works with `sandbox: true` and `contextIsolation: true`. The page never gets Node, sockets or IPC handles; it only
  sees the Presentation API stand-in (or the `chrome.cast` object in `"chromecast"` mode).
- No native modules. Pure TypeScript on Node's `tls` and `dgram`.
- The main process decides which pages may cast and which device the user picked. The library ships a picker hook,
  and the app supplies the UI.
- Small, well-tested modules with no Electron import below the `electron/` layer, so the protocol and discovery code
  run and test in plain Node.

## Layers

```
page (main world)       Google's Cast SDK on the Presentation API stand-in   src/polyfill/presentation-standin.ts
                        (or, mode "chromecast": chrome.cast polyfill          src/polyfill/install.ts)
   │  window-level bridge object, installed by the preload
preload (isolated)      bridge: contextBridge + ipcRenderer   src/electron/preload.ts
   │  IPC channel "electron-cast:*"
main process            CastManager: sessions, picker, IPC     src/electron/main.ts
                        ├─ Presentation handler + envelope      src/electron/presentation-*.ts
                        ├─ Discovery (mDNS)                    src/discovery/
                        └─ CastClient per device (Cast v2)     src/client/
                           └─ protocol: framing + CastMessage  src/protocol/
```

## Protocol layer (`src/protocol/`)

### CastMessage (protobuf, from `cast_channel.proto` in the Open Screen library)

| Field | No. | Wire type | Tag byte | Notes |
|---|---|---|---|---|
| `protocol_version` | 1 | varint | `0x08` | required; always `0` (CASTV2_1_0) |
| `source_id` | 2 | length-delimited | `0x12` | required string |
| `destination_id` | 3 | length-delimited | `0x1a` | required string |
| `namespace` | 4 | length-delimited | `0x22` | required string |
| `payload_type` | 5 | varint | `0x28` | required; `0` STRING, `1` BINARY |
| `payload_utf8` | 6 | length-delimited | `0x32` | optional UTF-8 string |
| `payload_binary` | 7 | length-delimited | `0x3a` | optional bytes |

Fields 8 and up (`continued`, `remaining_length` in CASTV2_1_1+) and any other unknown fields are skipped on decode.
The encoder writes fields in ascending order and writes the required fields even when their value is 0 or empty.

### Framing

Each message on the TLS socket is a 4-byte big-endian unsigned length followed by that many bytes of encoded
CastMessage. The maximum body is 65536 bytes (Chromium's `MessageFramer::MessageHeader::max_body_size()`); a larger declared length is a protocol
error and the connection must be closed.

## Client layer (`src/client/`)

TLS to the device on its mDNS port (8009 for single devices; groups use their own port). Cast devices present
self-signed certificates, so the TLS layer cannot verify them; device authenticity is the job of the
`urn:x-cast:com.google.cast.tp.deviceauth` challenge.

### Device authentication (`src/client/auth/`)

`CastClient.connect()` runs the challenge after the TLS handshake and before CONNECT, unless `verifyDevice: false`.
It is a port of Chromium's sender side (`components/media_router/common/providers/cast/channel/cast_auth_util.cc`
and `.../cast/certificate/`, with BoringSSL's path validator under it):

1. Send an `AuthChallenge` (16-byte nonce, SHA-256) as a BINARY CastMessage from `sender-0` to `receiver-0`.
2. The device replies with an `AuthResponse`: a signature, its certificate, its intermediates and optionally a CRL.
3. The TLS certificate's validity window must hold now and must end within four days (the lifetime of the proof).
4. The chain is built and validated to the embedded Cast Root CA or Eureka Root CA with RFC 5280 rules: signatures,
   validity, names, basic constraints and path length, key usage, extended key usage (clientAuth), name constraints,
   certificate policies, unhandled critical extensions, RSA of at least 2048 bits. Trust anchors are not checked for
   expiry. A chain valid for more than five years that has just expired is validated as of a week before it
   expired (Chromium's `GetValidationDate`).
5. The device certificate must assert digitalSignature, have a common name and a usable key.
6. Revocation uses the CRL the device sent (verified against the Cast CRL Root CA) or else the built-in fallback CRL,
   which counts as valid for 20 weeks from the package's build time (see below). If the device sent no valid CRL and the
   fallback has lapsed, the revocation check is skipped and `deviceAuth.revocationChecked` is `false`; with a fallback
   that is broken rather than old, or one that is not yet valid, the device is refused (`crl_invalid`).
7. The signature (RSASSA-PKCS1-v1_5, SHA-1 or SHA-256 as the reply says) must verify under the device certificate's
   key over `sender_nonce || DER of the TLS certificate`, which ties the proof to this connection.

A failure rejects `connect()` with `CastAuthError` (with a `reason`) and closes the socket. The session layer reports it
like any unreachable device (`receiver_unavailable`). The sink service connects to every discovered device and lists it
only once this has passed, so a device that fails is never a sink and never reaches the picker.

Not checked, or different from Chromium:

- Chromium's policy result `audio_only` is reported in `CastClient.deviceAuth.policy` but nothing acts on it.
- A stale fallback CRL skips revocation instead of failing closed. Chromium's `CRL_REQUIRED_WITH_FALLBACK` policy
  returns `ERR_FALLBACK_CRL_INVALID` (`VerifyDeviceCertUsingCustomTrustStore` in
  `components/media_router/common/providers/cast/certificate/cast_cert_validator.cc`) once the fallback is older than 20
  weeks, which is safe there because Chrome auto-updates. An Electron app that stops updating would start refusing every
  device that sends no CRL, about 20 weeks after its electron-cast release. For stale built-in security data Chrome
  degrades the same way: `ChromeCTPolicyEnforcer::IsLogDataTimely` in
  `components/certificate_transparency/chrome_ct_policy_enforcer.cc` treats its built-in CT log list as timely for 70 days
  (`(current_time - log_list_date_).InDays() < 70`), and an untimely build stops CT enforcement
  (`CT_POLICY_BUILD_NOT_TIMELY`) rather than refusing the connection. electron-cast does the same for revocation, and only
  when the fallback CRL is intact but past its window and the device sent no valid CRL. Still enforced: chain to a Cast
  root, the device certificate checks, the signature over this connection's TLS certificate, the device's own CRL
  (including revocation by it), and revocation by a fallback CRL that is still valid. `DeviceAuthResult.revocationChecked`
  is `false` in the skipped case.
- The fallback CRL's window starts at the package's build time, as Chromium's does at `base::GetBuildTime()`.
  `npm run build` runs `scripts/stamp-build-time.mjs` after `tsc`, which rewrites the one `BUILD_TIME = undefined`
  assignment in `dist/client/auth/build-time.js` and `dist/cjs/client/auth/build-time.js` (honouring
  `SOURCE_DATE_EPOCH`). The source keeps `undefined`, so tests and source checkouts use `FALLBACK_CRL_DEFAULT_BUILD_TIME`
  in `src/client/auth/trust-data.ts`, which still has to be refreshed with the fallback CRL on each release. Patching
  the emit keeps the working tree clean and needs no new dependency, and a published package carries the date of its
  own build, not of the last commit.
- ML-DSA and other post-quantum keys, and Merkle tree certificates, are not understood (BoringSSL's newer paths).
- As in Chromium, the reply's `signature_algorithm` field is ignored and a missing or different echoed nonce is
  tolerated (recorded in `deviceAuth.nonceEchoed`).

Namespaces (JSON payloads, `payload_type` STRING):

| Namespace | Messages |
|---|---|
| `urn:x-cast:com.google.cast.tp.connection` | `{type:"CONNECT", userAgent, connType, origin: {}, senderInfo}` opens a virtual connection to a destination id; `{type:"CLOSE"}` closes it. See [What the channel sends](#what-the-channel-sends-and-waits-for). |
| `urn:x-cast:com.google.cast.tp.heartbeat` | `PING` / `PONG`, sent from `sender-0` to `receiver-0`. A PING goes out after 5 s with nothing received; 10 s after the last message or completed keep-alive write the connection is dead. Answer the device's `PING` with `PONG`. |
| `urn:x-cast:com.google.cast.receiver` | `GET_STATUS`, `LAUNCH {appId, language, supportedAppTypes, appParams?}`, `STOP {sessionId}`, `SET_VOLUME {volume:{level}}` or `{volume:{muted}}`, `GET_APP_AVAILABILITY {appId:[…]}`. Replies: `RECEIVER_STATUS`, `LAUNCH_STATUS`, `LAUNCH_ERROR`, `INVALID_REQUEST`, and the availability reply. Requests carry an integer `requestId`; replies echo it. |

Ids: the platform receiver is `receiver-0`. Each sender uses `sender-<random>`. After `LAUNCH`, the app's
`transportId` from `RECEIVER_STATUS.status.applications[]` is the destination for a second `CONNECT` and for all app
namespace messages.

### What the channel sends and waits for

`CastClient` follows Chrome's `cast_channel` code for what it puts in its messages and for its timers. Everything below is
tested against a fake receiver. Tried on a Nest Hub Max: the CONNECT and LAUNCH of a session started by Google's SDK (accepted by the device), the close events of `Session.leave()` (`closed`) and `Session.stop()` (`terminated`), and the `USER_ALLOWED` launch status. Not yet tried on a real device: the approval wait of Android TV receivers, the declined and notification replies, and the timers.

| Rule | Where | Chromium |
|---|---|---|
| CONNECT carries `userAgent`, `connType` (0 strong, 2 invisible), `origin: {}` and `senderInfo` (`sdkType` 2, `version` and `browserVersion`, `platform` 3 on Windows, 4 on macOS, 6 on Linux, `connectionType` 1, and `systemVersion`, the first parentheses of the user agent) | `sender-info.ts` `connectFields` | `cast_message_util.cc`: `CreateVirtualConnectionRequest`, `GetVirtualConnectPlatformValue` |
| The connection to `receiver-0` is strong. The app's transport is strong too, and invisible only when the presentation URL says `invisibleSender=true` | `CastClient.connect`, `connectTransport(id, { invisible })` | `cast_message_util.cc`: `GetConnectionType`; `cast_activity_manager.cc`: `EnsureConnection`; `cast_media_source.cc`: `invisibleSender` |
| LAUNCH carries `language` (the locale), `supportedAppTypes` (`["WEB"]` when the URL names none) and `appParams` (the URL's JSON, left out when empty or `null`; text that is not JSON fails the launch with "Invalid JSON Format of appParams" before anything is sent) | `CastClient.launch`, `session-service.ts` `launchOn` | `cast_message_util.cc`: `CreateLaunchRequest`; `cast_activity_manager.cc`: `LaunchSession`; `cast_media_source.cc`: `SupportedAppTypesFromString` |
| `LAUNCH_STATUS` `USER_PENDING_AUTHORIZATION` and `USER_ALLOWED` keep the launch open and are reported (`LaunchOptions.onStatus` of the client; the session service and the mirroring manager raise and clear the sink's pending-authorization issue from it, once each: the Cast session launch and the mirroring launch are different paths). **The launch timeout is not extended**: its timer is started once, so a user who takes longer than the timeout makes the launch time out. Any other status fails the launch | `CastClient.handleLaunchStatus` | `cast_message_util.cc`: `GetLaunchSessionResponse`; `cast_message_handler.cc`: `AddLaunchRequest`; `cast_activity_manager.cc`: `HandleLaunchSessionResponseMiddleStages`, `SendPendingUserAuthNotification` |
| `LAUNCH_ERROR` with `extendedError` `USER_NOT_ALLOWED` or `USER_NOTIFICATIONS_DISABLED` are told apart (`CastLaunchError.failure`), and the page's request rejects with Chrome's text: "Failed to launch session as the user declined the cast request.", "Failed to launch session as the notifications are disabled on the receiver device.", "Failed to launch session due to timeout.", otherwise "Failed to launch session. " and the receiver's `error`. The page sees an `OperationError` (Chrome's `PresentationErrorType::UNKNOWN`) with that text | `CastClient.launch`, `session-service.ts` | `cast_activity_manager.cc`: `HandleLaunchSessionResponse`, `HandleLaunchSessionResponseFailures`; `start_presentation_context.cc`: `HandleRouteResponse`; `media_router_desktop.cc`: `RouteResponseReceived` |
| A launch waits for the URL's `launchTimeout` (60 s by default), never more than 2 minutes. Other requests (app availability, stop, volume, and status) wait 5 s | `CastClient` `launch`, `request` | `cast_media_source.h`: `kDefaultLaunchTimeout`; `cast_message_handler.cc`: `kLaunchMaxTimeout`; `cast_message_handler.h`: `kRequestTimeout` |
| Keep-alive: a PING after 5 s of silence, once (the timer is one-shot and the next message received starts it again); every message received restarts the ping and liveness timers; a keep-alive write that completes restarts the liveness timer only; one that fails closes the channel. A payload containing `PING` is answered with `PONG`, anything else in the heartbeat namespace is taken as a `PONG` | `CastClient.startHeartbeat`, `resetTimers`, `sendKeepAlive` | `keep_alive_handler.cc`: `Start`, `HandleMessage`, `ResetTimers`, `SendKeepAliveMessageComplete`, `LivenessTimeout`; `cast_message_util.cc`: `CreateKeepAliveMessage` |
| A close event carries blink's reason: `closed` for a page's `close()` and for `leave_session`, `wentaway` for a page that is destroyed (invisible: nobody is left to see it), and an empty message. `error` (`CONNECTION_ERROR`) is what Chrome gives a route whose launch failed, which has no page connection yet, so no page sees it. A session the receiver ends is `terminate`, which has no reason | `presentation-handler.ts` `Conn.end`, `main.ts`, `presentation-standin.ts` | `presentation_connection.cc`: `ConnectionCloseReasonToEnum`, `DoClose`, `CloseConnection`; `cast_activity.cc`: `HandleLeaveSession`; `cast_activity_manager.cc`: `RemoveActivity` |

Where electron-cast differs, on purpose or because Chrome's input is not there:

- Chrome takes the user agent, the browser version and the locale from the browser (`embedder_support::GetUserAgent`,
  `version_info::GetVersionNumber`, `GetApplicationLocale`, in `chrome_cast_message_handler.cc`). electron-cast builds the
  user agent as Chrome's reduced desktop one (`Chrome/<major>.0.0.0` with the unified platform token of
  `user_agent_utils.cc` `GetUnifiedPlatform`; whether Chrome's reduced form is on for every user was not checked in the
  source), takes the version from `process.versions.chrome` (empty in plain Node) and the locale from `Intl`. The app's own
  user agent, with its name and Electron's, is not sent.
- Chrome sends GET_STATUS without waiting for the reply. `CastClient.getStatus` waits for it, so it gets the same 5 s bound
  as the other requests.
- When the device's channel is lost, the session ends for the page as `disconnect_session` and a `closed` connection.
  Chrome ends it when the sink goes (`CastSessionTracker::OnSinkRemoved`, then `OnSessionRemoved`) as a
  `terminated` connection. This is not changed here.
- The stand-in reports whatever reason the main process sends (`closed`, `error` or `wentaway`; tested), but on the Cast
  route only `closed` reaches a page that is still alive; `wentaway` is sent for a sender that is gone, which no page sees.
- A join does not carry the source's `invisibleSender`: the transport of a joined session connects strong.

## Discovery layer (`src/discovery/`)

mDNS query for PTR `_googlecast._tcp.local`. A device is the join of PTR (instance name) → SRV (target host, port) →
A/AAAA (address) → TXT (`id`, `fn` friendly name, `md` model, `ca` capability bitmask, `rs` running app status,
`st`, `ve`, `ic`). Capability bits: 1 video out, 2 video in, 4 audio out, 8 audio in, 16 dev mode, 32 multizone
group. Groups (`ca & 32`, model `Google Cast Group`) share their leader's address but have their own port and id, so
devices are keyed by TXT `id`, never by address. TTL 0 is a goodbye.

Observed on real devices (fixtures in `test/fixtures/mdns/`):

- `ca` carries many more bits than the documented six (e.g. `464901`, `199204`); only test the documented bits.
- TXT `id` is 32 hex digits for single devices but a dashed UUID for groups: treat it as an opaque string.
- Fuchsia devices (Nest Hub family) answer with no question section, set the cache-flush bit (class `0x8001`), put
  several PTRs (the device plus every group it leads) in one packet, and send one A plus several AAAA records.
- On Windows a PC commonly has several adapters (Ethernet, Wi-Fi, Tailscale, WSL/Hyper-V virtual switches) and Cast
  devices answer on only one. Discovery must query and listen on every non-internal IPv4 interface; binding one
  default interface (what `multicast-dns` does) finds nothing on many machines.
- IPv6 and network changes. Besides IPv4, discovery joins `ff02::fb` on each adapter's link-local address (one
  socket per adapter; if that fails it is reported once and IPv4 carries on). `CastDevice.host` is IPv4 when the
  device has one (Chromium's Cast discovery resolves only A records, so IPv4 is what Chrome would use), else global
  IPv6, else link-local; `addresses` lists them in that order, newest first. Link-local AAAA records get the scope
  of the interface that heard them (`fe80::1%12`), which is what `tls.connect` needs. Devices are still keyed by
  TXT `id`, so a new DHCP address updates the same device (`deviceChanged`). When an interface disappears, devices
  that only it heard are removed at once rather than after their TTL, and a timer that fires far too late (the
  machine slept) makes discovery replace its sockets and query again.

### Device addresses

Chrome opens a Cast channel only to an address that is neither publicly routable nor loopback, unless the
`MediaRouterCastAllowAllIPs` policy is set: `CastMediaSinkServiceImpl::OpenChannel`
(`chrome/browser/media/router/discovery/mdns/cast_media_sink_service_impl.cc`) logs "Did not open a channel to the IP
endpoint" and reports the channel as not opened, so the sink never appears; the policy is wired in
`cast_media_sink_service.cc`. The predicates are `net::IPAddress::IsPubliclyRoutable` and `IsLoopback`
(`net/base/ip_address.cc`), ported in `src/discovery/ip-policy.ts`: IPv4 is routable unless inside one of
`kReservedIPv4Ranges` (`0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`,
`192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/3`); IPv6 only inside `2000::/3` and
`ff00::/8` (unique-local, link-local, `::`, `::1` are not), an IPv4-mapped address by its IPv4 part; a string that is not an
address counts as routable. Loopback is `127/8` and exactly `::1`, so `::ffff:127.0.0.1` passes, as in Chrome.
The sink service (`src/electron/sink-service.ts`, `openChannel`) applies them where Chrome does, to the endpoint it is
about to open, every time; with `sinks.allowAllIps` (`SetCastAllowAllIPs`) it does not.

## Polyfill layer (`src/polyfill/`)

Implements the legacy Chrome sender API (`chrome.cast`, API version `[1, 2]`), as documented at
https://developers.google.com/cast/docs/reference/web_sender/chrome.cast. String enums use the official lowercase
values (`"available"`, `"tab_and_origin_scoped"`, `"cancel"`, …). After install it sets `chrome.cast.isAvailable =
true` and calls `window.__onGCastApiAvailable(true)` if the page defined it. It covers sessions, custom namespace
messages, and `chrome.cast.media`: load and queue requests, playback commands, queue operations, media status
updates (applied to `Media` objects with update listeners), and media listeners on the session. Media traffic rides
the same bridge as everything else — JSON messages on `urn:x-cast:com.google.cast.media` — so no main-process change
was needed; joining a session sends a `GET_STATUS` when the receiver supports the media namespace.

Google's `cast_sender.js` loader checks for `navigator.presentation`, which Electron exposes, and then loads a
Presentation API based `chrome.cast` (`www.gstatic.com/eureka/clank/<version>/cast_sender.js`, or one of the Cast
extension URLs). That script replaces the polyfill's `chrome.cast` and finds no devices, because Electron has no Media
Router behind the Presentation API. The polyfill refuses those script URLs (through the `src` setter and
`setAttribute` on script elements) so the loader falls through to loading only `cast_framework.js`, and it calls
`__onGCastApiAvailable` once, after `DOMContentLoaded` if the page is still loading, for whichever function the page
assigns. The Cast Application Framework then runs on the polyfill.

## Presentation mode (default)

Google's `cast_sender.js` loader sees `navigator.presentation` and loads its Presentation API based SDK
(`www.gstatic.com/eureka/clank/<chrome major>/cast_sender.js`). That SDK implements `chrome.cast` on
`PresentationRequest` with URLs like `https://google.com/cast#__castAppId__=<appId>/__castClientId__=<id>/...`, and
talks to Chrome's Media Router over the `PresentationConnection` in a private JSON envelope
(`{type, message, sequenceNumber, timeoutMillis, clientId}`, defined in Chromium's
`cast_internal_message_util.cc`). Electron has the Presentation API but no Media Router, so electron-cast supplies
one:

- `src/polyfill/presentation-standin.ts` replaces `PresentationRequest`, `PresentationConnection`,
  `PresentationAvailability` and `navigator.presentation` in the main world. It checks the user gesture (as Blink does:
  `InvalidAccessError`; the preload stamps the real activation on the call and main refuses without it, see SECURITY.md
  "User gesture" for the trust boundary and the known gap against Chrome's browser-side check), allows
  one `start()` at a time, and moves strings over the bridge. It knows nothing about Cast.
- `src/electron/presentation-envelope.ts` parses the Cast presentation URLs and converts between the envelope and
  the session service's shapes. Examples: receiver labels are hashed, the media-command bitmask becomes strings, and
  null fields are stripped.
- `src/electron/presentation-handler.ts` (`CastPresentationHandler`) plays the Media Router's part on top of the
  session service: availability, start (picker, launch, `receiver_action` then `new_session`), reconnect
  (`auto-join` and `cast-session_<id>`), app and media messages with request id mapping, volume, leave and stop.
  Its interface (`getAvailability`, `startPresentation`, `reconnectPresentation`, and a connection with `send`,
  `close`, `terminate`, `onmessage` and `onclose`) is the one proposed to Electron as a native hook
  (not shipped). With that hook the stand-in would go away.

A navigation (a reload, say) ends the page's connections but parks its sessions instead of leaving them: they stay
open on the device, get no events, and the sender's next page rejoins them through auto-join or `joinSession`, as with
Chrome's Media Router. A parked session ends when the receiver app stops or the device drops, and is left for good when
the webContents is destroyed.

After an app restart nothing is persisted, as in Chrome. Chrome's `CastSessionTracker` learns the sessions running on
every sink from receiver status, and `CastActivityManager::AddNonLocalActivity` turns each into a non-local activity.
`FindActivityForAutoJoin` skips non-local activities (`route().is_local()`), so `reconnect("auto-join")` finds nothing;
`FindActivityForSessionJoin` accepts any activity by `cast-session_<id>`, and `AppActivity::CanJoinSession` checks only
the app, with no origin check. The handler's `reconnect("cast-session_<id>")` calls the service's `joinRunningSession`,
which joins a session it holds (no origin check either; `joinSession` of `mode: "chromecast"` keeps its own same-origin rule) or else asks each known device for its receiver
status and registers the session it finds. The one difference from Chrome: the lookup runs on request instead of
tracking every device continuously. The page must supply the id (Google's SDK stores nothing itself).

### Frames

Presentation mode follows Chrome: the Presentation API is scoped to a frame. In Chromium,
`PresentationServiceImpl` (`content/browser/presentation/presentation_service_impl.cc`) is created per
`RenderFrameHost`; it keeps that frame's availability listeners, passes `render_frame_host_->GetLastCommittedOrigin()`
as the request origin for start and reconnect, requires transient user activation on that frame
(`render_frame_host_->HasTransientUserActivation()`), and calls `controller_delegate_->Reset(process_id, frame_id)` when
the frame is destroyed or commits a non-same-document navigation (`DidFinishNavigation`). The controller delegate
(`components/media_router/browser/presentation/controller_presentation_service_delegate_impl.cc`) keeps one
`PresentationFrame` per `GlobalRenderFrameHostId`, and `PresentationFrame::Reset` detaches its routes rather than
terminating them, which is the "park" here. On the controller side only `SetDefaultPresentationUrls` is limited to the
outermost document (`is_outermost_document_`); electron-cast keeps the same rule for the default request (see
[Default presentation request](#default-presentation-request)).

electron-cast does the same:

- A sender is a frame. The main frame's sender id is its webContents id (unchanged). A subframe gets an id of its own
  (from 2^30 up), allocated on its first call and keyed by `frame.frameTreeNodeId`, which is browser-global and stays
  constant for the frame's lifetime across navigations and process swaps (`processId`/`routingId` change on a
  cross-process navigation, so they can't key a frame that must rejoin its session). The session service and the
  presentation handler still see plain numeric sender ids; only `main.ts` knows about frames (`registerSender`,
  `senderIdOf`, `deliver`).
- Events go to one frame: `webContents.send` for the main frame, otherwise `frame.send` on the frame found by
  `frameTreeNodeId` in `webContents.mainFrame.framesInSubtree` at send time (a held `WebFrameMain` goes stale when the
  frame navigates).
- Connections, watches and sessions are owned by the sender; `close`, `terminate` and `send` from another frame are
  ignored, and `senderFrame` of an IPC event is browser-provided, so a frame can't claim another's id. `allowOrigin` and
  the picker see the sending frame's own origin.
- `did-frame-navigate` for a subframe ends that frame's connections and parks its sessions (`senderNavigated`). A main
  frame `did-navigate` does that for the main frame and ends every subframe sender of that page (`senderGone`). A
  destroyed webContents ends all of them.
- Electron has no event for a removed iframe (only `frame-created`), so removed frames are found by sweeping: on every
  `did-frame-navigate`, and every 5 seconds (unref'd timer) while a subframe sender exists; a failed `frame.send` also
  ends the sender.
- The preload only runs in subframes if the app sets `webPreferences.nodeIntegrationInSubFrames: true`; without it
  iframes have no stand-in and behave as before. See the README.
- `mode: "chromecast"` (`<channel>:call`) stays main-frame only and refuses iframe calls.
- **Sandboxed iframes.** Blink's `PresentationRequest::Create` throws a `SecurityError` in a document whose sandbox lacks
  `allow-presentation` (`WebSandboxFlags::kPresentationController`, `presentation_request.cc`). A page cannot read its own
  sandbox flags, so the stand-in checks the one place they show: the `sandbox` attribute of its `<iframe>`, through
  `frameElement`, which a page may read only when its parent is same-origin (that is, when the iframe has `allow-same-origin`).
  Deviation, forced by the platform: a cross-origin parent, a `Content-Security-Policy: sandbox` header and an `<object>`
  are not seen, so there the stand-in lets the page construct a request where Chrome would refuse. The app's `allowOrigin`
  and `selectDevice` are still the gate, and an opaque-origin frame fails `allowOrigin` unless the app allows `"null"`.

Not done: Chrome also cancels a pending start whose frame navigated to another origin while the picker was open
(`HandleStartPresentationResponse` in the controller delegate); here a pending start is cancelled when the frame is
removed or navigates, not on an origin change alone.

### Default presentation request

Setting `navigator.presentation.defaultRequest` makes a page castable from the browser's own Cast dialog. Chromium
(checked against `main`, November 2026):

- `third_party/blink/renderer/modules/presentation/presentation.cc`, `Presentation::setDefaultRequest`: stores the
  request and always calls `PresentationService::SetDefaultPresentationUrls` with its URLs, or an empty list for
  `null`. The IDL (`presentation.idl`) types it `PresentationRequest?`, so another value is a `TypeError`.
- `content/browser/presentation/presentation_service_impl.cc`, `SetDefaultPresentationUrls`: ignored unless the frame is
  the outermost document; ignored when the list equals the one already set; otherwise builds a
  `content::PresentationRequest` (frame id, URLs, last committed origin) and passes it, with
  `OnDefaultPresentationStarted` as the callback, to `ControllerPresentationServiceDelegate::SetDefaultPresentationUrls`.
  `Reset` (a cross-document commit in the same frame, the frame going away) clears it.
- `components/media_router/browser/presentation/controller_presentation_service_delegate_impl.cc`: one delegate per
  `WebContents`, holding a single `default_presentation_request_`. `SetDefaultPresentationUrls` with no URLs clears it,
  otherwise stores it and calls `NotifyDefaultPresentationChanged`; `Reset` clears it only if the resetting frame owns it.
  `HasDefaultPresentationRequest` / `GetDefaultPresentationRequest` read it (`WebContentsPresentationManager`).
- `chrome/browser/ui/media_router/media_route_starter.cc`: `InitPresentationSources` and `OnDefaultPresentationChanged` turn
  the request's URLs into the `PRESENTATION` cast mode's sources; `CreateRouteParameters` finds the source for a sink
  (null, hence the "unable to cast" issue in `MediaRouterUI::CreateRoute`, when there is none); `StartRoute` calls
  `MediaRouter::CreateRoute` with `WebContentsPresentationManager::OnPresentationResponse` as the callback. Nothing on
  this path checks a user gesture.
- `OnPresentationResponse` (the delegate): ignores a result without a route or whose URL is not among the request's;
  records the presentation; and, if the default request equals the one started (`ArePresentationRequestsEqual`), runs
  the callback with a `PresentationConnectionResult`. `PresentationServiceImpl::OnDefaultPresentationStarted` forwards
  it, and `PresentationController::OnDefaultPresentationStarted` (Blink) returns if `defaultRequest` is null, else
  `ControllerPresentationConnection::Create`, which enqueues `connectionavailable` on the request as a task.

electron-cast:

- The stand-in's `navigator.presentation.defaultRequest` is an accessor with the same semantics, and sends
  `setDefaultRequest { urls }` over the bridge on every set. A `connectionavailable` event from main fires on the current
  default request after the current task; with no default request the connection is dropped (and closed in main), as Blink drops it.
- `main.ts` keeps a `DefaultPresentationRequests` (`default-presentation.ts`) keyed by `webContents.id`; a call from a
  subframe is ignored, an equal URL list is a no-op, an empty one clears. A main frame navigation or a destroyed window
  clears it (through the same `senderGone` that ends the page's connections).
- Chrome's launch details (`chrome/browser/media/router/providers/cast/cast_activity_manager.cc`,
  `cast_media_route_provider.cc`, `cast_app_availability_tracker.cc`, `cast_app_discovery_service.cc`,
  `components/media_router/common/providers/cast/cast_media_source.cc`, `chrome/browser/ui/media_router/media_router_ui_helper.cc`):
  `LaunchSession` launches even on a sink with a route and `DoLaunchSession` stops the frame's earlier route
  (`routes_by_frame_`); the launch timeout is the source's `__castLaunchTimeout__` or 60 s, not the dialog's 20 s
  (`GetRouteRequestTimeout`), which the provider ignores; a sink is offered for a source only when the device answered
  `GET_APP_AVAILABILITY` with the app and has the capabilities (`GetAvailableSinks`). The answers are kept in one place,
  `CastAppDiscovery` (`src/electron/app-discovery.ts`, Chrome's `CastAppDiscoveryServiceImpl` with its
  `CastAppAvailabilityTracker`), asked over the sinks' open channels: an available answer is kept, an unavailable one is
  asked again after 60 s (`kRefreshThreshold`, `ShouldRefreshAppAvailability`), an error is kept as `kUnknown` and always
  asked again, and an answer that was in flight when the sink's channel was replaced or the sink went is dropped (a
  generation counter per sink). `checkAppAvailability` asks one sink about one app; the page path observes sources.
- A page's `PresentationRequest` (`getAvailability()`, `start()`) is served by the same discovery: the handler observes
  the request's source (`StartObservingMediaSinks`: cached sinks at once, the source's new apps asked on every sink,
  `OnSinkAddedOrUpdated` asking the registered apps of a sink whose channel opened, `OnSinkRemoved` dropping a sink's
  answers), observers are told only when an app becomes or stops being available (`UpdateAppAvailability`), and the
  page only when its answer changes (`PresentationMediaSinksObserver::OnSinksReceived`). `start()` offers the sinks of
  the source. `discoverSinksNow()` refreshes (`Refresh`).
- `startCasting` follows `CreateRouteParameters` (a source for the sink, else `unable_to_cast`), launches through the
  session service's `requestSessionOnDevice` (the same code as `requestSession` with the picker's answer already
  known, reachable from main only), registers the connection like a page's `start()`, and announces it with a
  `connectionavailable` bridge event sent before the first message. As in `OnPresentationResponse`, it is announced only while the
  default request is still the one started. The route is a normal session, so routes observers need nothing more.

### Receiver labels, sink order and sink validation

- **The label token.** A receiver label is the hash of the sink id and a token (`GetReceiverIdHashToken`): 64 random bytes in
  base64, made on first use and kept in the profile's `media_router.receiver_id_hash_token` pref, so a page that remembers
  a `receiverLabel` finds the same one after a restart. **Deviation:** a library has no profile and writes no files of its
  own (it never imports Electron, so it has no `userData` path either). The app keeps the token through the
  `receiverIdHashToken` option (`load`, `save`), as it keeps remembered access code devices through `accessCode.store`;
  without it the token lasts for the process, which is what electron-cast did before (with 16 bytes). A store that throws
  does not stop casting: a token is made for the run.
- **Order.** The sinks the app is given (`registerMediaSinksObserver`, the `selectDevice` list, the wired display list)
  are sorted as `MediaRouterUI::OnSinksUpdated` sorts the dialog's: `MediaSink::CompareUsingCollator` compares the icon type
  (`cast`, `cast_audio_group`, `cast_audio`, `wired_display`, `generic`), then the names with the application locale's
  collator, then the sink ids. **Deviation:** the collator is `Intl.Collator()` in the runtime's default locale (Electron
  derives it from the app's locale), not an ICU collator created for `app.getLocale()`. `CastDeviceCache.devices()` stays
  sorted by name and id, as it is not a list shown to the app.
- **Validation.** `CreateCastMediaSink` rejects a device whose TXT record has no `id`, or no `fn` or an empty one, and one
  with no valid address; it requires nothing else (`md` and `ca` default to empty and 0). TXT entries are
  `service_data[key] = value` for each entry that has an `=`: keys are case-sensitive and the last repeat wins.

### Presentation sources

`src/electron/cast-media-source.ts` reads a Cast presentation URL as `CastMediaSource::FromMediaSource` does, and
`parsePresentationUrl` returns its fields under Chrome's names: `appInfos` (each app with the capabilities it needs),
`autoJoinPolicy`, `defaultActionPolicy`, `clientId`, `launchTimeout`, `targetPlayoutDelayMillis`
(`streamingTargetPlayoutDelayMillis`), `siteRequestedAudioCapture` (`streamingCaptureAudio=0` turns it off),
`supportedAppTypes` (default `["WEB"]`), `appParams` and `connectionType` (`invisible` for `invisibleSender=true`).
`appId` and `capabilities` are the first app's. The rules are Chrome's: a `cast:` URL's app is its whole path (not
unescaped, and a `(caps)` suffix is part of the id), its query values are unescaped with `+` as a space and the last
repeated key wins; the legacy form lists every `__castAppId__=ID(caps)`, unescapes each value, and takes the first pair of
a key; `streamingTargetPlayoutDelayMillis`, `streamingCaptureAudio`, `supportedAppTypes`, `appParams` and
`invisibleSender` are read only from a `cast:` URL; an unnamed or unknown auto-join policy is `page_scoped`; a number is
used only when `base::StringToInt` accepts it and it is above 0; a URL over 64 KB is refused. A sink is offered for a URL when
some app of it is available there and the sink has all of that app's capabilities
(`CastAppAvailabilityTracker::GetAvailableSinks`), and the app launched is `ChooseAppId`'s: the first the sink can run.
`streamingTargetPlayoutDelayMillis` and `streamingCaptureAudio` configure a page's site-initiated mirroring session
(see [Site-initiated mirroring](#site-initiated-mirroring-and-mirroring-to-flinging)): `main.ts` passes the parse's
`targetPlayoutDelayMillis`, `siteRequestedAudioCapture` and app infos to `siteMirroringSource`. `MirroringActivity::StartSession`
makes the session audio only when the sink has `audio_out` and `CastMediaSource::ProvidesStreamingAudioCapture()` holds
(the page did not say `streamingCaptureAudio=0`, and a streaming app of the URL requires `audio_out`), and gives the
service `target_playout_delay()`, which `MirrorSettings::GetVideoConfig` and `GetAudioConfig` put in each stream's
`targetDelay` of the OFFER. A `cast:` URL carries no capabilities (its `(caps)` text stays in the app id), so only the
legacy form can ask for sound. Tested: `test/electron/site-mirroring-offer.test.ts`.

Chrome's Cast provider builds a `CastMediaSource` from each presentation URL
(`components/media_router/common/providers/cast/cast_media_source.cc`, `FromMediaSource`): `remote-playback:` and plain
https URLs become tab-mirroring sources, a `cast:` URL one app (`ParseCastUrl`), the legacy `https://google.com/cast#` form
every `__castAppId__` (`ParseLegacyCastUrl`). `ContainsStreamingApp()` (exact match against
`openscreen::cast::GetCastStreamingAppIds()`: `0F5096E8`, `85CDB22F`) sends the whole source to a `MirroringActivity` in
`CastActivityManager::DoLaunchSession`, and `IsSiteInitiatedMirroringSource` restricts it to `kPresentationApiAllowlist`
origins (`CastMediaRouteProvider::GetOrigins`; for others `MediaSinksObserver::OnSinksUpdated` sees an empty list, so
availability is `UNAVAILABLE`). For `remote-playback:`, `CastMediaRouteProvider::OnSinkQueryUpdated` reports only sinks of
models known to remote the codec (`media::remoting`). electron-cast has no sink that mirrors or remotes, so
`src/electron/presentation-source.ts` classifies each URL the same way and the handler treats those as having no sink:
available `false`, `start` `NotFoundError` "No screens found." (`PresentationServiceImpl::StartPresentation`). Without a
controller delegate Electron's own browser side reports every URL `UNAVAILABLE`
(`PresentationServiceImpl::ListenForScreenAvailability`), so `video.remote` never lights up. Several URLs are separate
sources (`PresentationFrame` listens per URL; `PresentationAvailabilityState::GetScreenAvailability` is available when any
is), so the first ordinary one is served. Blink drops URLs of unknown protocol in the constructor
(`PresentationRequest::Create`, `IsKnownProtocolForPresentationUrl`: http family, `cast`, `cast-dial`), which the stand-in
repeats. A streaming URL is served as site-initiated mirroring for the allowlisted origins (docs, meet, music.youtube.com) when
the `mirroring` option is on (see [Site-initiated mirroring](#site-initiated-mirroring-and-mirroring-to-flinging)), and
reported unavailable otherwise. A plain https URL (Chrome's one-UA tab mirroring) is still rejected as
`NotSupportedError`, not `NotFoundError`. A `cast-dial:` URL is the DIAL kind (`MediaSource::IsDialSource`): with DIAL on,
`chooseSource` returns it next to the first Cast app URL and the sink the user picks decides which is used (see
[DIAL](#dial-srcdial)); with DIAL off it is a URL nothing here serves.
### Site-initiated mirroring and mirroring to flinging

Source: `src/electron/mirroring-to-flinging.ts` (the rules, pure), `presentation-handler.ts` (`startSiteMirroring`,
`fling`), `main.ts` (the wiring), `mirroring-manager.ts` (`startSiteInitiatedMirroring`, `switchToFlingingIfPossible`).
Tried on a Nest Hub Max for both: site-initiated mirroring from a local page with `AllowAllSitesToInitiateMirroring` (the OFFER's `targetDelay` was 300, frames flowed, `terminate()` from the page ended the route) and mirroring to flinging through the SDK's auto-join. Switching the mirrored tab to a window with a default request is unit-tested only.

**Site-initiated mirroring** (S1). A page may name a Cast Streaming app in its `PresentationRequest` URLs, as Google Meet
and Docs do ("Present to Cast"). `IsSiteInitiatedMirroringSource` (`cast_media_source.cc`) is any Cast Presentation URL
(`cast:` or the legacy `https://google.com/cast#` form) with a streaming app id (`0F5096E8`, `85CDB22F`). Chrome offers
the source's sinks only to the origins of `kPresentationApiAllowlist` (`CastMediaRouteProvider::GetOrigins`,
`cast_media_route_provider.cc`: `https://docs.google.com`, `https://meet.google.com`, `https://music.youtube.com`), or to
every origin when the feature `kAllowAllSitesToInitiateMirroring` (`AllowAllSitesToInitiateMirroring`, off by default) is
on. For any other origin the sinks are empty, so `getAvailability` says false and `start()` is "No screens found.". The
origin is compared as `url::Origin` is (scheme, host, port). The feature is read from `app.commandLine`
(`--enable-features`, a name also in `--disable-features` is off), through the `mirroring` option's `electron.app`.
No public option exists for any of it.

With the `mirroring` option on, such a URL from an allowed origin is a source like any other (URLs are served in order, a
streaming URL competing with ordinary ones): `getAvailability` follows the devices that have the app, and `start()` shows
the app's picker (Chrome's dialog is the consent; electron-cast has no other prompt) offering the same sinks, then
`CastActivityManager::DoLaunchSession` with a streaming source is `MirroringManager.startSiteInitiatedMirroring`: a tab
mirroring route whose source is the page's URL (`MirroringActivity::GetMirroringType`: "the source having a valid Cast
presentation URL indicates that it is site initiated mirroring, which we represent as tab mirroring here") and whose tab
is the page's window (`frame_tree_node_id` of the web contents' main frame, so an iframe's request mirrors the window).
The route obeys every mirroring rule (one per sink, one per page, the mirrored tab muted). `terminate()` on the page's
connection is `TerminateRoute`; `close()` only closes the connection (the route stays, as Chrome's `DetachRoute` is
`NOTIMPLEMENTED` for Cast); when the route ends the connection ends `terminated`. The default request of a window may be
a streaming URL as well: `startCasting` then starts this route and the page gets `connectionavailable`.

Differences, all of them narrower than Chrome:

- A URL with a `clientId` gets no `receiver_action` and `new_session` messages after the launch
  (`HandleLaunchSessionResponse` sends them whenever the client id is non-empty): the session belongs to the mirroring
  service and has no snapshot to send. The Cast SDK's own URLs always carry a client id but never name a streaming app;
  what Meet and Docs send could not be checked.
- A legacy URL that lists several apps keeps the capabilities of only the one electron-cast's own parser reads, and the
  app chosen is the first the sink can run (`ChooseAppId`). The streaming parameters of the URL are read (see the URL
  parameters section above).
- A mirroring route cannot be joined again with `reconnect` (Chrome's `FindActivityForSessionJoin` only finds a
  `cast-session_` id), and an auto-join naming a streaming URL answers "No matching route" (Chrome would launch the
  streaming app on the frame's sink again).

**Mirroring to flinging** (M5). A tab mirrored to a sink can turn into a real Cast session of the page's own app.
Two entry points, one rule (`CastActivityManager::JoinSession`, `cast_activity_manager.cc`):

- A join with the presentation id `auto-join` (what the Cast SDK's `initialize` sends through
  `PresentationRequest.reconnect("auto-join")`) first looks for an app activity to join
  (`FindActivityForAutoJoin`, the existing `initialize` rules); when there is none and the source's
  `defaultActionPolicy` is not `cast_this_tab`, and the page's frame has a mirroring route
  (`GetSinkForMirroringActivity`: the frame's own route in `routes_by_frame_`, when it is a mirroring one, which here is a
  tab route of the window), `LaunchSession` launches the app on that sink. The route keeps the presentation id
  `auto-join`, and the page's connection gets `receiver_action` (cast) then `new_session`, as for a `start()`. The
  launch ends the frame's mirroring route as `DoLaunchSession` does (before the LAUNCH is sent, as every session launch
  does). `cast_this_tab`, "mirror, not cast, despite the name" (`DefaultActionPolicy`), keeps the
  tab mirrored and the join fails with "No matching route". Only the exact string counts; any other value is
  `create_session`. `page_scoped` auto-join policy does not stop it: Chrome checks only that no activity was found.
- `SwitchToFlingingIfPossible` (`components/media_router/browser/mirroring_to_flinging_switcher.cc`) runs after
  `MirroringActivity::DidGetTabSourceId`, i.e. after `switchMirroringSourceTab` moved the capture to another window (and
  `OnSourceChanged` ended that window's own routes): if the window has a default presentation request, it joins with
  `auto-join` and the request's first URL ("TODO(crbug.com/1418744): Handle multiple URLs") and the result goes to the
  page as `OnPresentationResponse` does, only while that request is still the window's default one.

Differences: the sink is launched on whatever its capabilities are (Chrome's `ChooseAppId` only logs a mismatch) and
without asking whether it has the app. The mirroring route is stopped before the LAUNCH is sent (`onSessionLaunching`), as
`DoLaunchSession` does it: `JoinSession` only launches when `GetSinkForMirroringActivity` found the frame's mirroring route
in `routes_by_frame_`, so `DoLaunchSession` then finds that route there and calls `TerminateSession` on it, which sends the
STOP, and sends the LAUNCH right after it without waiting. Deviation: electron-cast waits for the STOP to be answered
before it sends the LAUNCH. Tried on a Nest Hub Max, Chrome's sequences all got `LAUNCH_ERROR` `CANCELLED` within 0.3 s:
STOP then LAUNCH back to back, with and without the transport CLOSE sent first, and a LAUNCH alone with the mirroring app
left to the receiver to replace (the `pending_activity_removal_` path of `LaunchSession`). Waiting for the STOP reply
worked in each run. Whether Chrome itself gets `CANCELLED` from that device is untested. A route the receiver ended
itself (what a LAUNCH from another sender does) is dropped with no STOP or CLOSE, as `OnSessionRemoved` does
(`MirroringActivity::onReceiverStatus`).

**The desktop capture escalation guard** (M6). `MediaRouterDesktop::JoinRoute` refuses, with `USER_NOT_ALLOWED` and the
text "Cannot switch to desktop capture without user consent", a join whose source is desktop mirroring unless the route
joined is itself desktop mirroring; auto-join, and a presentation id that names no route, always refuse
(`IsDesktopCaptureEscalation`, `media_router_desktop.cc`). The guard only looks at a join that has a provider (auto-join, a
`cast-session_` id, or an id some route has) and at least one route, as Chrome's check order does; the page sees
`NotFoundError` with that text (`OnJoinRouteResponse`). A page cannot name a desktop source (Blink drops presentation
URLs of an unknown scheme), so this only guards what reaches `reconnectPresentation` from the main process or a page
that bypasses the stand-in. Chrome's message for a join with no route at all is "Route not found"; electron-cast's is
"No matching route" (both `NotFoundError`).

## DIAL (`src/dial/`)

Chrome's Media Router has a second provider next to Cast: DIAL (Discovery and Launch), which starts an app on a TV
or dongle with an HTTP request. Google's SDK uses it when the page passes a `dialRequest`: the SDK then adds
`cast-dial:<appName>?dialPostData=<data>&clientId=<id>` to the `PresentationRequest`'s URLs next to the `cast:` one,
and the sink the user picks decides which URL is used. electron-cast follows Chrome's provider rule by rule. Paths
below are relative to the Chromium source root (read from `chromium/chromium` `main` when this was written).

| Part | electron-cast | Chromium |
|---|---|---|
| SSDP discovery | `dial-registry.ts`, `ssdp-socket.ts`: one UDP socket per external IPv4 address (the set mDNS uses), bound to an ephemeral port with broadcast on; four `M-SEARCH` requests to `239.255.255.250:1900` a second apart (`MX: 1`, `ST: urn:dial-multiscreen-org:service:dial:1`, `USER-AGENT: <product>/<version> <os>`, a trailing blank line); the cycle ends 2 s after the last one and the sockets close. | `chrome/browser/media/router/discovery/dial/dial_service_impl.cc` (`DialServiceImpl::Discover`, `BuildRequest`, `SendOneRequest`, `FinishDiscovery`, `DialSocket::CreateAndBindSocket`) |
| SSDP answers | `parse.ts` `parseSsdpResponse`: complete headers, a `LOCATION` that is an http(s) URL whose host is an IP literal that is not publicly routable and equals the sender, a `USN`; `ST` is not checked; `CACHE-CONTROL` max-age capped at 3600; `CONFIGID.UPNP.ORG` accepted when `0 < id <= (2 << 24) - 1`; a 1500-byte read buffer. | `dial_service_impl.cc` (`DialSocket::ParseResponse`), `dial_device_data.cc` (`DialDeviceData::IsValidUrl`) |
| Registry | A discovery cycle every 120 s; a device expires after 240 s or its max-age; at most 256 devices; keyed by `USN`, labelled by a counter; the list is published only when it changed (or when `discoverNow` forced it). | `dial_registry.cc` (`DialRegistry`, `PruneExpiredDevices`, `MaybeSendDeviceList`, `DiscoverNow`) |
| Network changes | `DialRegistry.onConnectionChanged`, from the manager's network monitor (`DialService.networksChanged`): each change first counts as offline, which reports `network_disconnected`, stops the periodic search (ending a cycle that is running), forgets every device and publishes the empty list, so the DIAL sinks go; then, when a network is up, discovery starts again: a search at once and the 120 s timer from then. With no network (`__disconnected__`) at `start()` or later, nothing is searched and `discoverNow` refuses. | `dial_registry.cc` (`OnConnectionChanged`, `StartPeriodicDiscovery`, `StopPeriodicDiscovery`, `ReadyToDiscover`, `Clear`); `net/base/network_change_notifier.h` (`OnNetworkChanged` is called with `CONNECTION_NONE` before every online type); `services/network/public/cpp/network_connection_tracker.cc` (`OnNetworkChanged` passes each one to `OnConnectionChanged`) |
| Device description | `dial-sink-service.ts`: `GET` without an `Origin` header, the `Application-URL` header validated like a `LOCATION` and stripped of a trailing slash, the XML parsed for `UDN`, `friendlyName` (else `<model> [<last 4 of UDN>]`), `modelName` and `deviceType`; cached 12 h by label and `CONFIGID`, 256 entries. | `device_description_fetcher.cc`, `device_description_service.cc` (`ValidateParsedDeviceDescription`), `safe_dial_device_description_parser.cc` |
| HTTP | `http.ts`: no redirects ("Redirect not allowed"), a 256 KiB body limit, a UTF-8 body, a `GET` with an empty body is an error, `GET` retried twice on 5xx, `POST` and `DELETE` not retried, `POST` as `text/plain`; an `Origin: package:Google-Chrome.<major>.<OS>` header on the app-info `GET`, `POST` and `DELETE` (not on the description `GET`), so a web page cannot make a browser do the same. | `dial_url_fetcher.cc` (`DialURLFetcher`, `GetFakeOriginForDialLaunch`) |
| App info | `parse.ts` `parseAppInfo`, `dial-sink-service.ts` `fetchAppInfo`: `<service dialVer>` with `name`, `options@allowStop`, `link@href`, `state` (`running` or `stopped`, any case; else invalid) and `additionalData`; the result is a `network_error` (no HTTP status), `http_error` (non-2xx) or `parsing_error` (2xx, unusable body). | `dial_app_discovery_service.cc`, `safe_dial_app_info_parser.cc`, `components/media_router/common/media_source.cc` (`GetDialAppUrl`) |
| Sinks | `dial-sink-service.ts`: sink id `dial:<UDN without "uuid:" and "-", lower case>`, icon `generic`, extra data `app_url`, `model_name`, `ip_address`; published 3 s after the last change; a sink is available for an app when app info said `running` or `stopped`, unavailable on an `http_error` or `parsing_error`, unknown on a `network_error`; app info is asked only while the answer is unknown, and never of `eureka dongle`, `chromecast audio` or `chromecast ultra`. | `dial_media_sink_service_impl.cc` (`OnDeviceDescriptionAvailable`, `OnDiscoveryComplete`, `FetchAppInfoForSink`, `GetSinkAppStatusFromResponse`), `media_sink_util.cc` |
| Cast/DIAL dedup | A DIAL sink whose uuid is the `id` of a Cast sink (processed the same way; a Cast sink is a device with an open, authenticated channel, not one mDNS merely heard) is removed from the DIAL sinks: when the Cast sink appears, and whenever DIAL discovery adds or updates it while the Cast sink is there. Nothing adds it back when the Cast sink goes; the next `OnDiscoveryComplete` does (a new device list, a description, or the timer a removal started). | `chrome/browser/media/router/discovery/mdns/cast_media_sink_service_impl.cc` (`OnChannelOpenSucceeded` removes the DIAL sink with the same id; `OnSinkAddedOrUpdated` -> `TryConnectDialDiscoveredSink` removes a DIAL sink that comes after the Cast one), `components/media_router/common/discovery/media_sink_service_base.cc` (`RemoveSinkById` starts the timer), `dial_media_sink_service_impl.cc` (`OnDiscoveryComplete` adds back the round's missing sinks) |
| Promotion to a Cast sink | `sink-service.ts` `onDialSinksChanged`, `tryConnectDialDiscoveredSink`, `isProbablyNonCastDevice`, `onOpened`: a DIAL sink that is new or changed (and every DIAL sink on `discoverSinksNow()`) is opened as a Cast device at its address on port 8009 (`openChannel(…, "dial")`), with the same retry and timeouts as an mDNS device. The Cast sink has the id of the DIAL sink without `dial:`, its friendly name and its model; once the channel authenticates it has audio out and, unless the device's certificate says audio only, video out. Skipped when a Cast sink has that id or that address (a second channel would be redundant and would end a session on the first). Every failed attempt (not each run) adds one to the device's DIAL count; at 10 the device is taken for a non-Cast device and not tried, whichever way the DIAL sink changes. Opening the device from anything but DIAL (mDNS, a reopen) clears the count, as does a network change. A success does not clear it. The DIAL sink is then removed (previous row). In Chrome this is always on desktop: `DualMediaSinkService` gives the DIAL sink service to `CastMediaSinkService` unconditionally, behind no flag. | `cast_media_sink_service_impl.cc` (`OnSinkAddedOrUpdated`, `TryConnectDialDiscoveredSink`, `CreateCastSinkFromDialSink`, `IsProbablyNonCastDevice`, `OpenChannel`, `OnChannelErrorMayRetry`, `OnChannelOpenSucceeded`, `OnNetworksChanged`, `DiscoverSinksNow`), `cast_media_sink_service_impl.h` (`kMaxDialSinkFailureCount` 10), `chrome/browser/media/router/providers/cast/dual_media_sink_service.cc` (`Initialize`), `chrome/browser/media/router/mojo/media_router_desktop.cc` (`InitializeDialMediaRouteProvider`) |
| Availability | `session-service.ts` `observeAppAvailability` (the same observation as a Cast source: the handler passes the request's DIAL app next to its Cast app), `origins.ts`: a `cast-dial:` source is available when a sink has the app; for `youtube`, `netflix`, `pandora`, `radio`, `hulu`, `vimeo` and `dailymotion` only to Chrome's list of origins (matched case-insensitively on the app name); a request with a Cast URL too is available if either is. Like Chrome's, the first DIAL answer is what is known now (the app query is still on its way); a DIAL sink that has the app answers yes at once, and a Cast URL next to it waits for the Cast sinks asked, as a Cast-only request does. | `chrome/browser/media/router/providers/dial/dial_media_route_provider.cc` (`StartObservingMediaSinks`, `GetOrigins`), `components/media_router/browser/media_sinks_observer.cc` (`OnSinksUpdated`) |
| Create a route | `route-provider.ts` `createRoute`: unknown sink, a source that is not a `cast-dial:` launch (the `clientId` is required) and a repeated route fail like `SINK_NOT_FOUND`, `NO_SUPPORTED_PROVIDER`, `ROUTE_ALREADY_EXISTS`; an existing route on the sink is terminated first; the page gets `receiver_action` (`cast`) and `new_session` at once. The route id is `urn:x-org.chromium:media:route:<presentation id>/<sink id>/<source>` and the presentation id `mr_<uuid>`. | `dial_media_route_provider.cc` (`CreateRoute`), `dial_activity_manager.cc` (`DialActivity::From`, `AddActivity`), `dial_internal_message_util.cc`, `components/media_router/common/media_route.cc` (`GetMediaRouteId`), `components/media_router/browser/media_router_base.cc` (`CreatePresentationId`) |
| The SDK's round trip | `client_connect` makes the provider fetch app info and send `custom_dial_launch` (`{receiver, appState, extraData}` with a fresh sequence number, remembered in a set of at most 10); the page answers with the same number and `{doLaunch, launchParameter}`; an answer to an unknown number is ignored. `dial_app_info` is answered with the app info or an `error` (`network_error`, `parsing_error`, `http_error` with `details.http_error_code`) under the same number. A failed fetch at `client_connect` sends nothing, as in Chrome, and the route stays. | `dial_media_route_provider.cc` (`HandleParsedRouteMessage`, `HandleClientConnect`, `HandleCustomDialLaunchResponse`, `HandleAppInfoRequest`), `dial_internal_message_util.cc` |
| Launch | `doLaunch: false` marks the route launched without a request; otherwise a `POST` to `<app url>/<app>` whose body is the launch parameter, else the source's `dialPostData` exactly as written in the source (Chrome reads the raw, still escaped query value); a `LOCATION` that is an http URL on the sink's own address becomes the run URL; a failed launch removes the route. | `dial_activity_manager.cc` (`LaunchApp`, `CustomDialLaunchMessageBody::From`, `DialActivity::From`) |
| Stop | A `v2_message` of type `STOP` or a page's `terminate()` sends `receiver_action` (`stop`) and `DELETE`s the run URL (`<app url>/<app>/run` when the launch gave none); a route that was never launched is dropped without a request; a failure looks at app info again and posts an issue unless the app is no longer running; the connection ends `terminated` either way. | `dial_media_route_provider.cc` (`DoTerminateRoute`, `HandleStopAppResult`), `dial_activity_manager.cc` (`StopApp`) |
| Join and close | `reconnect` with an `mr_` id joins the route with the same presentation id, source and origin and sends nothing; closing a connection, navigating or closing the page leaves the route and the app running. | `dial_media_route_provider.cc` (`JoinRoute`; `DetachRoute` is `NOTIMPLEMENTED`), `components/media_router/browser/presentation/controller_presentation_service_delegate_impl.cc` |

Differences from Chrome, and why:

- **Network changes are polled.** Chrome clears the DIAL failure counts when `DiscoveryNetworkMonitor` reports a new
  network id, and its `DialRegistry` restarts discovery when `NetworkConnectionTracker` reports a connection change; the
  manager's monitor drives both, by reading the interfaces (see
  [Network changes](#network-changes-network-monitorts)). A change of the network id stands for Chrome's
  `CONNECTION_NONE` then the new type; Node cannot tell a cellular connection apart, which Chrome never searches on.
- **Timeouts.** Chrome sets none on its URL fetches (`DialActivityManager::CreateFetcher` has a TODO for it); Node
  would wait forever, so a `GET` gives up after 10 s and a `POST` or `DELETE` after 30 s.
- **`setMulticastInterface`.** Each SSDP socket also pins its multicast sends to its interface, which Windows needs to
  send from the right adapter.
- **The `Origin` product.** `package:Google-Chrome.<major>.<OS>` is the syntax in `GetFakeOriginForDialLaunch`'s
  comment; `<major>` comes from the Chromium that Electron ships (`0` outside Electron).
- **Stop failures.** Chrome posts an issue (`IDS_MEDIA_ROUTER_ISSUE_CANNOT_TERMINATE`); the provider emits an `issue`
  event, which `createCastManager` raises as Chrome's "Use remote to stop casting" warning for the sink (see "Issues,
  policies and switches"), and rejects `terminateRoute`, and the connection still ends.
- **Volume.** A DIAL route has none, as in Chrome (`BindMediaController` is `NOTIMPLEMENTED`).
- **Errors never throw.** Chrome only logs a DIAL discovery error (`DialMediaSinkServiceImpl::OnDialError`) and a failed
  socket is closed while the others carry on (`DialSocket::CheckResult`, `DialServiceImpl::NotifyOnError`, which
  reports `DIAL_SERVICE_NO_INTERFACES` when no socket is left). The registry does the same, `DialService` logs through
  `dial.log`, and an empty interface list ends the cycle without an error (`DiscoverOnAddresses`).
- **Origins and bounds.** Chrome starts the app query for any page and filters the answer by origin on delivery
  (`StartObservingMediaSinks`, then `MediaSinksObserver::OnSinksUpdated`). Here nothing is queried for an origin that
  could not see the answer, at most 32 apps are monitored at once and 2048 app statuses are kept. A page can still make
  the devices answer app-info requests for app names no allowlist covers, as in Chrome.
- **A request waits for the devices.** Chrome's dialog observes the sinks of the source while it is open; a `start()`
  that finds no sink yet waits up to 5 s for the app answers instead of failing at once (and only when something is
  being asked, see above).
- **Cancelled requests.** Stopping the service aborts every request in flight. A route terminated while its launch
  `POST` is in flight cancels it, as erasing the record destroys the fetcher in `DialActivityManager::StopApp`; the
  device may still have started the app, which Chrome cannot tell either.
- **`mode: "chromecast"`.** Its sinks observers list DIAL sinks too (port 0, no capabilities); `createClient` and Cast
  sessions refuse such a device with an error.
- **The XML reader** (`xml.ts`) stands in for Chromium's out-of-process `data_decoder`: it refuses entity
  declarations, caps the depth and ignores namespaces.

## Electron layer (`src/electron/`)

No Electron import: both modules take the Electron objects they need as parameters, typed by small structural
interfaces, so the library has no Electron dependency and runs in plain Node.

- `main.ts`: `createCastManager({ ipcMain, selectDevice, allowOrigin?, discovery?, createClient?, channel?,
  presentation? })` returns `{ start, devices, dispose, ... }` (see MAIN-API.md). It registers one invoke handler on `<channel>:call`; events
  go back to the page on `<channel>:event`. Unless `presentation: false`, it also serves presentation mode:
  `<channel>:presentation` (invoke), `<channel>:presentation:send` (page to main) and `<channel>:presentation:event`
  (main to page). Each connection and availability watch belongs to one frame, and the others can't touch it. `selectDevice(devices, request)` resolves the user's choice: a device, `null` (maps to
  `chrome.cast.ErrorCode.CANCEL`) or `"stop"`
  (stop `request.session`, the sender's current session, which is set when the sender is already casting that app;
  picking that session's device returns it without relaunching). `allowOrigin(origin)` gates every call by the
  sender frame's origin. A sender is one frame (see Frames): the main frame leaves its sessions when its webContents is destroyed and parks them
  when it navigates (`did-navigate`); a subframe likewise on `did-frame-navigate` and removal.
- `preload.ts`: `installCastBridge({ contextBridge, ipcRenderer, channel?, mode?, bridgeKey?,
  presentationBridgeKey? })` exposes a bridge and, before page scripts run, installs the Presentation API stand-in
  (default) or, with `mode: "chromecast"`, the polyfill.

Main process:

<!-- no-check -->
```ts
import { ipcMain, BrowserWindow } from "electron";
import { createCastManager } from "electron-cast/main";

const manager = createCastManager({
  ipcMain,
  selectDevice: async (devices, request) => {
    const win = new BrowserWindow(); // your picker UI
    await win.loadFile("picker.html");
    return pickFromUI(devices, request); // or null for CANCEL
  },
  allowOrigin: (origin) => origin === "https://music.youtube.com",
});
await manager.start();
```

Preload script:

```ts
import { contextBridge, ipcRenderer } from "electron";
import { installCastBridge } from "electron-cast/preload"; // not the root: it loads node:tls, which a sandboxed preload cannot

installCastBridge({ contextBridge, ipcRenderer });
// the page now has chrome.cast; the bridge key defaults to "__electronCastBridge"
```

### Sinks and sessions (`sink-service.ts`, `session-tracker.ts`)

Chrome's Media Router does not look a device up when a page asks. It opens a channel to every device mDNS finds, lists
a device as a sink only when that channel is open and authenticated, keeps the channel open, and learns what each
device runs from the receiver status that comes over it. electron-cast does the same, with Chromium `main` (November
2026) as the reference. Paths are relative to the Chromium source root.

| Rule | Where here | Chromium |
|---|---|---|
| A channel is opened to each discovered device, after a random delay of up to 5 s so that many senders do not hit one receiver together | `CastSinkService.openChannelsWithRandomizedDelay` (`openDelayMaxMs`) | `chrome/browser/media/router/discovery/mdns/cast_media_sink_service_impl.cc`: `OpenChannelsWithRandomizedDelay`; `cast_media_sink_service.cc`: `OnDnsSdEvent` |
| The channel is a `CastSocket` that has passed device authentication (our `CastClient.connect()`); only then is the device a sink | `onOpened` | `cast_media_sink_service_impl.cc`: `OnChannelOpened`, which runs after `CastSocketImpl` finished the auth handshake (`components/media_router/common/providers/cast/channel/cast_socket.cc`) |
| A device that fails to open (a connect error or a failed authentication) is retried with `net::BackoffEntry`: 15 s initial, factor 1, 50% jitter, 30 s cap, 3 attempts, then it is dropped and never listed | `onOpenError`, `onOpenGaveUp` (`retry`) | `cast_media_sink_service_impl.h`: `RetryParams`; `.cc`: `OnChannelErrorMayRetry`, `OnChannelOpenFailed`; `net/base/backoff_entry.cc`: `CalculateReleaseTime` |
| Public and loopback addresses are skipped, unless the `kMediaRouterCastAllowAllIPs` policy is on | `openChannel` (`allowAllIps`) | `cast_media_sink_service_impl.cc`: `OpenChannel`; `cast_media_sink_service.cc`; `net/base/ip_address.cc`: `IsPubliclyRoutable`, `IsLoopback` |
| The sinks are reported to observers once discovery has been quiet for 3 s, and only when the list changed | `markChanged`, `report` (`reportDelayMs`) | `components/media_router/common/discovery/media_sink_service_base.cc`: `kDiscoveryTimeout`, `StartTimer`, `OnDiscoveryComplete` |
| mDNS forgetting a device does not close its channel or remove its sink. A sink is removed when its channel fails and cannot be reopened | `onClientClosed`, `removeSink` | `cast_media_sink_service_impl.cc`: `OnError` (reopens through `OpenChannel`), `OnChannelOpenFailed` |
| One channel per IP endpoint, shared by sink discovery and sessions. A sink whose address changed gets a channel to the new one; two ids at one address are one sink | `sinkMap`, `pending`, `onOpened` | `components/media_router/common/providers/cast/channel/cast_socket_service.cc`: `AddSocket`, `GetSocket`; `cast_media_sink_service_impl.cc`: `OnChannelOpened`, `UpdateCastSink` |
| The channel is kept alive: a PING every 5 s and a 10 s liveness timeout. A failure closes it, and the sink service reopens it | `CastClient` heartbeat, then `onClientClosed` | `cast_media_sink_service_impl.h`: `ping_interval_in_seconds` 5, `liveness_timeout_in_seconds` 10; `cast_socket.cc`: `KeepAliveDelegate`; `cast_media_sink_service_impl.cc`: `OnError` |
| When a sink is added or its channel opens, the device is asked for its receiver status | `CastSessionTracker.attach` | `chrome/browser/media/router/providers/cast/cast_session_tracker.cc`: `OnSinkAddedOrUpdated` -> `RequestReceiverStatus` |
| A status describes a session only if it has exactly one application with a session id, app id, transport id and display name, whose transport is not `receiver-0`, which is not the backdrop app and has namespaces (a multizone leader may have none). Cast's reserved namespaces are dropped except the media one | `sessionFromStatus` | `chrome/browser/media/router/providers/cast/cast_internal_message_util.cc`: `CastSession::From`; `cast_message_util.cc`: `IsCastReservedNamespace` |
| `MEDIA_STATUS` entries on the device's channel are merged by `mediaSessionId` into the session, fields an update lacks are kept, and a `supportedMediaCommands` bit mask becomes a list of names | `CastSessionTracker.applyMedia` | `cast_session_tracker.cc`: `HandleMediaStatusMessage`, `CopySavedMediaFieldsToMediaList`; `cast_internal_message_util.cc`: `CastSession::UpdateMedia`, `SupportedMediaCommandsToListValue` |
| Every receiver status that describes a session and every MEDIA_STATUS is passed on, changed or not; the media controller of any route, local or not, takes its volume and media status from them | `sessionStatus` and `mediaStatus` events, `createMediaControllers` | `cast_session_tracker.cc`: `HandleReceiverStatusMessage` (`OnSessionAddedOrUpdated`), `HandleMediaStatusMessage` (`OnMediaStatusUpdated`); `cast_activity_manager.cc`: `BindMediaController`, `AddNonLocalActivity`; `app_activity.cc`: `OnSessionUpdated`, `SendMediaStatusToClients`; `cast_media_controller.cc`: `SetSession`, `SetMediaStatus` |
| A session no page of this app holds is a route anyway, with no page and not local; its description is the status text, else the display name. It stays while the device runs it | `CastSessionService.mediaRoutes`, `nonLocalRouteOf` | `chrome/browser/media/router/providers/cast/cast_activity_manager.cc`: `AddNonLocalActivity`, `OnSessionAddedOrUpdated`; `cast_internal_message_util.cc`: `GetRouteDescription` |
| `joinRunningSession` joins a session the tracker already knows, by id and app, with no origin check and no scan. An unknown id, or another app's session, finds nothing | `handleJoinRunningSession` | `cast_activity_manager.cc`: `FindActivityForSessionJoin`; `app_activity.cc`: `CanJoinSession` |
| A non-local route can be terminated (the receiver's `STOP`) and have its volume set, over the device's own channel | `terminateSession`, `setSessionVolume` | `cast_activity_manager.cc`: `TerminateSession` |

Resources: a device costs one TLS connection and one 5 s ping, as in Chrome, however many pages there are. Everything
is released when a sink is removed, on `dispose()` (every channel is closed, timers are cleared) and after sleep: the
first missed ping closes the channel and the reopen runs the retry policy, so a device that is back is listed again and
one that is not is dropped after three attempts. Chrome has no setting that disables this or caps the number of
channels, so there is none here either; `allowAllIps`, `sinks.retry`, `sinks.openDelayMaxMs` and `sinks.reportDelayMs`
mirror what Chrome tunes.

Where electron-cast differs from Chrome here:

- Chrome's connect and liveness timeouts can grow with each failed attempt on a sink (`failure_count_map_`, at most 100,
  times `OpenParams::dynamic_timeout_delta_in_seconds`, capped at `kMaxConnectTimeoutInSeconds` 30 and
  `kMaxLivenessTimeoutInSeconds` 60 in `CreateCastSocketOpenParams`), but that delta is 0 and nothing in the fetched
  sources sets it, so Chrome's timeouts stay 10 s. The same mechanism is here (`sinks.dynamicTimeoutDeltaMs`, default 0;
  each run of attempts keeps the parameters it began with, as the `open_params` carried through
  `OnChannelErrorMayRetry`) and the timeouts reach `createClient` as its second argument.
- When a sink's endpoint changes, Chrome's `OnChannelOpenSucceeded` just adds the sink with the new channel and leaves the
  old socket alone, so a session on it goes on. Here the replaced channel stays open while a session uses it and closes
  when the last one ends (`CastSinkService.releaseUnused`, `channelRetired`), or on `dispose()`.
- mDNS lists a device's addresses in no fixed order, and a Chrome sink has one address, so there is no Chrome counterpart
  to a reorder. A sink keeps its endpoint while the device still offers it (same port, host among its addresses): only the
  other details are updated, as `OpenChannel` does for an unchanged endpoint, and a reopen uses that endpoint too.
- A retry waiting out its backoff is dropped when the device has meanwhile been reached at another endpoint or discovery
  names another one; Chrome's `OnChannelOpenFailed` ignores a failure whose endpoint is no longer the sink's for the same
  reason, but still re-runs the stale `OpenChannel`.
- A channel is opened to IP addresses only, as Chrome's `IPEndPoint` is. A device whose host is a name (a custom
  discovery) is skipped with a `skipped` event and one `console.warn` per device; `isPubliclyRoutable` answers for IP
  literals only. Chrome logs the same kind of skip in `OpenChannel` (`LoggerList`).
- A route whose channel is down (the sink stays listed while it is reopened, as in Chrome) stays listed. Terminating it
  fails with `session_error` and Chrome's message: `CastMessageHandler::StopSession` finds no socket and reports a
  failure, and `CastActivityManager::HandleStopSessionResponse` turns that into "StopSession response is not OK. Failed
  to terminate route." and keeps the activity.
- A page's own launch is not listed as a non-local route while it is in flight: the status the launch causes reaches the
  tracker before the page's session record exists. Chrome has the activity before the launch (`DoLaunchSession` adds it
  first), so the route is never non-local there.
- `CastSession::UpdateSession` keeps the old session id and app when another session shows up on a device, which would
  leave the tracker naming a session the device no longer runs; a different session replaces the old one here.
- A status with several applications is never a session, so such a session cannot be joined (as in Chrome).
- The tracker asks for status when a channel opens and then follows what the device pushes; Chrome asks again whenever
  a sink is added or updated (`OnSinkAddedOrUpdated`), including when only its name changed.
- The snapshot of a session this app started still passes the app's namespaces unfiltered, as before.

### Network changes (`network-monitor.ts`)

Chrome's `DiscoveryNetworkMonitor` (`chrome/browser/media/router/discovery/discovery_network_monitor.cc`) keeps one
network id for the machine and tells its observers when it changes. electron-cast has the same monitor, one per manager:
`createCastManager` makes it, `start()` starts it and `dispose()` stops it. There is no method for the app to call.

| Rule | Here | Chrome |
|---|---|---|
| The network list | `discoveryNetworkInfoList`: each interface that is not loopback and has a MAC address, with an id; sorted by id | `GetDiscoveryNetworkInfoList` (`discovery_network_list_win.cc`, `discovery_network_list_posix.cc`): Ethernet and Wi-Fi interfaces that are up, each with its SSID (Wi-Fi) or MAC address; `StableSortDiscoveryNetworkInfo` sorts by id |
| The network id | `computeNetworkId`: `__disconnected__` for an empty list, `__unknown__` when no network has an id, else the hex SHA-256 of `"!" + id` for each network in order | `ComputeNetworkId`, `kNetworkIdDisconnected`, `kNetworkIdUnknown` |
| When observers hear | only when the recomputed id differs from the last; the first id is taken without telling anyone | `UpdateNetworkInfo`, run on every `OnConnectionChanged` from the `NetworkConnectionTracker`; the monitor is one per browser and has its id before a profile's services observe it |
| The Cast sinks | the DIAL failure counts are cleared; the sinks of the network being left are kept by its id (not those added by access code); on coming back to a known network its sinks are opened again after the usual random delay. The sinks are not cleared and discovery is not restarted | `CastMediaSinkServiceImpl::OnNetworksChanged` (`dial_sink_failure_count_`, `sink_cache_`, `OpenChannelsWithRandomizedDelay` with `SinkSource::kNetworkCache`); its `Start` asks `GetNetworkId` first |
| Devices added by address | those with no route are removed, and the remembered ones are added again 4.45 s later | `AccessCodeCastSinkService::OnNetworksChanged` (`kExpirationDelay` + `kNetworkChangeBuffer`) |

| DIAL discovery | each change forgets the DIAL devices and, with a network up, searches at once; no search while disconnected (the "Network changes" row of [DIAL](#dial-srcdial)) | `DialRegistry::OnConnectionChanged`, an observer of the `NetworkConnectionTracker` rather than of this monitor |

These are the only two observers of the monitor in Chrome; DIAL follows the connection tracker, which the manager's
monitor stands in for. Differences, and why:

- **A poll, not an event.** Chrome recomputes when `NetworkChangeNotifier` reports a connection change; Node and
  Electron have no such event, so the monitor reads `os.networkInterfaces()` every 5 s (`NETWORK_POLL_MS`). A change is
  seen up to 5 s late, and a drop and return within one interval is not seen.
- **MAC and IPv4 network instead of SSID.** Node reports neither an interface's type nor its Wi-Fi SSID. An interface
  counts when it is not loopback and has a MAC address (tunnels have none), and its id is the MAC with the IPv4 networks
  it is on (address and netmask, so a new DHCP address on the same network is no change). Joining another Wi-Fi network
  is a change when its subnet differs, which Chrome sees by SSID; two networks with the same subnet on one adapter look
  the same. Virtual adapters with a MAC (Hyper-V, WSL, some VPNs) count, where Chrome counts Ethernet and Wi-Fi only.
- **Off with a custom `discovery`**, as DIAL is, unless `networkMonitor` is given; `networkMonitor: false` turns it off.

### Access code casting (`access-code.ts`)

Chrome can cast to a device that mDNS does not reach, by typing the code the device shows on its screen. Chrome calls this
Access Code Cast (the product around it is Cast Moderator). It is two things, and only the second is here. Chromium `main`
(November 2026); paths are relative to the Chromium source root, under
`chrome/browser/media/router/discovery/access_code/` unless a path is given.

**1. Turning a code into an address: not supported.** Chrome sends the code to Google's `castedumessaging-pa.googleapis.com`
(`access_code_cast_constants.cc`: `kDefaultDiscoveryEndpoint`, `kDiscoveryServicePath`; a `GET /v1/receivers/<code>` built in
`access_code_cast_discovery_interface.cc`: `CreateEndpointFetcher`) with an OAuth token of the signed-in Chrome profile
(`SetAuthType(OAUTH)`, `ConsentLevel::kSignin`, consumer `OAuthConsumerId::kAccessCodeCastDiscovery`, whose only scope is
`https://www.googleapis.com/auth/cast-edu-messaging`, `google_apis/gaia/oauth_consumer_registry.cc`). Without a signed-in
profile the flow stops before the request (`ui/webui/access_code_cast/access_code_cast_handler.cc`: `IsPrimaryAccountSignedIn`,
`PROFILE_SYNC_ERROR`). The service is an internal Google one (`discovery_resources.proto` points at a google3
`discovery_service.proto`) with no public documentation and no key for apps; the token comes from Chrome's own sign-in and
OAuth client, which an Electron app does not have and must not borrow. The feature is also off unless an administrator sets
`AccessCodeCastEnabled` (default false, for `chrome.*` and `chrome_os` from 102, per profile;
`components/policy/resources/templates/policy_definitions/GoogleCast/`), and it is not built on Android
(`access_code_cast_feature.cc`: `!BUILDFLAG(IS_ANDROID)`). So electron-cast cannot resolve codes. The only override is
`--access-code-cast-url`, which Chrome honours on non-stable, non-beta builds only (`access_code_cast_constants.cc`:
`IsCommandLineSwitchSupported`), and it points at the same kind of service.

**2. Adding the device it names: here, with the address supplied by the app.** What the server returns is a device id, a
name, capabilities and a network address (`discovery_resources.proto`: `DiscoveryDevice`, `NetworkInfo`). Everything after
that is a normal Cast sink and does not depend on Google: `CreateAccessCodeMediaSink` builds a `MediaSinkInternal` from it,
`AddSinkToMediaRouter` has `CastMediaSinkServiceImpl::OpenChannel` open a Cast channel to the address, and the sink is listed
like an mDNS one. `CastManager.addSinkByAddress(device)` does that part; where the address comes from (a directory, a
config, the user typing an IP address) is up to the app. The device then goes through the same picker and the same
Presentation API availability as any other: `CastAppDiscoveryServiceImpl` asks every sink of `CastMediaSinkServiceImpl` for
app availability (`providers/cast/cast_app_discovery_service.cc`: `StartObservingMediaSinks`, `Refresh`), whatever its
`discovery_type`, and `CastActivityManager` uses the type only for metrics. Chrome's own entry point is a separate dialog in
the Cast menu (`chrome/browser/ui/webui/access_code_cast/`); a page cannot open it, and the app's picker takes its place here.

Mind what "another network" means: the server returns the address the device has registered, and Chrome opens a channel to
it by the same rule as for any sink, which refuses public and loopback addresses unless `MediaRouterCastAllowAllIPs` is set
(`mdns/cast_media_sink_service_impl.cc`: `OpenChannel`). So this reaches devices that are routable but not on mDNS's
multicast domain (another VLAN or subnet, as in a school or office); it does not traverse NAT, and a public address needs
`sinks.allowAllIps`.

| Rule | Where here | Chromium |
|---|---|---|
| Access code casting is off unless enabled; with it off nothing is added, remembered or timed (default `false`) | `accessCode.enabled`, `AccessCodeCastDisabledError` | `access_code_cast_feature.cc`: `GetAccessCodeCastEnabledPref`; `access_code_cast_sink_service_factory.cc`: `GetForProfile`, `BuildServiceInstanceForBrowserContext`; `AccessCodeCastEnabled.yaml` |
| The device must be an object with a string name and id and a capabilities object whose present values are booleans; otherwise the reply is malformed | `createAccessCodeSink` (`response_malformed`) | `access_code_cast_discovery_interface.cc`: `ConstructDiscoveryDeviceFromJson` |
| A sink needs, in this order: an IP literal (IPv6 preferred over IPv4), a non-empty id, a non-empty name, a port (a decimal integer in 0..65535, default 8009) | `createAccessCodeSink` (`sink_creation_error` and its `reason`) | `access_code_media_sink_util.cc`: `CreateAccessCodeMediaSink`, `GetIPAddress`; `net/base/port_util.cc`: `IsPortValid`; `mdns/media_sink_util.cc`: `CreateCastMediaSinkResult` |
| The id is processed as an mDNS id is (`uuid:` and dashes dropped, lower case) and put in angle brackets as the sink id (`cast:<%s>`; an mDNS sink is `cast:%s`); the model name is `Chromecast Cast Moderator`; capabilities are the five flags as the same bits an mDNS `ca` record has | `createAccessCodeSink` | `access_code_media_sink_util.cc`: `kDefaultAccessCodeModelName`, `ConvertDeviceCapabilities`; `components/media_router/common/discovery/media_sink_internal.cc`: `ProcessDeviceUUID` |
| A device already listed keeps its channel (and endpoint); only its name and capabilities are refreshed, and its stored data and time are replaced | `addSinkToMediaRouter`, `updateExistingSink` | `access_code_cast_sink_service.cc`: `OpenChannelIfNecessary`, `UpdateExistingSink` |
| Otherwise a channel is opened with its own quick parameters: connect 2 s, liveness 8 s, ping 4 s, retried 1 s apart (50% jitter, no growth) up to the sink service's 3 attempts; a failure is `channel_open_error` | `CastSinkService.openSink` (`params`, `backoff`), `MANUAL_ENTRY_PARAMS`, `MANUAL_ENTRY_BACKOFF` | `access_code_cast_sink_service.cc`: `kConnectTimeoutInSeconds`, `kPingIntervalInSeconds`, `kLivenessTimeoutInSeconds`, `backoff_policy_`, `OpenChannelIfNecessary`, `OnChannelOpenedResult`; `cast_media_sink_service_impl.cc`: `OnChannelErrorMayRetry` |
| The address rules of discovered devices apply: a public or loopback address is not opened to | `CastSinkService.openChannel` | `cast_media_sink_service_impl.cc`: `OpenChannel` |
| A device added by code is remembered with its addition time; another entry at the same IP endpoint is replaced | `storeSinkInPrefs`, `AccessCodeStore` | `access_code_cast_pref_updater_impl.cc`: `UpdateDevicesDict`, `UpdateDeviceAddedTimeDict`; `access_code_cast_pref_updater.cc`: `GetMatchingIPEndPoints` |
| It stays listed for `deviceDuration` seconds from when it was added (policy default 0) plus 20 s, so that a route can be created first | `setExpirationTimer`, `durationTillExpiration` (`accessCode.deviceDuration`) | `access_code_cast_sink_service.cc`: `DoSetExpirationTimer`, `DoCalculateDurationTillExpiration`; `access_code_cast_sink_service.h`: `kExpirationTimerDelay`; `AccessCodeCastDeviceDuration.yaml` |
| When the time is up, a device a page is casting to (a local route) stays until that route ends; any other is forgotten and its channel removed 450 ms later | `onExpiration`, `expireSink`, `removeAndDisconnectMediaSinkFromRouter` | `access_code_cast_sink_service.cc`: `OnExpiration`, `ExpireSink`, `RemoveAndDisconnectMediaSinkFromRouter`, `kExpirationDelay` |
| When a route to such a device ends, after 450 ms with no new route its time is checked and, if up, it expires at once | `onRoutesUpdated`, `checkMediaSinkForExpiration` | `access_code_cast_sink_service.cc`: `AccessCodeMediaRoutesObserver::OnRoutesUpdated`, `HandleMediaRouteRemovedByAccessCode`, `OnAccessCodeRouteRemoved`, `DoCheckMediaSinkForExpiration` |
| Remembered devices are read when the service starts (entries that do not validate are dropped), added again with the sink service's usual open parameters, and their timers set | `AccessCodeSinks.load`, `initAllStoredDevices` | `access_code_cast_sink_service.cc`: `InitAllStoredDevices`, `ValidateStoredDevices`; `access_code_media_sink_util.cc`: `ParseValueDictIntoMediaSinkInternal` |
| A network change removes the devices that have no route, and after 4.45 s the remembered ones are added again | `onNetworksChanged`, from the manager's network monitor | `access_code_cast_sink_service.cc`: `OnNetworksChanged`, `RemoveAndDisconnectExistingSinksOnNetwork`, `kNetworkChangeBuffer` |
| The policies apply while running: disabling removes and forgets every device, a new duration resets every timer | `configureAccessCode` | `access_code_cast_sink_service.cc`: `OnEnabledPrefChange`, `OnDurationPrefChange` |

Where electron-cast differs from Chrome here:

- The device arrives as an object, not as the server's JSON, so `networkInfo` and `deviceCapabilities` are flat fields and
  the "no network info / no capabilities" results (`kMissingNetworkInfo`, `kMissingDeviceCapabilities`) cannot occur: a
  missing capabilities object is `response_malformed`, as a missing dict is in `ConstructDiscoveryDeviceFromJson`. A port
  may be a number as well as the server's string; Chrome would ignore a number and use 8009, which here would hide a typo.
  An address that is not a string counts as absent, as in Chrome.
- Chrome names an access code sink `cast:<uuid>`, with literal angle brackets, where an mDNS sink is `cast:uuid`, so a
  device found both ways is two sinks until the same-address rule removes one. That is kept: electron-cast's mDNS ids have
  no `cast:` scheme, so an address-added sink is `<uuid>`. As a guard Chrome does not need, the service only remembers and
  expires a sink it opened itself; an already listed sink with the same id (a custom discovery could produce one) is only
  refreshed, so an expiry timer can never remove a device discovery found.
- Chrome does not check the address beyond `OpenChannel`'s rule (below), and its server is trusted to name real devices.
  Here the address comes from the app, so the app must validate what a user typed: private addresses and any port pass
  Chrome's rules, so an unchecked address turns `addSinkByAddress` into a probe of the LAN (a TLS connection to any
  host and port, and the error says whether it answered). An IPv4-mapped IPv6 address is judged by the IPv4 address in it
  (`net/base/ip_address.cc`: `IsPubliclyRoutableIPv6`); `IsLoopback` does not look inside it.
- The prefs become `AccessCodeStore` (`load` once when enabled, `save` the whole list after each change), with the app
  deciding where it lives; one entry holds the data of Chrome's two dictionaries. The default store is memory.
- Chrome learns of a network change from `DiscoveryNetworkMonitor`; the manager's monitor polls for it (see
  [Network changes](#network-changes-network-monitorts)).
- The result is reported after the device is remembered and its timer set; Chrome reports first.
- Chrome's metrics, its `chrome://media-router-internals` log (here the optional `accessCode.log`), its offline check
  (`SERVICE_NOT_PRESENT`) and the dialog that goes on to start a route are not here: the app starts a cast through its own
  picker once the device is listed.

### Issues, policies and switches (`issues.ts`, `switches.ts`, `logger.ts`)

Tried on a Nest Hub Max: a failed launch (an app the device does not have) raises "Failed to cast. Please try again." for that sink as a warning, and the log and provider state show it. Not tried on a real device: the other issues, the 1 and 5 minute dismissals, and the policies and switches other than `AllowAllSitesToInitiateMirroring`. Chromium `main` (November 2026).

**Issues.** `IssueManager` (`components/media_router/browser/issue_manager.cc`) is ported whole: issues are deduplicated by
value (`IssueInfo::operator==`), the top issue is the oldest (the lowest id), an observer is told of the top issue
when it changes (`onIssue`) or when none is left (`onIssuesCleared`) and of the current one when it registers, a
notification goes after 60 s and a warning after 300 s, and `AddPermissionRejectedIssue` replaces every issue and has no
timeout. The main-process API is `registerIssuesObserver`, `clearIssue` and `clearTopIssueForSink`. The titles are
Chrome's English strings (`media_router_strings.grdp`); there is no localization.

Where Chrome raises an issue, and where this library does:

| Chrome | Issue | Here |
|---|---|---|
| `CastActivityManager::SendFailedToCastIssue` (a failed launch, `HandleLaunchSessionResponseFailures`) | warning "Failed to cast. Please try again." (not for a declined request or disabled notifications) | A failed launch in `session-service.ts` (page and `startCasting` paths) and in `mirroring-manager.ts` |
| `SendPendingUserAuthNotification`, and `kUserAllowed` clearing it (`ClearTopIssueForSink`) | notification "Accept cast request on <device>" | `LAUNCH_STATUS` `USER_PENDING_AUTHORIZATION` / `USER_ALLOWED` of the launch |
| `MediaRouterUI::SendIssueForRouteTimeout`, `SendIssueForUserNotAllowed`, `SendIssueForNotificationDisabled` | notification (timeout), warnings | The same launch failures, by `extendedError` (`USER_NOT_ALLOWED`, `USER_NOTIFICATIONS_DISABLED`) or a timeout; a DIAL launch that times out raises the timeout one |
| `MediaRouterUI::SendIssueForUnableToCast` | warning | `startCasting` rejecting with `unable_to_cast` |
| `MediaRouterUI::SendIssueForScreenPermission` (macOS) | warning | `startCasting` for `desktop_mirror` when `getMediaAccessStatus("screen")` is not `granted`; see S12 below |
| `CastActivityManager::MaybeShowIssueAtLaunch` (macOS, desktop audio) | notification | A desktop mirroring launch on macOS without audio |
| `DialMediaRouteProvider::HandleStopAppResult` | warning "Use remote to stop casting" | The provider's `issue` event, which `createCastManager` now sends to the issue manager (the event itself stays) |
| `MediaRouterDesktop::OnLocalDiscoveryPermissionRejected` | the permission-rejected issue | A discovery source's `permissionRejected` event, behind `ShowCastPermissionRejectedError` |
| `MediaRouterUI::CreateRoute` | `ClearAllIssues` | When a device is chosen and before a route is started |

Chrome raises nothing in the access code paths and nothing for a mirroring session that fails after the launch (only the
log, checked in `access_code_cast_sink_service.cc` and `mirroring_activity.cc`), so none is raised here either.

Differences: (1) A presentation route is the Cast session id here, which exists only once the launch succeeded, so the
"Failed to cast" issue of a failed page launch has an empty `routeId` and repeated failures for one sink are one issue (a
mirroring route has Chrome's id). (2) A presentation `startCasting` rejects with the codes the bridge already had;
`user_not_allowed` and `notification_disabled` are raised as issues but not as new rejection codes. (3) Issue ids are a
process-wide counter, as in Chrome, so two managers in one process share it.

**Policies and switches.** An Electron app has no enterprise policy store, so each policy is an option of
`createCastManager`, and a Chrome switch or feature is read from `app.commandLine` (the `commandLine` option, which
defaults to `mirroring.electron.app.commandLine`; a feature named in both `--enable-features` and `--disable-features` is
disabled).

| Chrome | electron-cast |
|---|---|
| `MediaRouterCastAllowAllIPs` policy, else `CastAllowAllIPs` feature (`GetCastAllowAllIPsPref`) | `sinks.allowAllIps` when given, else `--enable-features=CastAllowAllIPs` |
| `AccessCodeCastEnabled`, `AccessCodeCastDeviceDuration` policies | The `accessCode` options `enabled` and `deviceDuration` (and `configureAccessCode`), as before |
| `EnableMediaRouter` policy, `MediaRouter` feature (`MediaRouterEnabled`) | `--disable-features=MediaRouter`: `start()` discovers nothing and `addSinkByAddress` is refused. Read once, as Chrome does not support turning the router on or off while running. The policy is not read: not creating the manager is the app's way to turn the router off |
| `ShowCastPermissionRejectedError` | `--disable-features=ShowCastPermissionRejectedError` stops the permission-rejected issue |
| `CastDesktopMirroringKeepLocalAudio` (Windows) | `--disable-features=CastDesktopMirroringKeepLocalAudio` mutes the local output while desktop mirroring, as the other platforms do |
| `--cast-mirroring-target-playout-delay` (1 to 1000 ms) | Read at each mirroring route whose source has no delay of its own: the URL's `streamingTargetPlayoutDelayMillis` (or the `targetPlayoutDelayMs` of `startCasting`) wins, as `MirroringActivity::StartSession` takes `cast_source->target_playout_delay()` before `GetCastMirroringPlayoutDelay()`; `CHROME_MIRRORING_PLAYOUT_DELAY` and the 200 ms default apply only when neither is set |
| `--cast-device-ips` (`GetFixedIPSinksFromCommandLine`) | A channel is opened to each address at `start()`, as a discovered device's |
| `--cast-developer-certificate-path` | The PEM certificates are trusted as device authentication roots besides Google's |
| `CastMessageLogging` | Not ported: it logs every app message of a route; the log API below has no per-message hook yet |
| `AllowAllSitesToInitiateMirroring` | `--enable-features=AllowAllSitesToInitiateMirroring` lets any origin start mirroring through a Cast Streaming presentation URL, not only `kPresentationApiAllowlist` (`allowAllSitesToInitiateMirroring` in `switches.ts`; see [Site-initiated mirroring](#site-initiated-mirroring-and-mirroring-to-flinging)) |
| `DelayMediaSinkDiscovery` | Does not apply: it holds discovery back until a user gesture in the browser; here discovery starts at `start()`, and the app decides when to call it |
| `FallbackToAudioTabMirroring` | Does not apply: it adds tab mirroring to the cast modes of a dialog; the app builds its own |
| `RedirectionMediaRouteProvider` | Does not apply: media remoting redirection is not ported |
| `MediaRouterShowCastSessionsStartedByOtherDevices` (profile pref) | Does not apply: it only filters what the dialog shows; `getRoutes` returns them all and the app filters |
| `MediaRouterMediaRemotingEnabled`, `MediaRouterReceiverIdHashToken` | Not part of S10 here (remoting is not offered; the token is S3) |

**S11, local discovery permission.** Chrome starts discovery on a user gesture and shows the permission-rejected issue when
the OS refuses it (`DualMediaSinkService::OnDiscoveryPermissionRejected`, `DnsSdRegistry::ServicesPermissionRejected`).
Node cannot tell why a multicast socket sees nothing, and the Windows firewall check
(`CastMediaSinkService::CanFirewallUseLocalPorts`, a Windows API call) needs native code, which this library does not have. So
the issue and its gate are ported and raised when a discovery source emits `permissionRejected` (a custom source that
can detect it, such as one backed by a native module); the built-in mDNS discovery never does. A blocked firewall or a
denied macOS local-network permission still shows an empty list.

**S12, the screen capture permission.** `MediaRouterUI::CreateRoute` refuses a desktop capture on macOS without the Screen
Recording permission and raises the issue. Pass `mirroring.electron.systemPreferences` (Electron's) and
`startCasting` for `desktop_mirror` does the same; the check is for macOS only, as Chrome's.

**S13, diagnostics.** `MediaRouterLogger` is `LoggerImpl` (1000 entries, the same truncation of the fields): discovery,
route and mirroring events are written to it and `getLogs`, `registerLogObserver` read it, and `getCastProviderState` is
`CastMediaRouteProvider::GetState`. The sink service status page of Chrome (`media_sink_service_status.cc`) no longer
exists in Chromium `main`, so there is no port of it; `getSinks` already reports the sinks.

## Wired displays

Opt-in (`wiredDisplay` on `createCastManager`, presentation mode only). It follows Chromium's
`WiredDisplayMediaRouteProvider` (chrome/browser/media/router/providers/wired_display/), `PresentationReceiverWindowController`
and `LocalPresentationManager`, with the receiver side of Blink's `PresentationReceiver`. Code: `src/electron/wired-display/`,
`src/polyfill/presentation-receiver.ts`.

- **Sinks** (`displays.ts`): one per display, id `wired_display_<id>`, name "Display N" (N counts from 1 over the sorted
  list: primary first, then by y, then x). Displays that mirror the primary are dropped, so a single or mirrored setup has
  no sinks. The display the controller window is on is hidden only in the picker (see "The picker's display" below), as Chrome's dialog does;
  availability and `getSinks` still list it.
- **Sources**: https that is not the legacy Cast URL, or http on localhost. Anything else is not served.
- **Routes** (`provider.ts`): one per presentation, description `Presenting (<host>)`. Creating a route on a display first
  terminates the presentation already there, as `CreateRoute` does.
- **Local presentations** (`local-presentation.ts`): in-process connection pairs (`ControllerEnd`/`ReceiverEnd`), a
  pending controller per frame until the receiver page registers, and an origin check on join. A connection is
  `connecting` until the receiver page touches `navigator.presentation`, then `connected`.
- **Termination**: `terminate()` (either side), a closed window, a removed display and navigation of the receiver all end
  through the window closing, and every controller sees `terminated`. A controller going away only unregisters its
  connection.
- **Receiver window** (`electron-windows.ts`): fullscreen, shown inactive, on the display's bounds, own non-persistent
  session per presentation, downloads refused, only fullscreen permitted, and the first main-frame navigation is the only one
  allowed (`PresentationNavigationPolicy`). Chrome starts the receiver's browsing context with `kPresentationReceiverSandboxFlags`
  (kModals, kPopups, kTopNavigation: `presentation_receiver_flags.h`), which every frame inherits and which makes
  `ShouldSuppressDialogs` moot. Electron cannot set starting flags, so the same sandbox is sent as a `Content-Security-Policy:
  sandbox` header (`RECEIVER_SANDBOX`: every token but `allow-modals`, `allow-popups` and the `allow-top-navigation*` ones) on each
  main-frame and subframe response through `session.webRequest.onHeadersReceived`; an iframe's `alert()` is refused like the
  page's own. `setWindowOpenHandler` denies windows, a `beforeunload` prompt cannot hold the window, and there is no menu
  (`removeMenu`, so no reload or developer-tools accelerator) and no `devTools`, as Chrome's receiver window has no browser UI.
  A finished presentation's in-memory session is cleared and kept for the next one (up to four), instead of one new session each.
  `createReceiverWindows` can be called once per `ipcMain` and channel until its `dispose()`; a second call throws. F11 toggles fullscreen (Control+Command+F on macOS).
- **Receiver page API** (`presentation-receiver.ts`): `navigator.presentation.receiver.connectionList`,
  `connectionavailable`, `send`, `close`, `terminate`; it registers lazily on first use.
- **Sizes**: Blink limits only binary, to 4 GiB, with a `RangeError` from `send()` ("ArrayBuffer size exceeds the maximum supported
  size (4294967295)"); text has no limit. Here a local presentation has one cap, 64 MiB, in both directions and for text (UTF-16
  code units), bytes and Blobs alike (`MAX_MESSAGE_SIZE`). Both stand-ins refuse a larger `send()` with that `RangeError` before
  anything crosses IPC, so nothing is lost silently; main drops what a page past the stand-in sends anyway. A Cast connection keeps its
  own 1 MiB limit in main. An ArrayBuffer or view is copied at the call (Blink reads an ArrayBuffer when its turn comes), so a
  detached one is a `TypeError` at the call and never reaches the queue.
- **Binary messages** (`presentation_connection.cc`, `presentation.mojom`'s `PresentationConnectionMessage` union of `message` and
  `data`): on both stand-ins `send()` takes a string, an ArrayBuffer, an ArrayBufferView or a Blob (anything else is converted
  to a string, as WebIDL picks the DOMString overload). Sends leave through one queue, in order; while a Blob is being read the
  ones behind it wait (`HandleMessageQueue`), a Blob that fails to read is skipped, and a connection that ends drops its queue
  (`TearDown`). A view is copied when sent, an ArrayBuffer when its turn comes. `binaryType` is `arraybuffer` by default;
  `blob` and `arraybuffer` are accepted and anything else is ignored; a received message is converted when it arrives. In main
  the local pair copies the bytes (Blink copies into a Vector). The Cast path matches Chrome by dropping bytes:
  `CastSessionClientImpl::OnMessage` returns at once for a message that is not text, so a page can send them without an error and
  the device never hears of it.
- **The picker's display** (`MediaRouterUI::GetEnabledSinks` with `WebContentsDisplayObserver`): the display the page's window is on
  is found with `BrowserWindow.fromWebContents(wc)` and `screen.getDisplayMatching(win.getBounds())`, looked up at every start. While a
  picker is open `request.observeSinks` gives the new list when the window moves or resizes to another display or a display
  comes or goes. Without a window for the page (or without the `BrowserWindow` option) every display is offered. `displayOf`
  overrides the lookup.

Forced by Electron: a sandboxed preload must be a real bundled file, so the receiver preload is generated into a folder the
app gives (`preloadDir`); the package never imports Electron, so `screen`, `BrowserWindow`, `session` and `ipcMain` are passed
in; Electron has no per-window display observer, so the display of a page is derived from its window's bounds on move and
resize; a binary message over IPC is capped at 64 MiB (`MAX_BINARY_BYTES`; Blink allows 4 GiB) because it is cloned through
the main process. The Blob is read in the page, as Blink reads it in the renderer, and sent as bytes.

- **Mixed requests** (a Cast app URL and a standard source in one `PresentationRequest`): Chrome's dialog lists both kinds of sink.
  When displays and Cast devices both exist, `selectDevice` is the one picker: it gets `request.displays` and answers `{ display: id }`
  for a display, which starts the wired presentation, or a device, which casts. With devices but no displays it is the Cast flow
  unchanged, with displays but no devices `selectDisplay` runs. `reconnect(id)` goes to a display for a local id and to Cast otherwise.
- **Differences kept on purpose**: `reconnect(id)` with a local id but a URL the presentation was not started with is rejected with
  `NotFoundError`, where Chrome never settles the promise; and one manager serves one provider where Chrome's
  `MediaRouter` is per profile, so presentations of different `createCastManager` calls do not know of each other.


## Mirroring (`src/mirroring/`)

Tab and desktop mirroring, as Chrome's Cast dialog offers ("Cast tab", "Cast screen"). It is a TypeScript port of the
sender Chrome uses today, and it keeps Chrome's boundaries so the port can later be swapped for the real Mirroring
Service (the upstream Electron RFC):

```
MirroringActivity  <->  CastMessageChannel  <->  Mirroring Service (OpenscreenSessionHost -> openscreen sender)
 mirroring-activity.ts    (a callback pair)       engine.ts, session-host.ts, sender/
 mirroring-manager.ts                              (utility process: electron/engine-process.ts)
```

Every module cites the Chromium or openscreen file and function it ports. Chromium paths are from
`chromium/src@main`; openscreen paths are from `third_party/openscreen/src` (`cast/streaming/...`). Fetched, not
recalled, on 2026-11-25.

### What Chrome does (verified)

Chrome no longer has its own RTP stack for this: `media/cast/sender/{video,audio}_sender.cc` and
`openscreen_frame_sender.cc` wrap openscreen's `SenderSession`/`Sender`/`SenderPacketRouter`, and
`components/mirroring/service/openscreen_session_host.cc` drives them. `MirroringActivity`
(`chrome/browser/media/router/providers/cast/mirroring_activity.cc`) sits in the browser: it routes the CastMessages of
the streaming namespaces and starts and stops the host. So the port is openscreen's sender, plus the Chromium frame
sender policy, plus the session host, plus the routing.

### Module map

| Ours (`src/mirroring/`) | Ported from |
|---|---|
| `protocol/constants.ts` | openscreen `cast/streaming/public/constants.h`, `impl/rtp_defines.h`, `impl/session_config.h`, `public/capture_recommendations.h`, `impl/ssrc.cc` |
| `protocol/frame-id.ts` | openscreen `cast/streaming/public/frame_id.h`, `impl/expanded_value_base.h` (`ExpandLessThanOrEqual`, `ExpandGreaterThan`) |
| `protocol/offer.ts` | openscreen `public/offer_messages.cc` (`Offer::ToJson`, `Stream::ToJson`, `AudioStream`, `VideoStream`), `public/sender_session.cc` (`CreateStream`) |
| `protocol/answer.ts` | openscreen `public/answer_messages.cc` (`Answer::TryParse`, constraints, display), `public/resolution.cc`, `public/receiver_message.cc` (`ReceiverMessage::Parse`, `ReceiverCapability`) |
| `protocol/recommendations.ts` | openscreen `public/capture_recommendations.cc` (`GetRecommendations`) |
| `protocol/messenger.ts` | openscreen `public/session_messenger.cc` (namespaces, 4 s reply timeout, `*` destination), `sender_session.cc` (`Negotiate`, `OnAnswer`, `RequestCapabilities`, `OnCapabilitiesResponse`, `ToCapabilities`) |
| `rtp/packetizer.ts` | openscreen `impl/rtp_packetizer.cc` |
| `rtp/frame-crypto.ts` | openscreen `impl/frame_crypto.cc` |
| `rtcp/ntp.ts`, `rtcp/sender-report.ts` | openscreen `impl/ntp_time.cc`, `impl/sender_report_builder.cc`, `impl/rtcp_common.cc` |
| `rtcp/parser.ts` | openscreen `impl/compound_rtcp_parser.cc` |
| `sender/sender.ts` | openscreen `impl/sender_impl.cc` (`Sender`) |
| `sender/packet-router.ts` | openscreen `impl/sender_packet_router.cc` |
| `sender/bandwidth-estimator.ts` | openscreen `impl/bandwidth_estimator.cc` |
| `sender/video-encoder-metrics.ts` | Chromium `media/cast/encoding/media_video_encoder_wrapper.cc` (`CalculateEncoderUtilization`, `ComputeAndRecordUtilization`, `ComputeLossiness`) |
| `sender/capture-size-oracle.ts` | Chromium `media/capture/content/video_capture_oracle.cc` (`RecordConsumerFeedback`, `AnalyzeAndAdjust`, `AnalyzeForDecreasedArea`, `AnalyzeForIncreasedArea`), `capture_resolution_chooser.cc`, `media/base/feedback_signal_accumulator.h`, `media/capture/video/video_capture_types.cc` (`SuggestConstraints`), `media/base/video_util.cc` (`ScaleSizeToTarget`, `PadToMatchAspectRatio`) |
| `sender/frame-sender.ts` | Chromium `media/cast/sender/openscreen_frame_sender.cc`, `video_sender.cc`, `audio_sender.cc`, `media/cast/constants.h` |
| `session-host.ts` | Chromium `components/mirroring/service/openscreen_session_host.cc` (`NegotiateMirroring`, `OnError` fallback offer, `OnVideoEncoderStatus`, `MaybeFallbackHardwareFrameRate`, `MaybeDenylistHardwareCodecAndRenegotiate`), `mirror_settings.cc`, `mirroring_features.cc`, `media/cast/openscreen/config_conversions.cc` |
| `encoding-support.ts` | Chromium `media/cast/encoding/encoding_support.cc` (`IsHardwareEnabled`, `IsSoftwareEnabled`, the hardware deny list, `GetCodecParameterString`, `ToProfile`) and the `kCastStreamingForce{Enable,Disable}Hardware*` switches of `media/base/media_switches.cc` |
| `mirroring-activity.ts` | Chromium `mirroring_activity.cc` (`OnAppMessage`, `OnInternalMessage`, `HandleParseJsonResult`, `StartSession`, `StopMirroring`, `ScheduleFetchMirroringStats`, `FetchMirroringStats`) and `cast_activity_manager.cc` (`DoLaunchSession`, `OnActivityStopped`) |
| `mirroring-manager.ts` | Chromium `cast_activity_manager.cc` (`LaunchSession`, `TerminateSession`, `NotifyAllOnRoutesUpdated`), `media_route.cc` (`GetMediaRouteId`), `media_router_debugger.h` (the mirroring stats methods) |
| `routing.ts` | Chromium `cast_media_source.cc` (`CastMediaSourceForTabMirroring`, `ForDesktopMirroring`, `ProvidesStreamingAudioCapture`, the streaming `CastAppInfo`s), `components/media_router/common/media_source.cc`, `cast_activity_manager.cc` (`ChooseAppId`), `mirroring_activity.cc` (`StartSession`, `GetRouteDescription`, `GetMirroringNamespace`, `GetScrubbedLogMessage`), `chrome/app/media_router_strings.grdp` |
| `stats/*.ts` | openscreen `impl/statistics_{collector,dispatcher,analyzer,common}.cc`, `impl/clock_offset_estimator_impl.cc`, `public/statistics.cc`; Chromium `openscreen_stats_client.cc`, `openscreen_session_host.cc` (`GetMirroringStats`), `stats_event_subscriber.cc` (`CastStatToString`) |
| `engine.ts` | assembles `OpenscreenSessionHost` around a backend, as the Mirroring Service does with its resource provider |
| `transport/udp-environment.ts` | openscreen `cast/streaming/public/environment.cc` (`SendPacket`, `GetMaxPacketSize`, `OnRead`) and `SenderPacketRouter::OnReceivedPacket` (packets only from the announced endpoint) |
| `electron/agent-source.ts`, `electron/port-backend.ts`, `electron/agent-protocol.ts` | Chromium `components/mirroring/service/video_capture_client.cc` (`ProcessFeedback`, `SwitchVideoCaptureHost`), `audio_capturing_callback.cc`, `media/cast/encoding/{video_encoder,audio_encoder}.cc` (frame ids, key frames, bitrate), `media_video_encoder_wrapper.cc` (frame duration, utilization, lossiness), `frame_complexity_estimator.cc` (the agent's complexity estimate), `components/viz/service/frame_sinks/video_capture/frame_sink_video_capturer_impl.cc` (what the oracle is shown per frame), `openscreen_session_host.cc` (`OnVideoEncoderStatus`, `ProcessFeedback`), `media/capture/video_capture_types.cc` (`SuggestConstraints`), `content/browser/media/capture/frame_sink_video_capture_device.cc` (`SetResolutionConstraints`), blink `media_stream_constraints_util_video_content.cc` (`SelectResolutionPolicyFromCandidates`), blink `video_encoder.cc` (`GetRequiredEncoderType`, `isConfigSupported`) |
| `electron/host.ts` | Chromium `chrome/browser/media/cast_mirroring_service_host.cc` (the tab and desktop capture sources) and the hardware encoder query of `openscreen_session_host.cc` (`supported_profiles_`), answered by WebCodecs |
| `mirroring-activity.ts` `shouldForceLetterboxing` | Chromium `mirroring_activity.cc` (`ShouldForceLetterboxing`) |

### Process split

One mirroring route is three contexts:

- **Main process**: the control plane. `MirroringManager` and `MirroringActivity` launch the streaming app (`0F5096E8`
  audio and video, `85CDB22F` audio only; `GetCastStreamingAudioVideoAppId` and `GetCastStreamingAudioOnlyAppId` in
  openscreen `cast/common/public/cast_streaming_app_ids.h`) over the Cast v2 channel the CastClient already speaks,
  open the virtual connection, relay the `urn:x-cast:com.google.cast.webrtc` and `...remoting` messages to and from the
  engine, and stop the app when the route ends. It never sees a frame.
- **Engine, an Electron `utilityProcess`** (`electron/engine-process.ts`, one per route): the whole sender. The session
  host (OFFER, ANSWER, bandwidth), `SenderSession`, `Sender`s, `SenderPacketRouter`, the frame sender policy, AES and
  packetizing, and the UDP socket. Pacing is a 10 ms burst timer (`kDefaultBurstInterval`); a busy main process would
  add jitter the receiver's 200 ms playout delay does not forgive, and a stuck page cannot stall a stream. Everything in
  it is plain TypeScript over an injected clock and socket (`SenderEnvironment`), so the same code runs in-process in
  tests. The frame sender policy lives here, not in the renderer: `ShouldDropNextFrame` reads the sender's in-flight
  state, and Chrome makes that call synchronously on one thread.
- **Capture agent, a hidden `BrowserWindow`** (`electron/agent-source.ts`) on a private in-memory partition, sandboxed,
  with navigation and window creation denied. It captures (`getUserMedia` with `chromeMediaSource: 'tab'` and the id
  from `webContents.getMediaSourceId`; or `getUserMedia` with `chromeMediaSource: 'desktop'` and the `desktopCapturer` id the app chose, plus loopback audio where the OS has it; `getDisplayMedia` would need a user gesture the hidden page never has, and Chrome's `CastMirroringServiceHost` asks for none), reads tracks with `MediaStreamTrackProcessor`, and encodes with WebCodecs
  `VideoEncoder` and `AudioEncoder`. A `MessagePort` goes straight between the agent and the engine, so frame bytes
  never pass through main. A hidden window was chosen over the source page's isolated world because the page cannot
  disturb it (navigation, CSP, `beforeunload`) and the library needs no foothold in the app's page.

The agent and the engine split the work as Chrome splits capture and the Mirroring Service. The agent announces each
raw frame (RTP timestamp, reference time); the engine runs `VideoSender::InsertRawVideoFrame` (the drop decision) and
answers `encode`; the agent encodes and posts the chunk; the engine assigns the frame id and calls
`FrameSender::EnqueueFrame`. Audio works the same way per 10 ms buffer. A frame that never yields a chunk (encoder queue full, evicted, unsupported, swallowed by the encoder, encoder error) is reported as `video-drop` or `audio-drop`; the engine turns a video drop into Chrome's empty encoded frame (`VideoSender::OnFrameDroppedByEncoder`) so the sender's in-encoder count never leaks, and an audio drop becomes skipped samples on the next frame. Audio RTP and reference times follow `AudioEncoder::ImplBase::EncodeAudio` (underrun skip above `kUnderrunSkipThreshold`). A bitrate change reconfigures the running encoder in place and forces no key frame. The agent holds at most three raw frames and
closes the oldest, so a dropped frame costs nothing. A `VideoFrame` goes from the track
processor into the encoder; the only pixel read is one copy of the frame per encoded frame for the complexity estimate (see "Encoder feedback"). Encoded chunks are copied once, through the port (Electron cannot transfer an
`ArrayBuffer` over a `MessagePortMain`).

The agent keeps at most the session's frame rate with Chrome's `SmoothEventSampler`
(`media/capture/content/smooth_event_sampler.cc`): a token bucket that fills with the time between frames, holds at most
1.5 frame periods and pays one period for each frame kept. Chrome runs it in the capturer on compositor updates; the
agent runs it on the capture timestamps of the frames the track delivers, so frames that arrive bunched after a stall
are kept, and it allows 0.01 ms for timestamps rounded to microseconds. A frame's reference time is its capture time from
the frame metadata when the source has one, else its capture timestamp moved onto the wall clock by the smallest delay
seen; it never goes backwards, so a refresh frame cannot overtake the next real one. A tab switch learns the new
track's clock offset again.

### Encoder feedback: lossiness, utilization and the capture size

What Chrome does. `MediaVideoEncoderWrapper::OnFrameEncodeDone` gives every encoded frame an `encoder_utilization`
(`CalculateEncoderUtilization`: processing time over the target frame duration for a software encoder, the worse of
backlog and latency for a hardware one, clamped to [0, 2] and smoothed with an exponential average of weight 0.1) and a
`lossiness`: the frame's bitrate as a share of the target bitrate, times a normalized quantizer (`ComputeLossiness`,
clamped to [0, 5]). The quantizer is the encoder's QP when it reports one; otherwise the wrapper asks
`FrameComplexityEstimator` before encoding: the Shannon entropy of the luma differences (neighbouring pixels in a key
frame, the same pixel of the previous frame otherwise) over 10% of the rows, divided by 7.5 and capped at 1.
`VideoSender` keeps the last of each, and `ReportResourceUtilization` passes `max(utilization, lossiness) / 0.75` (a key
frame capped at 1) to `OpenscreenSessionHost::ProcessFeedback` and `VideoCaptureClient::ProcessFeedback`, which attaches
it to the next buffer it releases. For a tab that reaches `FrameSinkVideoCaptureDevice::OnUtilizationReport` and
`FrameSinkVideoCapturerImpl`, whose `VideoCaptureOracle` (created with auto-throttling on, in `FrameSinkManagerImpl`)
turns it into a capture size. The first positive utilization activates throttling. Each report updates an average of the
area the consumer could handle (capture area divided by utilization). When that, or the buffer pool's utilization, is
below the current area, the target drops by at least one snapped size (`CaptureResolutionChooser`: steps of 90 lines,
each at least 15% smaller in area, between the limits of the resolution change policy). When both leave room, it rises
one step: at once for content that is not animating, after 30 s of contiguous headroom while it is. A change takes
effect at most every 3 s. A fixed resolution has one size, so nothing adapts. The desktop capturer
(`DesktopCaptureDevice`) has a `CaptureResolutionChooser` too but never reads the feedback, so a screen is always
captured at the largest allowed size.

What is built. WebCodecs reports no QP, so Chrome's no-QP path is the only path. The agent copies each encoded frame's
planes once (0.5 to 1.4 ms for 1080p in the smoke test, measured around the copy and the estimate) and runs a port of
the estimator over the same 10% of rows (`agent-source.ts`), for I420, I420A, I422, I444 and NV12 frames. Other formats
get no complexity and no lossiness, as in Chrome, where the estimator returns nothing for them. The agent reports
`complexity` and the frame duration (the frame's own `duration`, else the time since the last frame clamped to 1/60 to
1/24 s: `GetFrameDuration`). `PortBackend` computes lossiness and utilization with the wrapper's formulas
(`sender/video-encoder-metrics.ts`), against the target bitrate in force when the chunk arrives. `VideoSender` was
already the consumer of both. No web API carries a `VideoCaptureFeedback` from a page to the capture device
(WebCodecs, `MediaStreamTrackProcessor` and the track API have none), so the oracle (`sender/capture-size-oracle.ts`)
runs in the engine, for tab sources only, and is shown each frame as `FrameSinkVideoCapturerImpl::MaybeCaptureFrame`
shows it: source size, the event, then the capture with the pipeline utilization (frames in the encoder over 6). Its
capture size goes to the agent as `capture-size`, rounded down to even numbers as `DesktopCaptureDevice` does with
`& ~1`. The agent configures the encoder for that size and gives it the unscaled frame, which a WebCodecs encoder
scales (checked in Electron 45: a 1920x1080 frame encoded with a 640x360 configuration decodes at 640x360). A change
of size reconfigures the encoder, as a change of source size already did.

Differences:

- The capture still happens at the source size, since the browser's capturer never sees our oracle: a smaller capture
  size saves encoder and network load, not capture load.
- `AnimatedContentSampler` finds animation from damage rectangles, which a page cannot see. Frames arriving at most
  200 ms apart (the oracle's own minimum of 5 fps) count as animating here, and a refresh frame does not. A page that
  keeps painting waits the 30 s proving period before each step up; a static one does not.
- The feedback is applied to the frame whose chunk produced it, not to the next buffer released (one frame later in
  Chrome).
- Switching the mirrored tab starts a new oracle at the full size, as Chrome's `VideoCaptureClient::SwitchVideoCaptureHost`
  starts a new capture device (with its own oracle) on the new tab.
- Whether an encoder is hardware for `CalculateEncoderUtilization` is what the session host chose
  (`useHardwareEncoder`, from the WebCodecs hardware query), not what the encoder reports, since WebCodecs does not say
  which implementation it picked under `prefer-hardware`.
- The estimator runs on the agent's main thread, not on a thread-pool task.
- `SmoothEventSampler` is ported as the agent's frame-rate limit (above); `AnimatedContentSampler` is not, and
  neither is the max frame rate and max pixels feedback, which `VideoSender` never sends.

### Local audio while mirroring

Chrome decides whether the sender's own speakers stay on, and we match it (`CastMirroringServiceHost`,
`chrome/browser/media/cast_mirroring_service_host.cc`):

- **Desktop**: `GetDesktopAudioLoopbackDeviceId` returns `kLoopbackInputDeviceId` on Windows, so local playback keeps
  going, when `kCastDesktopMirroringKeepLocalAudio` is enabled (on by default there, `media_router_feature.cc`;
  muting the endpoint silences the loopback on some drivers). Every other platform gets `kLoopbackWithMuteDeviceId`,
  which mutes local playback while mirroring. Here: Windows captures with `getUserMedia` and `chromeMediaSource:
  'desktop'` (loopback, no mute); other platforms take the audio from `getDisplayMedia` on the capture window's private
  session, whose `setDisplayMediaRequestHandler` answers with the app's source id and `audio: 'loopbackWithMute'` (the
  video still comes from `getUserMedia`, see "Letterboxing"). The id goes through as the app gave it,
  as `CastMirroringServiceHost` parses the media id rather than listing the sources again. A machine with no audio
  output device has no loopback to open; the capture fails and the session ends with `AUDIO_CAPTURE_ERROR`, as in
  Chrome (`OpenscreenSessionHost::ReportAndLogError` stops the session). The choice is Chrome's, and like
  `kCastDesktopMirroringKeepLocalAudio` it is an internal flag, not an app setting. The mute path was exercised on Windows (valid Opus reached the fake receiver) but not on
  macOS or Linux, and whether the speakers really went quiet was not listened for.
- **Tab**: `CreateAudioStream` binds a Muter on the tab's audio group when the first loopback stream is requested, so
  the tab is silent locally for the whole session and restored when the host is destroyed (crbug.com/40708932). Here
  `webContents.setAudioMuted(true)` on the captured page, undone at teardown only if we were the one to mute it. Measured
  in Electron 45: a tab muted this way still delivers its audio to `getUserMedia` tab capture at full level (peak 1.0
  with and without the mute), so the receiver keeps hearing it. An app that wants local audio from the mirrored tab during a session can call
  `setAudioMuted(false)` on its own `webContents`; the library only restores the state it changed.

### Switching the source tab, and freezing

**Switching** (`CastMirroringServiceHost::SwitchMirroringSourceTab`, `MirroringService::SwitchMirroringSourceTab`,
`OpenscreenSessionHost::SwitchSourceTab`, `MirroringActivity::DidGetTabSourceId`, `CastActivityManager::OnSourceChanged`).
The session is **not renegotiated**: the OFFER, the senders, the encoders, the target bitrate, frame ids and RTP timelines
are untouched, and the receiver sees one uninterrupted stream. What changes, in Chrome's order:

1. The host starts observing the new page, drops its video capture host (`video_capture_host_ = nullptr`) and its
   `web_contents_audio_muter_` (so the old tab is audible locally again), and calls the service. Here:
   `host.ts` `switchMirroringSourceTab` unmutes the old page if the library muted it, mutes the new one the same way
   (never touching a page someone else muted), and sends the new page's capture id to the engine.
2. `SwitchSourceTab` gives the `VideoCaptureClient` a new `VideoCaptureHost` (`SwitchVideoCaptureHost`): the client
   stops the old device and restarts with the same parameters and frame callback, with `accumulated_time_ =
   last_timestamp_ + 1 ms` so the timeline continues. It also does `audio_input_device_->Stop(); Start()`, which asks the
   host for a new audio stream for the new tab (and binds the new tab's Muter). Here: `session-host.ts` `switchSourceTab`
   calls `backend.switchVideoCaptureHost()` and `restartAudioCapture()`; the capture agent opens the new page's
   `getUserMedia` stream, stops the old tracks, starts new pumps, rebases its RTP clock to last RTP + 90 ticks (1 ms), and
   keeps the video and audio encoders. A new capture is not frozen (below). The audio encoder keeps its timeline; the gap
   in capture is resolved by the existing underrun rule.
3. `DidGetTabSourceId` updates the activity's `frame_tree_node_id_` and `routes_by_frame_`, terminates any other route of
   the new tab, and sets the play state to PLAYING. Here: `MirroringActivity.webContentsId`, the manager's one-route-per-tab
   rule, and `freezeInfo.isFrozen` back to false. **The route's id and `media_source` do not change in Chrome and do not
   here**; the page it is bound to is `route.webContentsId` (and `members`).

Public entry point: Chrome has none in the Media Router; the "Share this tab instead" control of the tab-sharing UI
(`TabSharingUI`, its `SourceCallback`) calls the host. `CastManager.switchMirroringSourceTab(routeId, webContentsId)` takes
that place, named after the host method. Deviations: a route that is still launching refuses (Chrome has no host yet); a
page that is already the source is a no-op (Chrome restarts capture and then ignores the unchanged id).

Only **tab** routes switch. Chrome's host `CHECK`s that the new source is a web contents, `ShowTabSharingUI` is for tab
capture only, and the control is behind `AccessCodeCastTabSwitchingUi` (an internal UI flag, not mirrored here). A desktop
route refuses with `unable_to_cast`; Chrome has no desktop-source switch to port.

Not ported: the remoting branch of `SwitchSourceTab` (remoting is not offered).

**One route per page** (`CastActivityManager::routes_by_frame_`, keyed by `frame_tree_node_id`, for every kind of route).
`DoLaunchSession` ("If there is a route from this frame already, stop it") terminates the frame's existing route before a
new one launches, and `OnSourceChanged` does the same for the new tab's frame on a switch. Here the two route kinds live in
separate layers, so the rule is a pair of narrow hooks: `MirroringManagerOptions.terminateRoutesOfPage` (called when a page
becomes a mirroring source, by a launch or a switch; `main.ts` ends the Cast SDK / Presentation API sessions that page
*launched*, `CastSessionService.sessionsLaunchedBy`, through `terminateSession`) and `CastSessionServiceOptions.onSessionLaunching`
(called when a page launches a session, before its LAUNCH is sent; `main.ts` ends that page's mirroring routes). A session the page only joined is not
ended, as Chrome's `routes_by_frame_` records launches only. Deviation: Chrome's key is the frame, here a main frame is
its page (a subframe's session is not matched to a mirroring route, which in Chrome is also a main frame).

**The mirrored page being destroyed** (tab routes only). `CastMirroringServiceHost` is a `WebContentsObserver` on the tab
(`Observe(GetContents(...))` in `Start`, again for the new tab in `SwitchMirroringSourceTab`); `WebContentsDestroyed()`
calls `StopMirroringSession()`, which resets `mirroring_service_`. The Mirroring Service's disconnect handler
(`MirroringService::OnDisconnect`) resets its `OpenscreenSessionHost`, whose destructor runs `StopSession()` and calls
`observer_->DidStop()`; `MirroringActivity::DidStop()` -> `StopMirroring()` runs `on_stop_` ->
`CastActivityManager::OnActivityStopped` -> `TerminateSession`, which removes the activity as `TERMINATED` with
`PresentationConnectionCloseReason::CLOSED` (the same path as a user stopping the route). Here `host.ts` listens for
`destroyed` on the page being mirrored (the new page after a switch; the old one is ignored) and reports `didStop`, which
ends the route as `terminateRoute` does. A desktop source observes no `WebContents` (the `Observe` calls are in the tab
branch only), so nothing happens there when a window closes: capture just ends or goes on.

**Freezing** (`MediaRouterUI::FreezeRoute` / `UnfreezeRoute` -> `MirroringMediaControllerHostImpl::Freeze` / `Unfreeze` ->
`MirroringActivity::Pause` / `Play` -> `CastMirroringServiceHost::Pause` / `Resume`). Freezing pauses the *video capture
host* only (`VideoCaptureHost::Pause`, `SingleClientVideoCaptureHost::Pause` -> `MaybeSuspendDevice`): the mirroring
service, its client, senders, refresh timer and the **audio stream are not told**, no frames are produced and the receiver
keeps the last frame it was given. `RequestRefreshFrame` does nothing while the device is suspended
(`FrameSinkVideoCaptureDevice::RequestRefreshFrame`), so the refresh timer cannot unfreeze it; `Resume` restarts the
capturer, which delivers a frame at once. Here: `route.freezeInfo = { canFreeze, isFrozen }` (Chrome's
`UIMediaSink::freeze_info`), `freezeRoute` / `unfreezeRoute` on the manager, `MirroringService.pause` / `resume`, and in
the agent a `frozen` flag that drops capture frames and refresh requests and, on unfreeze, sends the last frame again
(stamped with the time that passed) as the restarted capturer would. The flag is separate from the session's own
`pause`/`resume` (the capture client's pause during encoder reconfiguration), because Chrome's browser-side pause is below
the client.

- `Freeze()` starts a 500 ms one-shot timer (`kPauseDelay`) and ignores requests while it runs; `Unfreeze()` acts at once.
- `can_play_pause` becomes true at the end of `NegotiateMirroring` (`OnRemotingStateChanged(false)`) and false while
  remoting; here `canFreeze` becomes true when the session reports `didStart` (the ANSWER is in and capture has begun),
  since a pause before that finds no capture host in Chrome and does nothing. When remoting is ported this should follow
  `OnRemotingStateChanged` too. `is_frozen` is `can_freeze && play_state == PAUSED`, set when the pause request has been
  made (the callback of `CastMirroringServiceHost::Pause` runs after posting to the IO thread), not when the device
  confirmed.
- The pause request goes main -> engine -> agent because the agent's port belongs to the engine (Chrome's host talks to the
  video capture host directly).
- The receiver's behaviour while frozen (how long it holds the last frame, whether it shows a spinner) is the receiver's;
  that needs a real device.

### Codecs

Opus (48 kHz stereo, 10 ms frames, 128 kbps; `audio_encoder.cc` `OpusImpl`) is always offered. Video follows
`NegotiateMirroring` and `encoding_support.cc`:

- **Hardware first.** A codec is offered in hardware when the encoder exists, its feature or switch allows it
  (`IsHardwareEnabled`: H.264, VP8 and VP9 by default; HEVC and AV1 only with
  `--cast-streaming-force-enable-hardware-hevc` / `-av1`; `--cast-streaming-force-disable-hardware-<codec>` wins) and
  it is not on the hardware deny list. Software codecs (VP8 and VP9, `IsSoftwareEnabled`; AV1 only with
  `--enable-features=CastStreamingAv1`) are offered only when no hardware codec was (`kCastStreamingOfferHardwareFirst`, on by default), or in the one fallback
  offer after the receiver selected no stream (`OnError`, `offering_fallback_codecs_`). The order is
  `kSupportedVideoCodecs` (HEVC, AV1, VP9, H.264, VP8). Chrome has no software H.264 encoder in the list, and no
  model-based codec deny list turned up in `openscreen_session_host.cc`, `mirroring_activity.cc` or openscreen's
  `sender_session.cc`: the one receiver-model rule there is `ShouldForceLetterboxing` (below).
- **How "hardware" is established.** Chrome asks the GPU process for the `VideoEncodeAccelerator` profiles. Here the
  capture page asks WebCodecs: `VideoEncoder.isConfigSupported` with `hardwareAcceleration: "prefer-hardware"`, at the
  session's maximum resolution (1920x1080, 30 fps) and the codec string Chrome would offer (`GetCodecParameterString`).
  In Chromium's blink `video_encoder.cc` `prefer-hardware` makes `GetRequiredEncoderType` return `kHardware`, and
  `CreateMediaVideoEncoder` returns the accelerated encoder's status without the software fallback that
  `no-preference` and `prefer-software` get (it also excludes the OS software encoders, such as Media Foundation's
  software H.264). So a supported answer means a hardware encoder takes that configuration, and the same setting at
  `configure` time makes the encoder refuse to run in software. A hardware offer is encoded with
  `prefer-hardware`, a software offer with `prefer-software`; H.264 is configured as Annex B (`avc: { format: "annexb" }`),
  which is what Cast Streaming carries, with the parameter sets in the key frames.
- **Profiles.** Chrome's `GetHardwareCodecParameters` accepts any profile in a codec's range; WebCodecs is asked about
  the one profile that is offered (H.264 Main level 4.0, `avc1.4d0028`; Baseline, `avc1.420028`, on macOS as
  `ToProfile` does with `kCastMacForceBaselineProfile`). An encoder that only does another profile is not found.
- **Failure.** A hardware encoder that reports an error (`codec_runtime_error`, `codec_init_failed`,
  `unsupported_codec`) is not a session error. As in `OnVideoEncoderStatus`, the frame rate is lowered to 30 in place if
  it was higher (`MaybeFallbackHardwareFrameRate`; capture is limited to 30 fps here, so this is never taken), else the
  codec goes on the hardware deny list and the session streams down and negotiates again
  (`MaybeDenylistHardwareCodecAndRenegotiate`): the next OFFER holds the other hardware codecs or, if none, the
  software ones. A deny-listed codec is listed once. A software encoder that fails is an `ENCODING_ERROR` and stops the
  session. Chrome's list is process-wide (`GetHardwareCodecDenyList()` is a static): the main process holds it for as
  long as the mirroring factory lives and gives it to each engine, which reports additions back. A status from an
  encoder that has been replaced is ignored, as a destroyed `VideoEncoder` reports nothing.

HEVC and AV1 are off by default in Chrome and so here. No encoder is bundled.

### Letterboxing

`MirrorSettings::GetVideoCaptureParams` gives the capture a `resolution_change_policy`: `fixed_aspect_ratio` when
sender-side letterboxing is on (a receiver whose ANSWER does not say `scaling: "receiver"`, or any `Nest Hub` model
unless `--disable-cast-letterboxing`: `ShouldForceLetterboxing`), `any_within_limit` otherwise, `fixed_resolution` at the
minimum size. Chrome gives those to the capture device, which turns them into `SetResolutionConstraints(min, max,
fixed_aspect_ratio)` (`VideoCaptureParams::SuggestConstraints`: the minimum is the maximum for `fixed_resolution`, 180
lines of the same aspect ratio for `fixed_aspect_ratio`, 2x2 for `any_within_limit`) and the capture then keeps the
aspect ratio of the maximum, 16:9, scaling and padding the source into it. Here the agent reaches the same capture
device through `getUserMedia`, whose legacy constraints Blink turns back into a policy
(`SelectResolutionPolicyFromCandidates`), so the agent sends the sizes `SuggestConstraints` would give and a unit test
runs Blink's rule over them. Before this the agent sent only a maximum, so Blink's default applied (`fixed_resolution` for
a tab, which made every tab 1920x1080 whatever its size, as measured, and `any_within_limit` for the desktop). The smoke test checks that a 4:3 page and the screen come out 16:9 (a 640x480 page: 1706x960).

`getDisplayMedia`, used for desktop audio off Windows, refuses minimum sizes (a TypeError, "min constraints are not
supported"), so it cannot carry a policy: without a minimum Blink falls back to `any_within_limit` for a screen. The
agent therefore takes only the audio track from it (asked with the maximums), stops its video track, and captures the
video with the same `getUserMedia` request as on Windows. `fixed_resolution` is only chosen when the receiver recommends
the minimum size.

On macOS the screen is captured by ScreenCaptureKit, which letterboxes into the frame
(`IOSurfaceCaptureDeviceBase::ComputeFrameSizeAndDestRect`) but reports the content rect as the frame's visible rect
(`content/browser/media/capture/screen_capture_kit_device_mac.mm`, `OnStreamSample`). Chrome's encoder encodes the
visible rect (`MediaVideoEncoderWrapper`, `visible_rect().size()`), and so does WebCodecs here, so a desktop mirrored
from a Mac keeps the screen's own shape (a 4:3 screen gives 1024x768 frames, seen with Electron 40 on a macOS runner).

### Media remoting: capabilities only, the renderer side is not reachable

Chrome's remoting is started by the renderer, not by the Mirroring Service. In a mirrored tab, `media::remoting::RendererController`
(created in `content/renderer/media/media_factory.cc`, `MediaFactory::CreateRendererFactorySelector`, under
`BUILDFLAG(ENABLE_MEDIA_REMOTING)`) calls `GetRemoterFactory()->Create(RemotingSource, Remoter)`, a request on the
frame's browser interface broker. The embedder answers it through
`ContentBrowserClient::CreateMediaRemoter(RenderFrameHost*, PendingRemote<RemotingSource>, PendingReceiver<Remoter>)`
(`content/public/browser/content_browser_client.h`); Chrome implements it in
`ChromeContentBrowserClient::CreateMediaRemoter` (`chrome/browser/chrome_content_browser_client.cc`), which hands the
pipes to `CastRemotingConnector::Get(web_contents)` (`chrome/browser/media/cast_remoting_connector.cc`) through
`RemotingBridge`. The connector reaches the Mirroring Service's `MediaRemoter`, which uses `OpenscreenSessionHost`
(`StartRemoting`, `NegotiateRemoting`, `CreateRemotingDataStreamSender`, `StopRemoting`).

Status in Electron (checked 2026-11-25 against `electron/electron@main`):

- The renderer half is built in: `enable_media_remoting = !is_cast_media_device && !is_ios` in `media/media_options.gni`,
  and Electron's `build/args/*.gn` do not turn it off. So an Electron renderer does create a `RendererController` and
  asks for a `RemoterFactory`.
- The browser half is missing. `ElectronBrowserClient` (`shell/browser/electron_browser_client.{h,cc}`) does not
  override `CreateMediaRemoter`; the content default is an empty function, so the request is dropped and the
  `RendererController` never sees `OnSinkAvailable`. Electron's only `CastRemotingConnector` reference is in the
  exclusive-access patch (`patches/chromium/fix_adapt_exclusive_access_for_electron_needs.patch`), which turns the `DidAcquireFullscreen` calls into `#if 0`.
- There is no JavaScript API for any of it: `RemoterFactory`, `Remoter`, `RemotingSource` and
  `RemotingDataStreamSender` (`media/mojo/mojom/remoting.mojom`) are Mojo interfaces bound inside the browser process,
  and the data path is a Mojo data pipe carrying demuxed `DecoderBuffer`s. The sender runs in a utility process here
  and nothing exposes these to Node.

So remoting cannot be built in this library without a change in Electron, and it is not faked. What is ported is
the part that does not need the renderer: after the first negotiated OFFER the host sends `GET_CAPABILITIES` once
(`OpenscreenSessionHost::OnNegotiated`, "We should only request capabilities once"), parses the
`CAPABILITIES_RESPONSE`, rejects a receiver whose `remoting` version is above 2 (`kSupportedRemotingVersion`; absent
means 1), maps the media capabilities as `ToCapabilities` does (`audio` is `baseline`, `video` is ignored) and keeps
the result in `OpenscreenSessionHost.receiverCapabilities`. A missing, errored or too-new response is logged ("Remoting
is disabled for this session") and the session continues, as in `OnError` for `kRemotingNotSupported`. In Chrome the
result feeds `ToRemotingSinkMetadata` and then the `MediaRemoter`; here nothing reads it yet. (Earlier text said Chrome
sends `GET_CAPABILITIES` only for remoting; it sends it for every non-Remote-Playback mirroring session, so a real
receiver now gets one extra request.)

What Electron would need, for the remoting RFC:

1. An embedder hook that forwards `ContentBrowserClient::CreateMediaRemoter` (render frame host, `RemotingSource`
   remote, `Remoter` receiver) to the application, per frame, honouring the `IsActive()` and fenced-frame checks of
   Chrome's implementation, and a way to tie it to an existing cast route for that `WebContents`.
2. A JS-visible binding of the four interfaces, or a narrower message API: `RemotingSource.OnSinkAvailable(metadata)`
   / `OnSinkGone`, `OnStarted` / `OnStartFailed(reason)` / `OnStopped(reason)`, `OnMessageFromSink(bytes)`;
   `Remoter.Start`, `Stop(reason)`, `SendMessageToSink(bytes)`, `StartDataStreams(audio_pipe, video_pipe, ...)`; and
   `RemotingDataStreamSender.SendFrame(DecoderBuffer)` / `CancelInFlightData`. The serialized RPC messages are the
   protobufs in `media/remoting/proto`, and the pipes carry encoded frames, so a binding must expose the data pipe
   consumer (for example as a `ReadableStream`) to the utility process that owns the RTP senders.
3. Once those exist, the library side is: a remoting OFFER (`castMode: "remoting"`, `CreateRemotingOffer`), the RPC
   dispatcher on `urn:x-cast:com.google.cast.remoting` (`messenger.ts` already routes that namespace and
   `SenderSessionMessenger.sendRpcMessage` exists), a `RemotingSender` that pumps pipe data into the frame senders,
   and the return to mirroring (`StopRemoting`, `StopRemotingAndMaybeResumeMirroring`).

### Mirroring statistics (`src/mirroring/stats/`)

Chrome measures a mirroring session for debugging, not for pages: `MirroringActivity::OnSessionSet` asks the
`MediaRouterDebugger` (`ShouldFetchMirroringStats`) and, when it is on, starts the session with
`enable_rtcp_reporting`; `DidStart` then calls `CastMirroringServiceHost::GetMirroringStats` every
`kRtcpReportInterval` (500 ms) and hands the dictionary to the debugger (`OnMirroringStats`), where
`chrome://media-router-internals` shows it and `MirroringStatsObserver`s get it. It is off by default and read at the
start of a session. Rules, all from openscreen revision `aec59dd1baf42bc7e23963ccbe7b72bbaf28dfe6` (the one Chromium
pins; the files are identical on main) unless noted:

- **Collection** (`statistics_collector.cc`, `statistics_dispatcher.cc`). While a stats client is set on the session
  (`SenderSession::SetStatsClient`), `Environment::SendPacket` reports every packet to the collector, which parses the
  wire bytes (RTP timestamp at 4, packet id and max packet id at 14 and 16, size = the packet) and tags it
  `kPacketRetransmitted` or `kPacketSentToNetwork`. `SenderImpl` dispatches capture begin, capture end and encoded
  (size, key frame) at the end of `EnqueueFrame`, frame ack received from the receiver's checkpoint and ack vector for
  slots still in flight, and frame dropped by encoder from `ReportFrameDropEvent`. The receiver's RTCP event log
  (`receiverRtcpEventLog` is already in the OFFER) is parsed by `CompoundRtcpParser::ParseFrameLogMessages` and
  dispatched between the receiver report and the checkpoint: packet received, ack sent, decoded and played out (with
  its signed delay). Event times in the log are `RtcpSession::start_time` (the sender's clock when the `Sender` was
  made) plus the 24-bit base plus a 12-bit delta; the receiver's own origin is whatever it chose, which the clock
  offset estimate absorbs.
- **Clock offset** (`clock_offset_estimator_impl.cc`). Two Kalman-filtered bounds (process noise 5 ms, measurement
  noise 30 ms): packet sent against packet received, and ack sent against ack received, each matched by RTP
  timestamp, packet id and media type in a map capped at 500 entries. Offset is half the sum of the bounds, latency
  half the difference, and neither exists until both bounds have a measurement.
- **Analysis** (`statistics_analyzer.cc`). Every 500 ms the analyzer takes the collected frame events, then packet
  events, updates its aggregates and latency pairs (the 200 most recent frames and 1000 most recent packets are kept to
  join events), and gives `SenderStats` to the client. Counts, bitrates and rates cover the whole session since the
  analyzer was made, not a sliding window; latencies are means over every data point so far; durations are truncated
  to whole milliseconds as `to_milliseconds` does, so a session shorter than 1 ms yields an infinite rate (shown as
  the string "null", as Chrome's dictionary does). Histograms are 0 to 800 ms in 20 ms buckets, for capture, encode,
  queueing, network, packet and end-to-end latency, and lateness.
- **Exposure** (`openscreen_stats_client.cc`, `openscreen_session_host.cc` `GetMirroringStats`,
  `stats_event_subscriber.cc` `CastStatToString`). `{ audio, video }`, each holding every statistic under Chrome's name
  (`ENQUEUE_FPS`, `AVG_CAPTURE_LATENCY_MS`, ..., `LAST_EVENT_TIME_MS`) and the histograms as lists of single-key
  objects (`"<0"`, `"20-39"`, `">=800"`; empty buckets are left out). The session host merges its own counters:
  `TARGET_BITRATE` (kbps), `ENCODER_UTILIZATION` and `LOSSINESS` (percent, -100 when nothing reported yet),
  `FRAMES_INSERTED`, and `FRAMES_DROPPED` (video: dropped before plus after encoding). The `MediaRouterDebugger` surface
  is mirrored by `getMirroringStats(routeId)`, `setMirroringStatsEnabled`, `isMirroringStatsEnabled` and
  `registerMirroringStatsObserver`; like Chrome they are a debugging aid, off by default and applied to sessions that
  start afterwards, and there is no web API for them.
- **Quirks copied on purpose.** The collector reads RTCP sender reports as if they were RTP packets (every packet
  goes through `Environment::SendPacket`), so they add to `NUM_PACKETS_SENT` and `TRANSMISSION_KBPS` with a garbage
  packet id. `kNumPacketsRetransmitted` has no case in Chromium's `StatisticTypeToCastStat`, so it is reported under
  `UNKNOWN_OPEN_SCREEN_STAT`. Receiver events that arrive before the clock offset is known are left out of the frame
  and end-to-end latencies, the late-frame count and the first and last event times.
- **Deviations.** (1) Chrome's debugger is a single global one holding the most recent push of any session (its own
  TODO says multiple sessions are not handled); `getMirroringStats` takes the route id and each route keeps its own. What Chrome's copy does is kept per route:
  `MediaRouterDebuggerImpl::GetMirroringStats` returns an empty dictionary while `ShouldFetchMirroringStats` is false
  and otherwise `most_recent_mirroring_stats_`, which nothing clears when a session ends and which the next push of any
  session replaces (`NotifyGetMirroringStats`, which also drops pushes while statistics are off). So `getMirroringStats`
  never throws, returns `{}` while off and for an unknown route, and gives an ended route its last statistics until
  another route pushes.
  (2) A video frame's capture begin is its capture time from the frame metadata (or the agent's estimate, see
  "Process split") and its capture end is when the agent read it from the track; Chrome has `capture_begin_time`
  and `capture_end_time` from the capturer, so the capture latency here also counts the delivery to the agent. Audio is the same as in Chrome (one time for both). (3) The stats
  are fetched from the utility process over its message port (`get-stats`/`stats`), where Chrome calls the Mirroring
  Service over mojo. (4) Not ported: UMA (`RecordCastStreamingSenderUma` and the other histograms Chrome uploads): they
  need Chrome's metrics pipeline and send usage data to Google, and this library has no backend or consent to
  report to.

### Not checked, or different from Chromium

- The fake receiver in `test/mirroring/` is ours: it implements what openscreen's receiver does for the parts we send
  to (ANSWER, RTCP reports, ACKs, NACKs), not Chrome's receiver app. On a real device (Windows to a Chromecast Ultra,
  with the live harness in `examples/live-mirroring/`) tab mirroring ran at 1080p30 with Opus and VP8 in software, the
  picture smooth and the audio in sync and only on the TV; desktop mirroring sent picture and system audio, with local
  audio kept on Windows as Chrome keeps it there. Linux and macOS have not been tried.
- Not ported: Remoting (RPC playback; see "Media remoting" below), UMA (see Mirroring statistics; each frame's lossiness and utilization are computed, the averages Chrome records are not).
- Hardware encoding differs from Chrome in how it is found out and run: the GPU factories (`MirroringGpuFactoriesFactory`,
  `OnGpuFactoryContextLost`) have no counterpart because the encoder is WebCodecs in the capture page; a lost GPU
  surfaces as an encoder error, which takes the same deny-list path. Which profile a hardware encoder supports is a
  yes or no for the offered profile, not Chrome's range check. The `VideoEncodeAccelerator` frame rate is not
  consulted (Chrome stopped doing that too: crbug.com/586527429).
- A receiver that answers a hardware-first offer with audio only (it took no video codec) gets no fallback offer: the
  fallback is sent on `NoStreamSelected`, which needs the ANSWER to select nothing at all. This is Chrome's behaviour.
- Chrome sends the fallback offer after any `NoStreamSelected`, with or without a hardware codec in the first offer.
- `kCastStreamingForceEnableHardware*`, `kCastStreamingForceDisableHardware*`, `--disable-cast-letterboxing` and the
  `CastStreaming*` features (`--enable-features` / `--disable-features`: Vp8, Vp9, Av1, HardwareHevc, Win/MacHardwareH264)
  are read from Electron's `app.commandLine` (`hasSwitch`, `getSwitchValue`), as Chrome reads `base::CommandLine`, so
  switches the app appended with `app.commandLine.appendSwitch` count too. The app's `electron` object carries `app`
  already; there is no option for it. Only these features are read, not the whole `base::FeatureList` (field trials,
  `::` params); a feature named in both lists is disabled, as there.
- `PortBackend` restarts nothing when the 30 fps fallback asks for a capture restart (`RestartWithParams`); it is
  never asked to, as above.
- Chrome's `OnAppMessage` compares a message's `source_id` with the sender's id and its `destination_id` with the
  session's, which reads as swapped for a message from the receiver; `MirroringActivity` here takes the transport as
  the source and the sender's id (or `*`) as the destination.
- Frame rate: capture is rate-limited to the requested rate, never raised to it, and a hidden page can render slower
  than 30 fps. In the smoke test a 60 Hz test page mirrors at about 22 fps on the development machine.
- `startCasting` is one method for Chrome's three cast modes, as `MediaRouterUI::StartCasting` takes the mode:
  `presentation` (the default) casts the window's default request, `tab_mirror` and `desktop_mirror` start a
  mirroring route. Each mode keeps its own argument checks; a mode that is none of the three is a `RangeError`, and a
  mirroring mode without the `mirroring` option is `unable_to_cast`.
- The mirroring session runs on the device's one kept-open channel, as Chrome's `MirroringActivity` sends through
  `CastMessageHandler` on the sink's one `CastSocket`; the activity's view of the channel only detaches when the route
  ends and never closes it. Its session on the device is a local route: the session tracker does not report it as a
  non-local route (`CastActivityManager` adds a non-local activity only for a session no local activity holds), nor
  while it is being launched.
