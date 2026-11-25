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
- The log shows the negotiation (the OFFER with its keys redacted, the ANSWER) and the codec chosen. The line
  `encoders: hardware [...], software [...]` says what this machine can encode, and `negotiated a new mirroring
  session. ... video codec=h264 (hardware)` says what the receiver took.

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

Options: `--stats` prints the mirroring statistics (Chrome's "Mirroring stats") every 5 seconds, for example
`npm run tab -- "Living Room TV" --stats`. The first lines come a few seconds in, once the receiver has sent its event log.

Video codec, as in Chrome: when the machine has a hardware encoder for H.264, VP8 or VP9 (checked with WebCodecs
`prefer-hardware`), those are offered, alone among the video codecs; when it has none, software VP8 and VP9 are.
Opus is always offered for audio. To compare the two on one machine, add
Chrome's own switches after the device name: `--cast-streaming-force-disable-hardware-h264` gives VP8,
`--cast-streaming-force-disable-hardware-vp8` and `...-vp9` switch those hardware encoders off the same way,
`--disable-features=CastStreamingVp9` takes VP9 out altogether, and
`--cast-streaming-force-enable-hardware-hevc` / `-av1` switch on codecs that are off by default (a receiver that
cannot decode them will take nothing, or fall back to VP8). A hardware encoder that fails during a session is dropped
for the rest of the run and the session offers again, so the log shows a second `OFFER` and a `Hardware h264 encoding
is disabled` line instead of the mirroring stopping.

If something fails, the log lines that start with `electron-cast mirroring:` and `engine:` say where.
