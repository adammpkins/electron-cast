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

Options: `--extra-codecs` lets the sender also offer VP9 (VP8 is always offered, and Opus for audio).

If something fails, the log lines that start with `electron-cast mirroring:` and `engine:` say where.
