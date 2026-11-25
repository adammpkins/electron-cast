# Live mirroring harness

Mirrors a demo page ("Casting tab") or a screen ("Casting screen") to a **real** Cast device. The library's own tests
and smoke test never do this: they stream to a fake receiver on localhost. This harness is for you to run, by hand,
on a device you choose.

```sh
npm run build                     # from the repository root, once
cd examples/live-mirroring
npm install                       # links the repo as electron-cast and installs Electron
npm start                         # lists the devices that can receive tab mirroring, then quits
npm run tab -- "Living Room TV"       # mirror the demo window
npm run desktop -- "Living Room TV"   # mirror the primary screen, with system audio where the OS allows
```

What to expect:

- A dialog names the device and asks before anything starts.
- The device launches Google's streaming receiver app (`0F5096E8`, or the audio-only `85CDB22F` for speakers) and
  shows the window ("Casting tab") or the screen ("Casting screen").
- Click the demo window once to start a quiet tone, so the tab has audio to carry.
- Close the window or press Ctrl+C to end it: the receiver's app is stopped and the TV returns to its idle screen.
- The log shows the negotiation (the OFFER with its keys redacted, the ANSWER) and the codec chosen.

Switching the tab and freezing (tab mode). A second window ("B", a different colour and a higher tone) opens next to the
demo window ("A"). Once the route runs, type a key and press Enter in the terminal that started it (or use the **Cast**
menu, `Ctrl+Shift+S/F/U`):

| Key | Does | Check on the TV and in the log |
|---|---|---|
| `s` | `switchMirroringSourceTab` to the other window, and back on the next press | The picture changes to the other window's colours **without the app restarting or the screen going to the idle/loading state**; the log shows `Switching the mirroring source tab` and no new `OFFER`. `route id unchanged: true`. Click the window you switched to once so it has a tone: the TV's sound follows the mirrored window, and the window you left is audible again on the PC. |
| `f` | `freezeRoute` | After about half a second the picture stops on its last frame while the sound goes on. `freezeInfo` goes to `{ canFreeze: true, isFrozen: true }`. Note how long the TV keeps the frozen picture (a minute or more) and whether it shows a spinner or goes idle. |
| `u` | `unfreezeRoute` | The picture moves again at once; `isFrozen` is false. |

Also try: `s` while frozen (the picture should move again on the new window), `f` twice quickly, closing the window that
is not being mirrored (nothing should happen), and closing the one that is (the route ends).

Options: `--extra-codecs` lets the sender also offer VP9 (VP8 is always offered, and Opus for audio).

If something fails, the log lines that start with `electron-cast mirroring:` and `engine:` say where.
