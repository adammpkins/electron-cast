# Main-process API

`createCastManager` returns a `CastManager`: `start()`, `devices()`, `dispose()` and the API below, which lets the
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
| `getMediaController(id, observer?)` | `MediaRouter::GetMediaController`: binds a `mojom::MediaController` (`Play`, `Pause`, `SetMute`, `SetVolume`, `Seek`, `NextTrack`, `PreviousTrack`) and a `mojom::MediaStatusObserver` (`OnMediaStatusUpdated(MediaStatus)`). `CastMediaController` builds the status from the receiver volume (`SetSession`) and MEDIA_STATUS messages (`SetMediaStatus`, `UpdateMediaStatus`), which `CastSessionTracker::HandleMediaStatusMessage` first completes from the media it saved | `components/media_router/common/mojom/media_controller.mojom`, `media_status.mojom`, `chrome/browser/media/router/providers/cast/cast_media_controller.cc`, `app_activity.cc`, `cast_session_tracker.cc` |
| `selectDevice`'s third argument | `QueryResultManager` (owns the sinks observers the dialog's `MediaRouteStarter` / `MediaRouterUI` uses while open) | `chrome/browser/ui/media_router/query_result_manager.cc` |
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
- `MediaRoute` also carries `appId`, `displayName`, `origin`, `volume`, `members` (`webContents.id`s, once each however
  many of a window's frames hold the route), `parkedSenders` and `parked`, because in an Electron app main wants to
  know which windows hold a route. A route is `parked` when its pages navigated away (a reload, say) and none is
  attached; it stays on the device so the next page can rejoin (see CHANGELOG 0.3.1).
- `detachRoute` has no Chrome counterpart (see the table). It is electron-cast's own.
- Volume matches Chrome: both send the receiver's `SET_VOLUME` (`level` or `muted`), the volume of the device, not of
  a media session; the route's `volume` shows what the device last reported. Chrome additionally ignores the call
  when the route has no session yet (every route here has one). The rest of Chrome's controller is
  [`getMediaController`](#media-control).

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

## Routes

```ts
manager.registerMediaRoutesObserver({
  onRoutesUpdated(routes) {
    // now, then when a route starts, ends, or its status, volume or pages change
  },
});

manager.getRoutes();                          // the current list, parked routes included
await manager.terminateRoute(routeId);        // stop the app on the device
manager.detachRoute(routeId);                 // let go, leave the app running
const controller = manager.getRouteController(routeId);
await controller.setVolume(0.4);              // 0 to 1
await controller.setMute(true);
```

Control goes through the same `CastSessionService` code the page's calls use, so the page sees what it would see if
the change came from the device:

- `terminateRoute`: every page on the route gets `sessionEnded` (`stopped`); the Presentation connection of
  presentation mode closes.
- `detachRoute`: every page gets `sessionEnded` (`disconnected`); the device keeps running the app.
- `setVolume` / `setMute`: the device reports its new volume, and the pages get `sessionUpdated`.

`dispose()` stops the observers (they are not called again) and closes the device connections; it does not stop the
apps running on the devices.

## Media control

```ts
const controller = manager.getMediaController(routeId, {
  onMediaStatusUpdated(status) {
    // title, secondaryTitle, playState ("playing" | "paused" | "buffering"), currentTime, duration (seconds),
    // volume, isMuted, canPlayPause, canSeek, canMute, canSetVolume, canSkipToNextTrack, canSkipToPreviousTrack, images
  },
});
await controller.play();
await controller.pause();
await controller.seek(90);          // seconds
await controller.nextTrack();       // QUEUE_UPDATE with jump 1, as Chrome does
await controller.setVolume(0.4);    // the receiver's volume, as getRouteController
controller.close();                 // stop the reports
```

It is what Chrome offers for a Cast route (`CastMediaController`), sent over the route's own connection, so it is
available on every route electron-cast has (all are app routes; Chrome's mirroring routes have a controller of their own,
and there is no mirroring here). Messages go out as Chrome writes them (`CreateMediaRequest`): `PLAY`, `PAUSE`,
`SEEK` with `currentTime`, `QUEUE_UPDATE` with `jump` 1 or -1, each with the `mediaSessionId` last seen in a
MEDIA_STATUS (-1 before any, which the receiver refuses, as for Chrome) and the `sessionId`. Binding asks the receiver
for its media status (`GET_STATUS`).

Where it differs from Chrome:

- Commands return promises, resolved when the message is written, not when the receiver has acted. They reject with
  `MediaRouteError` `route_not_found` once the route is gone. `seek` rejects with `RangeError` for a time that is not a
  number of seconds from 0 up. `getMediaController` throws `MediaRouteError` for an unknown route.
- An observer is not called again with a status identical to the last one it got (Chrome calls it on every receiver
  status). It is called at once when the receiver volume is known, as Chrome does on binding.
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

## Starting a cast from main

Not supported: a cast needs the page's own SDK state and a user gesture, as in Chrome. To start one from the app's
menu or tray, tell the page to press its own Cast button (for example `webContents.executeJavaScript` clicking the
site's cast button, or a message the page listens for). The route then appears in the observers above.
