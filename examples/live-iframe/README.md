# Live iframe harness

A manual test for casting from iframes in presentation mode, on real hardware. The unit tests cover the frame logic
against fake frames; this runs Google's real Cast sender SDK in a real Electron, in two iframes of different origins.

```sh
npm ci                     # once
npm run live:iframe        # installs Electron 45 into smoke/.out/electron on first use, builds, opens the window
```

Nothing casts until you click **Cast** in a frame and pick a device in the dialog. `npm run live:iframe -- --selftest`
is the no-click check: it loads both iframes, waits for each SDK to report a cast state, prints PASS or FAIL and quits
(it never calls `selectDevice`). `LIVE_IFRAME_NO_SUBFRAMES=1` turns `nodeIntegrationInSubFrames` off (see check 0).

## What is on screen

- The top page `http://127.0.0.1:<port A>`, with two iframes:
  - **same-origin**: `http://127.0.0.1:<port A>/frame.html`
  - **cross-origin**: `http://localhost:<port B>/frame.html` (another host name and port, so another site and process)
- Each iframe shows its own origin, frame instance id, cast state, session state, session id, device, player state and
  a log of the events it received (SDK events, and the Presentation API connection events and message types the
  stand-in delivered to it). Buttons: Cast, Load test stream, Play / pause, Leave (keep playing), Stop casting.
- The top page has a table of what each frame reported, and a "Main process view": every `selectDevice` call (origin and
  sender id) and every change of the manager's routes (`registerMediaRoutesObserver`), also printed in the terminal with
  the prefix `[main]`. Frame console output is printed with the prefix `[renderer]`.
- Buttons to navigate, remove and re-add each iframe, and to reload the top page.

The sessions use the Default Media Receiver (`CC1AD845`) and, once connected, the public stream
`https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`. Use two different devices (say a Chromecast and a Nest Hub) for
the isolation checks. What happens when both frames cast to the same device is not covered by the checks below.

## Checks and expected results

Expectations come from `docs/API.md` (Frames and iframes), README (Iframes) and the code in `src/electron/main.ts`
(sender ids, sweep, navigation) and `src/electron/session-service.ts` (parking, leaving, auto-join).

**0. Subframe opt-in (no device needed).** `npm run live:iframe -- --selftest` prints PASS: both iframes show
"electron-cast stand-in installed" and a cast state. With `LIVE_IFRAME_NO_SUBFRAMES=1` both iframes show "NOT installed"
and the cast state stays `NO_DEVICES_AVAILABLE`: an iframe has no cast without the option.

**1. Each frame is its own sender, with its own origin.** Click **Cast** in the same-origin iframe.
- The dialog says "Asked by origin http://127.0.0.1:<A>" and "sender id <n> (an iframe)", n at or above 1073741824
  (2^30). (Here it equals the top page's origin; check 2 shows a frame whose origin differs from the top page's.)
- Pick device 1. In that iframe: session state `SESSION_STARTED`, a session id, the device name, and the test stream
  starts on the TV; its event log shows `presentation.start`, then `presentation.message` lines (`new_session`,
  `update_session`, `v2_message`...). `allowOrigin(...) -> true` is logged once per origin in the terminal.
- The cross-origin iframe stays at `NOT_CONNECTED`, session state `null`, and its event count does not rise while the
  other frame's does (media status updates keep arriving in the casting frame).
- Main process view: one route, `origin` http://127.0.0.1:<A>, `members` holding the one window id, `parked` false.

**2. The cross-origin frame has its own origin and session.** Click **Cast** in the cross-origin iframe and pick device 2.
- The dialog says origin `http://localhost:<B>` and a different sender id (also 2^30 or more).
- It gets its own session id; two routes now exist, with different origins. The first frame's log and session id do
  not change, and each frame's log shows only its own session's messages.
- If you pick device 1 again, see "not covered" above and tell the maintainer what you saw; no result is expected.

**3. A navigating iframe parks its session and rejoins it.** Click **Navigate same-origin iframe** while it casts.
- The route in the main process view is `parked: true` (no page attached) and the TV keeps playing; nothing is sent to
  the frame while it is parked.
- The new document (new frame instance id, "nav #1") sets the same options with `TAB_AND_ORIGIN_SCOPED` and the route is
  rejoined: `parked: false`, the same session id, session state `SESSION_RESUMED`. The stream is not reloaded.
- The cross-origin frame's session is untouched throughout (its event log gets nothing from this).

**4. A removed iframe leaves its session.** Click **Remove cross-origin iframe**.
- Electron does not announce a removed iframe, so electron-cast finds it with a sweep every 5 s: expect the route to
  disappear from the main process view within about 5 s (up to a little more).
- The code only closes the sender's transport (`leave`); it does not stop the receiver app, so the device is expected to
  keep playing. Report what the TV does. **Add cross-origin iframe** mounts a fresh frame: it has no session
  (`NOT_CONNECTED`) because that session's record is gone; electron-cast only auto-joins sessions it still holds.
- The same-origin frame's route and playback are unaffected.

**5. A navigating top page ends its iframes' sessions.** With the same-origin iframe casting, click **Reload top page**.
- The route disappears from the main process view at the page navigation (the iframes went with the page), and both
  new iframes start at `NOT_CONNECTED`.

**6. Controls still work from the right frame.** Re-cast from one iframe, then use **Play / pause**, **Leave (keep
playing)** (route is gone, the TV keeps playing) and **Stop casting** (the TV stops). Each affects only its own
session, and a frame's buttons never change the other frame's state.

If something differs, keep the terminal output (it has `[main]` routes and `selectDevice` lines with timestamps in the
frames' events) and the on-screen tables.
