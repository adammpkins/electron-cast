# Changelog

## 0.5.0

The first stable release of 0.5: `npm i electron-cast` now installs it. It holds everything in the two prereleases
below (0.5.0-next.1 and 0.5.0-next.2) and the changes in this section. electron-cast's main process now works as Chrome's
Media Router does: devices are kept open and authenticated, pages get app availability, sessions started by other
senders are listed, routes can be controlled from the app, and DIAL, wired displays, the Presentation Receiver API and
tab and desktop mirroring (a port of Chrome's Cast Streaming sender) are in. This section adds an ordinary web page
presented on a Cast device (Chrome's 1-UA mode), the capture capped at the primary screen as Chrome caps it, more of
Chrome's mirroring flags, the media router's sink service status and logs, and VP8, VP9 and HEVC quantizer reading.

Upgrading from 0.4.0: read **Changed** under 0.5.0-next.1. `createClient` is called once per device with a new
signature, and devices at public or loopback addresses are refused unless `sinks.allowAllIps` is set.

### Chrome parity

- **`CastMessageLogging` is ported** (`kCastMessageLogging`, off by default). With `--enable-features=CastMessageLogging` the
  media router log (`getLogs`, `registerLogObserver`) also holds the messages of Cast routes, as Chrome logs them: the
  envelopes to and from the page and the messages to and from the receiver, at `Info` in the `Route` category, with the JSON
  written as `base::WriteJson` writes it.
- **The media router's sink service status** (`MediaSinkServiceStatus`, what `chrome://media-router-internals` shows as its
  state): `getMediaSinkServiceStatus()` returns `discovered_sinks` (the sinks each discovery service, `cast` and `dial`,
  reported, 3 s after a change) and `available_sinks` (the last 100 lists of sink ids, keyed `<PROVIDER>:<media source>`),
  with Chrome's key names; `getMediaSinkServiceStatusAsString()` is `MediaRouterDesktop::GetMediaSinkServiceStatus`.
- **`getLogsAsString()`** is `MediaRouterDesktop::GetLogsAsString`, the log as the JSON the Cast feedback page gets, with each
  entry's keys sorted as Chrome writes them.
- **A `castMode: "tab_mirror"` sinks query listed every device**, DIAL sinks and speakers without audio out included: it asked
  for a tab source Chrome's `IsTabMirroringSource` does not accept. It now lists the Cast sinks that can run a streaming app.
- **The capture resolution is capped at the primary screen, as Chrome caps it** (`CastMirroringServiceHost::GetCaptureResolutionConstraint`
  and `GetClampedResolution`): the screen's size in pixels, in landscape, limited to 1920x1080 and rounded down to a
  whole step of 160x90. A 1366x768 laptop screen mirrors at 1280x720 instead of asking for 1080p. Pass Electron's `screen`
  in `mirroring.electron`; without it the capture is limited to 1920x1080 as before, which is also what Chrome does when it
  cannot get the screen.
- **`--enable-features=CastStreamingGradualBandwidthBackoff:congestion_signal/before_encoding` (or `after_encoding`)**
  chooses which video frame drops count as congestion, as Chrome's feature parameter does. The default
  (`before_or_after_encoding`) is what the library always did. `--enable-features` now understands Chrome's
  `Feature:name/value` parameter syntax.
- **`--enable-features=CastStreamingPerformanceOverlay`** draws Chrome's performance metrics overlay (three lines of digits
  at the bottom of each frame: frames in the encoder, encoder utilization and lossiness; capture time, playout delay, low
  latency mode and target bitrate; frame duration, size and timestamp) on the frames sent to the receiver. Off by default.
- **More of Chrome's mirroring flags are read**, each with Chrome's default and `Feature:name/value` syntax:
  `--enable-features=CastStreaming60fps` (offer and capture 60 fps instead of 30),
  `CastStreamingMaxVideoBitrate:max_bitrate_mbps/<n>` (the maximum video bitrate, default 5 Mbps as before; the start
  bitrate stays at most 10 Mbps), the `good_network_citizen_factor`, `min_backoff_factor`, `max_backoff_factor`,
  `fast_recovery_increase` and `conservative_increase` parameters of `CastStreamingGradualBandwidthBackoff` (clamped as
  Chrome clamps them), `--disable-features=CastStreamingGradualBandwidthBackoff` (Chrome's legacy bandwidth update:
  snap down to the estimate when frames drop) and `--disable-features=CastStreamingOfferHardwareFirst` (hardware and
  software codecs in one offer, no fallback offer). Defaults change nothing.
- **The performance overlay is laid out as current Chromium main draws it**, not as Chrome 120 did: main advances the
  pointer before each glyph, so a line sits one glyph further right and its last glyph runs into the next pixel row. That
  looks like a regression in Chromium; it is matched on purpose.
- **Desktop audio on Linux needs `--enable-features=PulseaudioLoopbackForCast`**, as in Chrome: without it `withAudio` is
  ignored for a desktop capture and the sinks query does not ask for audio. Windows and macOS are unchanged.
- **A presentation URL that is not a Cast URL can be presented on a Cast device** (Chrome's 1-UA mode,
  `CastMediaSource::FromMediaSource`, `OffscreenTab`). With the `mirroring` option on, a page's `PresentationRequest` for
  an https URL (or http on localhost) is available on every Cast sink that has a streaming app. `start()` opens the URL
  in a hidden, muted window with `navigator.presentation.receiver`, mirrors it to the device at the primary display's
  size (16:9, at most 1920x1080), and connects the page to it; the route is `Presenting (<host>)`. It was
  `NotSupportedError`. There is no option to set; pass `screen` in `mirroring.electron` for Chrome's capture size. The
  hidden window's session has no permissions: the presented page cannot capture the screen, the camera or the
  microphone. Tested on a Chromecast Ultra from Windows: the page showed on the TV with its sound, messages went both
  ways, and the page's terminate ended the route and closed the hidden window (`npm run live:checks -- parity --test
  one-ua`; `npm run smoke:one-ua` runs it against the fake receiver). See
  [DESIGN.md](docs/DESIGN.md#presentation-urls-on-a-cast-device).

### Fixed

- **Software VP8 and VP9 and hardware HEVC read the quantizer too, as H.264 does since 0.5.0-next.2**, so a PC without a hardware H.264 encoder no longer
  mirrors a blocky tab at full size. The quantizer is read from the VP8 frame header, the VP9 uncompressed header and
  the HEVC slice header, and normalized as Chrome's encoders report it: libvpx's 0 to 63 scale over 63
  (`VpxVideoEncoder::GetEncoderOutput`; Chrome lets libvpx go up to 58), the HEVC slice QP over 51, and a hardware VP8
  or VP9 q index over 127 or 255 (`VideoEncodeAcceleratorAdapter::BitstreamBufferReady`). The stage log names the
  scale with the QP (`video QP (of 63)`).
- **A mirrored tab whose size keeps changing no longer gets a new encoder and a key frame for every size.** As in
  Chrome (`resize_debounce_timer_` of `MediaVideoEncoderWrapper`), a new frame size has to last 250 ms before the
  encoder is rebuilt for it; until then the running encoder scales the frames to its own size, and a size that goes
  back within that time costs nothing. The first frame still makes its encoder at once.

### Documentation

- `FallbackToAudioTabMirroring` stays "does not apply", now with Chrome's reason: only the Global Media Controls panel reads
  it, and the toolbar dialog always has tab and desktop mirroring.
- The README no longer lists file mirroring as a Chrome feature (Chrome's `MediaCastMode` has none), and the DESIGN page no
  longer says `media_sink_service_status.cc` is gone from Chromium (it is in `chrome/browser/media/router/mojo/`).
- The Chromium map's "not yet tried on a real device" rows now agree with the README and the "Tested on real devices"
  records: the CONNECT and LAUNCH fields, receiver labels with a token store, the sink order and the failed launch were tested
  on a Nest Hub Max; discovery parsing with eight real devices.

## 0.5.0-next.2 (prerelease)

A second prerelease of 0.5.0 on the npm `next` tag: install it with `npm i electron-cast@next` (`npm i electron-cast`
still installs 0.4.0). Tab mirroring over a laggy link now behaves as Chrome's does: the capture gets smaller instead of
the picture going blocky, and on Windows the sender keeps time. Presentation URLs, sink order and receiver labels follow
Chrome more closely.

### Documentation

- **Troubleshooting for laggy or blocky mirroring**: which log lines to read, and what helps (a quieter network, a longer
  playout delay). The README's 1080p lag known issue is gone: on a Chromecast Ultra a mirrored tab looked as clean as
  Chrome's.

### Chrome parity

- **Cast presentation URLs are read as Chrome reads them** (`CastMediaSource::FromMediaSource`). New fields:
  `supportedAppTypes`, `appParams`, `invisibleSender`, `streamingTargetPlayoutDelayMillis` and `streamingCaptureAudio`.
  A legacy URL with several `__castAppId__` is no longer reduced to its last app: a sink is offered the URL when it has
  one of the apps and its capabilities, and the first app it can run is launched. Values are unescaped as Chrome unescapes
  them, an unknown `autoJoinPolicy` is `page_scoped` (it was `tab_and_origin_scoped`), and a `cast:` URL's `(caps)` suffix is
  no longer split off the app id. Tested on a Nest Hub Max (see below).
- **A device with no `fn` is not a sink** (`CreateCastMediaSink`: an empty or missing `id` or `fn`). It was listed under its
  instance name. TXT keys are now case-sensitive and the last repeat wins, as in Chrome.
- **Sinks are listed in Chrome's order** (`MediaSink::CompareUsingCollator`): by icon type, then collated name, then id.
  Group speakers now come before single speakers.
- **Receiver labels survive a restart when the app gives `receiverIdHashToken`** a store: a 64-byte token as Chrome keeps in
  the profile (`GetReceiverIdHashToken`). It was a 16-byte token made at every start.

### Tested on real devices

- **Chrome parity, tested on a Nest Hub Max** (`npm run live:checks -- parity`). The CONNECT and LAUNCH JSON of a session
  started by Google's SDK were logged and accepted (`flower.mp4` reached `PLAYING`); `Session.leave()` closed the page's
  connection with reason `closed` and `Session.stop()` ended it as `terminated`; receiver labels were the same across two
  runs with a token store and different without one; the sink list of eight real devices was in Chrome's order; a launch
  of an app the device does not have raised the "Failed to cast" warning for that sink and showed in `getLogs`; a page with
  `AllowAllSitesToInitiateMirroring` started mirroring with a streaming delay of 300 ms (the OFFER carried it, about
  8,600 packets were sent and acknowledged in 30 s, and `terminate()` from the page ended the route); and a mirrored tab
  whose page's SDK auto-joined was replaced by a Default Media Receiver session.
- **Sessions started by another sender, tested on a Nest Hub Max** (`npm run live:checks -- parity --test nonlocal-join` and `nonlocal-terminate`). A Node script on its own connection launched the Default Media Receiver and played `flower.mp4`. The route was listed as non-local (`isLocal` false, no member, Chrome's description, the right sink); a page's `ORIGIN_SCOPED` auto-join did not take it, `chrome.cast.requestSessionById` did, and media status reached the page; the other sender's stop removed the route and ended the page's session; and `terminateRoute` stopped the app on the device. No library change was needed.
- **DIAL dedup tested with real Chromecasts.** With DIAL on, three Chromecasts that answer both mDNS and DIAL were each listed
  once over 60 s, as Cast sinks and never as DIAL sinks (the DIAL entry shows for about a second until the Cast channel
  opens and then goes, as in Chrome's `CastMediaSinkServiceImpl::OnChannelOpenSucceeded`); the other five devices were
  listed once each. No flapping.
- **Casting from an iframe, tested on a Nest Hub Max.** Google's SDK in a same-origin and in a cross-origin iframe started a
  session on the Default Media Receiver through `selectDevice` (the iframe's own origin, a sender id from 2^30 up), media
  reached `PLAYING` and the page stopped the session. The top page did the same as a control.
- **Casting from the app's own UI, tested on a Nest Hub Max.** `startCasting(sinkId, { webContentsId })` from the main
  process for the page's default `PresentationRequest` (set by the SDK) started a session without a click, the page got
  `connectionavailable`, the SDK adopted the session, media reached `PLAYING`, and `terminateRoute` ended it.

### Fixed

- **Mirroring on Windows sends its packets on time.** The sender's delayed tasks ran on Node's timers, which on Windows
  end on the 15.6 ms system tick: a packet burst that was due at once, or 10 ms after the last one, went out up to 15.6 ms
  late (62 bursts a second instead of 100, a frame waiting 8.5 ms on average and up to 40 ms before its first packet
  left). A task that is due now runs without a timer, and a delayed one is woken by the capture window's timer, which is
  Chromium's and keeps time as Chrome's task runner does; Node's timer stays as the fallback. The engine logs how late its
  tasks ran (`timers:`), and the feedback line now gives the round trips as measured and the number of feedback gaps over
  100 ms.
- **A hardware H.264 encoder that cannot reach its target bitrate now makes the mirrored tab's capture smaller, as in
  Chrome.** Chrome judges how lossy a frame is by the quantizer its encoder reports; WebCodecs reports none, so the
  estimated complexity of the frame's pixels stood in, and for mostly still pages that estimate is low. At a low target
  the encoder sat at its largest quantizer (QP 51, a blocky picture) and still sent several times the target, while the
  capture stayed at full size. The quantizer is now read from each H.264 frame's slice header, and the complexity
  estimate (a copy of every frame's pixels) is skipped while it can be. The stage log adds the QP, each frame's bitrate
  as a share of the target, the capture area the feedback allows, and a line for every capture size change.
- A mirroring route the receiver ended itself (its app is gone from the receiver status) no longer sends a CLOSE and a STOP
  for the session the receiver dropped; it only closes its channel (`CastActivityManager::OnSessionRemoved`,
  `RemoveActivity`).
- A Cast session launched by a page that is being mirrored now stops the mirroring app and waits for the receiver to answer
  the STOP before it sends the LAUNCH (`onSessionLaunched` is now `onSessionLaunching`, and may return a promise). Chrome
  sends the two back to back (`DoLaunchSession` terminates the frame's mirroring route first); a Nest Hub Max answered a
  LAUNCH sent right behind the STOP, and a LAUNCH sent alone, with `LAUNCH_ERROR` `CANCELLED`.
- A sandboxed iframe without `allow-presentation` can no longer construct a `PresentationRequest`: it throws Blink's
  `SecurityError` ("The document is sandboxed and lacks the 'allow-presentation' flag.") as
  `PresentationRequest::Create` does. A page cannot read its sandbox flags, so this is seen only for an iframe that is
  same-origin with its parent (the stand-in reads the `sandbox` attribute through `frameElement`); see
  [docs/DESIGN.md](docs/DESIGN.md).

### Added

- **The channel says what Chrome's says, and waits as Chrome's does** (CONNECT, LAUNCH and the close reasons tested on a Nest Hub Max; the approval wait and the timers not yet tried on a real device). CONNECT carries
  `userAgent`, `connType`, `origin` and `senderInfo`; LAUNCH carries `language`, `supportedAppTypes` and `appParams`
  (from the presentation URL); the app's virtual connection is invisible only for `invisibleSender`.
  `LAUNCH_STATUS` `USER_PENDING_AUTHORIZATION` and `USER_ALLOWED` keep a launch open (without extending its timeout), and
  `USER_NOT_ALLOWED` and `USER_NOTIFICATIONS_DISABLED` fail it with Chrome's messages (`CastLaunchError`). Requests wait 5 s
  and a launch 60 s (2 minutes at most), the keep-alive timers restart on every message received, the ping timer fires
  once and a failed keep-alive write closes the channel. A page's close event carries blink's reason and message
  ([docs/DESIGN.md](docs/DESIGN.md#what-the-channel-sends-and-waits-for)).
- **Mirroring to flinging.** A page whose tab is mirrored and whose Cast SDK auto-joins (`defaultActionPolicy` other than
  `cast_this_tab`) gets its app launched on the mirroring sink, which ends the mirroring
  (`CastActivityManager::JoinSession`, `GetSinkForMirroringActivity`); switching the mirrored tab to a window with a default
  presentation request does the same and hands the window a `connectionavailable`
  (`SwitchToFlingingIfPossible`). The auto-join path is tested on a Nest Hub Max; switching the mirrored tab is unit-tested only.
- **Site-initiated mirroring.** With the `mirroring` option, a page of `docs.google.com`, `meet.google.com` or
  `music.youtube.com` (or any origin with the `AllowAllSitesToInitiateMirroring` feature in `app.commandLine`) can start
  tab mirroring with a Cast Streaming URL in a `PresentationRequest` (`kPresentationApiAllowlist`,
  `IsSiteInitiatedMirroringSource`). Other origins still see the source unavailable. Tested on a Nest Hub Max.
- **The desktop capture escalation guard.** Joining a route as a desktop mirroring source is refused with Chrome's text
  unless the route is desktop mirroring (`IsDesktopCaptureEscalation`).
- **Issues, like Chrome's Cast dialog shows.** `registerIssuesObserver`, `clearIssue` and `clearTopIssueForSink` on the manager:
  per-sink issues (a failed launch, a request waiting for the user on the TV, a declined one, a route timeout, "Use remote to
  stop casting" for DIAL, "unable to cast", the macOS screen-capture permission), deduplicated, going away after 1 minute
  (notifications) or 5 minutes (warnings), as Chrome's `IssueManager`. A failed launch is tested on a Nest Hub Max; the other issues and the dismissal timers are unit-tested only.
- **Chrome's switches and features** read from `app.commandLine` (new `commandLine` option): `--disable-features=MediaRouter`,
  `CastAllowAllIPs`, `ShowCastPermissionRejectedError`, `CastDesktopMirroringKeepLocalAudio`, `--cast-device-ips`,
  `--cast-developer-certificate-path`, `--cast-mirroring-target-playout-delay`. The mapping of Chrome's enterprise policies
  is in [docs/DESIGN.md](docs/DESIGN.md). Not yet tried on a real device.
- **Diagnostics:** `getLogs` and `registerLogObserver` (Chrome's media router log) and `getCastProviderState`.
- `mirroring.electron.systemPreferences`: the macOS Screen Recording permission is checked before a desktop mirroring route.

- `npm run live:checks` ([examples/live-checks](examples/live-checks)): unattended live checks for DIAL dedup (read-only) and
  for casting to one named device from the top page, same-origin and cross-origin iframes, a sandboxed iframe, the
  app's own UI, and the new `parity` checks (wire fields, close reasons, receiver-id token, sink order, issues,
  site-initiated mirroring, mirroring to flinging). The live iframe harness (`npm run live:iframe`) and the read-only discovery probes are in too.

## 0.5.0-next.1 (prerelease)

A prerelease of 0.5.0 on the npm `next` tag: install it with `npm i electron-cast@next` (`npm i electron-cast`
still installs 0.4.0).

This release brings electron-cast's main process in line with Chrome's Media Router: devices are tracked over kept-open
channels, the sessions on them are followed whoever started them, the app can cast and control media from its own
UI, DIAL devices are found and cast to next to Cast devices, a page can present on another screen (a wired
display) with the Presentation Receiver API on the other end, and the app can mirror a tab or the desktop. Each rule names the Chromium code it follows ([docs/CHROMIUM-MAP.md](docs/CHROMIUM-MAP.md)). `mode: "chromecast"`
is frozen and behaves as before for pages; it shares the device list.

### Highlights

- **Tab and desktop mirroring, tested on a Chromecast Ultra and a Nest Hub Max.** `createCastManager({ mirroring })` enables
  `startCasting(sinkId, { castMode: "tab_mirror", webContentsId })` and
  `startCasting(sinkId, { castMode: "desktop_mirror", desktopSourceId, withAudio })` in the main process, Chrome's `TAB_MIRROR` and `DESKTOP_MIRROR` cast modes, with `castMode` and `withAudio` filters on
  `registerMediaSinksObserver`. `startCasting` is one method for the three modes (`StartCastingOptions`, a union on
  `castMode`; `MediaCastMode` gains the two mirroring modes). It is a TypeScript port of Chrome's Cast Streaming sender
  (openscreen's sender session, Chromium's frame sender policy and Mirroring Service host, and the MirroringActivity
  routing): OFFER/ANSWER, VP8, VP9, H.264 in hardware and Opus, AES encryption, RTCP, NACK retransmission and bitrate adaptation.
  The video encoder is set up as Chrome's `MediaVideoEncoderWrapper` sets it up (a constant bitrate, the screen content
  hint), and frame drops are logged by reason.
  Capture and WebCodecs encoding run in a hidden window; the sender runs in a utility process per route; the session
  runs on the device's one kept-open channel. A mirrored tab is muted locally while it is cast (Chrome's muter);
  desktop audio follows Chrome per platform (local playback keeps going on Windows, `kCastDesktopMirroringKeepLocalAudio`,
  and is muted elsewhere). No new dependencies. Tested on Windows to a Chromecast Ultra (1080p, tab and desktop) and a
  Nest Hub Max (720p): at 720p frames reach the device in about 30 ms with none late; on the Ultra, video lag at 1080p
  is under investigation. Tab mirroring sends Opus and VP8 in software, with the audio in sync and only on the TV;
  desktop mirroring sends the picture and system audio and keeps local audio on Windows. Not tested on Linux or macOS. Desktop mirroring on macOS is untested on a real Mac; CI covers it with video only on Electron 40+. Not ported: remoting (Electron has no hook
  for it, see [DESIGN.md](docs/DESIGN.md#media-remoting-capabilities-only-the-renderer-side-is-not-reachable)). Like Chrome, a mirroring session sends `GET_CAPABILITIES`
  once after the first negotiation and keeps the receiver's remoting capabilities. Tested on a Nest Hub Max: it answers
  error 10106 "Remoting is not supported" and mirroring goes on.
- **Wired displays, as Chrome's `WiredDisplayMediaRouteProvider` has them, tested on a second monitor** (Windows, a
  1080x1920 portrait display). New `wiredDisplay` option on `createCastManager` (presentation mode): other screens are presentation sinks (`wired_display_<id>`, "Display N"). A
  `PresentationRequest` whose URL is https (not the legacy Cast URL) or http on localhost can start on a display: the
  page opens fullscreen in a receiver window that has its own in-memory session (cleared and reused, not one per
  presentation), no menu or developer tools, no permissions except fullscreen, and ends the presentation if it
  navigates away. The receiver is sandboxed as Chrome's is (`kPresentationReceiverSandboxFlags`: no modals, popups or
  top-level navigation) by a `Content-Security-Policy: sandbox` header on every receiver document, so an iframe's
  `alert()` is refused too. A display connection starts `connecting` and becomes `connected` when the receiver page is
  ready, as Blink's does.
  - The receiver page gets `navigator.presentation.receiver` (`connectionList`, `connectionavailable`, `send`, `close`,
    `terminate`), and the controller can `reconnect(id)`. Closing the window, removing the display or `terminate()`
    ends the presentation for every controller; a controller that goes away only leaves it.
  - The display a page is on is left out of the picker by default, found with the new `BrowserWindow` option and
    `screen.getDisplayMatching`, and `request.observeSinks` follows the window as it moves (`displayOf` overrides it).
  - A request that lists both a Cast (or `cast-dial:`) URL and a page URL is one picker, as Chrome's dialog lists both
    kinds of sink: `selectDevice` gets `request.displays` and may answer `{ display }` (new type `DisplayChoice`), and the
    request starts on the sink it returns. Its `getAvailability()` is true when either kind has a sink.
  - New exports: `createReceiverWindows` (the Electron `BrowserWindow` part, taking `BrowserWindow`, `session`,
    `ipcMain` and a folder for the generated receiver preload; calling it twice on one `ipcMain` and channel throws),
    the display rules (`isWiredDisplaySource`, `availableDisplays`, `wiredDisplaySinks`), and `manager.wiredDisplay`
    (sinks and routes observers, `terminateRoute`). `mode: "chromecast"` is unchanged.
- **DIAL, as Chrome's Media Router does it (presentation mode).** DIAL discovery and device descriptions are tested on
  real Chromecasts (1st gen, Ultra); launching an app over DIAL needs a DIAL-only TV and is untested. electron-cast now
  discovers DIAL devices by SSDP and
  serves the `cast-dial:` sources that Google's SDK adds to a request when the page passes a `dialRequest`
  (`chrome.cast.DialRequest`, as YouTube's web app does for non-Cast TVs). Each rule follows a Chromium function,
  cited in [docs/DESIGN.md](docs/DESIGN.md#dial-srcdial): an M-SEARCH on every IPv4 interface (four searches a second
  apart, every 120 s), the UPnP device description and the `Application-URL` header (both only for private addresses
  that equal the sender's), app info for the app a page asks about, and a sink per device. A page sees availability
  per app (only to the origins Chrome allows for that app) through the same observation as its Cast URL, the picker
  offers DIAL sinks that have the app next to the Cast devices that have theirs, and starting one runs the SDK's
  `custom_dial_launch` round trip, an HTTP launch with the SDK's launch parameter, and a stop by `DELETE` of the run
  URL. A device that is also a Cast sink (its UDN is the Cast id, and its channel is open) is shown as a Cast device
  only, as in Chrome. On by default, as in Chrome; `dial: false` on `createCastManager` turns it off (SSDP and the
  HTTP requests to devices stop entirely). A custom `discovery` turns it off unless `dial` is given.
  - A DIAL sink that is a Cast sink too is removed, as Chrome removes it, and only DIAL discovery adds it back (not
    the Cast sink going away).
  - Differences from Chrome: requests have timeouts (Chrome sets none). A DIAL route has no volume or media control,
    as in Chrome (`BindMediaController` is not implemented there).
  - **A DIAL device is tried as a Cast device**, as Chrome's `CastMediaSinkServiceImpl` does
    (`OnSinkAddedOrUpdated`, `TryConnectDialDiscoveredSink`, `CreateCastSinkFromDialSink`): when a DIAL sink is new or
    changed, and on `discoverSinksNow()`, a Cast channel is opened to its address on port 8009. If it opens and the device
    authenticates, the device is a Cast sink (id the sink's UUID, its friendly name and model, audio and video, or audio
    only for an audio-only certificate) and the DIAL sink is removed, as above. It is skipped when a Cast sink has that id or that
    address. Every failed attempt is counted per device; at ten (`kMaxDialSinkFailureCount`) the device is taken for a
    non-Cast device and not tried again, until it is opened from mDNS or the network changes.
  - DIAL discovery errors (no interface, a socket that fails to bind or send) are logged through `dial.log` and never
    thrown; `start()` works with no network. Nothing is asked of a device for an app the page's origin may not see,
    the monitored apps are bounded, stopping aborts requests in flight (a route terminated mid-launch cancels its
    POST), and a `start()` without an earlier availability watch waits (up to 5 s) for the devices' app answers.
  - API: `MediaSink` and `MediaRoute` gain `providerId` (`"cast"` or `"dial"`), `SinkIconType` gains `"generic"`, and
    `CastDevice` gains an optional `dial` field that marks a DIAL sink. The sinks observer without a query also
    reports DIAL sinks (they have no capabilities, so a `capabilities` query never does, and a `presentationUrls` query
    matches them for its `cast-dial:` URLs); `manager.devices()` still lists Cast devices only. `selectDevice` can be handed a DIAL
    device when the request carries a `cast-dial:` URL: return it like any other and the manager does the rest (do not
    connect to it yourself). `getMediaController` on a DIAL route throws `route_not_found`. The SDK canary no longer
    lists the DIAL messages and `cast-dial:` as unhandled.
- New options and methods for the device list: `sinks` (`openDelayMaxMs`, `reportDelayMs`, `retry`, `allowAllIps`,
  `dynamicTimeoutDeltaMs`) on `createCastManager` and `CastSessionService`, each a Chrome setting (there is no cap or
  off switch, because Chrome has none); `CastManager.discoverSinksNow()` and `CastManager.settled()` (with
  `{ retries: true }`); the type `ChannelParams`.
- `isPubliclyRoutable`, `isLoopback`, `isCastAddressAllowed` and `parseIpBytes` are exported from the discovery layer
  (ports of `net::IPAddress`). `APP_AVAILABILITY_REFRESH_MS` is exported.
- **Access code casting: devices can be added by address, as Chrome's access code casting adds the device a code
  resolves to.** `manager.addSinkByAddress({ id, name, capabilities, ipV4Address, port })` opens a channel to a device the app knows the
  address of, lists it like a discovered one (the picker, availability for pages, the sinks observers) and remembers it,
  with Chrome's checks, quick open parameters (2 s connect, 3 attempts 1 s apart) and expiry: it stays for
  `accessCode.deviceDuration` seconds (default 0) plus 20 s, a device a page is casting to stays until the cast ends, and a
  network change removes it and brings the remembered ones back. It is off
  unless `createCastManager({ accessCode: { enabled: true } })`, as Chrome's `AccessCodeCastEnabled` policy is. Turning a
  typed code into an address is a private Google service that needs Chrome's sign-in, so it is not part of electron-cast;
  [DESIGN.md](docs/DESIGN.md#access-code-casting-access-codets) says why. The address comes from the app, not from
  Google's server as in Chrome, so validate what users type: Chrome's rules allow any private address and port. New: `addSinkByAddress`, `configureAccessCode`,
  `rememberedSinks`, `createAccessCodeSink`, the `accessCode` option (with `store` to keep devices
  between runs), and `pingIntervalMs` in `createClient`'s second argument.
- **`electron-cast dial-test`, a one-command test for DIAL TVs** (`npx electron-cast@next dial-test`; Node 20 or later, no
  Electron), run on a real network: it found three Chromecasts over DIAL and flagged them as Cast devices. It runs the
  library's own DIAL discovery, device description, app info, launch and stop against a real device, asks before it opens YouTube on it, and writes a Markdown report with names, serial numbers, UUIDs, MAC addresses,
  IP addresses and URL hosts removed, plus a prefilled GitHub issue link. The package gains a `bin` entry
  (`electron-cast` -> `dist/cli.js`). See the README's "Test a DIAL TV".

Not yet tried on real devices: casting from the app's own UI (`startCasting` from its menu) and the sessions that other
senders started. Both are covered by unit tests with fakes.

### Added

- **A session tracker follows what every device runs**, from the receiver status and media status on the device's
  channel, whoever started it (Chrome's `CastSessionTracker`). Sessions started elsewhere, or by this app before it
  restarted, are reported through the routes observers and `getRoutes()` as non-local routes, as Chrome does;
  `MediaRoute` gains `isLocal` and `sinkName`, and `origin` is empty on a non-local route. A non-local route can be
  terminated and have its volume set.
- **Media control from the main process.** `manager.getMediaController(routeId, observer?)` is Chrome's
  `MediaController` and `MediaStatusObserver` for a route: `play`, `pause`, `seek`, `nextTrack`, `previousTrack`,
  `setVolume`, `setMute`, and the media status (title, play state, position, duration, volume, what the media can do,
  images). It works on non-local routes too. Its status comes from the session tracker, as `CastMediaController`'s does:
  every receiver status and every `MEDIA_STATUS` reaches every observer, changed or not, with media updates merged
  into what was known and the `supportedMediaCommands` mask turned into a list. Binding sends the session's state
  first and then `MEDIA_GET_STATUS`. New types `MediaController`, `MediaStatus`, `MediaStatusObserver`, `MediaImage`
  and `MediaPlayState`. See docs/MAIN-API.md.
- **Casting from the app's own UI, on the page's default request.** In Chrome a page sets
  `navigator.presentation.defaultRequest = new PresentationRequest(urls)`; the Cast dialog, opened from the browser's
  menu or toolbar, offers it as a source, and when the user picks a device Chrome starts the presentation and fires
  `connectionavailable` on the default request, which Google's Cast SDK adopts. electron-cast now does the same:
  - The page-side stand-in reports `navigator.presentation.defaultRequest` (set, replaced, cleared) to the main
    process, and only the window's main frame counts. A navigation or a destroyed window clears it.
  - New `CastManager` methods, named after Chrome's `WebContentsPresentationManager` and `MediaRouterUI`:
    `hasDefaultPresentationRequest(webContentsId)`, `getDefaultPresentationRequest(webContentsId)`,
    `addPresentationObserver(webContentsId, observer)` and `startCasting(sinkId, { webContentsId })`, which starts the
    default request on a sink with no picker and no user gesture. The page gets `connectionavailable` with a working
    connection and the route appears in routes observers. It rejects with `MediaRouteError` carrying Chrome's
    `RouteRequestResultCode` (`timed_out`, `sink_not_found`, `invalid_origin`, `cancelled`, `redundant_request`,
    `unknown_error`) or `unable_to_cast`. `startCasting` launches anew on a sink that already has a route, stops the
    route its window launched before, and uses the URL's `__castLaunchTimeout__` or 60 s, all as Chrome's
    `CastActivityManager` does. New types `PresentationRequest`, `PresentationObserver` and `MediaCastMode`.
  - `MediaSinksQuery` gains `presentationUrls`, the sinks that can run a presentation URL: as in Chrome, the device
    must say the app is available (`GET_APP_AVAILABILITY`) and have its capabilities. A DIAL sink matches a
    `cast-dial:` URL whose app it has, for the query's new `origin`, and `startCasting` starts a DIAL route on it, as
    Chrome's dialog offers DIAL sinks for a default request's `cast-dial:` URLs.
- **Switch the mirrored tab, freeze the picture.** `switchMirroringSourceTab(routeId, webContentsId)` moves a
  `tab_mirror` route to another page without ending or renegotiating the session (Chrome's "share this tab instead":
  capture and the audio stream restart on the new page, encoders and timelines carry on, local muting moves to the new
  page, and a second route on the same page ends). `freezeRoute` / `unfreezeRoute` pause and resume the video on its last
  frame as Chrome's freeze does (audio goes on, 500 ms delay), and mirroring routes report `freezeInfo` (`canFreeze`,
  `isFrozen`). Tested on a Nest Hub Max: a switch keeps the same route with no new OFFER and runs at about 30 fps after (the
  picture was not checked on screen); freezing the picture works and keeps the session, but the Hub stopped acknowledging frames for about 9 s during a 15 s freeze and for 8 s after unfreezing (the sender matches Chrome; a Chrome control run is pending).
- **One route per page, and a closed tab ends its mirroring.** As in Chrome, a page that becomes a mirroring source
  (a launch or a switch) loses the Cast SDK / Presentation API sessions it launched, and a page that launches one
  loses its mirroring routes (`CastActivityManager::routes_by_frame_`). Closing the page being mirrored ends a tab route
  (`CastMirroringServiceHost::WebContentsDestroyed`); a desktop route is unaffected. Tested on a Nest Hub Max: closing the
  mirrored tab ends the route at once, and the receiver app is gone within 3 s.
- **Mirroring statistics.** A debugging aid with Chrome's names and units, like `chrome://media-router-internals`
  "Mirroring stats": `setMirroringStatsEnabled(true)` before `startCasting`, then `getMirroringStats(routeId)` and
  `registerMirroringStatsObserver` (every 500 ms) give `{ audio, video }` with `ENQUEUE_FPS`, the latency averages and
  histograms, bitrates, packet counts and the sender's own counters. A port of openscreen's statistics collector,
  clock offset estimator and analyzer, with the receiver's RTCP event log parsed. Off by default; nothing is uploaded
  (Chrome's UMA is not ported). `examples/live-mirroring` takes `--stats`. `getMirroringStats` never throws, as
  Chrome's `MediaRouterDebuggerImpl::GetMirroringStats` has no error path: `{}` while off and for an unknown route, and an
  ended route keeps its last statistics until another route pushes. Tested on a Nest Hub Max: Chrome's names, internally
  consistent; `AVG_E2E_LATENCY_MS` is 0 on the Hub, which sends no playout events.
- **Mirroring uses a hardware encoder when there is one, as Chrome does.** The capture page asks WebCodecs
  (`prefer-hardware`) which of H.264, VP8 and VP9 a hardware encoder takes, and offers those hardware-first (H.264 as
  Annex B); VP8 in software is offered only when no hardware codec is, or when the receiver takes none of the hardware
  ones. A hardware encoder that fails mid-session no longer stops mirroring: the codec is dropped for the rest of the
  app's run and the session negotiates again. Chrome's `--cast-streaming-force-{enable,disable}-hardware-<codec>` and
  `--disable-cast-letterboxing` switches, and the `CastStreamingVp8` / `Vp9` / `Av1` / `HardwareHevc` / `Win|MacHardwareH264`
  features of `--enable-features` / `--disable-features`, are honoured, read from `app.commandLine` (so switches the app
  appends count) when the `electron` object passed as `mirroring.electron` includes `app`. Tested on a Nest Hub Max: the
  Hub chose H.264 in hardware, about 30 fps at 2.7 Mbps, with about 4.4 ms per encode.
- **VP9 is offered by default, as in Chrome.** In hardware when an encoder takes it, in software under the same
  hardware-first rule as VP8; there is no option for it.
- **Mirroring letterboxes like Chrome.** The capture now asks for the `fixed_aspect_ratio` policy when the receiver
  cannot scale (always for a Nest Hub): frames keep a 16:9 shape whatever the page or screen looks like, and a tab is
  no longer upscaled to 1920x1080. The new offer after an encoder failure and the letterboxing are tested
  against the fake receiver and in the smoke test; not yet on a real device (H.264 in hardware is, above).
- **Mirroring adapts to encoder load as Chrome does.** Each encoded frame now carries Chrome's encoder utilization
  (smoothed, clamped) and lossiness, estimated from the frame's pixels because WebCodecs reports no quantizer (a port of
  `FrameComplexityEstimator`). `VideoSender` feeds the larger of the two back, and for a tab the capture size follows it
  like Chrome's `VideoCaptureOracle`: it steps down when the encoder or the link is overloaded and back up when there is
  room, within the limits of the resolution change policy. Screens are captured at the full size, as in Chrome.
  Switching the tab starts the size over, as a new capture device does in Chrome. The `LOSSINESS` statistic now reads
  each frame's value; it is -100, as in Chrome, until a frame has reported one. Not yet tried on a real device.
- **Mirrored frames carry their capture time, and the capture rate is limited as Chrome limits it.** A frame's
  reference time is its capture time from the frame metadata when the source gives one (else the capture timestamp
  moved onto the wall clock by the smallest delay seen), so uneven delivery no longer skews the receiver's playout.
  Each frame carries its capture begin and end times to the sender, which logs them as `FRAME_CAPTURE_BEGIN` and
  `FRAME_CAPTURE_END`, so the capture, encode and end-to-end latency statistics start at capture. The capture is thinned
  to the session's frame rate by a port of Chrome's `SmoothEventSampler` (a token bucket of 1.5 frame periods, judged
  on capture timestamps), so a burst after a stall is kept whole. The sender logs its pipeline stages, the router's
  bursts and the frame sizes, and `smoke/perf.mjs` mirrors a 1080p page to the fake receiver to measure them. Checked
  on a Nest Hub Max: a steady 30 fps, 1.1% of the video frames dropped, no audio dropped.
- **The manager follows network changes by itself, as Chrome's `DiscoveryNetworkMonitor` tells its media router.** It
  computes Chrome's network id from the connected interfaces and, when it changes, does what Chrome's two observers do:
  DIAL devices given up on as non-Cast are tried again, the sinks of the network being left are remembered and reopened
  on coming back to it (`CastMediaSinkServiceImpl::OnNetworksChanged`), and devices added by address with no route are
  removed and the remembered ones added back 4.45 s later (`AccessCodeCastSinkService::OnNetworksChanged`). DIAL
  discovery forgets its devices and searches again at once instead of waiting up to 120 s, and does not search while
  there is no network (`DialRegistry::OnConnectionChanged`). Node has no
  network-change event, so it reads `os.networkInterfaces()` every 5 s while started; Node has no Wi-Fi SSID either, so
  an interface is identified by its MAC and IPv4 network. A custom `discovery` turns it off unless the new
  `networkMonitor` option is given, and `networkMonitor: false` turns it off; a `NetworkMonitor` of your own drives it in
  tests. There is no method for the app to call.
- Presentation mode: `PresentationConnection.send()` takes ArrayBuffer, ArrayBufferView and Blob as well as strings,
  and `binaryType` (`arraybuffer` or `blob`) picks what `message` events carry, as in Chrome. Binary goes to wired
  displays, in both directions. To a Cast device it is dropped without an error, as Chrome's
  `CastSessionClientImpl::OnMessage` ignores messages that are not text. One 64 MiB cap holds for text and bytes in both
  directions; a larger `send()` throws `RangeError`, and a detached ArrayBuffer is a `TypeError`. Before,
  `send()` threw a `TypeError` for anything but a string.

### Changed

- **Devices are tracked as Chrome's Media Router tracks them.** electron-cast opens a channel to every device mDNS
  finds (after Chrome's random delay of up to 5 s), runs device authentication on it, and lists the device only once
  that has passed. A failed attempt is retried with Chrome's backoff (15 s, 3 attempts); a device that fails
  authentication is never listed, where before it appeared in the picker and failed on use. The channel then stays
  open, with a ping every 5 s, and is reopened after a failure (sleep and resume included); a device is dropped only
  when it cannot be reopened, not when mDNS stops reporting it. The list is reported once it has been quiet for 3 s.
  `manager.devices()`, the picker's list and the sinks observers show these devices, so **right after `start()` the
  list is empty and fills in over a few seconds**.
- **`createClient` is called once per device, and its signature is now `(device, params)`.** A device's channel is
  shared by its sessions and kept open, so clients live as long as the device is a sink, not as long as a session,
  and must be fine to keep connected. `createClient` is called again after a failure, with
  `params = { connectTimeoutMs, livenessTimeoutMs }` for that attempt; pass them on to `CastClient`
  (`connectTimeoutMs`, `heartbeatTimeoutMs`). A channel replaced because the device's address changed stays open while
  a session uses it (as Chrome leaves the old socket); an address list that mDNS merely reorders changes nothing. A
  device whose host is not an IP address is skipped with a warning.
- **App availability for pages, as in Chrome.** In the default mode a page's `getAvailability()` and the devices its
  `start()` offers come from the devices' own answer to `GET_APP_AVAILABILITY` for the request's app, asked over the
  channels already open (Chrome's `CastAppDiscoveryServiceImpl`): a device that does not have the app is not offered,
  availability turns true as soon as a device says it has the app, and `change` events follow each answer. An
  "available" answer stands, an "unavailable" one for a minute, no answer never. `discoverSinksNow()` asks again by
  the same rules. `mode: "chromecast"` still goes by capabilities.
- **Public and loopback device addresses are refused, as in Chrome.** Chrome opens no Cast channel to a publicly
  routable or loopback address unless `MediaRouterCastAllowAllIPs` is set (`CastMediaSinkServiceImpl::OpenChannel`).
  The sink service checks the address each time it opens a channel, so such a device is not listed, offered or
  connected to; `sinks: { allowAllIps: true }` turns it off. Private, link-local, unique-local and `100.64.0.0/10`
  addresses are unaffected.
- `joinRunningSession` is answered from the session tracker instead of connecting to every device and asking, with the
  same results and errors; the device must be listed (its channel open) by then. A session whose pages all let go now
  stays a (non-local) route while the device runs it, where it used to disappear from the list.
- `navigator.presentation.defaultRequest` is now a nullable attribute as in Blink: it takes a `PresentationRequest`
  or `null` and throws `TypeError` for anything else. `connectionavailable` fires after the current task, as Blink
  enqueues it.
- Up to 1024 media requests from a page may wait for the receiver's answer, as in Chrome
  (`kMaxPendingMediaRequests`); a full table drops its older half before taking the new one (it was 100).

### Fixed

- **Mirroring and remote-playback sources are never launched as ordinary apps.** A presentation URL naming a Cast
  Streaming app (`0F5096E8`, `85CDB22F`), alone or beside other apps in one legacy URL, and a `remote-playback:` URL
  are unavailable (`getAvailability()` is `false`) and `start()` rejects with `NotFoundError` ("No screens found.") unless the
  page's origin may start mirroring (see Site-initiated mirroring in the Unreleased section).
  Of several URLs the first ordinary Cast app one is served. The stand-in's `PresentationRequest` drops URLs of unknown
  protocol like Blink and throws `NotSupportedError` when none is left.
- A device that fails device authentication no longer shows in the picker (see Changed).

### Documentation

- A rewritten README with a Chrome parity table (including what is out of scope, such as Chrome's Global Media
  Controls panel, and what is partly done: access-code
  casting, without the code lookup), a getting-started page, guides (device picker, restart rejoin, windows and iframes, custom
  receivers, audio-only devices and groups, device authentication, the low-level client, testing), troubleshooting
  and a FAQ, architecture diagrams and a glossary, a map of the Chromium code each module follows, and CONTRIBUTING.
- Tested-on facts: casting, rejoin after a force-kill, and stop verified end to end in an Electron 45 app on Linux
  (Ubuntu under WSL2, dev and packaged builds) as well as Windows; IPv6 discovery and the Cast channel with TLS and device
  authentication over unique-local and link-local addresses verified on real devices.
- `npm run check` now also checks the docs: every public export is mentioned, the TypeScript examples typecheck
  against the sources, and relative links and anchors resolve; `npm run docs:check:chromium` (network) rechecks the
  Chromium citations. Comment fixes only in `src/`.

## 0.4.0

- **Devices are now verified, as in Chrome.** `CastClient.connect()` runs the Cast device authentication challenge
  after TLS and before CONNECT: it checks the device's certificate chain against Google's Cast roots (a port of
  Chromium's checks, with no new dependencies), revocation, and a signature tied to the connection's TLS certificate.
  A device that fails makes `connect()` reject with the new `CastAuthError` (with a `reason`), and the page sees an
  unreachable device. It is on by default. Set `verifyDevices: false` on `createCastManager`, or `verifyDevice: false`
  on `CastClient`, for receivers that are not Google-certified. `CastClient` also gains `authTimeoutMs`, `deviceAuth`
  (trust roots and clock, for tests and private deployments) and a `deviceAuth` result (`policy`, `hashAlgorithm`,
  `nonceEchoed`, `usedFallbackCrl`, `revocationChecked`). The protocol layer gains `DeviceAuthMessage` encoding and
  decoding. Tested on 8 real devices, which all passed.
- Device authentication does not start refusing devices that send no CRL once the built-in fallback CRL is past its 20
  weeks: with a lapsed fallback and no valid CRL from the device, the revocation check is skipped and
  `deviceAuth.revocationChecked` is `false` (Chromium fails closed; Chrome updates itself, an app may not). All other
  checks, the device's own CRL, and revocation by a still-valid fallback CRL are unchanged. The fallback window starts
  at the package's build time, stamped by `npm run build`.
- Presentation mode: `start()` now needs transient user activation in the main process too, not only in the page's
  stand-in. The preload reads `navigator.userActivation.isActive` in its isolated world and the main process refuses
  a start without it (`AbortError`, "PresentationRequest::start() requires user gesture.", as Chrome's browser-side
  check). The stand-in's own refusal now throws Blink's `InvalidAccessError` instead of `AbortError`. Electron has no
  main-process API for activation, so a compromised renderer could still forge it (see SECURITY.md).
- Presentation mode: a page can rejoin a session that kept playing on the device after the app restarted, the way it
  can in Chrome. The library persists nothing: the app keeps the session id, the page calls
  `chrome.cast.requestSessionById`, Google's SDK turns that into `reconnect("cast-session_<id>")`, and electron-cast
  finds the session by asking the known devices what they run (the new `joinRunningSession` service call). Auto-join
  still does not join such sessions, as in Chrome. Joining by id no longer checks the origin, also for a session this
  run holds, as in Chrome (`AppActivity::CanJoinSession`); `allowOrigin` still applies. `mode: "chromecast"` is
  unchanged.
- Google's Cast SDK now works inside iframes in presentation mode, with Chrome's per-frame semantics: each frame has its
  own availability watches, connections and sessions, receives only its own events, and uses its own origin. An iframe
  that navigates parks its sessions; a removed iframe or a navigating page ends them. Needs
  `nodeIntegrationInSubFrames: true` in the window's `webPreferences` so the preload runs in iframes; without it nothing
  changes. `mode: "chromecast"` stays main-frame only.
- Discovery also runs mDNS over IPv6 (link-local, per adapter), so IPv6-only devices are found; `fe80::` addresses carry
  their scope so they can be connected to, and IPv4 is still preferred. A network adapter that goes away takes its
  devices with it at once, and sockets are replaced after the machine wakes from sleep.
- Main-process API on the cast manager, modelled on Chrome's Media Router: sinks and routes observers, `getRoutes`,
  `terminateRoute`, `detachRoute`, route volume control, and a third `selectDevice` argument that streams devices
  found while the picker is open. Sink icon types follow Chrome's `GetCastSinkIconType`, and a route's `members` are
  `webContents.id`s, also for iframes. See docs/MAIN-API.md.
- Presentation mode matches Chrome's Media Router for v2 requests: `QUEUE_NEXT`, `QUEUE_PREV` and `PRECACHE` are
  forwarded to the receiver (they were dropped, so their callbacks never fired); a failed `SET_VOLUME` or `STOP`
  reports `internal_error` / "unknown error"; a media request that cannot be sent gets no reply; an app message for a
  vanished session reports `session_error` "Invalid session ID". Unknown v2 message types are still dropped, as in Chrome.
- Added a CommonJS build (`dist/cjs`, no new dependencies) with `import` / `require` conditions on every entry point, so a
  non-sandboxed CommonJS preload or main process can `require("electron-cast/preload")` and `require("electron-cast/main")`.
  The ESM build is unchanged. `package.json` declares an optional peer dependency on `electron >=35`.
- CI runs a smoke test in a real Electron (35, 40 and the latest stable, on Linux, Windows and macOS): a sandboxed
  preload built from `electron-cast/preload`, `createCastManager` from `electron-cast/main` with a fake device, both
  modes. `npm run smoke` runs it locally. A weekly canary (`npm run canary`) fetches Google's Cast sender SDK for the
  current Chrome majors and checks it still speaks the message envelope the translator expects; a failed run opens one
  issue.
- The `DeviceAuthResult`, `DeviceAuthOptions`, `CastCertError` and `CastDeviceCertPolicy` types are exported.
- The page's IPC channel accepts only the bridge's own methods. `joinRunningSession`, which only main calls, is refused
  from a page as an unknown method.
- Thanks to Michael Arthur (@mikey0000). Restart rejoin was proposed by him in
  [#1](https://github.com/adammpkins/electron-cast/pull/1) (an optional `sessionStore`); 0.4.0 does it the way Chrome
  does instead, as described above. His [#2](https://github.com/adammpkins/electron-cast/pull/2) arrived independently
  at the presentation-mode design that 0.3.0 shipped.

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
