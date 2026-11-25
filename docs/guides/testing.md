# Testing your app

How to test code that uses electron-cast without a Cast device or a network: fakes for the manager, a fake receiver for the
client, and the smoke-test approach that runs the real package in a real Electron.

electron-cast takes everything it touches as a parameter, which is what makes this practical: Electron objects (`ipcMain`,
`contextBridge`, `ipcRenderer`), device discovery (`discovery`) and the connection to a device (`createClient`) can each be
replaced.

## Fakes for the manager

`createCastManager` accepts a `discovery` (anything with `devices()`, `start()`, `stop()` and `on`/`off` for `deviceUp`,
`deviceDown`, `deviceChanged`) and a `createClient` (anything shaped like `CastClientLike`). With those and a fake
`ipcMain`, a unit test drives the whole main-process path without Electron. As in Chrome, a device is offered only once
its channel is open and authenticated, after a random delay of up to 5 s and a 3 s quiet period; a test sets both to 0
with `sinks` and waits for `cast.settled()` after `cast.start()`:

```ts
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { CastClientLike, CastDevice, IpcMainLike, ReceiverApplication } from "electron-cast";
import { createCastManager } from "electron-cast/main";

const TV: CastDevice = {
  id: "dev-tv", name: "Test TV", model: "Chromecast", host: "10.0.0.10", addresses: ["10.0.0.10"], port: 8009,
  capabilities: 5, isGroup: false, statusText: "", instanceName: "Chromecast-dev-tv._googlecast._tcp.local", txt: {},
};

class FakeDiscovery extends EventEmitter {
  devices(): CastDevice[] { return [TV]; }
  async start(): Promise<void> {}
  stop(): void {}
}

class FakeClient extends EventEmitter implements CastClientLike {
  connected = false;
  async connect(): Promise<void> { this.connected = true; }
  close(): void { this.connected = false; this.emit("close"); }
  send(): void {}
  async launch(appId: string): Promise<ReceiverApplication> {
    return { appId, displayName: "Test app", sessionId: "session-1", transportId: "transport-1", namespaces: [] };
  }
  async stop() { return { applications: [], volume: {} }; }
  async setVolume() { return { applications: [], volume: {} }; }
  async getStatus() { return { applications: [], volume: { level: 0.5, muted: false } }; }
  connectTransport(): void {}
  closeTransport(): void {}
}

test("a page can start a session on the picked device", async () => {
  // A fake ipcMain keeps the handlers the manager registers, so the test can call them like Electron would.
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const ipcMain: IpcMainLike = {
    handle: (channel, listener) => handlers.set(channel, listener as (event: unknown, ...args: unknown[]) => unknown),
    removeHandler: (channel) => handlers.delete(channel),
    on: () => {},
    removeListener: () => {},
  };

  let asked: CastDevice[] = [];
  const client = new FakeClient();
  const cast = createCastManager({
    ipcMain,
    discovery: new FakeDiscovery(),
    createClient: () => client,
    sinks: { openDelayMaxMs: 0, reportDelayMs: 0 },
    allowOrigin: (origin) => origin === "https://app.example.com",
    selectDevice: async (devices) => ((asked = devices), devices[0] ?? null),
  });
  await cast.start();
  await cast.settled(); // the fake device's channel is open and it is listed

  // The "page": one webContents with a main frame at an allowed origin.
  const sender = Object.assign(new EventEmitter(), { id: 1, send() {}, isDestroyed: () => false });
  const event = { sender, senderFrame: { url: "https://app.example.com/index.html", origin: "https://app.example.com" } };
  const call = handlers.get("electron-cast:call")!;

  const init = (await call(event, "initialize", { appId: "CC1AD845", capabilities: [], autoJoinPolicy: "origin_scoped" })) as any;
  assert.equal(init.value.available, true);

  const started = (await call(event, "requestSession", { appId: "CC1AD845", capabilities: [] })) as any;
  assert.equal(started.ok, true);
  assert.equal(started.value.sessionId, "session-1");
  assert.deepEqual(asked.map((d) => d.id), ["dev-tv"]);

  await cast.dispose();
});
```

That exercises `mode: "chromecast"`'s channel (`electron-cast:call`), which is the shortest path to the session service. The
default presentation mode's channel is `electron-cast:presentation` and also needs `ipcMain.on` for
`electron-cast:presentation:send`; the repository's own tests for it
([test/electron/presentation-wiring.test.ts](../../test/electron/presentation-wiring.test.ts)) show the calls and fake frames
to copy. The `presentation: false` option serves only the `chromecast` channel and does not need `ipcMain.on`.

Things worth testing in your own code, all possible this way: that `allowOrigin` refuses what it should, that your picker
resolves `null` on cancel and a device otherwise, that a device whose client's `connect()` rejects (a `CastAuthError` or
`CastConnectionError`) never reaches your picker, and what your UI does when a client emits `close` mid-session (the channel
is reopened, and the device dropped if that fails).

## A fake receiver for `CastClient`

To test code that uses `CastClient` itself, run a fake receiver: a TLS server on `127.0.0.1` that speaks the real wire format
using the library's own codec (`frame`, `FrameDecoder`, `encodeCastMessage`, `decodeCastMessage`). The repository's
[test/client/fake-receiver.ts](../../test/client/fake-receiver.ts) is one, with a self-signed certificate from
[test/fixtures/tls](../../test/fixtures/tls/README.md); copy it into your project. Point a client at it with
`verifyDevice: false`, since a fake is not Google-certified:

```ts no-check
const receiver = new FakeReceiver();
const port = await receiver.listen();
const client = new CastClient({ host: "127.0.0.1", port, verifyDevice: false });
await client.connect();
```

To exercise device authentication itself, the `deviceAuth` client option replaces the trust anchors and the clock, so a test
can mint its own chain ([test/client/device-auth.test.ts](../../test/client/device-auth.test.ts) does).

## The smoke-test approach: the real package in a real Electron

Unit tests with fakes prove your logic; they cannot prove that the preload bundles and runs sandboxed, that
`contextBridge.executeInMainWorld` works in your Electron, or that the page really sees the stand-in. electron-cast's own
`npm run smoke` does, and its method is the one to copy for your app:

- **Real:** a sandboxed preload built from `electron-cast/preload` (bundled with esbuild, as in [Getting
  started](../GETTING-STARTED.md#2-the-preload)), the real `ipcMain`, `contextBridge` and `webContents`, and the built package
  loaded by name (`electron-cast/main`), so the `exports` map and `dist/` are what get tested.
- **Faked:** only the network. `createCastManager({ ipcMain, discovery: new FakeDiscovery(), createClient: (d) => new FakeClient(d), ... })`
  with a fake device, so there is no mDNS, no TLS and no device. The fake client answers `getStatus` and
  `getAppAvailability`, which the manager asks over the channel it keeps open to the device.
- **A page with a real origin.** A `file:` page has an opaque origin, so the test registers a standard, secure custom scheme
  (`protocol.registerSchemesAsPrivileged`) and loads a page from it, which `allowOrigin` can name.
- **A user gesture.** The page's code runs through `webContents.executeJavaScript(code, true)`, whose second argument makes
  Electron treat it as a user gesture, so `navigator.userActivation.isActive` is true and `start()` is allowed. The same
  call with `false` is how the smoke test checks that a start without a gesture is refused.
- **Assertions from inside the page:** that the stand-in exists, that availability resolves true for the fake device, that
  `start()` reaches your `selectDevice`, and that the page's connection receives the session.

The files: [smoke/run.mjs](../../smoke/run.mjs) installs and finds an Electron and runs [smoke/main.mjs](../../smoke/main.mjs),
with its fakes in [smoke/fakes.mjs](../../smoke/fakes.mjs) and preload build in
[smoke/build-preloads.mjs](../../smoke/build-preloads.mjs). CI runs it on Electron 35, 40 and the latest stable, on Linux,
Windows and macOS; none of those runs touches a real device or network. To run it yourself:

```sh
npm i --prefix smoke/.out/electron --no-package-lock electron@45
npm run smoke
```

(Electron is installed into its own folder because it is an optional peer dependency that npm skips in the repository's own
`node_modules`.)

## What no fake can tell you

Real networks, real firewalls, and real devices. Discovery on a VPN-laden Windows PC, a speaker group that renames itself, a
TV that drops off Wi-Fi: these need a device. When you probe one, [read-only is the rule](../../CONTRIBUTING.md#probing-real-devices):
discover, connect, authenticate and read status; do not launch apps, change volume or stop playback on a device that is
not yours to disturb.

For a DIAL TV there is a command that does this for you: `npx electron-cast@next dial-test` discovers DIAL devices, reads
their description and app info, and opens and closes YouTube only if you say yes. It writes a scrubbed report to
paste into an issue ([README](../../README.md#test-a-dial-tv)).
