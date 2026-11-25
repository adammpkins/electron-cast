# Rejoining a session after a restart

How to let a user quit or crash your app while casting and get the same cast back when it starts again, the way Chrome
lets a page rejoin a session by id.

## Why the app has to help

A cast session lives on the device, not in your app. When your app quits, the receiver app keeps playing. After a
**page reload** electron-cast rejoins for you (auto-join: the session stays open, parked, and the next page of the
same frame joins it, as in Chrome). After an **app restart** it cannot, for the same reason Chrome cannot:

- Chrome's auto-join only joins sessions this browser run started (`FindActivityForAutoJoin` skips activities that are
  not local), and electron-cast follows.
- electron-cast persists nothing. Chrome keeps no file either: its Media Router learns what each device runs from the
  device's own status (`CastSessionTracker`).

What Chrome *does* allow is joining a known session by id: `PresentationRequest.reconnect("cast-session_<id>")`, which
checks only that the receiver app matches and that this client is not already connected (`AppActivity::CanJoinSession`).
Google's SDK issues that call from `chrome.cast.requestSessionById(id)`. So the recipe is the one Chrome gives a page:

1. While casting, the app stores the session id (Google's SDK exposes it as `session.sessionId`).
2. At the next start, the page calls `chrome.cast.requestSessionById(id)` once the SDK is ready.
3. electron-cast asks the known devices which one runs that session, connects to it and returns it. The SDK hands it to
   the `sessionListener` you gave `chrome.cast.initialize`, exactly like a session the user just started.

Nothing to configure in electron-cast. `allowOrigin` still applies first; no origin check beyond that is made, because
the session id acts as the capability, as in Chrome ([SECURITY.md](../../SECURITY.md#scoping-of-sessions-and-messages)).

## The app side

The main process owns the stored id, so it survives anything the page does. Write it to disk when it changes, not on
quit: an app that is killed never reaches a quit handler.

```ts
import { app, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface SavedSession { sessionId: string; appId: string }

const file = join(app.getPath("userData"), "cast-session.json");
const ORIGIN = "https://music.youtube.com"; // the origin allowOrigin admits

let saved: SavedSession | null = null;
try {
  saved = JSON.parse(readFileSync(file, "utf8")) as SavedSession | null;
} catch {
  // none yet
}

// The page asks once per app start; later asks get null, so a page reload does not rejoin a session the user ended.
let taken = false;
ipcMain.handle("cast-app:take-saved-session", (event) => {
  if (event.senderFrame?.origin !== ORIGIN || taken) return null;
  taken = true;
  return saved;
});

ipcMain.on("cast-app:session-changed", (event, session: unknown) => {
  if (event.senderFrame?.origin !== ORIGIN) return;
  let next: SavedSession | null = null;
  if (typeof session === "object" && session !== null) {
    const { sessionId, appId } = session as Record<string, unknown>;
    if (typeof sessionId !== "string" || sessionId === "" || typeof appId !== "string") return;
    next = { sessionId, appId };
  }
  saved = next;
  writeFileSync(file, JSON.stringify(saved));
});
```

Expose both calls from the preload next to `installCastBridge`:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("castApp", {
  takeSavedSession: () => ipcRenderer.invoke("cast-app:take-saved-session"),
  sessionChanged: (session: { sessionId: string; appId: string } | null) => ipcRenderer.send("cast-app:session-changed", session),
});
```

## The page side

If you write the page, wire it into the SDK calls you already make. The three jobs are: report a session when the SDK
adopts one, forget it only when the user ended it, and rejoin once at startup.

```ts
declare const chrome: any;
declare const castApp: {
  takeSavedSession(): Promise<{ sessionId: string; appId: string } | null>;
  sessionChanged(session: { sessionId: string; appId: string } | null): void;
};

const APP_ID = chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID;
const JOIN_TIMEOUT_MS = 15_000;
let adopted = false;

// Every session the SDK hands you, started by the user or rejoined, arrives here.
function sessionListener(session: any): void {
  adopted = true;
  castApp.sessionChanged({ sessionId: session.sessionId, appId: session.appId });
  session.addUpdateListener((isAlive: boolean) => {
    // Forget it only when the user stopped the cast. A dropped connection (the app quitting or being killed) keeps it,
    // so the next start rejoins.
    if (!isAlive && session.status === chrome.cast.SessionStatus.STOPPED) castApp.sessionChanged(null);
  });
}

window.__onGCastApiAvailable = async (available: boolean) => {
  if (!available) return;
  const config = new chrome.cast.ApiConfig(
    new chrome.cast.SessionRequest(APP_ID),
    sessionListener,
    () => {}, // receiver availability
    chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  );
  chrome.cast.initialize(config, () => {}, () => {});

  const saved = await castApp.takeSavedSession();
  if (saved === null) return;
  // The SDK reports a failed join to no one, so a session that never arrives is how failure shows.
  setTimeout(() => {
    if (!adopted) castApp.sessionChanged(null);
  }, JOIN_TIMEOUT_MS);
  chrome.cast.requestSessionById(saved.sessionId);
};
declare global {
  interface Window { __onGCastApiAvailable?: (available: boolean) => void }
}
```

Why these choices:

- **Rejoin once, and give up.** A session that is gone (the device was restarted, someone else took the device, the
  receiver app was stopped from a phone) makes the join fail with `NotFoundError`, and Google's SDK does not tell the page.
  The timeout turns "nothing arrived" into "forget it", so the next start does not retry a dead id forever.
- **Discovery has to have found the device first.** electron-cast asks the *known* devices what they run, so a join
  attempted before mDNS has answered fails. Start the manager early (before the page loads, as YouTube Music Desktop does)
  and use a join timeout of several seconds. If your page loads very fast, retry `requestSessionById` after receiver
  availability turns true instead of only once.
- **Do not save on every update.** Report on adoption and on stop; the session id does not change while it lives.

## A worked example: YouTube Music Desktop

YouTube Music Desktop loads `music.youtube.com`, whose own script drives
Google's SDK through `chrome.cast`. It did not control the page, so it wraps the SDK's
`chrome.cast.Session.prototype.addUpdateListener`: every session the page adopts, whether from the user's pick or from a
rejoin delivered to the page's session listener, gets an update listener, and that is the point where the app learns the
session id. It then:

- sends `{ sessionId, appId, deviceName }` to the main process, which keeps it in the app's persisted state and writes
  it to disk at once (the app's normal state file lags by 30 seconds, which a killed app would never reach);
- forgets it only when `session.status` is `STOPPED`, so quitting or killing the app keeps it;
- at each start asks main for the saved session once, calls `chrome.cast.requestSessionById`, and clears the saved
  session if none arrives within 15 seconds.

This was tested on Windows, in dev and packaged builds: the app was killed mid-song, restarted, and rejoined the same
session on the same device with no picker; Stop casting cleared it. It has not been tried on macOS or Linux. The
implementation is in the YouTube Music Desktop fork's `src/main/services/castmanager/index.ts` and
`src/renderer/ytmview/scripts/setup/cast.ts`.

## What happens in electron-cast

For the curious, `reconnect("cast-session_<id>")` reaches the session service's `joinRunningSession`
([API](../API.md#joinrunningsession)): a session this run already holds is joined at once; otherwise each known device is
asked for its receiver status, the first one running the id is connected to, and the other connections are released.
Chrome does the same lookup from state it tracks continuously (`CastSessionTracker`, then
`CastActivityManager::AddNonLocalActivity`); electron-cast looks when asked. The message flow is drawn in
[Architecture](../ARCHITECTURE.md#reconnect-and-rejoin).

`mode: "chromecast"` does not do this.
