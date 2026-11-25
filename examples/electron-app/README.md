# electron-cast example app

A small Electron app that shows the recommended setup:

- `main.js`: creates the cast manager with `createCastManager`, restricts casting to the app's own page with
  `allowOrigin`, and shows a device picker (`selectDevice`) as a native message box.
- `preload.js`: calls `installCastBridge`. The window uses `sandbox: true` and `contextIsolation: true`.
- `index.html` and `page.js`: a page that loads Google's own Cast SDK (`cast_sender.js?loadCastFramework=1`), shows
  the launcher button, and loads a public HLS sample on the default media receiver (`CC1AD845`).
- `receiver.html` and `receiver.js`: a presentation page. The "Present on a display" button shows it fullscreen on
  another screen (a wired display, as Chrome does), and the two pages exchange messages. The button is enabled only
  when a second display is connected. `main.js` wires this with the `wiredDisplay` option and `createReceiverWindows`.

## Run it

Needs Node 20 or later. electron-cast is not published from this folder, so build it first, then install and start
the example:

```sh
# from the repository root
npm install
npm run build

# then
cd examples/electron-app
npm install
npm start
```

Click the Cast button, pick a device in the dialog, then click "Play sample video". With no Cast device on the
network the button stays hidden and nothing happens. Close the window to quit.

## Why there is a bundling step

A sandboxed preload script can only `require` a few built-in modules (`electron`, `events`, `timers`, `url`). It
cannot load `electron-cast/preload` from `node_modules`, which is also an ES module. So `npm start` first runs
esbuild, which inlines `electron-cast/preload` into a single CommonJS file, `preload.bundle.cjs` (git-ignored). Any
bundler that can produce a CommonJS file with `electron` left external will do. The bundle is only the preload; the
main process imports `electron-cast/main` directly because Electron 28 and later load ES modules in the main
process.

## Notes

- The page is served from a local HTTP server on `127.0.0.1` so it has a real origin to allow. Pages loaded from
  `file:` have an opaque origin, which `allowOrigin` cannot name usefully.
- `main.js` uses `app.whenReady().then(...)` rather than a top-level `await app.whenReady()`. In an ES module main
  the top-level form keeps Electron from finishing startup.
- Electron prints a security warning about `http://www.gstatic.com` resources in development. Those are loaded by
  Google's Cast SDK, not by this app.
- The sample stream is from Shaka Player's public demo assets. Replace `SAMPLE_URL` in `page.js` with your own media;
  it must be reachable from the Cast device and send CORS headers for HLS or DASH.
