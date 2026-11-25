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

### CastMessage (protobuf, from Chromium `cast_channel.proto`)

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
CastMessage. The maximum body is 65536 bytes (Chromium's `kMaxMessageSize`); a larger declared length is a protocol
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
like any unreachable device (`receiver_unavailable`). Devices are verified when connected, not when discovered, so a
device that fails shows in the picker but cannot be cast to.

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
  (`docs/upstream/`, not shipped). With that hook the stand-in would go away.

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
terminating them, which is the "park" here. Only `SetDefaultPresentationUrls` is limited to the outermost document
(`is_outermost_document_`); electron-cast has no `defaultRequest` support, so that rule has no counterpart.

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
| Device description | `dial-sink-service.ts`: `GET` without an `Origin` header, the `Application-URL` header validated like a `LOCATION` and stripped of a trailing slash, the XML parsed for `UDN`, `friendlyName` (else `<model> [<last 4 of UDN>]`), `modelName` and `deviceType`; cached 12 h by label and `CONFIGID`, 256 entries. | `device_description_fetcher.cc`, `device_description_service.cc` (`ValidateParsedDeviceDescription`), `safe_dial_device_description_parser.cc` |
| HTTP | `http.ts`: no redirects ("Redirect not allowed"), a 256 KiB body limit, a UTF-8 body, a `GET` with an empty body is an error, `GET` retried twice on 5xx, `POST` and `DELETE` not retried, `POST` as `text/plain`; an `Origin: package:Google-Chrome.<major>.<OS>` header on the app-info `GET`, `POST` and `DELETE` (not on the description `GET`), so a web page cannot make a browser do the same. | `dial_url_fetcher.cc` (`DialURLFetcher`, `GetFakeOriginForDialLaunch`) |
| App info | `parse.ts` `parseAppInfo`, `dial-sink-service.ts` `fetchAppInfo`: `<service dialVer>` with `name`, `options@allowStop`, `link@href`, `state` (`running` or `stopped`, any case; else invalid) and `additionalData`; the result is a `network_error` (no HTTP status), `http_error` (non-2xx) or `parsing_error` (2xx, unusable body). | `dial_app_discovery_service.cc`, `safe_dial_app_info_parser.cc`, `components/media_router/common/media_source.cc` (`GetDialAppUrl`) |
| Sinks | `dial-sink-service.ts`: sink id `dial:<UDN without "uuid:" and "-", lower case>`, icon `generic`, extra data `app_url`, `model_name`, `ip_address`; published 3 s after the last change; a sink is available for an app when app info said `running` or `stopped`, unavailable on an `http_error` or `parsing_error`, unknown on a `network_error`; app info is asked only while the answer is unknown, and never of `eureka dongle`, `chromecast audio` or `chromecast ultra`. | `dial_media_sink_service_impl.cc` (`OnDeviceDescriptionAvailable`, `OnDiscoveryComplete`, `FetchAppInfoForSink`, `GetSinkAppStatusFromResponse`), `media_sink_util.cc` |
| Cast/DIAL dedup | A DIAL sink whose uuid is a Cast device's `id` (processed the same way) is hidden: not listed, not queried, not routable. | `chrome/browser/media/router/discovery/mdns/cast_media_sink_service_impl.cc` (`TryConnectDialDiscoveredSink`: a Cast sink with the same id removes the DIAL sink) |
| Availability | `presentation-handler.ts`, `origins.ts`: a `cast-dial:` source is available when a sink has the app; for `youtube`, `netflix`, `pandora`, `radio`, `hulu`, `vimeo` and `dailymotion` only to Chrome's list of origins (matched case-insensitively on the app name); a request with a Cast URL too is available if either is. Like Chrome's, the first answer is what is known now: the app query is still on its way. | `chrome/browser/media/router/providers/dial/dial_media_route_provider.cc` (`StartObservingMediaSinks`, `GetOrigins`), `components/media_router/browser/media_sinks_observer.cc` (`OnSinksUpdated`) |
| Create a route | `route-provider.ts` `createRoute`: unknown sink, a source that is not a `cast-dial:` launch (the `clientId` is required) and a repeated route fail like `SINK_NOT_FOUND`, `NO_SUPPORTED_PROVIDER`, `ROUTE_ALREADY_EXISTS`; an existing route on the sink is terminated first; the page gets `receiver_action` (`cast`) and `new_session` at once. The route id is `urn:x-org.chromium:media:route:<presentation id>/<sink id>/<source>` and the presentation id `mr_<uuid>`. | `dial_media_route_provider.cc` (`CreateRoute`), `dial_activity_manager.cc` (`DialActivity::From`, `AddActivity`), `dial_internal_message_util.cc`, `components/media_router/common/media_route.cc` (`GetMediaRouteId`), `components/media_router/browser/media_router_base.cc` (`CreatePresentationId`) |
| The SDK's round trip | `client_connect` makes the provider fetch app info and send `custom_dial_launch` (`{receiver, appState, extraData}` with a fresh sequence number, remembered in a set of at most 10); the page answers with the same number and `{doLaunch, launchParameter}`; an answer to an unknown number is ignored. `dial_app_info` is answered with the app info or an `error` (`network_error`, `parsing_error`, `http_error` with `details.http_error_code`) under the same number. A failed fetch at `client_connect` sends nothing, as in Chrome, and the route stays. | `dial_media_route_provider.cc` (`HandleParsedRouteMessage`, `HandleClientConnect`, `HandleCustomDialLaunchResponse`, `HandleAppInfoRequest`), `dial_internal_message_util.cc` |
| Launch | `doLaunch: false` marks the route launched without a request; otherwise a `POST` to `<app url>/<app>` whose body is the launch parameter, else the source's `dialPostData` exactly as written in the source (Chrome reads the raw, still escaped query value); a `LOCATION` that is an http URL on the sink's own address becomes the run URL; a failed launch removes the route. | `dial_activity_manager.cc` (`LaunchApp`, `CustomDialLaunchMessageBody::From`, `DialActivity::From`) |
| Stop | A `v2_message` of type `STOP` or a page's `terminate()` sends `receiver_action` (`stop`) and `DELETE`s the run URL (`<app url>/<app>/run` when the launch gave none); a route that was never launched is dropped without a request; a failure looks at app info again and posts an issue unless the app is no longer running; the connection ends `terminated` either way. | `dial_media_route_provider.cc` (`DoTerminateRoute`, `HandleStopAppResult`), `dial_activity_manager.cc` (`StopApp`) |
| Join and close | `reconnect` with an `mr_` id joins the route with the same presentation id, source and origin and sends nothing; closing a connection, navigating or closing the page leaves the route and the app running. | `dial_media_route_provider.cc` (`JoinRoute`; `DetachRoute` is `NOTIMPLEMENTED`), `components/media_router/browser/presentation/controller_presentation_service_delegate_impl.cc` |

Differences from Chrome, and why:

- **No Cast channel for a DIAL-only device.** Chrome tries to open a Cast channel to a device it found by SSDP only
  (port 8009) and, when that works, shows it as a Cast sink (`CastMediaSinkServiceImpl::TryConnectDialDiscoveredSink`
  opens the channel; `OnChannelOpenSucceeded` drops the DIAL sink). electron-cast does not try: such a device is
  listed as a DIAL sink. A device that mDNS also found is a Cast sink either way.
- **Timeouts.** Chrome sets none on its URL fetches (`DialActivityManager::CreateFetcher` has a TODO for it); Node
  would wait forever, so a `GET` gives up after 10 s and a `POST` or `DELETE` after 30 s.
- **`setMulticastInterface`.** Each SSDP socket also pins its multicast sends to its interface, which Windows needs to
  send from the right adapter.
- **The `Origin` product.** `package:Google-Chrome.<major>.<OS>` is the syntax in `GetFakeOriginForDialLaunch`'s
  comment; `<major>` comes from the Chromium that Electron ships (`0` outside Electron).
- **Stop failures.** Chrome posts an issue (`IDS_MEDIA_ROUTER_ISSUE_CANNOT_TERMINATE`); the provider emits an `issue`
  event and rejects `terminateRoute`, and the connection still ends.
- **Volume.** A DIAL route has none, as in Chrome (`BindMediaController` is `NOTIMPLEMENTED`).
- **The XML reader** (`xml.ts`) stands in for Chromium's out-of-process `data_decoder`: it refuses entity
  declarations, caps the depth and ignores namespaces.

## Electron layer (`src/electron/`)

No Electron import: both modules take the Electron objects they need as parameters, typed by small structural
interfaces, so the library has no Electron dependency and runs in plain Node.

- `main.ts`: `createCastManager({ ipcMain, selectDevice, allowOrigin?, discovery?, createClient?, channel?,
  presentation? })` returns `{ start, devices, dispose }`. It registers one invoke handler on `<channel>:call`; events
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
