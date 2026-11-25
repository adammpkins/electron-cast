# API reference

This reference reflects **v0.4.0**.

electron-cast ships an ES module build and a CommonJS build (`dist/cjs`, no extra dependencies). Every entry point has an
`import` and a `require` condition in `exports`, so `import` and `require("electron-cast/preload")` both work, and a
non-sandboxed CommonJS preload or main process can load the package without a bundler. Electron is an optional peer
dependency (`electron >=35`): the library never imports it (Electron objects are passed in), and the version matters
only because the preload needs `contextBridge.executeInMainWorld`, added in Electron 35. Node 20 or later.

There are four entry points:

| Entry point | Import it from | Contains |
|---|---|---|
| `electron-cast/main` | the Electron main process | [`createCastManager`](#createcastmanageroptions) and its types |
| `electron-cast/preload` | a preload script | [`installCastBridge`](#installcastbridgeoptions) and its types |
| `electron-cast/polyfill` | code that runs in a page | [`installChromeCast`](#installchromecastbridgekey) and the bridge types |
| `electron-cast` | plain Node code, or anywhere you want every layer | everything above, plus the session service, `CastClient`, discovery and the protocol layer |

Do not import the root from a preload script: it also pulls in Node's `tls` and `dgram`, which a sandboxed preload
cannot load. Use `electron-cast/preload`. A sandboxed preload can load no packages at all, so bundle it; see
[examples/electron-app](../examples/electron-app).

Electron objects (`ipcMain`, `contextBridge`, `ipcRenderer`) are passed in, never imported by the library. The
`...Like` interfaces below describe the part of each object the library uses.

How the library behaves: on the default Presentation API path it does what Chrome does, and the code cites
the Chromium source for each rule it copies. `mode: "chromecast"` (electron-cast's own `chrome.cast`) is a frozen
fallback that gets no new features, and nothing in the library is specific to one app.

Contents: [`electron-cast/main`](#electron-castmain) · [`electron-cast/preload`](#electron-castpreload) ·
[`electron-cast/polyfill`](#electron-castpolyfill) · [`electron-cast` (root)](#electron-cast-root):
[session service](#session-service), [`CastClient`](#castclient), [discovery](#discovery), [protocol](#protocol)

---

## `electron-cast/main`

### `createCastManager(options)`

<!-- no-check -->
```ts
function createCastManager(options: CastManagerOptions): CastManager
```

Registers the IPC handlers, creates the session service and discovery, and returns a manager. Nothing touches the
network until `start()`. Throws `TypeError` if `presentation` is not `false` and `ipcMain` has no `on` or
`removeListener`.

It registers `ipcMain.handle` on `<channel>:call` and `<channel>:presentation`, and `ipcMain.on` on
`<channel>:presentation:send`. It sends `<channel>:event` and `<channel>:presentation:event` to the one frame that
owns the sender. A frame is tracked from its first call. When its webContents is destroyed, or the page navigates,
its connections end; a navigation keeps its sessions open on the device so the next page can rejoin them.

**Frames and iframes.** In presentation mode every frame is its own sender: its availability watches, connections and
sessions belong to it, its events go only to it, and the `origin` checked by `allowOrigin` and shown to
`selectDevice` is that frame's own. The preload only runs in iframes when the window sets
`nodeIntegrationInSubFrames: true` in its `webPreferences`; without it nothing changes and an iframe has no cast. An
iframe that navigates parks its sessions as a reloading page does; a removed iframe (found by a 5 s sweep of the
frame tree, since Electron does not announce it) or a navigating page ends them. `mode: "chromecast"` is main-frame
only: a call from an iframe is refused with `extension_missing`. `CastRequestInfo.senderId` is the webContents id for a
main frame and a synthetic id (2^30 and up) for an iframe.

#### `CastManagerOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `ipcMain` | `IpcMainLike` | required | Electron's `ipcMain`. |
| `selectDevice` | `(devices: CastDevice[], request: CastRequestInfo, picker: DevicePickerContext) => Promise<DeviceChoice \| DisplayChoice>` | required | Called when a page asks to start a session. Show your picker and resolve a device, `null` to cancel, or `"stop"` to stop `request.session`; with `wiredDisplay`, `{ display: id }` picks one of `request.displays`. A rejection fails the request with `session_error`. A function that declares only the first two parameters works. See [`selectDevice`](#selectdevice). |
| `allowOrigin` | `(origin: string) => boolean` | none (every origin allowed) | Called on every page call with the origin of the calling frame. Return `false` to refuse. A throw refuses too. See [SECURITY.md](../SECURITY.md#alloworigin). |
| `discovery` | `DeviceSource & { start(): Promise<void>; stop(): void }` | `new CastDiscovery()` | Replaces device discovery. Mainly for tests. |
| `createClient` | `(device: CastDevice, params: ChannelParams) => CastClientLike` | `new CastClient({ host, port, verifyDevice: verifyDevices !== false, connectTimeoutMs, heartbeatTimeoutMs })` | Creates the connection to a device. `params` is `{ connectTimeoutMs, livenessTimeoutMs }` for this attempt (10 s unless `sinks.dynamicTimeoutDeltaMs` is set). Use it to pass `CastClient` options such as `tls`. When you give it, `verifyDevices` is ignored: pass `verifyDevice` to your own `CastClient`. |
| `channel` | `string` | `"electron-cast"` | Prefix of the IPC channel names. Must match the preload's `channel`. |
| `presentation` | `boolean` | `true` | Serve the preload's default (`"presentation"`) mode. With `false`, only `mode: "chromecast"` pages are served, and `ipcMain.on` and `removeListener` are not needed. |
| `verifyDevices` | `boolean` | `true` | Verify each device is a genuine Google-certified Cast device when connecting, as Chrome does (see [device authentication](#device-authentication)). `false` allows uncertified receivers such as open-source ones. A device that fails is never listed (see [sinks](MAIN-API.md#sinks)). |
| `sinks` | `CastSinkOptions` | Chrome's values | When and how channels to devices open and the list is reported: `openDelayMaxMs` (5000), `reportDelayMs` (3000), `retry` (a `SinkRetryOptions`: `initialDelayMs` 15000, `maxAttempts` 3, `multiplyFactor` 1, `jitter` 0.5, `maxDelayMs` 30000), `dynamicTimeoutDeltaMs` (0, as in Chrome: added to the 10 s connect and liveness timeouts per failed attempt, up to 30 s and 60 s) and `allowAllIps` (false: no channel is opened to a publicly routable or loopback address, as Chrome's `CastMediaSinkServiceImpl::OpenChannel` refuses them unless the `MediaRouterCastAllowAllIPs` policy is set; the address checked is the one being opened, with the predicates of [`isPubliclyRoutable` and `isLoopback`](#other-discovery-exports); see [SECURITY.md](../SECURITY.md#device-addresses)). Channels are opened to IP addresses only; a device whose `host` is a name is skipped with one `console.warn`. Each is Chrome's own setting (see [DESIGN.md](DESIGN.md#sinks-and-sessions-sink-servicets-session-trackerts)); mostly for tests. |
| `dial` | `boolean \| { registry?, http?, httpOptions?, settleMs?, log? }` | `true`, but `false` when a custom `discovery` is given | DIAL: SSDP discovery and the `cast-dial:` sources of presentation mode (see [DESIGN.md](DESIGN.md#dial-srcdial)). `false` sends no SSDP and no request to any device for DIAL. An object replaces the network layers (`registry`: `DialRegistryOptions`, `http`: a `DialHttp`, `httpOptions`: `origin`, `getTimeoutMs`, `actionTimeoutMs`), mostly for tests; `log` receives discovery problems, which are never thrown. A DIAL sink that is also a Cast sink (its UDN is the Cast id) is listed as Cast only, as in Chrome. |
| `wiredDisplay` | `WiredDisplayOptions` | none (off) | Presentation mode: other screens are presentation sinks, as Chrome's wired display provider has them; `screen`, `createReceiverWindow`, `selectDisplay`, and optional `BrowserWindow` and `displayOf` ([MAIN-API](MAIN-API.md#wired-displays)). |
| `accessCode` | `AccessCodeOptions` | off | Adding a device by its address, as Chrome's access code casting adds the device a code resolved to: `enabled` (Chrome's `AccessCodeCastEnabled`), `deviceDuration`, `store` ([MAIN-API](MAIN-API.md#adding-a-device-by-address)). |
| `networkMonitor` | `NetworkMonitor \| false` | reads `os.networkInterfaces()` every 5 s while started; none with a custom `discovery` | Network changes, as Chrome's `DiscoveryNetworkMonitor` reports them: DIAL devices given up on are tried again, the sinks of a network the machine comes back to are reopened, and devices added by address are removed and re-added 4.45 s later. A `NetworkMonitor` is `{ networkId(), observe(listener), start(), stop() }`; pass a fake to drive changes in tests, or `false` to turn it off ([DESIGN](DESIGN.md#network-changes-network-monitorts)). |
| `mirroring` | `ElectronMirroringOptions \| { createService }` | none (off) | Tab and desktop mirroring (`startCasting` with `castMode: "tab_mirror"` or `"desktop_mirror"`): the Electron classes it needs (with `app`, Chrome's codec switches on `app.commandLine` are honoured), and optional `engineModulePath`, `log`; `createService` replaces the engine (tests) ([MAIN-API](MAIN-API.md#tab-and-desktop-mirroring)). |

#### `CastManager`

| Member | Description |
|---|---|
| `start(): Promise<void>` | Starts discovery: opens an mDNS socket on every external IPv4 interface and on each adapter's IPv6 link-local address, and queries (see [Discovery](#discovery)). Safe to call more than once. Rejects only if the manager was disposed. |
| `devices(): CastDevice[]` | The devices that can be cast to: those whose channel has opened and passed device authentication, as last reported (see [sinks](MAIN-API.md#sinks)). Not the same as what mDNS has heard. Fresh copies. |
| `discoverSinksNow(): void` | Opens channels at once to every discovered device that has none, with no random delay (Chrome: `DiscoverSinksNow`). A device that gave up after its retries is only tried again by this or when discovery reports it again. It also tries the DIAL sinks again (Chrome: `CastMediaSinkServiceImpl::DiscoverSinksNow`). |
| `settled(options?: { retries?: boolean }): Promise<void>` | Resolves when no channel is being opened or waiting to be, and the list is reported. A retry waiting out its backoff counts only with `retries: true`. For tests and start-up. |
| `addSinkByAddress(device): Promise<AddSinkResult>` | Opens a channel to a device the app knows the address of and lists it for `accessCode.deviceDuration` seconds, as Chrome adds the device an access code resolved to. Validate the address first ([MAIN-API](MAIN-API.md#adding-a-device-by-address)). |
| `configureAccessCode({ enabled?, deviceDuration? }): Promise<void>`, `rememberedSinks()` | Change the access code settings while running; the devices remembered now. |
| `dispose(): Promise<void>` | Removes the IPC handlers, stops discovery, closes every device connection and ends all sessions. Idempotent. A disposed manager cannot be restarted; create a new one. |
| `registerMediaSinksObserver(observer, query?)`, `registerMediaRoutesObserver(observer)`, `registerIssuesObserver(observer)`, `clearIssue(id)`, `clearTopIssueForSink(sinkId)`, `getLogs()`, `registerLogObserver(observer)`, `getCastProviderState()`, `getRoutes()`, `terminateRoute(id)`, `detachRoute(id)`, `getRouteController(id)`, `getMediaController(id, observer?)` | The main-process Media Router API: observe devices (sinks) and sessions (routes), stop or detach a session, set its volume. Documented in [MAIN-API.md](MAIN-API.md), with the types `MediaSink`, `MediaSinksObserver`, `MediaSinksQuery`, `SinkIconType`, `MediaRoute`, `MediaRoutesObserver`, `MediaRouteController`, `MediaController`, `MediaStatus`, `MediaStatusObserver`, `CastManagerApi`, `Issue`, `IssueInfo`, `IssueSeverity`, `IssuesObserver`, `LogEntry`, `LogCategory`, `LogSeverity`, `LogObserver`, `CastProviderState`, `CastSessionState`, `CommandLineLike` (what `createCastManager`'s `commandLine` option needs: Electron's `app.commandLine`), `DevicePickerContext` and the error class `MediaRouteError`, all exported from `electron-cast/main`. |
| `hasDefaultPresentationRequest(webContentsId)`, `getDefaultPresentationRequest(webContentsId)`, `addPresentationObserver(webContentsId, observer)`, `startCasting(sinkId, options: StartCastingOptions)` | Casting from the app's own UI on the page's `navigator.presentation.defaultRequest`, as Chrome's Cast dialog does: read and observe the window's default request (`PresentationRequest`: `{ webContentsId, presentationUrls, frameOrigin }`; `PresentationObserver`: `onDefaultPresentationChanged(request \| null)`), and start it on a sink. `startCasting` resolves with the `MediaRoute`, hands the page `connectionavailable` with a connection, needs no user gesture, and rejects with `MediaRouteError` (`unable_to_cast`, `timed_out`, `sink_not_found`, `invalid_origin`, `cancelled`, `redundant_request`, `unknown_error`). `MediaSinksQuery.presentationUrls` lists the sinks that can run those URLs. With `castMode: "tab_mirror"` (`webContentsId` is then the page to mirror) or `"desktop_mirror"` (`desktopSourceId`, `withAudio`) the same method starts mirroring, and `MediaSinksQuery.castMode` lists the sinks for it. See [MAIN-API.md](MAIN-API.md#casting-from-the-apps-own-ui) and [mirroring](MAIN-API.md#tab-and-desktop-mirroring). |
| `switchMirroringSourceTab(routeId, webContentsId)`, `freezeRoute(routeId)`, `unfreezeRoute(routeId)` | Chrome's "share this tab instead" and freeze for a running mirroring route: `switchMirroringSourceTab` moves a `tab_mirror` route to another page in the same session (same route id, no renegotiation; local muting moves with it; throws `route_not_found`, or `unable_to_cast` for a desktop route, a route still launching or a page that cannot be captured). `freezeRoute` pauses the video on its last frame after 500 ms (the audio goes on) and `unfreezeRoute` resumes it at once; both do nothing for a route that is not a mirroring route. Mirroring routes carry `freezeInfo: { canFreeze, isFrozen }`. See [MAIN-API.md](MAIN-API.md#tab-and-desktop-mirroring). |
| `setMirroringStatsEnabled(enabled)`, `isMirroringStatsEnabled()`, `getMirroringStats(routeId)`, `registerMirroringStatsObserver(observer)` | Mirroring statistics, a debugging aid like Chrome's `chrome://media-router-internals` "Mirroring stats" (`MediaRouterDebugger`): off by default and read when a session starts, so enable them before `startCasting`; then each mirroring route has `{ audio, video }` with Chrome's names and units, refreshed every 500 ms (`MirroringStats`). `getMirroringStats` never throws: like Chrome's `MediaRouterDebuggerImpl::GetMirroringStats`, which has no error path, it returns `{}` while statistics are off, before the first fetch and for a route id it does not know, and an ended route keeps its last statistics (Chrome's copy outlives the session) until another route pushes newer ones. Not a web API, nothing is uploaded. See [MAIN-API.md](MAIN-API.md#tab-and-desktop-mirroring). |

#### `selectDevice`

`devices` holds only devices that have the capabilities the page asked for (default mode asks for none, so it lists
every device). The list is live at call time and is not updated while your picker is open.

`request` is a `CastRequestInfo`:

| Field | Type | Description |
|---|---|---|
| `appId` | `string` | The receiver application the page wants to launch (for example `CC1AD845`, the default media receiver). |
| `capabilities` | `string[]` | Capabilities the page requires: `video_out`, `video_in`, `audio_out`, `audio_in`, `multizone_group`. |
| `origin` | `string` | Origin of the requesting frame. Show it to the user. |
| `senderId` | `number` | The requesting webContents id. |
| `session` | `{ sessionId: string; deviceId: string }` (optional) | The sender's current session for this `appId`. The key is absent when there is none. |

The result is a `DeviceChoice` (`CastDevice | null | "stop"`):

- a `CastDevice`: cast to it. If it is the device of `request.session`, the existing session is returned and nothing is
  relaunched.
- `null`: the user cancelled. The page gets a cancel error.
- `"stop"`: stop `request.session`. The page's receiver action listeners are told, the session ends, and the
  request resolves as cancelled. Without a `request.session`, it is treated as cancelled.

The time the picker is open does not count against the page's launch timeout.

When the page's request carries a `cast-dial:` URL (Google's SDK adds one when the page passes a `dialRequest`),
`devices` also holds the DIAL sinks that have that app and may be shown to the page's origin; `request.appId` is then `""`
for a request that has no Cast URL. A DIAL sink has `device.dial` set. Choose it like any device: the manager creates the
DIAL route, and `request.session` does not apply to it.

The third argument, a `DevicePickerContext` (`{ signal: AbortSignal; registerMediaSinksObserver(observer): () => void }`),
streams devices that appear while the picker is open (mDNS often needs seconds). `signal` aborts when the request no
longer waits for a choice. See [MAIN-API.md](MAIN-API.md#a-live-device-picker).

#### App availability

In the default (Presentation API) mode a device counts for a page's request only once it has said, over its open
channel, that it has the request's receiver app, as in Chrome, where a `PresentationRequest`'s availability and the
sinks its `start()` offers come from `CastAppDiscoveryServiceImpl` (`cast_app_discovery_service.cc`). When a page asks
(`getAvailability()`) or starts (`start()`), every device with an open channel is asked `GET_APP_AVAILABILITY` for the
app, unless an answer stands; a device whose channel opens later is asked then. The answers follow Chrome's rules
(`ShouldRefreshAppAvailability`): "available" stands until the device goes away, "unavailable" for a minute
(`APP_AVAILABILITY_REFRESH_MS`), and no answer (a timeout, an error) is asked again each time.

- `getAvailability()` resolves at once from answers that stand; otherwise as soon as one device says yes, or when every
  device asked has answered. Its `change` events follow each answer that makes a device available or not, and each
  device that comes or goes, without waiting for the device list's 3 s report. So a page that asks at load, before the
  channels are open, gets `false` and then a `change` to `true` a moment later.
- `start()` offers the picker the devices that have the app (and the capabilities the URL names), waiting for the
  answers when none stands yet; with none, it rejects with `NotFoundError`. The picker's live list follows the answers.
- `mode: "chromecast"` is unchanged: `chrome.cast` availability and `requestSession` go by capabilities only.

Chrome's first answer waits for a device's result with no bound of its own; here it is bounded by the asks in flight
(each has the client's request timeout).

#### Errors the page sees

In `mode: "chromecast"`, `chrome.cast.ErrorCode` values: `cancel`, `timeout`, `receiver_unavailable`,
`session_error`, `channel_error`, `invalid_parameter`, `extension_missing` (origin not allowed, no sender frame, or a
call from an iframe).
In default mode they are mapped onto `DOMException` names: a cancelled request is `AbortError`, no receiver (or a
session that is gone, or one that does not match) is `NotFoundError`, a rejected parameter is `InvalidAccessError`, an
unusable presentation URL is `NotSupportedError`, and anything else is `OperationError`. An origin refused by
`allowOrigin` reads as no receivers and `start` fails; a call with no sender frame gets `NotAllowedError`.

`start` needs transient user activation, as in Chrome: the preload reads `navigator.userActivation.isActive` in its
own (isolated) world when the page calls the bridge's `start` and sends the result, replacing anything the page
passed; the main process refuses a start without it with `AbortError` ("PresentationRequest::start() requires user
gesture.", what Chromium's `PresentationServiceImpl::StartPresentation` reports as `PRESENTATION_REQUEST_CANCELLED`).
The page-side stand-in rejects with `InvalidAccessError` first, as Blink's `PresentationRequest::start()` does.
`mode: "chromecast"` has no gesture check. See [SECURITY.md](../SECURITY.md#user-gesture) for what this does and does
not protect against.

#### Sources electron-cast does not serve

electron-cast launches receiver apps; it does not mirror or remote. A presentation URL that names a Cast Streaming app
(`0F5096E8` or `85CDB22F`, in `cast:` or the legacy `https://google.com/cast#__castAppId__=` form, also when
listed beside ordinary apps in one legacy URL) is a mirroring source in Chrome, and a `remote-playback:` source (made
by `HTMLMediaElement.remote`) is served by media remoting. Neither is launched here: the request reads as having no
screen, so `getAvailability()` resolves `false` and `start()` rejects with `NotFoundError` ("No screens found.").
When a request lists several URLs, the first ordinary Cast app URL is served, so a normal app next to a mirroring one
still casts. The stand-in's `PresentationRequest` keeps only `http`, `https`, `cast` and `cast-dial` URLs and throws
`NotSupportedError` ("An empty sequence of URLs is not supported.") when none is left, as Blink does, so a page cannot
make a `remote-playback:` request. `video.remote` is not touched and never reports a device. See
[DESIGN.md](DESIGN.md#presentation-sources).

#### Rejoining after a reload or restart

- **Page reload or navigation.** The sessions stay open on the device (parked) and the next page of the same sender
  rejoins them by auto-join, as in Chrome.
- **App restart.** The library persists nothing. A session may still be playing on the device; Chrome's auto-join does
  not find sessions started by an earlier run, and neither does electron-cast. The app keeps the session id (Google's
  SDK exposes it as `session.sessionId`) and the page calls `chrome.cast.requestSessionById(id)` at startup. The SDK
  turns that into `PresentationRequest.reconnect("cast-session_<id>")`, which reaches
  [`joinRunningSession`](#joinrunningsession): electron-cast already knows what each device runs (it follows
  every device's receiver status, as Chrome does) and joins the session if the app matches. This checks no origin (Chrome's `AppActivity::CanJoinSession` checks only the
  app and that the client is not already connected), but `allowOrigin` still applies first. If the device no longer
  runs the session, the call fails with `NotFoundError`. `mode: "chromecast"` does not do this.

#### Structural types

```ts
interface FrameLike {
  url: string;
  origin?: string;
  frameTreeNodeId?: number;   // identifies a subframe across navigations
  parent?: unknown;           // null or absent on a main frame
  processId?: number;
  routingId?: number;
  send?(channel: string, ...args: any[]): void;   // reaches only this frame
}
interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: any[]): void;
  isDestroyed(): boolean;
  readonly mainFrame?: { readonly framesInSubtree: readonly FrameLike[] };
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "did-navigate" | "did-frame-navigate", listener: (...args: any[]) => void): unknown;
}
interface IpcMainInvokeEventLike { sender: WebContentsLike; senderFrame: FrameLike | null }
interface IpcMainEventLike { sender: WebContentsLike; senderFrame?: FrameLike | null }
interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEventLike, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
  on?(channel: string, listener: (event: IpcMainEventLike, ...args: any[]) => void): unknown;
  removeListener?(channel: string, listener: (event: IpcMainEventLike, ...args: any[]) => void): unknown;
}
```

Electron's `ipcMain`, `WebContents` and `WebFrameMain` satisfy these. The main entry also exports the types
`CastRequestInfo`, `DeviceChoice` and `CastDevice`, and the manager API types listed above.

#### `CastDevice`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | The device's stable id (mDNS TXT `id`). Devices are de-duplicated by it. |
| `name` | `string` | Friendly name (TXT `fn`), or the first label of the instance name. |
| `model` | `string` | Model name (TXT `md`), or `""`. |
| `host` | `string` | Address to connect to: the first of `addresses`. |
| `addresses` | `string[]` | All addresses: IPv4 first, then global IPv6, then link-local IPv6 (`fe80::1%12`, with its zone so it can be connected to); newest first within each group. |
| `port` | `number` | The Cast port, usually 8009. |
| `capabilities` | `number` | Capability bit mask (TXT `ca`): 1 `video_out`, 2 `video_in`, 4 `audio_out`, 8 `audio_in`, 32 `multizone_group`. |
| `isGroup` | `boolean` | True when the `multizone_group` bit is set. |
| `statusText` | `string` | TXT `rs`, or `""`. |
| `instanceName` | `string` | The full mDNS instance name. |
| `txt` | `Record<string, string>` | All TXT records. Treat the values as untrusted. |
| `dial` | `{ appUrl: string; modelName: string; ipAddress: string }` (optional) | Set only on a DIAL sink, which is shown to `selectDevice` when a request carries a `cast-dial:` URL. Then `id` is `dial:<uuid>`, `host` and `addresses` hold the device's address, `port` is 0, `capabilities` is 0 and `txt` is empty. Do not connect to it: return it from `selectDevice` and the manager launches the app over DIAL. |

---

## `electron-cast/preload`

### `installCastBridge(options)`

<!-- no-check -->
```ts
function installCastBridge(options: CastBridgeOptions): void
```

Call it once from a preload script. It exposes a bridge object to the page's main world with
`contextBridge.exposeInMainWorld`, then runs the page-side code in the main world with
`contextBridge.executeInMainWorld` (Electron 35 or later), before the page's own scripts run.

- `mode: "presentation"` (default): installs a stand-in for the Presentation API (`PresentationRequest`,
  `PresentationConnection`, `PresentationAvailability`, `navigator.presentation`). Google's own Cast SDK then loads
  and runs unmodified. It runs in every frame the preload runs in (iframes need `nodeIntegrationInSubFrames: true`).
- `mode: "chromecast"`: installs electron-cast's own `chrome.cast` and `chrome.cast.media` (and `cast.framework`)
  and blocks Google's loader scripts from replacing them. Nothing is installed if `chrome.cast` already exists.

Throws `TypeError` for an unknown `mode`, and in default mode if `ipcRenderer.send` is missing.

#### `CastBridgeOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `contextBridge` | `ContextBridgeLike` | required | Electron's `contextBridge`. |
| `ipcRenderer` | `IpcRendererLike` | required | Electron's `ipcRenderer`. Default mode also needs `send`. |
| `channel` | `string` | `"electron-cast"` | Prefix of the IPC channel names. Must match the manager's `channel`. |
| `mode` | `"presentation" \| "chromecast"` | `"presentation"` | See above. |
| `bridgeKey` | `string` | `"__electronCastBridge"` | Name of the global the bridge is exposed as. `"chromecast"` mode only. |
| `presentationBridgeKey` | `string` | `"__electronCastPresentationBridge"` | Name of the global the bridge is exposed as. `"presentation"` mode only. |
| `isUserActive` | `() => boolean` | reads `navigator.userActivation.isActive` in the preload's isolated world (`false` if missing) | Whether the frame has transient user activation right now, asked when the page calls `start`. `"presentation"` mode only. Mainly for tests. |

The page can read the bridge global and call it. See [SECURITY.md](../SECURITY.md).

#### Structural types

```ts
interface ContextBridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
  executeInMainWorld(script: { func: (...args: any[]) => unknown; args?: unknown[] }): unknown;
}
interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: any[]) => void): unknown;
  send?(channel: string, ...args: unknown[]): void;   // needed in "presentation" mode
}
```

---

## `electron-cast/polyfill`

### `installChromeCast(bridgeKey)`

<!-- no-check -->
```ts
function installChromeCast(bridgeKey: string): boolean
```

Installs electron-cast's own `chrome.cast` (API version `[1, 2]`), `chrome.cast.media` and `cast.framework` on the
page's global object, talking to the bridge at `globalThis[bridgeKey]`. Returns `true` when installed, `false`
when the bridge is missing or `chrome.cast` already exists (nothing is changed).

You normally do not call this: `installCastBridge({ mode: "chromecast" })` does. The function must stay
self-contained because Electron serializes it to source to run it in the main world.

The default mode's Presentation API stand-in is internal and has no public entry.

### Bridge types

Also exported from the root. These describe the messages between the page-side polyfill and the main process.

```ts
type BridgeResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; code: string; description?: string };

type BridgeMethod = "initialize" | "requestSession" | "joinSession" | "sendMessage" | "stopSession"
  | "leaveSession" | "setReceiverVolume" | "setReceiverMuted";

interface CastBridge {
  call(method: BridgeMethod, params: unknown): Promise<BridgeResult>;   // never rejects
  onEvent(listener: (event: BridgeEvent) => void): void;               // one listener
}

type BridgeEvent =
  | { type: "receiverAvailability"; available: boolean }
  | { type: "sessionUpdated"; session: SessionSnapshot }
  | { type: "sessionEnded"; sessionId: string; status: "stopped" | "disconnected" }
  | { type: "receiverAction"; sessionId: string; action: "stop" }
  | { type: "message"; sessionId: string; namespace: string; message: string };

interface InitializeParams { appId: string; capabilities: string[]; autoJoinPolicy: string }
interface InitializeResult { available: boolean; sessions: SessionSnapshot[] }
interface RequestSessionParams { appId: string; capabilities: string[]; timeoutMs: number }
interface VolumeSnapshot { level: number | null; muted: boolean | null; controlType?: string; stepInterval?: number }
interface ImageSnapshot { url: string; height?: number | null; width?: number | null }
interface ReceiverSnapshot {
  label: string; friendlyName: string; capabilities: string[]; volume: VolumeSnapshot;
  isActiveInput?: boolean | null; displayStatus?: { statusText: string; appImages: ImageSnapshot[] } | null;
}
interface SessionSnapshot {
  sessionId: string; appId: string; displayName: string; appImages: ImageSnapshot[]; statusText: string | null;
  namespaces: { name: string }[]; transportId: string; receiver: ReceiverSnapshot;
  senderApps?: { platform: string; url?: string | null; packageId?: string | null }[];
}
```

---

## `electron-cast` (root)

The root re-exports every layer below and everything from the three entry points above. The layers need Node and
have no Electron dependency, so they run in plain Node.

### Session service

<!-- no-check -->
```ts
class CastSessionService {
  constructor(options: CastSessionServiceOptions)
  handle(sender: SenderInfo, method: string, params: unknown): Promise<BridgeResult>
  senderGone(senderId: number): void
  senderNavigated(senderId: number): void
  dispose(): Promise<void>
}
```

The session logic behind `createCastManager`: it tracks initialized senders, one client per device and the sessions
pages hold, and pushes events through `options.emit`.

| Member | Description |
|---|---|
| `handle(sender, method, params)` | Handles one bridge call (`BridgeMethod`). Checks `allowOrigin`, validates `params`, and returns a `BridgeResult`. Never throws or rejects. An unknown method gives `invalid_parameter`. |
| `senderGone(senderId)` | The sender is gone for good: cancels its pending request and leaves its sessions. |
| `senderNavigated(senderId)` | The sender's page navigated: cancels its pending request but keeps its sessions open, parked, for a rejoin. |
| `dispose()` | Unsubscribes from devices, closes every client and clears all state. Idempotent. |

`handle` method names and parameters:

| Method | Params | Success value |
|---|---|---|
| `initialize` | `{ appId: string, capabilities: string[], autoJoinPolicy: string }` | `InitializeResult`: availability, and the sessions auto-joined (`origin_scoped`, or `tab_and_origin_scoped` for this sender's own sessions) |
| `requestSession` | `{ appId: string, capabilities: string[], timeoutMs?: number }` (default 60000) | `SessionSnapshot` |
| `joinSession` | `{ sessionId: string }` (the session must have been started from the same origin) | `SessionSnapshot` |
| `joinRunningSession` | `{ sessionId: string, appId?: string }` | `SessionSnapshot` |
| `sendMessage` | `{ sessionId: string, namespace: string, message: string }` | `undefined` |
| `stopSession` | `{ sessionId: string }` | `undefined` |
| `leaveSession` | `{ sessionId: string }` | `undefined` |
| `setReceiverVolume` | `{ sessionId: string, level: number }` (0 to 1) | `undefined` |
| `setReceiverMuted` | `{ sessionId: string, muted: boolean }` | `undefined` |

##### `joinRunningSession`

Joins a session by id the way Chrome's Media Router does for `reconnect("cast-session_<id>")`. A session this service
already holds is joined at once. Otherwise the session tracker, which keeps what every device runs from the receiver
status on its open channel, is asked, and the caller joins over that device's channel; the session then belongs to the
caller's origin. Nothing is looked up when asked, so the device must have been found (its channel open and status
received) by then. `appId`, when given, must be the session's app. No origin is compared with the session's (unlike
`joinSession`); `allowOrigin` still applies. Fails with `session_error` when no known device runs the session, the
app differs, or the service was disposed; with `invalid_parameter` for a bad `sessionId`. The presentation handler calls it for `reconnect`;
`mode: "chromecast"` does not (its `requestSessionById` uses `joinSession`). Only main calls it: it is not a
`BridgeMethod`, and the IPC channel refuses it from a page as an unknown method (`invalid_parameter`).

Error codes: `invalid_parameter`, `extension_missing` (origin not allowed), `receiver_unavailable`, `cancel`, `timeout`,
`session_error`, `channel_error`.

#### `CastSessionServiceOptions`

| Option | Type | Description |
|---|---|---|
| `devices` | `DeviceSource` | Source of devices and change events. The service opens a channel to each and lists it only once the channel is open. |
| `sinks` | `CastSinkOptions` (optional) | As for the manager. |
| `createClient` | `(device: CastDevice, params: ChannelParams) => CastClientLike` | Creates a connection for a device. |
| `selectDevice` | `(devices, request, picker) => Promise<DeviceChoice>` | As in [`selectDevice`](#selectdevice). |
| `allowOrigin` | `(origin: string) => boolean` (optional) | As for the manager. |
| `emit` | `(senderId: number, event: BridgeEvent) => void` | Receives every event for a sender. |

The root also exports the DIAL layer from `src/dial/`. They are the pieces [DESIGN.md](DESIGN.md#dial-srcdial)
describes, each with the Chromium function it follows, and are not needed to use the manager:

| Export | What it is |
|---|---|
| `DialService`, `DialServiceOptions` | The registry, sink service and route provider behind the manager's `dial` option. `isCastDevice` tells it which processed uuids are Cast sinks, whose DIAL sinks it then hides. |
| `DialRegistry`, `DialRegistryOptions` | SSDP discovery cycles and the device list (`DialRegistry`). |
| `DialSinkService`, `DialSink` | Device descriptions, app info and the sinks (`DialMediaSinkServiceImpl`). |
| `DialRouteProvider`, `DialRouteInfo`, `DialRouteError` | The DIAL routes and the SDK's round trip (`DialMediaRouteProvider`); `DialRouteError` carries Chrome's result code. |
| `dialEnvelope`, `parseDialMessage` | Build and read the router messages of a DIAL route (`dial_internal_message_util.cc`). |
| `createDialHttp`, `DialHttp`, `DialHttpOptions`, `DialHttpResult`, `defaultDialOrigin` | The HTTP layer (`DialURLFetcher`) and the fake `Origin` it sends (`GetFakeOriginForDialLaunch`). |
| `dialOriginAllowed`, `dialOriginsFor` | Which origins may see an app (`DialMediaRouteProvider::GetOrigins`). |
| `DIAL_SCHEME`, `isDialSource`, `appNameFromDialSource`, `parseDialLaunchSource` | `cast-dial:` sources (`MediaSource::IsDialSource`, `AppNameFromDialSource`, `DialActivity::From`). |
| `dialSinkToDevice` | A DIAL sink as a `CastDevice` with its `dial` field set, the shape pickers and sinks observers see. |

#### Other exports

| Export | Description |
|---|---|
| `capabilityNames(bits: number): string[]` | Capability bit mask to names, in bit order. |
| `DeviceSource` | `devices(): CastDevice[]` and `on`/`off` for `"deviceUp"`, `"deviceDown"`, `"deviceChanged"` (listener gets a `CastDevice`). `CastDiscovery` fits it. |
| `CastClientLike` | The part of `CastClient` the service uses: `connected`, `connect`, `close`, `send`, `launch`, `stop`, `setVolume`, `getStatus`, `connectTransport`, `closeTransport`, and `on` for `message`, `receiverStatus`, `transportClosed`, `close`. |
| `ClientMessage` | `{ namespace, sourceId, destinationId, data: string \| Buffer }`. |
| `SenderInfo` | `{ id: number, origin: string }`: a frame (the webContents id for a main frame; the manager gives each iframe its own id) and its origin. |
| `CastRequestInfo`, `DeviceChoice` | As above. |
| `APP_AVAILABILITY_REFRESH_MS` | `60000`: how long a device's "unavailable" answer to `GET_APP_AVAILABILITY` stands before it is asked again (Chrome's `kRefreshThreshold` in `cast_app_discovery_service.cc`). |

The service also has `mediaRoutes()`, `observeSessions(listener)`, `terminateSession(id)`, `setSessionVolume(id, volume)`,
`detachSession(id)`, `sendSessionMessage(id, namespace, message)`, `sessionVolume(id)`,
`observeSessionStatus(listener)` and `observeMediaStatus(listener)`, the hooks the manager's
[main-process API](MAIN-API.md) is built on (the last four serve the media controller, for local and non-local routes
alike), and the [app availability](#app-availability) the presentation handler and `startCasting` use:
`observeAppAvailability(sender, { appIds, capabilities }, onchange)` (`{ available: Promise<boolean>; close() }`),
`checkAppAvailability(device, appId)` and `cachedAppAvailability(device, appId)`.

### `CastClient`

<!-- no-check -->
```ts
class CastClient extends EventEmitter<CastClientEvents> {
  constructor(options: CastClientOptions)
  readonly senderId: string
  get connected(): boolean
  get deviceAuth(): DeviceAuthResult | undefined
  connect(): Promise<void>
  close(): void
  send(namespace: string, destinationId: string, payload: string | Uint8Array | object): void
  request<T = Record<string, unknown>>(namespace: string, destinationId: string,
    payload: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>
  getStatus(): Promise<ReceiverStatus>
  launch(appId: string, options?: LaunchOptions): Promise<ReceiverApplication>
  stop(sessionId: string): Promise<ReceiverStatus>
  setVolume(volume: { level: number } | { muted: boolean }): Promise<ReceiverStatus>
  getAppAvailability(appIds: string[]): Promise<Record<string, boolean>>
  connectTransport(transportId: string, options?: { invisible?: boolean }): void
  closeTransport(transportId: string): void
}
```

A single-use Cast v2 client: one TLS connection to one receiver. After `close()` or a failure it cannot be
reconnected; make a new one. The TLS socket is opened with `rejectUnauthorized: false`, as Cast devices present
self-signed certificates; the device is authenticated instead by the [device authentication](#device-authentication)
challenge that `connect()` runs by default (see [SECURITY.md](../SECURITY.md#tls-and-device-authentication)).

#### `CastClientOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | required | Receiver address. |
| `port` | `number` | `8009` | Receiver port. |
| `senderId` | `string` | `"sender-"` plus 8 random hex digits | The `sourceId` of the client's messages. |
| `connectTimeoutMs` | `number` | `10000` | Limit for the TLS handshake. |
| `verifyDevice` | `boolean` | `true` | Verify the device is a genuine Google-certified Cast device before use. `false` skips the challenge, for uncertified receivers. |
| `authTimeoutMs` | `number` | `10000` | Limit for the device's reply to the authentication challenge, counted from the end of the TLS handshake. |
| `deviceAuth` | `DeviceAuthOptions` | none | Trust roots and clock overrides for the check, for tests and private Cast deployments (see [below](#deviceauthoptions)). |
| `requestTimeoutMs` | `number` | `5000` | Default limit for `request` and the calls built on it: Chrome's `kRequestTimeout`. |
| `launchTimeoutMs` | `number` | `60000` | Limit for `launch` (Chrome's default launch timeout; a launch is never held longer than 2 minutes). |
| `heartbeatIntervalMs` | `number` | `5000` | How often a PING is sent. |
| `heartbeatTimeoutMs` | `number` | `10000` | The connection fails after this long with no traffic. |
| `tls` | `Omit<tls.ConnectionOptions, "host" \| "port">` | none | Extra `tls.connect` options, applied after the defaults (so they can override `rejectUnauthorized`). |
| `connectPayload` | `Record<string, unknown>` | none | Extra fields merged over those of every CONNECT message. |
| `sender` | `Partial<{ userAgent, browserVersion, locale, platform }>` | what Chrome on this machine sends | What CONNECT and LAUNCH tell the receiver about the sender ([DESIGN](DESIGN.md#what-the-channel-sends-and-waits-for)). For tests. |

#### Methods

| Method | Description |
|---|---|
| `connect()` | Opens the TLS connection, runs device authentication (unless `verifyDevice` is `false`) and sends CONNECT to the platform receiver (`receiver-0`). Rejects with `CastConnectionError`, `CastTimeoutError` (TLS handshake) or `CastAuthError` (the device failed or did not answer the challenge; the socket is closed). Only valid once, from the idle state. |
| `deviceAuth` (getter) | What authentication established: a `DeviceAuthResult` once `connect()` has verified the device, `undefined` before that or with `verifyDevice: false`. |
| `close()` | Sends CLOSE for every open transport and the receiver, ends the socket, rejects pending work with `CastConnectionError`, and emits `close`. Idempotent. |
| `send(namespace, destinationId, payload)` | Sends a message. A string is sent as is, an object as JSON, a `Uint8Array` as a binary payload. Throws `CastConnectionError` when not connected. |
| `request(namespace, destinationId, payload, options?)` | Adds a `requestId`, sends, and resolves with the matching reply. Rejects with `CastRequestError` for an error reply, `CastTimeoutError` on timeout, `CastConnectionError` if the connection ends. |
| `getStatus()` | The receiver's current status. |
| `launch(appId, options?)` | Launches an app and resolves when it appears in a `RECEIVER_STATUS`. The LAUNCH carries `language`, `supportedAppTypes` (`options.supportedAppTypes`, else `["WEB"]`) and `appParams` (`options.appParams`). `options.timeoutMs` replaces `launchTimeoutMs` (2 minutes at most); `options.onStatus` hears a `LaunchStatus`, `pending_authorization` or `allowed` (`LAUNCH_STATUS`), which do not extend the timeout. Rejects with `CastLaunchError` (for `LAUNCH_ERROR`, `INVALID_REQUEST` or an unknown `LAUNCH_STATUS`) or `CastTimeoutError`. |
| `stop(sessionId)` | Stops a session. Resolves with the new status. |
| `setVolume(volume)` | Sets the device volume level (0 to 1) or muted flag. Resolves with the new status. |
| `getAppAvailability(appIds)` | Which of the apps the receiver can run. |
| `connectTransport(transportId, options?)` | Opens a virtual connection to an app's transport, strong unless `options.invisible`. Idempotent. Needed before messaging the app. Ignored when not connected. |
| `closeTransport(transportId)` | Closes it. |

#### Events

| Event | Payload | When |
|---|---|---|
| `message` | `{ namespace, sourceId, destinationId, data: string \| Buffer }` | A message arrives on any namespace except heartbeat and connection control. |
| `receiverStatus` | `ReceiverStatus` | A `RECEIVER_STATUS` arrives. |
| `transportClosed` | `transportId: string` | The receiver closed a transport. |
| `close` | `error?: Error` | The client closed. The error is absent after a deliberate `close()`. |

#### Constants and types

| Export | Description |
|---|---|
| `NS` | Namespace urns: `CONNECTION` (`urn:x-cast:com.google.cast.tp.connection`), `HEARTBEAT` (`...tp.heartbeat`), `RECEIVER` (`urn:x-cast:com.google.cast.receiver`) and `DEVICE_AUTH` (`...tp.deviceauth`). `DEVICE_AUTH` is used by the authentication challenge. |
| `PLATFORM_RECEIVER_ID` | `"receiver-0"`, the destination id of the device itself. |
| `ReceiverApplication` | `{ appId, displayName, sessionId, transportId, namespaces: { name }[], statusText?, isIdleScreen?, iconUrl?, ... }` |
| `ReceiverVolume` | `{ level?, muted?, controlType?, stepInterval? }` |
| `ReceiverStatus` | `{ applications: ReceiverApplication[], volume: ReceiverVolume, ... }` |
| `CastClientOptions`, `CastClientEvents` | The option and event types above. |

#### Device authentication

Like Chrome, `connect()` proves the device is a genuine, Google-certified Cast device before CONNECT, as a port of
Chromium's sender side (`cast_auth_util.cc` and the certificate code beside it): it sends a challenge (16-byte nonce,
SHA-256) on the `deviceauth` namespace, then checks the TLS certificate's validity window, the device's certificate
chain against Google's built-in Cast root certificates, revocation, and a signature over the nonce and this
connection's TLS certificate. There are no dependencies and no network access. How it works and where it differs from
Chromium: [DESIGN.md](DESIGN.md#device-authentication-srcclientauth).

**Revocation and the stale fallback CRL.** Revocation uses the CRL the device sends, or else a fallback CRL built into
the package, which counts for 20 weeks from the package's build time (stamped by `npm run build`; Chromium uses the
binary's build time). When that window has lapsed and the device sent no valid CRL, the revocation check is skipped and
`deviceAuth.revocationChecked` is `false`, where Chromium would refuse the device (Chrome updates itself; an app may
not). Everything else is still checked, and revocation by a device CRL or a still-valid fallback is always enforced.
Update the package to get a fresh fallback CRL.

##### `DeviceAuthResult`

Returned by the `deviceAuth` getter. Exported as a type.

| Field | Type | Meaning |
|---|---|---|
| `policy` | `"unrestricted" \| "audio_only"` | Chromium's certificate policy result. `audio_only` is reported; nothing in electron-cast acts on it. |
| `hashAlgorithm` | `"sha1" \| "sha256"` | The digest the device signed with. |
| `nonceEchoed` | `boolean` | `false` when the reply did not echo our nonce. Chromium records this and carries on, and so does electron-cast. |
| `usedFallbackCrl` | `boolean` | The device sent no usable CRL and the built-in fallback CRL was used. |
| `revocationChecked` | `boolean` | `false` only in the stale-fallback case above. |

`CastDeviceCertPolicy` (an exported type) is the type of `policy`: `"unrestricted"` or `"audio_only"`.

`CastCertError` (an exported type) is the outcome of the certificate-chain check that device authentication runs, named after
Chromium's `CastCertError`: `OK`, `OK_FALLBACK_CRL`, `OK_FALLBACK_CRL_STALE`, `ERR_CERTS_MISSING`, `ERR_CERTS_PARSE`,
`ERR_CERTS_DATE_INVALID`, `ERR_CERTS_VERIFY_GENERIC`, `ERR_CERTS_RESTRICTIONS`, `ERR_CERTS_REVOKED`,
`ERR_CERTS_REVOKED_BY_FALLBACK_CRL` and `ERR_FALLBACK_CRL_INVALID`. A client reports it through `CastAuthError.reason`, never
directly: the `ERR_CERTS_MISSING`, `_PARSE`, `_DATE_INVALID` and `_RESTRICTIONS` outcomes become `invalid_certificate`,
`ERR_CERTS_VERIFY_GENERIC` becomes `untrusted_chain`, both `REVOKED` outcomes become `revoked`, and `ERR_FALLBACK_CRL_INVALID`
becomes `crl_invalid`. The three `OK` outcomes pass; `OK_FALLBACK_CRL_STALE` is the stale-fallback case above.

##### `DeviceAuthOptions`

The `deviceAuth` client option, exported as the type `DeviceAuthOptions`. All fields are optional.

| Field | Type | Meaning |
|---|---|---|
| `now` | `number` | Verification time, epoch milliseconds. Default: now. |
| `roots` | `Uint8Array[]` | DER trust anchors replacing the Cast Root CA and Eureka Root CA. |
| `crlRoots` | `Uint8Array[]` | DER CRL trust anchors replacing the Cast CRL Root CA. |
| `fallbackCrl` | `Uint8Array \| null` | Replacement fallback CRL (a serialized CrlBundle), or `null` for none. |
| `fallbackCrlBuildTime` | `number` | The build time the fallback's 20-week window starts at, epoch milliseconds. |

#### Errors

All are `Error` subclasses with `name` set to the class name.

| Class | Thrown or rejected when | Extra fields |
|---|---|---|
| `CastConnectionError` | The connection could not be made, was closed, failed, or timed out on heartbeat; `send` while disconnected. | `cause` (the underlying error, if any) |
| `CastTimeoutError` | The TLS handshake, a request, or a launch did not finish in time. | none |
| `CastAuthError` | The device did not prove it is a genuine Cast device (reasons below). The message names the device address when known. | `reason: CastAuthReason`, `host: string \| undefined` |
| `CastLaunchError` | A `launch` failed (a `CastRequestError`). | `failure: CastLaunchFailure` (`"user_not_allowed"`, `"notification_disabled"` or `"error"`), `description: string` (Chrome's text for it) |\| "notification_disabled" \| "error"`, `description: string` (Chrome's text for it) |
| `CastRequestError` | The receiver replied with an error: type `INVALID_REQUEST`, `LOAD_FAILED`, `LOAD_CANCELLED`, `INVALID_PLAYER_STATE`, or ending in `_ERROR`. | `type: string`, `reason: string \| undefined`, `response: Record<string, unknown>` |

`CastAuthReason` (an exported type) is one of:

| `reason` | Meaning |
|---|---|
| `timeout` | No authentication reply within `authTimeoutMs`. |
| `no_tls_certificate` | The device presented no TLS certificate. |
| `tls_certificate_invalid` | The TLS certificate does not parse, is not yet valid, has expired, or is valid for more than 4 days (it bounds the proof's lifetime). |
| `device_error` | The device answered with an authentication error. |
| `malformed_reply` | The reply was not a binary, parseable `DeviceAuthMessage` with a response, or the framing broke during authentication. |
| `unsupported_algorithm` | The reply's hash algorithm is neither SHA-1 nor SHA-256. |
| `invalid_certificate` | No device certificate, one that does not parse, is outside its validity dates, or breaks a certificate restriction. |
| `untrusted_chain` | The chain does not lead to a Cast root. |
| `revoked` | The device certificate (or a CA) is revoked by the device's CRL or the fallback CRL. |
| `crl_invalid` | The device sent no valid CRL and the built-in fallback CRL is itself invalid (broken or not yet valid; a merely lapsed one skips revocation instead). |
| `bad_signature` | The signature over the nonce and TLS certificate is empty or does not verify. |

Through the manager, any `connect()` failure, `CastAuthError` included, reaches the page as an unreachable device.

### Discovery

#### `CastDiscovery`

<!-- no-check -->
```ts
class CastDiscovery extends EventEmitter<CastDiscoveryEvents> {
  constructor(options?: CastDiscoveryOptions)
  start(): Promise<void>
  query(): void
  devices(): CastDevice[]
  interfaces(): NetworkInterfaceInfo[]
  stop(): void
}
```

Finds Cast devices by sending mDNS PTR queries on every external IPv4 interface and on one IPv6 link-local address
per adapter (group `ff02::fb`), and joining the answers into `CastDevice`s, so IPv6-only devices are found too. What
users see:

- A device's `host` is its IPv4 address when it has one (Chromium's Cast discovery resolves only A records), else a
  global IPv6, else link-local. Link-local addresses carry the interface's zone (`fe80::1%12`) so they can be
  connected to; one heard on an interface with no known zone is dropped.
- Interfaces that appear or disappear are picked up (checked every `interfaceCheckMs`). Devices that only a vanished
  interface heard are removed at once (`deviceDown`) instead of after their TTL.
- After the machine wakes from sleep (an interface check that runs more than `resumeGapMs` late) all sockets are
  replaced and queried again, since they can come back deaf.
- If the socket for an interface fails (IPv6 included), `socketError` is emitted once and the other interfaces carry on.

| Member | Description |
|---|---|
| `start()` | Opens a socket on every interface and starts querying: right away, at each `followUpQueriesMs` offset, then every `refreshMs`. Resolves when every interface has been tried; an interface that fails emits `socketError` and does not fail the call. Calling it again returns the same promise. Rejects after `stop()`. |
| `query()` | Sends one query now on every open socket. |
| `devices()` | Copies of the devices known now. |
| `interfaces()` | The interfaces that have an open socket. |
| `stop()` | Stops timers, closes sockets and forgets devices. Idempotent. The instance cannot be restarted. |

##### `CastDiscoveryOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `serviceName` | `string` | `"_googlecast._tcp.local"` | The mDNS service to query. |
| `interfaces` | `() => NetworkInterfaceInfo[]` | `listMdnsInterfaces()` | Which interfaces to use: external IPv4 addresses plus one IPv6 link-local address per adapter. |
| `openSocket` | `OpenMdnsSocket` | `openUdpMdnsSocket` | How to open a socket (for tests). |
| `followUpQueriesMs` | `number[]` | `[1000, 3000]` | Extra queries, in ms after `start()`. |
| `refreshMs` | `number` | `60000` | Query interval after the follow-ups. |
| `expireCheckMs` | `number` | `1000` | How often expired records are dropped (and `deviceDown` emitted). |
| `interfaceCheckMs` | `number` | `10000` | How often the interface list is re-read. |
| `resumeGapMs` | `number` | `3 * interfaceCheckMs` | A check this much later than due means the machine slept; sockets are then replaced. |

##### `CastDiscoveryEvents`

| Event | Payload |
|---|---|
| `deviceUp` | `CastDevice`: a new device. |
| `deviceChanged` | `CastDevice`: a known device's details changed. |
| `deviceDown` | `CastDevice`: a device's records expired or it said goodbye. |
| `socketError` | `(iface: NetworkInterfaceInfo, error: Error)` |

#### Other discovery exports

| Export | Description |
|---|---|
| `listIPv4Interfaces(nets?)` | External IPv4 interfaces: not internal, not link-local (`169.254.`), one entry per address. `nets` defaults to `os.networkInterfaces()`. |
| `listMdnsInterfaces(nets?)` | `listIPv4Interfaces` plus one IPv6 link-local entry per adapter (`family: "IPv6"`, with its `scopeId`); an IPv4 entry gets the `scopeId` of the same adapter's link-local address. |
| `NetworkInterfaceInfo` | `{ name: string, address: string, family?: "IPv4" \| "IPv6", scopeId?: number }` (IPv4 when `family` is absent) |
| `MdnsSocket`, `MdnsSocketHandlers`, `OpenMdnsSocket` | The socket abstraction: `send(packet)` and `close()`; handlers `message(packet, from)` and `error(error)`. |
| `openUdpMdnsSocket(iface, handlers, options?)` | The default `OpenMdnsSocket`: multicast on port 5353 if it can bind, else a unicast socket on an ephemeral port; an IPv6 interface uses `ff02::fb` on its scope. |
| `MDNS_GROUP`, `MDNS_GROUP_V6`, `MDNS_PORT` | `"224.0.0.251"`, `"ff02::fb"` and `5353`. |
| `CastDeviceCache` | A pure, time-explicit cache that joins records into devices. `new CastDeviceCache(serviceName?)`, `ingest(records, now, source?): CacheChange`, `expire(now): CacheChange`, `dropSource(source): CacheChange` (forget what one interface heard), `devices(): CastDevice[]`. |
| `CacheChange` | `{ added, updated, removed }`, each a `CastDevice[]`. |
| `CastDevice` | See [`CastDevice`](#castdevice). |
| `decodeDnsPacket(buf)` | Parses a DNS packet into a `DnsPacket`. Throws `DnsFormatError` if it is malformed or truncated. |
| `encodeMdnsQuery(name, type, opts?)` | A one-question mDNS query as a `Buffer`. `opts.unicastResponse` sets the unicast-response bit. Throws `RangeError` for an empty or oversized label or name. |
| `formatIPv6(bytes)` | 16 bytes to an RFC 5952 string. |
| `RecordType` | `{ A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 }` |
| `DnsFormatError`, `DnsQuestion`, `DnsRecord`, `DnsPacket` | DNS types. `DnsRecord` is a union discriminated by `type` (`A`, `AAAA`, `PTR`, `TXT`, `SRV`, `UNKNOWN`). |
| `isPubliclyRoutable(address)`, `isLoopback(address)` | Ports of `net::IPAddress::IsPubliclyRoutable` and `IsLoopback` (`net/base/ip_address.cc`), byte for byte: an IPv4-mapped IPv6 address is judged by its IPv4 part, a string that is not an IP address counts as publicly routable. |
| `isCastAddressAllowed(address, allowAllIps?)` | Whether a Cast channel may be opened to `address`: neither publicly routable nor loopback, unless `allowAllIps` (Chrome's `CastMediaSinkServiceImpl::OpenChannel` rule). |
| `parseIpBytes(address)` | An IPv4 or IPv6 literal (zone ignored, brackets allowed) as its 4 or 16 bytes, or `null`. |

### Protocol

The Cast v2 wire format.

| Export | Description |
|---|---|
| `CastMessage` | `{ protocolVersion: 0, sourceId, destinationId, namespace, payloadType, payloadUtf8?, payloadBinary? }` |
| `PayloadType` | `{ STRING: 0, BINARY: 1 }`, also a type. |
| `encodeCastMessage(msg)` | `CastMessage` to protobuf bytes (`Buffer`). Throws `TypeError` for an inconsistent payload. |
| `decodeCastMessage(bytes)` | Protobuf bytes to a `CastMessage`. Throws `CastProtocolError` if invalid. Unknown fields are skipped. |
| `frame(body)` | Adds the 4-byte big-endian length prefix. Throws `RangeError` over `MAX_MESSAGE_SIZE`. |
| `FrameDecoder` | `push(chunk): Buffer[]` returns every complete body from a chunked stream; `bufferedBytes` is the incomplete amount. Throws `CastProtocolError` on an oversized length and is unusable afterwards. |
| `MAX_MESSAGE_SIZE` | `65536` bytes. |
| `DeviceAuthMessage`, `AuthResponse` | A decoded device-authentication message (`response` or `error`) and its response parts (`signature`, `clientAuthCertificate`, `intermediateCertificates`, `signatureAlgorithm`, `senderNonce`, `hashAlgorithm`, `crl`). |
| `encodeAuthChallenge(challenge)`, `encodeAuthResponse(response)`, `encodeAuthError(errorType)`, `decodeDeviceAuthMessage(bytes)` | Encode and decode the `deviceauth` payloads (`encodeAuthResponse` and `encodeAuthError` are for tests and fake receivers). `decodeDeviceAuthMessage` throws `CastProtocolError` if invalid. |
| `SignatureAlgorithm`, `HashAlgorithm`, `AuthErrorType` | The enums of `cast_channel.proto` (`HashAlgorithm`: `SHA1` 0, `SHA256` 1), also types. |
| `CastProtocolError` | A message or frame broke the protocol. |
