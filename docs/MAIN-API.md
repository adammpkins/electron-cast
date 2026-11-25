# Main-process API

`createCastManager` returns a `CastManager`: `start()`, `devices()`, `discoverSinksNow()`, `settled()`, `dispose()`, `addSinkByAddress()` (see [Adding a device by address](#adding-a-device-by-address)) and the API below, which lets the
app observe and control casting from the main process. It follows Chrome's Media Router, so the same concepts and
method names apply: devices are **sinks**, running sessions are **routes**, and you watch both with **observers**.

This API does not touch the preload's `mode: "chromecast"`; it works for both modes, because both end in the same
session service.

Media control, casting from the app's own UI, wired displays, adding a device by address and tab and desktop mirroring
are new in 0.5. Until 0.5.0 is released they are in the `next` prerelease: `npm i electron-cast@next`.

## Mapping to Chrome

Checked against Chromium `main` (November 2026). Paths are relative to the Chromium source root.

| electron-cast | Chrome | Chromium source |
|---|---|---|
| `registerMediaSinksObserver(observer, query?)` | `MediaSinksObserver` (constructed with a `MediaSource` and an origin, or for all sinks; `Init()` registers it) and its `OnSinksUpdated(sinks, origins)`. `MediaRouter::RegisterMediaSinksObserver` is private to the observer class | `components/media_router/browser/media_router.h`, `components/media_router/browser/media_sinks_observer.h` |
| `MediaSink` | `media_router::MediaSink`: `id`, `name`, `icon_type`, `provider_id` (no description) | `components/media_router/common/media_sink.h` |
| `MediaSink.iconType` | `GetCastSinkIconType`: `video_out` gives `CAST`, else a multizone group gives `CAST_AUDIO_GROUP`, else `CAST_AUDIO` | `chrome/browser/media/router/discovery/mdns/media_sink_util.cc` |
| `registerIssuesObserver(observer)` | `IssueManager::RegisterObserver` (`IssuesObserver::OnIssue`, `OnIssuesCleared`): told of the top issue now and when it changes | `components/media_router/browser/issue_manager.cc` |
| `clearIssue(id)`, `clearTopIssueForSink(sinkId)` | `IssueManager::ClearIssue`, `MediaRouter::ClearTopIssueForSink` | `components/media_router/browser/issue_manager.cc` |
| `getLogs()`, `registerLogObserver(observer)` | `LoggerImpl::GetLogsAsValue`, `AddObserver`. With `--enable-features=CastMessageLogging` (off by default, as `kCastMessageLogging`) the log also holds the messages of Cast routes: `Cast::SendMessageToClient`, `Cast::HandleParsedClientMessage`, `CastActivityManager::OnAppMessage`, `OnInternalMessage` and `MessageSent`, at `Info` in the `Route` category (see [DESIGN.md](DESIGN.md#issues-policies-and-switches-issuests-switchests-loggerts)) | `components/media_router/browser/logger_impl.cc`, `chrome/browser/media/router/providers/cast/cast_activity_manager.cc`, `cast_session_client_impl.cc` |
| `getLogsAsString()` | `MediaRouterDesktop::GetLogsAsString` (`LoggerImpl::GetLogsAsJson`), the method the Cast feedback page calls: the log as pretty-printed JSON, the keys of each entry sorted as a `base::DictValue` writes them | `chrome/browser/media/router/mojo/media_router_desktop.cc`, `components/media_router/browser/logger_impl.cc` |
| `getMediaSinkServiceStatus()`, `getMediaSinkServiceStatusAsString()` | `MediaRouterDesktop::GetState` (`MediaSinkServiceStatus::GetStatusAsValue`), which the `getState` message of `chrome://media-router-internals` returns, and `MediaRouterDesktop::GetMediaSinkServiceStatus` (`GetStatusAsJSONString`): `discovered_sinks` per discovery service (`cast`, `dial`) and the last 100 `available_sinks` lists, keyed `<PROVIDER>:<media source>`. Chrome's key names are kept (`discovered_sinks`, `icon_type`, `ip_endpoint`, ...) | `chrome/browser/media/router/mojo/media_sink_service_status.cc`, `chrome/browser/media/router/mojo/media_router_desktop.cc` |
| `getCastProviderState()` | `CastMediaRouteProvider::GetState` | `chrome/browser/media/router/providers/cast/cast_media_route_provider.cc` |
| `registerMediaRoutesObserver(observer)` | `MediaRoutesObserver` (constructed with the router) and `OnRoutesUpdated(routes)`; `MediaRouter::RegisterMediaRoutesObserver` is private to it | `components/media_router/browser/media_routes_observer.h` |
| `MediaRoute` (`mediaSource`, `sinkId`, `description`) | `media_router::MediaRoute` (`media_source`, `media_sink_id`, `description`; the id is `media_route_id`) | `components/media_router/common/media_route.h`, `media_route.cc` |
| `MediaRoute.description` | `CastSession::GetRouteDescription`: the status text, else the display name | `chrome/browser/media/router/providers/cast/cast_internal_message_util.cc` |
| `terminateRoute(id)` | `MediaRouter::TerminateRoute`, called by the Cast dialog's stop (`MediaRouterUI::StopCasting`) and by the global media controls' `CastMediaNotificationItem::StopCasting`; `CastActivityManager::TerminateSession` stops the receiver app | `media_router.h`, `chrome/browser/ui/media_router/media_router_ui.cc`, `chrome/browser/ui/global_media_controls/cast_media_notification_item.cc`, `chrome/browser/media/router/providers/cast/cast_activity_manager.cc` |
| `detachRoute(id)` | `MediaRouter::DetachRoute` exists, but the Cast provider does not implement it (`CastMediaRouteProvider::DetachRoute` is `NOTIMPLEMENTED`): a page lets go through its Presentation connection closing (`CastSessionClientImpl::DidClose`). No counterpart for "every page lets go" | `media_router.h`, `chrome/browser/media/router/providers/cast/cast_media_route_provider.cc`, `cast_session_client_impl.cc` |
| `getRouteController(id).setVolume / setMute` | `MediaRouter::GetMediaController` binds a `mojom::MediaController` (`SetVolume`, `SetMute`); on a Cast route `CastMediaController` sends a receiver `SET_VOLUME` request. Used by the global media controls (`CastMediaNotificationItem::SetVolume / SetMute`, controller bound in `cast_media_notification_producer.cc`), not by the Cast dialog. There is no class named `MediaRouteController` in current Chromium | `components/media_router/common/mojom/media_controller.mojom`, `chrome/browser/media/router/providers/cast/cast_media_controller.cc`, `app_activity.cc`, `chrome/browser/ui/global_media_controls/` |
| `hasDefaultPresentationRequest(webContentsId)`, `getDefaultPresentationRequest(webContentsId)`, `addPresentationObserver(webContentsId, observer)` | `WebContentsPresentationManager` (`HasDefaultPresentationRequest`, `GetDefaultPresentationRequest`, `AddObserver`; implemented by `ControllerPresentationServiceDelegateImpl`, one per `WebContents`), `content::PresentationObserver::OnDefaultPresentationChanged`, `content::PresentationRequest` (`render_frame_host_id`, `presentation_urls`, `frame_origin`) | `components/media_router/browser/presentation/web_contents_presentation_manager.h`, `controller_presentation_service_delegate_impl.cc`, `content/public/browser/presentation_request.h` |
| `startCasting(sinkId, { webContentsId, castMode: "presentation" })` | `MediaRouterUI::StartCasting(sink_id, MediaCastMode::PRESENTATION)`, then `MediaRouteStarter::CreateRouteParameters` (the source for the sink comes from the default request's URLs; none gives an "unable to cast" issue), `StartRoute` (`MediaRouter::CreateRoute`, with `WebContentsPresentationManager::OnPresentationResponse` as the response callback) and `OnPresentationResponse`, which adds the presentation and runs the default-presentation callback; `RouteRequestResultCode` is the error set | `chrome/browser/ui/media_router/media_router_ui.cc`, `media_route_starter.cc`, `components/media_router/common/mojom/route_request_result_code.mojom` |
| `getMediaController(id, observer?)` | `MediaRouter::GetMediaController`: binds a `mojom::MediaController` (`Play`, `Pause`, `SetMute`, `SetVolume`, `Seek`, `NextTrack`, `PreviousTrack`) and a `mojom::MediaStatusObserver` (`OnMediaStatusUpdated(MediaStatus)`). `CastMediaController` builds the status from the receiver volume (`SetSession`) and MEDIA_STATUS messages (`SetMediaStatus`, `UpdateMediaStatus`), which `CastSessionTracker::HandleMediaStatusMessage` first completes from the media it saved | `components/media_router/common/mojom/media_controller.mojom`, `media_status.mojom`, `chrome/browser/media/router/providers/cast/cast_media_controller.cc`, `app_activity.cc`, `cast_session_tracker.cc` |
| `selectDevice`'s third argument | `QueryResultManager` (owns the sinks observers the dialog's `MediaRouteStarter` / `MediaRouterUI` uses while open) | `chrome/browser/ui/media_router/query_result_manager.cc` |
| `addSinkByAddress`, `configureAccessCode`, network changes (the `networkMonitor` option) | `AccessCodeCastSinkService` after the discovery server has answered (`OnAccessCodeValidated`, `OnEnabledPrefChange`, `OnNetworksChanged`) | `chrome/browser/media/router/discovery/access_code/access_code_cast_sink_service.cc`; see [DESIGN.md](DESIGN.md#access-code-casting-access-codets) |
| Sinks listed only once a channel is open and authenticated, with retry and removal; the session tracker; non-local routes | `CastMediaSinkServiceImpl`, `MediaSinkServiceBase`, `CastSessionTracker`, `CastActivityManager::AddNonLocalActivity` | see [DESIGN.md](DESIGN.md#sinks-and-sessions-sink-servicets-session-trackerts) for each rule and its source |
| the Cast provider behind routes | `CastMediaRouteProvider`, `CastActivityManager`, `AppActivity` | `chrome/browser/media/router/providers/cast/` |

Where electron-cast differs from Chrome:

- Observers get the full list straight away on registration, then after each change, as Chrome's observers do once
  the router has a list. A sinks observer is only called when its (filtered) list actually changed.
- Chrome's sinks observer is scoped by a `MediaSource` and origin; here `query.capabilities` filters instead. Chrome's
  `MediaSink` has no description; `description` here is the device model (Chrome keeps it in
  `CastSinkExtraData::model_name`, not on the sink).
- Registration returns the unregister function; Chrome unregisters when the observer object is destroyed.
- `terminateRoute`, `setVolume` and `setMute` return promises and reject with `MediaRouteError` (`code`:
  `route_not_found` or a bridge code such as `session_error`); `setVolume` rejects with `RangeError` for a level outside
  0 to 1 and `setMute` with `TypeError` for a non-boolean. `detachRoute` and `getRouteController` are synchronous and
  throw `MediaRouteError` `route_not_found` for an unknown route. Chrome's are fire-and-forget.
- A route's id is the Cast session id. Chrome's `media_route_id` is `urn:x-org.chromium:media:route:<presentation id>/<sink id>/<source id>`
  (`MediaRoute::GetMediaRouteId`).
- `MediaRoute` also carries `appId`, `displayName`, `sinkName`, `isLocal`, `origin`, `volume`, `members` (`webContents.id`s, once each however
  many of a window's frames hold the route), `parkedSenders` and `parked`, because in an Electron app main wants to
  know which windows hold a route. A route is `parked` when its pages navigated away (a reload, say) and none is
  attached; it stays on the device so the next page can rejoin (see CHANGELOG 0.3.1).
- `detachRoute` has no Chrome counterpart (see the table). It is electron-cast's own.
- Volume matches Chrome: both send the receiver's `SET_VOLUME` (`level` or `muted`), the volume of the device, not of
  a media session; the route's `volume` shows what the device last reported. Chrome additionally ignores the call
  when the route has no session yet (every route here has one). The rest of Chrome's controller is
  [`getMediaController`](#media-control).

## Sinks

<!-- no-check -->
```ts
import { createCastManager, type MediaSink } from "electron-cast/main";

const manager = createCastManager({ ipcMain, selectDevice });
await manager.start();

const stop = manager.registerMediaSinksObserver({
  onSinksUpdated(sinks: MediaSink[]) {
    // called now with the current devices, then whenever one appears, changes or goes
    tray.setDevices(sinks.map((s) => s.name));
  },
}, { capabilities: ["video_out"] }); // optional, same names as requestSession's
// stop() unregisters
```

A `MediaSink` is `{ id, providerId: "cast" | "dial", name, description (the model), iconType: "cast" | "cast_audio" | "cast_audio_group" | "generic", device }`
where `device` is the discovered `CastDevice`. A DIAL sink (`providerId: "dial"`, id `dial:<uuid>`, icon `generic`, as
`DialMediaSinkServiceImpl` creates it) has `device.dial` set. A device that both mDNS and SSDP found is reported once,
as the Cast sink (`CastMediaSinkServiceImpl::TryConnectDialDiscoveredSink`). DIAL sinks have no capabilities, so a
`capabilities` query never lists them; `manager.devices()` stays the Cast devices.

A device is a sink only once electron-cast has opened a channel to it and it has passed device authentication, as in
Chrome. Channels open after discovery with a random delay of up to 5 s, so right after `start()` the list is empty for
a moment; a failed attempt is retried (15 s, 3 attempts), and a device that never opens is never listed. The list is
reported once it has been quiet for 3 s. A device that mDNS stops reporting stays listed while its channel is up; it
goes when the channel fails and cannot be reopened (a ping every 5 s notices within 10 s). `manager.devices()` and
`selectDevice`'s list are these sinks. `manager.discoverSinksNow()` skips the delay, and `createCastManager({ sinks })`
tunes the numbers (see [API.md](API.md#castmanageroptions)); `sinks.allowAllIps` lets it reach public and loopback
addresses, which Chrome refuses by default.

## Routes

<!-- no-check -->
```ts
manager.registerMediaRoutesObserver({
  onRoutesUpdated(routes) {
    // now, then when a route starts, ends, or its status, volume or pages change
  },
});

manager.getRoutes();                          // the current list: local, parked and non-local routes
await manager.terminateRoute(routeId);        // stop the app on the device
manager.detachRoute(routeId);                 // let go, leave the app running
const controller = manager.getRouteController(routeId);
await controller.setVolume(0.4);              // 0 to 1
await controller.setMute(true);
```

A device that runs a session no page of this app holds (started by another sender, or by this app before it restarted)
has a route too, as in Chrome (`AddNonLocalActivity`): `isLocal` is `false`, `members` and `origin` are empty, and
`sinkName` names the device. It follows the device's receiver status, goes when the app stops, and can be
terminated and have its volume set (while its channel is down, because the device is being reopened, terminating fails with `session_error` "StopSession response is not OK. Failed to terminate route." and the route stays, as in Chrome); `detachRoute` on it does nothing. A route a page held, once every page has let go
of it without stopping the app, becomes a non-local route. `isLocal` is `true` for the routes of this app's pages.

A DIAL route (`providerId: "dial"`) is the route of a `cast-dial:` presentation. Its `id` is Chrome's
`urn:x-org.chromium:media:route:<presentation id>/<sink id>/<source>`, `mediaSource` the `cast-dial:` source, `appId` is `""`
and `description` and `displayName` the app name, and `isLocal` is `true`. It has no volume and no media control:
`getRouteController(id).setVolume()` rejects and `getMediaController(id)` throws `MediaRouteError` `route_not_found`, as
Chrome's DIAL provider does not implement `BindMediaController`. `terminateRoute` sends the `DELETE` that stops the app
(and tells the page's connection it ended); `detachRoute` ends the page's connections and leaves the app running, which
is also what a page closing its connection does (`DialMediaRouteProvider::DetachRoute` is not implemented in Chrome, so
nothing stops the app).

Control goes through the same `CastSessionService` code the page's calls use, so the page sees what it would see if
the change came from the device:

- `terminateRoute`: every page on the route gets `sessionEnded` (`stopped`); the Presentation connection of
  presentation mode closes.
- `detachRoute`: every page gets `sessionEnded` (`disconnected`); the device keeps running the app.
- `setVolume` / `setMute`: the device reports its new volume, and the pages get `sessionUpdated`.

`dispose()` stops the observers (they are not called again) and closes the device connections; it does not stop the
apps running on the devices.

## Media control

<!-- no-check -->
```ts
const controller = manager.getMediaController(routeId, {
  onMediaStatusUpdated(status) {
    // title, secondaryTitle, playState (a MediaPlayState: "playing" | "paused" | "buffering"), currentTime,
    // duration (seconds), volume, isMuted, canPlayPause, canSeek, canMute, canSetVolume, canSkipToNextTrack,
    // canSkipToPreviousTrack, images (MediaImage[]: { url, size: { width, height } | null })
  },
});
await controller.play();
await controller.pause();
await controller.seek(90);          // seconds
await controller.nextTrack();       // QUEUE_UPDATE with jump 1, as Chrome does
await controller.setVolume(0.4);    // the receiver's volume, as getRouteController
controller.close();                 // stop the reports
```

It is what Chrome offers for a Cast route (`CastMediaController`), sent over the device's open channel, so it is
available on every route electron-cast has, non-local ones included: Chrome binds a controller to any activity
(`CastActivityManager::BindMediaController`), and a session started elsewhere is an `AppActivity` too
(`AddNonLocalActivity`); for one, a virtual connection to its transport is opened first, as Chrome's message handler
does. (All routes here are app routes; Chrome's mirroring routes have a controller of their own, and there is no
mirroring here.) The status comes from the session tracker on that channel: the volume of every receiver status
(`SetSession`) and every MEDIA_STATUS the device sends, whoever started the media, merged with the fields saved from
earlier ones (`CastSessionTracker::HandleMediaStatusMessage`). Messages go out as Chrome writes them (`CreateMediaRequest`): `PLAY`, `PAUSE`,
`SEEK` with `currentTime`, `QUEUE_UPDATE` with `jump` 1 or -1, each with the `mediaSessionId` last seen in a
MEDIA_STATUS (-1 before any, which the receiver refuses, as for Chrome) and the `sessionId`. Binding asks the receiver
for its media status (`GET_STATUS`).

Observers are called as Chrome calls them: on every receiver status that has a volume and every MEDIA_STATUS, repeated
or not, and on binding (any controller's binding tells every observer of the route, as `SetSession` does).

Where it differs from Chrome:

- Commands return promises, resolved when the message is written, not when the receiver has acted. They reject with
  `MediaRouteError` `route_not_found` once the route is gone. `seek` rejects with `RangeError` for a time that is not a
  number of seconds from 0 up. `getMediaController` throws `MediaRouteError` for an unknown route.
- Times are seconds, not `TimeDelta`. `MediaStatus.images` keeps only `https` URLs, as Chrome does.
- electron-cast has one Cast sender id per device connection where Chrome gives the controller its own, so the
  receiver's replies to a command also reach the route's pages. Request ids start at 2^30 so they cannot be mistaken
  for the page SDK's.
- Chrome's controller is a mojo pipe that closes with its route; here, after the route ends the commands reject and the
  observer is not called again.

## A live device picker

`selectDevice(devices, request, picker)` gets the devices at request time and, as a third argument, a handle that
works like Chrome's dialog watching sinks while it is open. mDNS often needs a few seconds, so devices can appear
after the picker opens:

<!-- no-check -->
```ts
selectDevice: (devices, request, picker) =>
  new Promise((resolve) => {
    const win = openPickerWindow(devices, resolve);
    // only the devices that can serve this request, the same way `devices` was filtered
    picker.registerMediaSinksObserver({ onSinksUpdated: (sinks) => win.setDevices(sinks.map((s) => s.device)) });
    picker.signal.addEventListener("abort", () => win.close()); // answered, cancelled, page gone or disposed
  }),
```

The observer is called at once with the current list, and is dropped when `picker.signal` aborts. Existing pickers
with two parameters keep working; they just ignore the third. If no device matches when the page asks, the request
still fails with `receiver_unavailable` before the picker opens.

## Casting from the app's own UI

In Chrome a page that wants to be castable from the browser's Cast dialog sets
`navigator.presentation.defaultRequest = new PresentationRequest(urls)`, and Google's Cast SDK listens for
`connectionavailable` on it. The dialog (opened from the toolbar or menu, not from the page) lists that request as its presentation
source, and when the user picks a device Chrome starts the presentation and fires `connectionavailable` on the default
request with the new connection; the SDK adopts the session. The app's own cast UI does the same here:

<!-- no-check -->
```ts
const id = win.webContents.id;

// is the page castable from my UI? (has it set defaultRequest?)
manager.hasDefaultPresentationRequest(id);
manager.getDefaultPresentationRequest(id);   // { webContentsId, presentationUrls, frameOrigin } or null
const off = manager.addPresentationObserver(id, {
  onDefaultPresentationChanged(request) { menu.setCastEnabled(request !== null); },
});

// the devices that can run it, kept current (the dialog's sinks observers for its presentation source)
manager.registerMediaSinksObserver(
  { onSinksUpdated: (sinks) => menu.setDevices(sinks) },
  {
    presentationUrls: manager.getDefaultPresentationRequest(id)?.presentationUrls ?? [],
    origin: manager.getDefaultPresentationRequest(id)?.frameOrigin,
  },
);

// the user picked a device in my menu
try {
  const route = await manager.startCasting(sink.id, { webContentsId: id });   // the page's connectionavailable fires
} catch (err) {
  if (err instanceof MediaRouteError) showCastError(err.code, err.message);
}
```

What happens, with Chrome's counterparts:

1. **The page sets `defaultRequest`.** Blink's `Presentation::setDefaultRequest` sends the request's URLs (none for
   `null`) to the browser on every set, and the stand-in does the same. `PresentationServiceImpl::SetDefaultPresentationUrls`
   ignores a frame that is not the outermost document and a list equal to the current one, then hands the request to
   `ControllerPresentationServiceDelegateImpl::SetDefaultPresentationUrls`, which keeps one default request per
   `WebContents` and tells its observers. electron-cast keeps one per window, from its main frame only (an iframe's
   `defaultRequest` is not reported to the app, as in Chrome), keyed by `webContents.id`.
2. **It is cleared** when the page sets `null` (or a request with no URLs), navigates to another document
   (`PresentationServiceImpl::DidFinishNavigation` → `Reset` → `ClearDefaultPresentationRequest`; a same-document
   navigation keeps it) or goes away. Observers then get `null`.
3. **`startCasting(sinkId, { webContentsId })`** is `MediaRouterUI::StartCasting(sink_id, PRESENTATION)`.
   `MediaRouteStarter::CreateRouteParameters` needs a presentation source for the sink: the first of the request's URLs
   the sink can run (`QueryResultManager::GetSourceForCastModeAndSink`): a Cast app URL for a Cast sink, a `cast-dial:`
   URL for a DIAL sink (`MediaRouteStarter::OnDefaultPresentationChanged` makes a source of every URL, and the DIAL
   provider serves the `cast-dial:` ones). With no default request, an unknown sink, or no
   URL the sink suits (a Cast URL that is not one, or capabilities the sink lacks), Chrome shows an "unable to cast"
   issue and starts nothing; here the promise rejects with `unable_to_cast`. Otherwise `MediaRouter::CreateRoute` runs,
   here a launch on the sink with no picker. The session is a route like any other: routes observers see it, and it is
   owned by the window's main frame.
4. **`WebContentsPresentationManager::OnPresentationResponse`** adds the presentation, and only when the default
   request is still the one that was started (`ArePresentationRequestsEqual`) does it run the default-presentation
   callback: `PresentationServiceImpl::OnDefaultPresentationStarted` →
   `PresentationController::OnDefaultPresentationStarted` → `ControllerPresentationConnection::Create`, which
   enqueues `connectionavailable` on the page's current `defaultRequest` (and does nothing if it is null). The stand-in
   does the same: the event fires after the current task with a `connected` connection whose first messages are
   `receiver_action` and `new_session`, which Google's SDK turns into its session. If the page replaced the request during the
   launch, the session stays up as a route but the page is not handed a connection (Chrome likewise records the
   presentation and tells nobody).

There is **no user gesture** on this path. The gesture check (`HasTransientUserActivation`) is in
`PresentationServiceImpl::StartPresentation`, which serves the page's own `PresentationRequest.start()`; the dialog's
route creation does not call it, because the browser UI is the user's action. The app is trusted the same way: only
code in the main process can call `startCasting`, never a page.

Errors are `MediaRouteError`s whose `code` is Chrome's `RouteRequestResultCode` in lower case, from the cause the
launch reports: `timed_out` (`TIMED_OUT`, the app did not launch in time), `sink_not_found` (`SINK_NOT_FOUND`, the device
cannot be reached), `invalid_origin` (`INVALID_ORIGIN`, `allowOrigin` refuses the page), `cancelled` (`CANCELLED`, the page
navigated or went away during the launch), `redundant_request` (`REDUNDANT_REQUEST`, the window already has a start in
progress, for the page's own or the app's) and `unknown_error` (`UNKNOWN_ERROR`). `unable_to_cast` is the dialog's own
check, above. `TypeError` and `RangeError` are thrown, as elsewhere here, for arguments of the wrong type or a cast mode
other than `"presentation"`, the only one electron-cast has (no tab or desktop mirroring).

Differences from Chrome:

- `getDefaultPresentationRequest` returns `null` without a request, where Chrome calls it an error. Observers are not
  called on registration, like Chrome's, so read the current request first. They are called with `null` when the window is
  destroyed, which Chrome does not announce.
- A `PresentationRequest` has `webContentsId` where Chrome has `render_frame_host_id`: only the outermost frame can own
  one, so the window identifies it.
- The sinks for a presentation source are asked for with `MediaSinksQuery.presentationUrls`; Chrome builds a
  `MediaSource` per URL. A sink matches when the URL is a Cast URL (`https://google.com/cast#__castAppId__=...` or
  `cast:<appId>`), the sink has the capabilities its app id names **and the device answered `GET_APP_AVAILABILITY`
  with the app available**, as Chrome's `CastAppAvailabilityTracker::GetAvailableSinks` requires
  (`CastAppDiscoveryServiceImpl::StartObservingMediaSinks` asks every sink when a source is first observed). So a
  sinks observer with `presentationUrls` first reports the sinks that were already asked, and the others when the
  device has answered; `startCasting` asks (once per device and app) before launching, so it works without an observer. The
  answers follow `CastAppDiscoveryServiceImpl::ShouldRefreshAppAvailability` (`cast_app_discovery_service.cc`): an
  available app is kept until the device goes away and comes back, an unavailable one is asked again after
  `kRefreshThreshold` (1 minute), and a device that cannot be reached or does not answer is unknown (always asked again
  by `startCasting`; a sinks observer retries it at most once a minute, not at every change). `discoverSinksNow()`
  asks again too, by the same rules (`CastAppDiscoveryServiceImpl::Refresh`). The question goes over the channel the
  device already has open; nothing else is connected. The page's own `getAvailability()` and `start()` use the same
  answers (see [API.md](API.md#app-availability)).
- A DIAL sink matches a `cast-dial:` URL whose app its DIAL server said it has, for the query's `origin` when the app is
  one Chrome offers to some origins only (`DialMediaRouteProvider::GetOrigins`); pass the request's `frameOrigin`. While
  the observer is registered the DIAL sinks are asked about those apps, as the DIAL provider's `StartObservingMediaSinks`
  does. `startCasting` on a DIAL sink asks too and waits up to 5 s for the answer, then starts the DIAL route; the page
  gets `connectionavailable` with an `mr_` presentation id, and the SDK's DIAL launch round trip runs on it as for its own
  `start()`. A DIAL route has no earlier-route rule: `CastActivityManager`'s is Cast's, and the DIAL provider stops the
  route already on the sink itself.
- Launching: `CastMediaRouteProvider::CreateRoute` ignores the `timeout` it is given (the dialog's
  `GetRouteRequestTimeout(PRESENTATION)`, 20 s, `media_router_ui_helper.cc`). `CastActivityManager::DoLaunchSession`
  gives the receiver the source's own `launch_timeout()`: `__castLaunchTimeout__` from the URL when it is a positive
  number of milliseconds, else `kDefaultLaunchTimeout`, 60 s (`cast_media_source.cc` / `.h`). `startCasting` does the same,
  as the page's own `start()` does.
- A sink that already has a route: `CastActivityManager::LaunchSession` launches anyway (a pending removal is noted for
  the old activity, which goes when the receiver's status update says its session is gone). It does not reuse the route, so
  neither does `startCasting` (the page's own picker path here still returns an existing session on the chosen sink).
  `DoLaunchSession` also stops the route this frame launched before (`routes_by_frame_`); `startCasting` stops the
  route its window's main frame last launched, by `startCasting` or by the page's `start()`, if it is still running.
- A default request replaced during the launch: `OnPresentationResponse` records the presentation and the route stays
  (`DoLaunchSession` already added it); only the connection is not handed over. The route stays here too, listed by
  routes observers, until the window launches another, the app terminates it or the receiver ends it. The connection of a
  declined start is not wired to the page (nothing it sends reaches the page that has the window now). If the request
  changed, or the page navigated, while the device was still being asked about the app, the start is `cancelled` before
  anything is launched.

## Wired displays

With the `wiredDisplay` option, other screens are presentation sinks, as Chrome's `WiredDisplayMediaRouteProvider`
makes them: a page's `PresentationRequest` for an https URL (not the legacy Cast URL) or http on localhost can start on
a display, which opens that page fullscreen in a locked-down receiver window; the presented page gets
`navigator.presentation.receiver`. The package never imports Electron, so the app passes `screen`, `BrowserWindow` and
a receiver window factory. Rules and their Chromium counterparts: [DESIGN.md](DESIGN.md#wired-displays).

<!-- no-check -->
```ts
import { app, BrowserWindow, ipcMain, screen, session } from "electron";
import { join } from "node:path";
import { createCastManager, createReceiverWindows } from "electron-cast/main";

const receivers = createReceiverWindows({
  BrowserWindow, session, ipcMain,
  preloadDir: join(app.getPath("userData"), "electron-cast-receiver"),   // the generated receiver preload goes here
});
const manager = createCastManager({
  ipcMain,
  selectDevice,   // may now answer { display: id } when request.displays is set (below)
  wiredDisplay: {
    screen,
    BrowserWindow,   // finds the page's own display, which the picker leaves out
    createReceiverWindow: receivers.factory,
    async selectDisplay(sinks, request) {   // the picker for a request only a display can show
      return (await myDisplayPicker(sinks, request.observeSinks))?.id ?? null;
    },
  },
});
manager.wiredDisplay?.registerMediaRoutesObserver({ onRoutesUpdated: (routes) => menu.setPresentations(routes) });
```

- **The pickers.** A request whose URLs only a display serves calls `selectDisplay(sinks, request)` (a
  `WiredDisplayRequest`; `observeSinks` follows the list while the picker is open), which resolves a sink id or `null`.
  A request that also has a Cast (or `cast-dial:`) URL is one picker, as Chrome's dialog lists both kinds of sink: when
  displays and devices both exist, `selectDevice` gets `request.displays` and may answer a `DisplayChoice`
  (`{ display: id }`), or a device as usual.
- **Sinks and routes** (`manager.wiredDisplay`, a `WiredDisplayApi`): `getSinks`, `registerMediaSinksObserver`,
  `getRoutes`, `registerMediaRoutesObserver` and `terminateRoute`, which closes the receiver window. A
  `WiredDisplaySink` is `wired_display_<id>`, "Display N", with its `display`; a `WiredDisplayRoute` has the
  presentation URL, `Presenting (<host>)` and `isLocalPresentation: true`. They are kept apart from the Cast and DIAL
  sinks of `registerMediaSinksObserver`.
- **Messages** are `PresentationMessage`s, a string or bytes, up to 64 MiB either way.

| Export | What it is |
|---|---|
| `createReceiverWindows(options)` | The Electron part: a `ReceiverWindows` whose `factory` opens receiver windows, and `dispose()`. `ReceiverWindowsOptions`: `BrowserWindow`, `session`, `ipcMain`, `preloadDir`, and optional `channel` and `platform`. Once per `ipcMain` and channel. |
| `isWiredDisplaySource(url)` | Whether a display can show the URL (`IsValidStandardPresentationSource`). |
| `availableDisplays(all, primary)`, `wiredDisplaySinks(all, primary)` | The displays that are sinks, in Chrome's order (primary first, then top-left; none for a single or mirrored setup), and their sinks. |
| `WiredDisplayOptions`, `WiredDisplayRequest`, `WiredDisplayApi`, `WiredDisplaySink`, `WiredDisplayRoute`, `DisplayChoice` | The types above. |
| `ScreenLike`, `DisplayLike`, `WindowLike` | The parts of Electron's `screen`, `Display` and `BrowserWindow` that are used. |

## Adding a device by address

Chrome's Access Code Cast lets a user type the code a device shows to cast to it from another network. electron-cast does
not turn codes into addresses (that is a Google service that needs Chrome's own sign-in; see
[DESIGN.md](DESIGN.md#access-code-casting-access-codets)), but it does what Chrome does once the address is known: the app
supplies it.

<!-- no-check -->
```ts
const manager = createCastManager({
  ipcMain, selectDevice,
  accessCode: { enabled: true, deviceDuration: 3600 },   // Chrome's AccessCodeCastEnabled and AccessCodeCastDeviceDuration
});
const result = await manager.addSinkByAddress({
  id: "a1b2c3d4e5f60718293a4b5c6d7e8f90",               // the device's unique id
  name: "Seminar Room 4",
  capabilities: { videoOut: true, audioOut: true },
  ipV4Address: "10.20.30.40",                            // or ipV6Address, which is preferred
  port: 8009,                                            // optional, 8009 by default
});
// { code: "ok", sinkId } | { code: "response_malformed" | "sink_creation_error" | "channel_open_error", message, ... }
```

The device is then in `devices()` and the sinks observers, offered to the picker and to pages' availability checks like any
discovered device. It is removed `deviceDuration` seconds after it was added (plus 20 s), or when the cast to it ends after
that. A public or loopback address is refused as for any device, unless `sinks.allowAllIps` is set. When the machine's
network changes the manager removes such devices and adds the remembered ones back, as Chrome does (it watches the
network itself; see the `networkMonitor` option). `configureAccessCode({ enabled, deviceDuration })` changes the settings while running,
`rememberedSinks()` lists what is remembered, and `accessCode.store` (`load`, `save`) keeps it between runs.

**Validate the address.** In Chrome it comes from Google's server; here it comes from your app. electron-cast only applies
Chrome's rules, which allow every private address and every port, so an address a user typed and you passed on unchecked
lets that user make the app open TLS connections to any host and port on your network and read from the result whether
something answered. Accept only addresses you expect (a known subnet, port 8009 unless you know otherwise) before
calling `addSinkByAddress`. The sink's id is the device id, in lower case without dashes, in angle brackets (`<uuid>`, Chrome's `cast:<uuid>`), so a
device that mDNS also finds is a second sink until the same-address rule removes one, as in Chrome.

| Export | What it is |
|---|---|
| `AccessCodeOptions` | The `accessCode` option: `enabled`, `deviceDuration` (seconds), `store`, and optional `log` and `now` (tests). |
| `AccessCodeDevice`, `AccessCodeCapabilities` | What `addSinkByAddress` takes: `id`, `name`, `capabilities` (`videoOut`, `videoIn`, `audioOut`, `audioIn`, `devMode`), `ipV6Address` or `ipV4Address`, and `port`. |
| `AddSinkResult`, `SinkCreationFailure` | How adding ended: `ok` with the `sinkId`, or `response_malformed`, `sink_creation_error` (with its `reason`) or `channel_open_error`. |
| `ReceiverIdHashTokenStore` | The `receiverIdHashToken` option: `load` and `save` the token that salts receiver labels (Chrome's `media_router.receiver_id_hash_token` pref), so a page's remembered `receiverLabel` still matches after a restart. Without it the token lasts for the process. |
| `AccessCodeRememberedSink`, `AccessCodeStore` | A remembered device, and where they are kept between runs (`load`, `save`). |
| `AccessCodeCastDisabledError` | What `addSinkByAddress` rejects with unless access code casting is enabled. |
| `createAccessCodeSink(device)` | Chrome's checks on a device, without opening anything: the sink it would be, or why it cannot be one. |

## Tab and desktop mirroring

`startCasting` also starts Chrome's other two cast modes, tab and desktop mirroring ("Cast tab" and "Cast screen"):
the app chooses what to send. They are off unless you pass `mirroring` to `createCastManager`:

<!-- no-check -->
```ts
import { app, BrowserWindow, MessageChannelMain, screen, utilityProcess, webContents } from "electron";

const manager = createCastManager({
  ipcMain,
  selectDevice,
  mirroring: { electron: { BrowserWindow, utilityProcess, MessageChannelMain, webContents, app, screen } },
});
await manager.start();

// Only the devices that can receive this kind of mirroring (audio-only speakers cannot take "desktop_mirror" without audio).
manager.registerMediaSinksObserver({ onSinksUpdated: showDevices }, { castMode: "tab_mirror" });

const route = await manager.startCasting(sink.id, { castMode: "tab_mirror", webContentsId: win.webContents.id });
// route.description is "Casting tab"; route.id is Chrome's urn:x-org.chromium:media:route:... form.
// The mirrored page is muted locally while the route runs, as in Chrome, and unmuted when it ends (an app that wants
// local audio can call webContents.setAudioMuted(false) itself). Desktop audio follows Chrome per platform: local
// playback keeps going on Windows and is muted elsewhere; there is no setting for it.
await manager.terminateRoute(route.id); // stops the receiver app, as Chrome does
```

`startCasting(sinkId, options)` is one method for the three modes, as `MediaRouterUI::StartCasting` takes the cast mode;
`options` is a `StartCastingOptions`, one shape per mode (`MediaCastMode`; the mirroring ones are `MirroringCastMode`). Note that `webContentsId` means two things:

- `castMode: "presentation"` (or none) with `webContentsId`: the window whose **default presentation request** is cast
  (above).
- `castMode: "tab_mirror"` with `webContentsId`: the **page to mirror** (video and its audio).
- `castMode: "desktop_mirror"` with `desktopSourceId` (an id from `desktopCapturer.getSources`) and optionally
  `withAudio` (system loopback audio, where the OS provides it).
- `targetPlayoutDelayMs` overrides the receiver playout delay (Chrome's default is 200 ms, `kDefaultPlayoutDelay`).

A mirroring start rejects with a `MediaRouteError` (`code`: `sink_not_found`, `unable_to_cast`, `unknown_error`,
`cancelled`); `unable_to_cast` too when the `mirroring` option was not given. A mode that is none of the three is a
`RangeError`. The sinks query for a mode is `MediaSinksQuery.castMode` (with `withAudio` for desktop mirroring): the Cast
sinks that can run one of its streaming apps; DIAL sinks never match. The mirroring session runs on the device's one
kept-open channel, as Chrome's runs on its `CastSocket`, and its route is a local route, not a non-local one. A new
route on a device ends the one already running there, as in Chrome. Mirroring routes show up in
`registerMediaRoutesObserver` and end on `terminateRoute`, when the receiver's app closes, or on a stream error.

While a tab route runs, the source can change and the video can be frozen, as in Chrome:

<!-- no-check -->
```ts
// "Share this tab instead": same route, same Cast session, no renegotiation; the new page is muted locally and the
// old one is unmuted (if the library muted it). A page has one route: a mirroring route already on it ends.
manager.switchMirroringSourceTab(route.id, otherWin.webContents.id);

// Pause the picture on its last frame (the audio goes on). It takes effect after 500 ms; unfreezing is immediate.
manager.registerMediaRoutesObserver({ onRoutesUpdated: (routes) => routes.forEach((r) => console.log(r.id, r.freezeInfo)) });
manager.freezeRoute(route.id); // ignored unless freezeInfo.canFreeze is true
manager.unfreezeRoute(route.id);
```

`route.id` and `route.mediaSource` keep their values across a switch (Chrome's route does not change either); the page the
route is bound to is in `route.members`. Switching is for `tab_mirror` routes only (`unable_to_cast` for a desktop route,
a route still launching, or a page that cannot be captured). `freezeInfo` is `{ canFreeze, isFrozen }` on mirroring
routes. A frozen route unfreezes when its tab is switched.

Mirroring statistics are a debugging aid, as in Chrome's `chrome://media-router-internals` "Mirroring stats" (not a web
API; nothing is uploaded, and Chrome's UMA is not ported):

```js
manager.setMirroringStatsEnabled(true); // off by default; read when a session starts, so call it before startCasting
const route = await manager.startCasting(sink.id, { castMode: "tab_mirror", webContentsId });
const off = manager.registerMirroringStatsObserver((routeId, stats) => {}); // every 500 ms, as Chrome's observers
manager.getMirroringStats(route.id); // { audio: {...}, video: {...} }; {} until the first fetch, while off, or for an unknown route
manager.isMirroringStatsEnabled();
```

The dictionary has Chrome's names and units. Per stream: `ENQUEUE_FPS`, `AVG_CAPTURE_LATENCY_MS`, `AVG_ENCODE_TIME_MS`,
`AVG_QUEUEING_LATENCY_MS`, `AVG_NETWORK_LATENCY_MS`, `AVG_PACKET_LATENCY_MS`, `AVG_FRAME_LATENCY_MS`,
`AVG_E2E_LATENCY_MS`, `ENCODE_KBPS`, `TRANSMISSION_KBPS`, `MS_SINCE_LAST_RECEIVER_RESPONSE`, `NUM_FRAMES_CAPTURED`,
`NUM_FRAMES_DROPPED_BY_ENCODER`, `NUM_FRAMES_LATE`, `NUM_PACKETS_SENT`, `NUM_PACKETS_RECEIVED`, `FIRST_EVENT_TIME_MS`,
`LAST_EVENT_TIME_MS`, `UNKNOWN_OPEN_SCREEN_STAT` (retransmitted packets), the histograms (`CAPTURE_LATENCY_MS_HISTO`,
`ENCODE_TIME_MS_HISTO`, `QUEUEING_LATENCY_MS_HISTO`, `NETWORK_LATENCY_MS_HISTO`, `PACKET_LATENCY_MS_HISTO`,
`E2E_LATENCY_MS_HISTO`, `LATE_FRAME_MS_HISTO`, each a list like `[{ "0-19": 12 }, { ">=800": 1 }]`), and from the session
host `TARGET_BITRATE`, `ENCODER_UTILIZATION`, `LOSSINESS`, `FRAMES_INSERTED`, `FRAMES_DROPPED`. A value that is not
finite is the string `"null"`. As in Chrome the structure is for logs, not a contract. `getMirroringStats` takes a route
id because several routes can run (Chrome's debugger keeps one global copy). It never throws: like Chrome's `MediaRouterDebuggerImpl::GetMirroringStats`, which has no error path, it returns `{}` while statistics are off, before the first fetch and for a route id it does not know, and a route that has ended keeps its last statistics (Chrome's copy outlives the session) until another route pushes newer ones.

`mirroring` options (`ElectronMirroringOptions`): `electron` (the Electron objects to use, an `ElectronMirroringApi`:
`BrowserWindow`, `utilityProcess`, `MessageChannelMain`, `webContents`, `app` so that Chrome's
switches are seen, and `screen`, whose primary display caps the capture resolution), `engineModulePath` (only if a bundler moved the library's files) and `log`. Opus audio is always offered. Video is
chosen as Chrome chooses it: H.264, VP8 and VP9 in hardware when the machine has an encoder for them
(`VideoEncoder.isConfigSupported` with `prefer-hardware`), VP8 and VP9 in software when it has none; Chrome's own
switches on `app.commandLine` change that (`--cast-streaming-force-{enable,disable}-hardware-<codec>`,
`--enable-features` / `--disable-features` with `CastStreamingVp8`, `CastStreamingVp9`, `CastStreamingAv1`,
`CastStreamingHardwareHevc`, and `--disable-cast-letterboxing`), including ones the app appends itself. The same
command line carries `--enable-features=CastStreamingGradualBandwidthBackoff:congestion_signal/before_encoding`
(or `after_encoding`; default `before_or_after_encoding`), `--enable-features=CastStreamingPerformanceOverlay` (Chrome's
metrics overlay drawn on the frames sent) and, on Linux, `--enable-features=PulseaudioLoopbackForCast` (without it a
desktop capture carries no audio, as in Chrome). `screen` is Electron's `screen` module: as in Chrome, the capture is
no larger than the primary display's size in pixels (landscape, in steps of 160x90, at most 1920x1080), for a tab and
for a desktop alike; without it the limit is 1920x1080. A hardware
encoder that fails during a session is dropped for the rest of the app's run and the session offers again without it.
Capture happens in a hidden window and encoding in WebCodecs; the network sender runs in a utility process, one per
route. See [DESIGN.md](DESIGN.md#mirroring-srcmirroring) for the layout and [examples/live-mirroring](../examples/live-mirroring/)
to try it on a real device.
