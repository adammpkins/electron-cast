# Chromium map

Which parts of Chromium each electron-cast module mirrors, with the file and symbol to read, and where electron-cast differs on
purpose.

electron-cast's rule is to behave as Chrome does and to say which Chromium code it follows. This is the index. Every path below
exists in `chromium/chromium` at `main`, and every symbol named was found in that file when this page was written. The opt-in
check `npm run docs:check:chromium` fetches each linked file and looks for each symbol again, so the page is rechecked on request,
not at every build (Chromium moves code around; a failing symbol means the link needs updating, not that the library is wrong).
Paths are relative to the Chromium source root: [github.com/chromium/chromium](https://github.com/chromium/chromium).
The `.proto` is in the Open Screen library, [github.com/chromium/openscreen](https://github.com/chromium/openscreen).

A symbol is cited by name and not by line number, because line numbers drift with every commit.

## Presentation API (page and frame)

| electron-cast | Chromium file | Symbols | What is mirrored | Differs |
|---|---|---|---|---|
| `src/polyfill/presentation-standin.ts` | [`third_party/blink/renderer/modules/presentation/presentation_request.cc`](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/presentation/presentation_request.cc) | `PresentationRequest::start`, `HasTransientUserActivation` | `start()` requires transient user activation and otherwise rejects with `InvalidAccessError: PresentationRequest::start() requires user gesture.` | The authoritative check is in the main process (`hasGesture` from the preload), because a page can forge anything it holds |
| `src/electron/main.ts`, `presentation-handler.ts` | [`content/browser/presentation/presentation_service_impl.cc`](https://github.com/chromium/chromium/blob/main/content/browser/presentation/presentation_service_impl.cc) | `PresentationServiceImpl::StartPresentation`, `HasTransientUserActivation`, `GetLastCommittedOrigin`, `DidFinishNavigation`, `Reset`, `is_outermost_document_` | One service per frame; the origin comes from the browser, not the page; a navigation resets the frame; user activation is required to start; only the outermost document sets default presentation URLs | No default presentation request yet (in progress) |
| `src/electron/session-service.ts` (parking) | [`components/media_router/browser/presentation/controller_presentation_service_delegate_impl.cc`](https://github.com/chromium/chromium/blob/main/components/media_router/browser/presentation/controller_presentation_service_delegate_impl.cc) | `ControllerPresentationServiceDelegateImpl`, `PresentationFrame::Reset` | A frame's reset detaches its routes and does not terminate them, which is the "park" | |

## Media Router (sessions, routes, envelope)

| electron-cast | Chromium file | Symbols | What is mirrored | Differs |
|---|---|---|---|---|
| `session-service.ts` (auto-join, join by id) | [`chrome/browser/media/router/providers/cast/cast_activity_manager.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/media/router/providers/cast/cast_activity_manager.cc) | `CastActivityManager::LaunchSession`, `FindActivityForAutoJoin`, `FindActivityForSessionJoin`, `AddNonLocalActivity` | Auto-join finds only sessions this run holds; a session id finds any activity | Chrome tracks every sink's sessions continuously; electron-cast asks the known devices when a join by id is made |
| `session-service.ts` (joining) | [`chrome/browser/media/router/providers/cast/app_activity.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/media/router/providers/cast/app_activity.cc) | `AppActivity::CanJoinSession`, `SendMediaRequestToReceiver`, `SendAppMessageToReceiver` | Joining checks the receiver app and that the client id is not already connected; no origin check | |
| `session-service.ts` (stop, volume) | [`chrome/browser/media/router/providers/cast/cast_activity.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/media/router/providers/cast/cast_activity.cc) | `CastActivity::SendStopSessionMessageToClients`, `SendSetVolumeRequestToReceiver` | What the clients are told when a session stops; how volume reaches the receiver | |
| `session-service.ts` (sessions of other senders) | [`chrome/browser/media/router/providers/cast/cast_session_tracker.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/media/router/providers/cast/cast_session_tracker.cc) | `CastSessionTracker` | Where Chrome learns the sessions running on all sinks | See above |
| `presentation-handler.ts` | [`chrome/browser/media/router/providers/cast/cast_session_client_impl.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/media/router/providers/cast/cast_session_client_impl.cc) | `CastSessionClientImpl::HandleV2ProtocolMessage`, `SendResultResponse` | Which `v2_message` types are forwarded to the receiver (media requests, volume) and that anything else is only logged; that a failed request's error carries no real cause | The cap on pending media requests: Chromium's `kMaxPendingMediaRequests` is 1024 (in `cast_session_client_impl.h`), electron-cast's is 100 |
| `presentation-envelope.ts` | [`chrome/browser/media/router/providers/cast/cast_internal_message_util.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/media/router/providers/cast/cast_internal_message_util.cc) | `CreateNewSessionMessage` | The private JSON envelope (`new_session`, `update_session`, `receiver_action`, `v2_message`, `app_message`, `error`) between Google's SDK and the router | |
| `presentation-envelope.ts` | [`components/media_router/common/providers/cast/channel/cast_message_util.cc`](https://github.com/chromium/chromium/blob/main/components/media_router/common/providers/cast/channel/cast_message_util.cc) | `IsMediaRequestMessageType` | Which message types are media requests | |
| `manager-api.ts` | [`chrome/browser/media/router/discovery/mdns/cast_media_sink_service_impl.cc`](https://github.com/chromium/chromium/blob/main/chrome/browser/media/router/discovery/mdns/cast_media_sink_service_impl.cc) | `CastSinkExtraData` (`model_name`) | The sink's device model | Chrome's `MediaSink` has no model field; electron-cast's `MediaSink` carries it |
| URL parsing | [`components/media_router/common/providers/cast/cast_media_source.cc`](https://github.com/chromium/chromium/blob/main/components/media_router/common/providers/cast/cast_media_source.cc) | `AutoJoinPolicy` | The auto-join policy names (`origin_scoped`, `tab_and_origin_scoped`, `page_scoped`) | |

## Cast v2 channel and device authentication

| electron-cast | Chromium file | Symbols | What is mirrored | Differs |
|---|---|---|---|---|
| `src/protocol/framing.ts` | [`components/media_router/common/providers/cast/channel/cast_framer.cc`](https://github.com/chromium/chromium/blob/main/components/media_router/common/providers/cast/channel/cast_framer.cc) | `MessageFramer::MessageHeader::max_body_size` (65536) | The 4-byte length prefix and the body limit | |
| `src/protocol/cast-message.ts` | [`cast/common/channel/proto/cast_channel.proto`](https://github.com/chromium/openscreen/blob/main/cast/common/channel/proto/cast_channel.proto) (in the Open Screen repository) | `CastMessage`, `DeviceAuthMessage` | The wire format | |
| `src/client/auth/cast-auth.ts` | [`components/media_router/common/providers/cast/channel/cast_auth_util.cc`](https://github.com/chromium/chromium/blob/main/components/media_router/common/providers/cast/channel/cast_auth_util.cc) | `kNonceSizeInBytes` (16), `kMaxSelfSignedCertLifetimeInDays` (4), `VerifyCredentialsImpl`, `AuthContext::VerifySenderNonce`, `CRL_REQUIRED_WITH_FALLBACK` | The challenge, the 4-day limit on the TLS certificate, the order of checks, revocation policy | Chrome records a missing nonce echo and carries on; so does electron-cast, reporting it as `nonceEchoed` |
| `src/client/auth/cast-cert-validator.ts`, `path-validator.ts` | [`components/media_router/common/providers/cast/certificate/cast_cert_validator.cc`](https://github.com/chromium/chromium/blob/main/components/media_router/common/providers/cast/certificate/cast_cert_validator.cc) | `VerifyDeviceCert`, `CastTrustStore`, `CertVerificationContextImpl::VerifySignatureOverData`, `kValidityFailedNotBefore` | Chain to the Cast roots, the device certificate's constraints, the signature over the nonce and the TLS certificate | A stand-alone port of the path validation, not BoringSSL's |
| `src/client/auth/crl.ts`, `trust-data.ts` | [`components/media_router/common/providers/cast/certificate/cast_crl.cc`](https://github.com/chromium/chromium/blob/main/components/media_router/common/providers/cast/certificate/cast_crl.cc) | `kFallbackCrlValidityInSeconds` (20 weeks), `kCastFallbackCRLTimestamp`, `CastCRLImpl`, `VerifyCRL` | The built-in fallback CRL and how long it is trusted | Once the fallback is older than 20 weeks Chrome refuses the device; electron-cast skips the revocation check and reports `revocationChecked: false` (see [DESIGN](DESIGN.md#device-authentication-srcclientauth)) |
| `src/client/auth/trust-data.ts` | [`components/certificate_transparency/chrome_ct_policy_enforcer.cc`](https://github.com/chromium/chromium/blob/main/components/certificate_transparency/chrome_ct_policy_enforcer.cc) | `ChromeCTPolicyEnforcer::IsLogDataTimely` (70 days) | The staleness rule that Chrome applies to its built-in data, cited as the precedent for ageing built-in trust data | |

## Outside Chromium

| electron-cast | Source | What is mirrored |
|---|---|---|
| `src/client/auth/der.ts`, `x509.ts`, `path-validator.ts`, `names.ts` | BoringSSL's `pki` library (`pki/parser.cc`, `pki/parse_certificate.cc`, `pki/verify_certificate_chain.cc`, ...), which Chromium's Cast verification is built on | Strict DER parsing and RFC 5280 path validation |
| `src/discovery/` | mDNS (RFC 6762) and DNS-SD (RFC 6763) for `_googlecast._tcp.local` | Queries and records; TXT keys `id`, `fn`, `md`, `ca`, `rs` |

## Adding or changing a citation

1. Read the Chromium code on `main` (open the file, do not rely on memory or a search snippet).
2. Cite the file and the symbol, not a line number.
3. Add the row here and run `npm run docs:check:chromium`.
4. If electron-cast differs, say so in the "Differs" column. A silent difference is a bug in the docs.
