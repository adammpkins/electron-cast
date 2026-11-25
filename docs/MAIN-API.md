# Main-process API

`createCastManager` returns a `CastManager`: `start()`, `devices()`, `discoverSinksNow()`, `settled()`, `dispose()` and the API below, which lets the
app observe and control casting from the main process. It follows Chrome's Media Router, so the same concepts and
method names apply: devices are **sinks**, running sessions are **routes**, and you watch both with **observers**.

This API does not touch the preload's `mode: "chromecast"`; it works for both modes, because both end in the same
session service.

## Mapping to Chrome

Checked against Chromium `main` (November 2026). Paths are relative to the Chromium source root.

| electron-cast | Chrome | Chromium source |
|---|---|---|
| `registerMediaSinksObserver(observer, query?)` | `MediaSinksObserver` (constructed with a `MediaSource` and an origin, or for all sinks; `Init()` registers it) and its `OnSinksUpdated(sinks, origins)`. `MediaRouter::RegisterMediaSinksObserver` is private to the observer class | `components/media_router/browser/media_router.h`, `components/media_router/browser/media_sinks_observer.h` |
| `MediaSink` | `media_router::MediaSink`: `id`, `name`, `icon_type`, `provider_id` (no description) | `components/media_router/common/media_sink.h` |
| `MediaSink.iconType` | `GetCastSinkIconType`: `video_out` gives `CAST`, else a multizone group gives `CAST_AUDIO_GROUP`, else `CAST_AUDIO` | `chrome/browser/media/router/discovery/mdns/media_sink_util.cc` |
| `registerMediaRoutesObserver(observer)` | `MediaRoutesObserver` (constructed with the router) and `OnRoutesUpdated(routes)`; `MediaRouter::RegisterMediaRoutesObserver` is private to it | `components/media_router/browser/media_routes_observer.h` |
| `MediaRoute` (`mediaSource`, `sinkId`, `description`) | `media_router::MediaRoute` (`media_source`, `media_sink_id`, `description`; the id is `media_route_id`) | `components/media_router/common/media_route.h`, `media_route.cc` |
| `MediaRoute.description` | `CastSession::GetRouteDescription`: the status text, else the display name | `chrome/browser/media/router/providers/cast/cast_internal_message_util.cc` |
| `terminateRoute(id)` | `MediaRouter::TerminateRoute`, called by the Cast dialog's stop (`MediaRouterUI::StopCasting`) and by the global media controls' `CastMediaNotificationItem::StopCasting`; `CastActivityManager::TerminateSession` stops the receiver app | `media_router.h`, `chrome/browser/ui/media_router/media_router_ui.cc`, `chrome/browser/ui/global_media_controls/cast_media_notification_item.cc`, `chrome/browser/media/router/providers/cast/cast_activity_manager.cc` |
| `detachRoute(id)` | `MediaRouter::DetachRoute` exists, but the Cast provider does not implement it (`CastMediaRouteProvider::DetachRoute` is `NOTIMPLEMENTED`): a page lets go through its Presentation connection closing (`CastSessionClientImpl::DidClose`). No counterpart for "every page lets go" | `media_router.h`, `chrome/browser/media/router/providers/cast/cast_media_route_provider.cc`, `cast_session_client_impl.cc` |
| `getRouteController(id).setVolume / setMute` | `MediaRouter::GetMediaController` binds a `mojom::MediaController` (`SetVolume`, `SetMute`); on a Cast route `CastMediaController` sends a receiver `SET_VOLUME` request. Used by the global media controls (`CastMediaNotificationItem::SetVolume / SetMute`, controller bound in `cast_media_notification_producer.cc`), not by the Cast dialog. There is no class named `MediaRouteController` in current Chromium | `components/media_router/common/mojom/media_controller.mojom`, `chrome/browser/media/router/providers/cast/cast_media_controller.cc`, `app_activity.cc`, `chrome/browser/ui/global_media_controls/` |
| `hasDefaultPresentationRequest(webContentsId)`, `getDefaultPresentationRequest(webContentsId)`, `addPresentationObserver(webContentsId, observer)` | `WebContentsPresentationManager` (`HasDefaultPresentationRequest`, `GetDefaultPresentationRequest`, `AddObserver`; implemented by `ControllerPresentationServiceDelegateImpl`, one per `WebContents`), `content::PresentationObserver::OnDefaultPresentationChanged`, `content::PresentationRequest` (`render_frame_host_id`, `presentation_urls`, `frame_origin`) | `components/media_router/browser/presentation/web_contents_presentation_manager.h`, `controller_presentation_service_delegate_impl.cc`, `content/public/browser/presentation_request.h` |
| `startCasting(sinkId, { webContentsId, castMode: "presentation" })` | `MediaRouterUI::StartCasting(sink_id, MediaCastMode::PRESENTATION)`, then `MediaRouteStarter::CreateRouteParameters` (the source for the sink comes from the default request's URLs; none gives an "unable to cast" issue), `StartRoute` (`MediaRouter::CreateRoute`, with `WebContentsPresentationManager::OnPresentationResponse` as the response callback) and `OnPresentationResponse`, which adds the presentation and runs the default-presentation callback; `RouteRequestResultCode` is the error set | `chrome/browser/ui/media_router/media_router_ui.cc`, `media_route_starter.cc`, `components/media_router/common/mojom/route_request_result_code.mojom` |
| `selectDevice`'s third argument | `QueryResultManager` (owns the sinks observers the dialog's `MediaRouteStarter` / `MediaRouterUI` uses while open) | `chrome/browser/ui/media_router/query_result_manager.cc` |
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
  when the route has no session yet. Chrome's controller also plays, pauses and seeks and reports media status; there is
  none of that here.

## Sinks

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

A `MediaSink` is `{ id, name, description (the model), iconType: "cast" | "cast_audio" | "cast_audio_group", device }`
where `device` is the discovered `CastDevice`.

A device is a sink only once electron-cast has opened a channel to it and it has passed device authentication, as in
Chrome. Channels open after discovery with a random delay of up to 5 s, so right after `start()` the list is empty for
a moment; a failed attempt is retried (15 s, 3 attempts), and a device that never opens is never listed. The list is
reported once it has been quiet for 3 s. A device that mDNS stops reporting stays listed while its channel is up; it
goes when the channel fails and cannot be reopened (a ping every 5 s notices within 10 s). `manager.devices()` and
`selectDevice`'s list are these sinks. `manager.discoverSinksNow()` skips the delay, and `createCastManager({ sinks })`
tunes the numbers (see [API.md](API.md#castmanageroptions)); `sinks.allowAllIps` lets it reach public and loopback
addresses, which Chrome refuses by default.

## Routes

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

Control goes through the same `CastSessionService` code the page's calls use, so the page sees what it would see if
the change came from the device:

- `terminateRoute`: every page on the route gets `sessionEnded` (`stopped`); the Presentation connection of
  presentation mode closes.
- `detachRoute`: every page gets `sessionEnded` (`disconnected`); the device keeps running the app.
- `setVolume` / `setMute`: the device reports its new volume, and the pages get `sessionUpdated`.

`dispose()` stops the observers (they are not called again) and closes the device connections; it does not stop the
apps running on the devices.

## A live device picker

`selectDevice(devices, request, picker)` gets the devices at request time and, as a third argument, a handle that
works like Chrome's dialog watching sinks while it is open. mDNS often needs a few seconds, so devices can appear
after the picker opens:

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
  { presentationUrls: manager.getDefaultPresentationRequest(id)?.presentationUrls ?? [] },
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
   the sink can run (`QueryResultManager::GetSourceForCastModeAndSink`). With no default request, an unknown sink, or no
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
  by `startCasting`; a sinks observer retries it at most once a minute, not at every change). Chrome also refreshes on
  `DiscoverSinksNow`; there is no refresh here. This costs a
  connection per device asked, closed again when idle (Chrome keeps its sockets open). The page's own
  `getAvailability()` and `requestSession` still check capabilities only, as before.
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
