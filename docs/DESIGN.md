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
| `protocol/messenger.ts` | openscreen `public/session_messenger.cc` (namespaces, 4 s reply timeout, `*` destination), `sender_session.cc` (`Negotiate`, `OnAnswer`, `RequestCapabilities`) |
| `rtp/packetizer.ts` | openscreen `impl/rtp_packetizer.cc` |
| `rtp/frame-crypto.ts` | openscreen `impl/frame_crypto.cc` |
| `rtcp/ntp.ts`, `rtcp/sender-report.ts` | openscreen `impl/ntp_time.cc`, `impl/sender_report_builder.cc`, `impl/rtcp_common.cc` |
| `rtcp/parser.ts` | openscreen `impl/compound_rtcp_parser.cc` |
| `sender/sender.ts` | openscreen `impl/sender_impl.cc` (`Sender`) |
| `sender/packet-router.ts` | openscreen `impl/sender_packet_router.cc` |
| `sender/bandwidth-estimator.ts` | openscreen `impl/bandwidth_estimator.cc` |
| `sender/frame-sender.ts` | Chromium `media/cast/sender/openscreen_frame_sender.cc`, `video_sender.cc`, `audio_sender.cc`, `media/cast/constants.h` |
| `session-host.ts` | Chromium `components/mirroring/service/openscreen_session_host.cc`, `mirror_settings.cc`, `mirroring_features.cc`, `media/cast/openscreen/config_conversions.cc`, `media/cast/encoding/encoding_support.cc` |
| `mirroring-activity.ts` | Chromium `mirroring_activity.cc` (`OnAppMessage`, `OnInternalMessage`, `HandleParseJsonResult`, `StartSession`, `StopMirroring`) and `cast_activity_manager.cc` (`DoLaunchSession`, `OnActivityStopped`) |
| `mirroring-manager.ts` | Chromium `cast_activity_manager.cc` (`LaunchSession`, `TerminateSession`, `NotifyAllOnRoutesUpdated`), `media_route.cc` (`GetMediaRouteId`) |
| `routing.ts` | Chromium `cast_media_source.cc` (`CastMediaSourceForTabMirroring`, `ForDesktopMirroring`, `ProvidesStreamingAudioCapture`, the streaming `CastAppInfo`s), `components/media_router/common/media_source.cc`, `cast_activity_manager.cc` (`ChooseAppId`), `mirroring_activity.cc` (`StartSession`, `GetRouteDescription`, `GetMirroringNamespace`, `GetScrubbedLogMessage`), `chrome/app/media_router_strings.grdp` |
| `engine.ts` | assembles `OpenscreenSessionHost` around a backend, as the Mirroring Service does with its resource provider |
| `transport/udp-environment.ts` | openscreen `cast/streaming/public/environment.cc` (`SendPacket`, `GetMaxPacketSize`, `OnRead`) and `SenderPacketRouter::OnReceivedPacket` (packets only from the announced endpoint) |
| `electron/agent-source.ts`, `electron/port-backend.ts`, `electron/agent-protocol.ts` | Chromium `components/mirroring/service/video_capture_client.cc`, `audio_capturing_callback.cc`, `media/cast/encoding/{video_encoder,audio_encoder}.cc` (frame ids, key frames, bitrate, utilization), `openscreen_session_host.cc` (`OnEncoderStatusChange`) |
| `electron/host.ts` | Chromium `chrome/browser/media/cast_mirroring_service_host.cc` (the tab and desktop capture sources) |

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
closes the oldest, so a dropped frame costs nothing. Pixels are not copied: a `VideoFrame` goes from the track
processor into the encoder. Encoded chunks are copied once, through the port (Electron cannot transfer an
`ArrayBuffer` over a `MessagePortMain`).

### Local audio while mirroring

Chrome decides whether the sender's own speakers stay on, and we match it (`CastMirroringServiceHost`,
`chrome/browser/media/cast_mirroring_service_host.cc`):

- **Desktop**: `GetDesktopAudioLoopbackDeviceId` returns `kLoopbackInputDeviceId` on Windows, so local playback keeps
  going, when `kCastDesktopMirroringKeepLocalAudio` is enabled (on by default there, `media_router_feature.cc`;
  muting the endpoint silences the loopback on some drivers). Every other platform gets `kLoopbackWithMuteDeviceId`,
  which mutes local playback while mirroring. Here: Windows captures with `getUserMedia` and `chromeMediaSource:
  'desktop'` (loopback, no mute); other platforms use `getDisplayMedia` on the capture window's private session, whose
  `setDisplayMediaRequestHandler` answers with the app's source and `audio: 'loopbackWithMute'`. The choice is Chrome's, and like
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
*launched*, `CastSessionService.sessionsLaunchedBy`, through `terminateSession`) and `CastSessionServiceOptions.onSessionLaunched`
(called when a page launches a session; `main.ts` ends that page's mirroring routes). A session the page only joined is not
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

Opus (48 kHz stereo, 10 ms frames, 128 kbps; `audio_encoder.cc` `OpusImpl`) and VP8 are always offered. VP9 is offered
only when the app asks for it (`extraVideoCodecs: ["vp9"]`) and `VideoEncoder.isConfigSupported` says Electron can
encode it, which is Chrome's software list (`encoding_support.cc`: VP8 and VP9). H.264, HEVC and AV1 are not offered:
Chrome offers H.264 only through hardware encoders and its HEVC and AV1 features are off by default, and WebCodecs
cannot tell us whether an encoder is hardware. The order of offered codecs is `kSupportedVideoCodecs` (HEVC, AV1, VP9,
H264, VP8) with the hardware-first rule, in `session-host.ts`. No encoder is bundled.

### Not checked, or different from Chromium

- The fake receiver in `test/mirroring/` is ours: it implements what openscreen's receiver does for the parts we send
  to (ANSWER, RTCP reports, ACKs, NACKs), not Chrome's receiver app. **No real device has been used.** Whether a real
  Chromecast accepts this OFFER, and what it does with the VP8 we produce, is unverified; the live harness in
  `examples/live-mirroring/` is how to find out.
- Not ported: Remoting (RPC playback), the stats analyzer and
  UMA, the GPU/hardware encoder denylist and re-offer after an encoder failure (an encoder failure stops the session),
  letterboxing, `GET_CAPABILITIES` (Chrome sends it only for remoting).
- Chrome's `OnAppMessage` compares a message's `source_id` with the sender's id and its `destination_id` with the
  session's, which reads as swapped for a message from the receiver; `MirroringActivity` here takes the transport as
  the source and the sender's id (or `*`) as the destination.
- Frame rate: capture is rate-limited to the requested rate, never raised to it, and a hidden page can render slower
  than 30 fps. In the smoke test a 60 Hz test page mirrors at about 22 fps on the development machine.
- `startCasting` for mirroring is added to the main-process API here. Where `feat/default-presentation` adds
  `startCasting` for `castMode: "presentation"`, the two merge into one method that dispatches on `castMode`.
