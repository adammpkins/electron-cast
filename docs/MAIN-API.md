# Main-process API

`createCastManager` returns a `CastManager`: `start()`, `devices()`, `dispose()` and the API below, which lets the
app observe and control casting from the main process. It follows Chrome's Media Router, so the same concepts and
method names apply: devices are **sinks**, running sessions are **routes**, and you watch both with **observers**.

This API does not touch the preload's `mode: "chromecast"`; it works for both modes, because both end in the same
session service.

## Mapping to Chrome

| electron-cast | Chrome | Chromium source |
|---|---|---|
| `registerMediaSinksObserver(observer, query?)` | `MediaRouter::RegisterMediaSinksObserver`, `MediaSinksObserver::OnSinksUpdated` | `components/media_router/browser/media_router.h`, `media_sinks_observer.h` |
| `MediaSink` | `media_router::MediaSink` (id, name, description, icon type) | `components/media_router/common/media_sink.h` |
| `registerMediaRoutesObserver(observer)` | `MediaRouter::RegisterMediaRoutesObserver`, `MediaRoutesObserver::OnRoutesUpdated` | `components/media_router/browser/media_routes_observer.h` |
| `MediaRoute` (`id`, `mediaSource`, `sinkId`, `description`) | `media_router::MediaRoute` (`media_route_id`, `media_source`, `media_sink_id`, `description`) | `components/media_router/common/media_route.h` |
| `terminateRoute(id)` | `MediaRouter::TerminateRoute` (what the Cast dialog's "Stop casting" calls) | `media_router.h`, `chrome/browser/ui/media_router/media_router_ui.cc` |
| `detachRoute(id)` | `MediaRouter::DetachRoute` | `media_router.h` |
| `getRouteController(id).setVolume / setMute` | `MediaRouter::GetMediaController`, `MediaRouteController::SetVolume / SetMute` (the controller the dialog and global media controls use) | `components/media_router/browser/media_route_controller.h`, `chrome/browser/ui/global_media_controls/` |
| `selectDevice`'s third argument | the Cast dialog's `QueryResultManager`, which registers sinks observers while the dialog is open | `chrome/browser/ui/media_router/query_result_manager.cc` |
| the Cast provider behind routes | `CastMediaRouteProvider`, `CastActivityManager` | `chrome/browser/media/router/providers/cast/` |

The Chromium paths and names above were written from memory of the source tree and not re-checked against a current
checkout; confirm them before quoting them elsewhere.

Where electron-cast differs from Chrome:

- Observers get the full list straight away on registration, then after each change, as Chrome's observers do once
  the router has a list. A sinks observer is only called when its (filtered) list actually changed.
- Registration returns the unregister function; Chrome unregisters when the observer object is destroyed.
- Control methods return promises and reject with `MediaRouteError` (`code`: `route_not_found` or a bridge code such
  as `session_error`); Chrome's are fire-and-forget.
- `MediaRoute` also carries `appId`, `displayName`, `origin`, `volume`, `members` (live `webContents.id`s),
  `parkedSenders` and `parked`, because in an Electron app main wants to know which windows hold a route. A route is
  `parked` when its pages navigated away (a reload, say) and none is attached; it stays on the device so the next
  page can rejoin (see CHANGELOG 0.3.1).
- Volume is the receiver's volume (what `setReceiverVolume` sets for the page). It is not the media session volume
  that Chrome's `MediaRouteController` sends over the media namespace; the route's `volume` shows what the device
  last reported. There is no media status (play state, position) in this API.

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

Routes are not ended on `dispose()`; the manager just stops reporting.

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
