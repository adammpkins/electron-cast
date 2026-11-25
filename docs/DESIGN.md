# electron-cast design

Electron exposes the Presentation API but has no Chrome Media Router behind it, so web pages that use the Google Cast
sender SDK (`chrome.cast`) cannot find or talk to Cast devices. Electron closed the upstream request
(electron/electron#869) in 2025 with no plans to implement it. electron-cast fills the gap from scratch. By default
the page keeps Google's own SDK, and electron-cast supplies the missing Media Router: a stand-in Presentation API in
the page, and in the main process a translator for the router's message format plus device discovery and the Cast v2
protocol. The older alternative (`mode: "chromecast"`) gives the page electron-cast's own `chrome.cast`
implementation instead.

First consumer: YouTube Music Desktop (YTM's web player uses the legacy `chrome.cast` API with the YouTube receiver
`233637DE` and the `urn:x-cast:com.google.youtube.mdx` namespace). The library is generic: nothing YouTube-specific
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
| `urn:x-cast:com.google.cast.tp.connection` | `{type:"CONNECT"}` opens a virtual connection to a destination id; `{type:"CLOSE"}` closes it. |
| `urn:x-cast:com.google.cast.tp.heartbeat` | `PING` / `PONG`. The sender pings every 5 s; no inbound traffic for 10 s means the connection is dead. Answer the device's `PING` with `PONG`. |
| `urn:x-cast:com.google.cast.receiver` | `GET_STATUS`, `LAUNCH {appId}`, `STOP {sessionId}`, `SET_VOLUME {volume:{level}}` or `{volume:{muted}}`, `GET_APP_AVAILABILITY {appId:[…]}`. Replies: `RECEIVER_STATUS`, `LAUNCH_ERROR`, `INVALID_REQUEST`, and the availability reply. Requests carry an integer `requestId`; replies echo it. |

Ids: the platform receiver is `receiver-0`. Each sender uses `sender-<random>`. After `LAUNCH`, the app's
`transportId` from `RECEIVER_STATUS.status.applications[]` is the destination for a second `CONNECT` and for all app
namespace messages.

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

### Presentation sources

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
repeats. Site-initiated mirroring for the allowlisted origins (docs, meet, music.youtube.com) is not available here
either, though Chrome offers it there. A plain https URL (Chrome's one-UA tab mirroring) is still rejected as
`NotSupportedError`, not `NotFoundError`.

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
| The sinks are reported to observers once discovery has been quiet for 3 s, and only when the list changed | `markChanged`, `report` (`reportDelayMs`) | `chrome/browser/media/router/discovery/media_sink_service_base.cc`: `kDiscoveryTimeout`, `StartTimer`, `OnDiscoveryComplete` |
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
