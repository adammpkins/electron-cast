# Multiple windows and iframes

How electron-cast treats several windows, views and iframes, and how to let an embedded player in an iframe cast.

## The rule: a frame is a sender

In presentation mode (the default) electron-cast follows Chrome: the Presentation API is scoped to a frame. Chromium
creates a `PresentationServiceImpl` per `RenderFrameHost`, and electron-cast gives each frame its own **sender** the same
way:

- a frame's availability watches, connections and sessions belong to it;
- its events go only to it;
- it cannot read, close or message another frame's connections;
- the `origin` that `allowOrigin` and `selectDevice` see is **that frame's own**, so a cross-origin iframe is its own
  origin, not its parent's.

The sender id of a main frame is its `webContents.id`. A subframe gets an id of its own (2^30 and up), kept for the frame's
lifetime across its navigations. You see it as `CastRequestInfo.senderId`. [Architecture](../ARCHITECTURE.md#frames-and-senders)
has the details.

## Several windows and views

Each window or view that has the preload is a sender (its main frame). Install the preload only where a page should cast.

- **Auto-join.** With `AutoJoinPolicy.ORIGIN_SCOPED` a new window of the same origin joins the session another window
  started (same app id). With `TAB_AND_ORIGIN_SCOPED` (the default policy in Google's SDK) only the sender that already
  held the session rejoins it, which includes the same window after a reload.
- **Who can act on a session.** Only members. Another window of the same origin cannot message or stop a session it has
  not joined ([SECURITY.md](../../SECURITY.md#scoping-of-sessions-and-messages)).
- **Which windows hold a route.** `getRoutes()` and the routes observer report `members` (the `webContents.id`s currently
  attached, once each however many of a window's frames hold the route) and `parkedSenders` (windows whose page
  navigated away and may rejoin). See the [main-process API](../MAIN-API.md#routes).
- **One pending request per sender.** A second `start` from the same frame while the picker is open is refused.

```ts
import { createCastManager } from "electron-cast/main";
import { ipcMain, BrowserWindow } from "electron";

const cast = createCastManager({
  ipcMain,
  selectDevice: async () => null, // your picker
  allowOrigin: (origin) => origin === "https://music.youtube.com",
});

// Find the window to bring to the front when a route changes.
cast.registerMediaRoutesObserver({
  onRoutesUpdated(routes) {
    for (const route of routes) {
      for (const id of route.members) BrowserWindow.getAllWindows().find((w) => w.webContents.id === id)?.show();
    }
  },
});
```

## Reloads and navigation

A reload or navigation ends the page's connections but **parks** its sessions: they stay open on the device, get no
events, and the sender's next page rejoins them through auto-join, as in Chrome. A parked session ends when the receiver
app stops or the device drops. A destroyed `webContents` leaves its sessions for good. When the last member of a session
is gone, electron-cast releases its connection to the app; the app keeps running on the device until it is stopped.

## Iframes

Google's SDK also works inside an iframe (an embedded player, say), with two things for you to do.

**1. Opt in to preloads in subframes.** Electron runs a preload in iframes only if the app asks for it:

```ts
import { BrowserWindow } from "electron";

const win = new BrowserWindow({
  webPreferences: {
    preload: "/absolute/path/to/preload.bundle.cjs",
    sandbox: true,
    contextIsolation: true,
    nodeIntegrationInSubFrames: true, // run the preload in iframes too
  },
});
```

Without it nothing changes: the preload runs only in the main frame, an iframe has no stand-in and its SDK finds no
devices. With it the preload, and so the cast bridge, runs in **every iframe of every origin**. `nodeIntegration` stays
`false`, so an iframe's page still gets no Node.

**2. Let the iframe's origin through `allowOrigin`.** The check uses the sending frame's own origin:

```ts
import { ipcMain } from "electron";
import { createCastManager } from "electron-cast/main";

const ALLOWED = new Set(["https://app.example.com", "https://player.example.net"]);

export const cast = createCastManager({
  ipcMain,
  selectDevice: async () => null, // your picker
  allowOrigin: (origin) => ALLOWED.has(origin), // exact origins, never endsWith or includes
});
```

What to expect for an iframe:

- An iframe that navigates parks its sessions, like a reloading page. An iframe that is removed, or whose page navigates,
  ends them.
- Electron announces neither a removed iframe nor its page's navigation, so electron-cast finds removed frames by sweeping
  the frame tree on every `did-frame-navigate` and every 5 seconds (an unreferenced timer) while an iframe sender exists.
  A removed iframe's sessions can therefore linger for up to 5 seconds.
- The picker sees the iframe's origin in `request.origin`. Show it: the user should know which embedded site is asking.
- `mode: "chromecast"` stays main-frame only: a call from an iframe is refused with `extension_missing`.

- A sandboxed iframe (`<iframe sandbox>`) needs `allow-presentation`, as in Chrome: without it `new PresentationRequest()`
  throws `SecurityError: The document is sandboxed and lacks the 'allow-presentation' flag.` electron-cast can only see
  that when the iframe is same-origin with its parent (it reads the `sandbox` attribute through `frameElement`; see
  [DESIGN](../DESIGN.md)). There is no `allow="..."` Permissions Policy to set for casting.

**What was tested.** The frame handling is covered by unit tests against fake frames. On a Nest Hub Max, Google's SDK in a
same-origin iframe and in a cross-origin iframe (another host name and port) each started a session on the Default Media
Receiver through `selectDevice` (the iframe's own origin and a sender id from 2^30 up), media reached `PLAYING`, and the page
stopped the session; the top page did the same as a control, and an iframe with `sandbox="... allow-presentation"` cast as
well. The smoke test in a real Electron does not load an iframe, and the iframe cases that move or remove a frame while it
casts (navigation, removal, several iframes at once) have not been tried on a device.

One difference from Chrome is left: Chrome also cancels a pending start whose frame navigated to another origin while the
picker was open (`HandleStartPresentationResponse`). Here a pending start is cancelled when the frame is removed or
navigates, not on an origin change alone.
