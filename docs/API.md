# API reference

This reference reflects **v0.3.1**.

electron-cast is an ES module package (`"type": "module"`, no CommonJS build) with four entry points:

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

Contents: [`electron-cast/main`](#electron-castmain) · [`electron-cast/preload`](#electron-castpreload) ·
[`electron-cast/polyfill`](#electron-castpolyfill) · [`electron-cast` (root)](#electron-cast-root):
[session service](#session-service), [`CastClient`](#castclient), [discovery](#discovery), [protocol](#protocol)

---

## `electron-cast/main`

### `createCastManager(options)`

```ts
function createCastManager(options: CastManagerOptions): CastManager
```

Registers the IPC handlers, creates the session service and discovery, and returns a manager. Nothing touches the
network until `start()`. Throws `TypeError` if `presentation` is not `false` and `ipcMain` has no `on` or
`removeListener`.

It registers `ipcMain.handle` on `<channel>:call` and `<channel>:presentation`, and `ipcMain.on` on
`<channel>:presentation:send`. It sends `<channel>:event` and `<channel>:presentation:event` to the webContents that
are using it. A webContents is tracked from its first call. When it is destroyed, or navigates, its connections end;
a navigation keeps its sessions open on the device so the next page can rejoin them.

#### `CastManagerOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `ipcMain` | `IpcMainLike` | required | Electron's `ipcMain`. |
| `selectDevice` | `(devices: CastDevice[], request: CastRequestInfo) => Promise<DeviceChoice>` | required | Called when a page asks to start a session. Show your picker and resolve a device, `null` to cancel, or `"stop"` to stop `request.session`. A rejection fails the request with `session_error`. See [`selectDevice`](#selectdevice). |
| `allowOrigin` | `(origin: string) => boolean` | none (every origin allowed) | Called on every page call with the origin of the calling frame. Return `false` to refuse. A throw refuses too. See [SECURITY.md](../SECURITY.md#alloworigin). |
| `discovery` | `DeviceSource & { start(): Promise<void>; stop(): void }` | `new CastDiscovery()` | Replaces device discovery. Mainly for tests. |
| `createClient` | `(device: CastDevice) => CastClientLike` | `new CastClient({ host: device.host, port: device.port })` | Creates the connection to a device. Use it to pass `CastClient` options such as `tls`. |
| `channel` | `string` | `"electron-cast"` | Prefix of the IPC channel names. Must match the preload's `channel`. |
| `presentation` | `boolean` | `true` | Serve the preload's default (`"presentation"`) mode. With `false`, only `mode: "chromecast"` pages are served, and `ipcMain.on` and `removeListener` are not needed. |

#### `CastManager`

| Member | Description |
|---|---|
| `start(): Promise<void>` | Starts discovery: opens an mDNS socket on every external IPv4 interface and queries. Safe to call more than once. Rejects only if the manager was disposed. |
| `devices(): CastDevice[]` | The devices known right now. Fresh copies, sorted. |
| `dispose(): Promise<void>` | Removes the IPC handlers, stops discovery, closes every device connection and ends all sessions. Idempotent. A disposed manager cannot be restarted; create a new one. |

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

#### Errors the page sees

In `mode: "chromecast"`, `chrome.cast.ErrorCode` values: `cancel`, `timeout`, `receiver_unavailable`,
`session_error`, `channel_error`, `invalid_parameter`, `extension_missing` (origin not allowed, or no sender frame).
In default mode they are mapped onto `DOMException` names: a cancelled request is `AbortError`, no receiver is
`NotFoundError`, a rejected parameter is `InvalidAccessError`, an unusable presentation URL is `NotSupportedError`,
and anything else is `OperationError`.

#### Structural types

```ts
interface FrameLike { url: string; origin?: string }
interface WebContentsLike {
  readonly id: number;
  send(channel: string, ...args: any[]): void;
  isDestroyed(): boolean;
  once(event: "destroyed", listener: () => void): unknown;
  on(event: "did-navigate", listener: (...args: any[]) => void): unknown;
}
interface IpcMainInvokeEventLike { sender: WebContentsLike; senderFrame: FrameLike | null }
interface IpcMainEventLike { sender: WebContentsLike }
interface IpcMainLike {
  handle(channel: string, listener: (event: IpcMainInvokeEventLike, ...args: any[]) => unknown): void;
  removeHandler(channel: string): void;
  on?(channel: string, listener: (event: IpcMainEventLike, ...args: any[]) => void): unknown;
  removeListener?(channel: string, listener: (event: IpcMainEventLike, ...args: any[]) => void): unknown;
}
```

The main entry also re-exports the types `CastRequestInfo`, `DeviceChoice` and `CastDevice`.

#### `CastDevice`

| Field | Type | Description |
|---|---|---|
| `id` | `string` | The device's stable id (mDNS TXT `id`). Devices are de-duplicated by it. |
| `name` | `string` | Friendly name (TXT `fn`), or the first label of the instance name. |
| `model` | `string` | Model name (TXT `md`), or `""`. |
| `host` | `string` | Address to connect to: the first IPv4 address, else the first IPv6. |
| `addresses` | `string[]` | All addresses, IPv4 first. |
| `port` | `number` | The Cast port, usually 8009. |
| `capabilities` | `number` | Capability bit mask (TXT `ca`): 1 `video_out`, 2 `video_in`, 4 `audio_out`, 8 `audio_in`, 32 `multizone_group`. |
| `isGroup` | `boolean` | True when the `multizone_group` bit is set. |
| `statusText` | `string` | TXT `rs`, or `""`. |
| `instanceName` | `string` | The full mDNS instance name. |
| `txt` | `Record<string, string>` | All TXT records. Treat the values as untrusted. |

---

## `electron-cast/preload`

### `installCastBridge(options)`

```ts
function installCastBridge(options: CastBridgeOptions): void
```

Call it once from a preload script. It exposes a bridge object to the page's main world with
`contextBridge.exposeInMainWorld`, then runs the page-side code in the main world with
`contextBridge.executeInMainWorld` (Electron 35 or later), before the page's own scripts run.

- `mode: "presentation"` (default): installs a stand-in for the Presentation API (`PresentationRequest`,
  `PresentationConnection`, `PresentationAvailability`, `navigator.presentation`). Google's own Cast SDK then loads
  and runs unmodified.
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
| `joinSession` | `{ sessionId: string }` (same origin only) | `SessionSnapshot` |
| `sendMessage` | `{ sessionId: string, namespace: string, message: string }` | `undefined` |
| `stopSession` | `{ sessionId: string }` | `undefined` |
| `leaveSession` | `{ sessionId: string }` | `undefined` |
| `setReceiverVolume` | `{ sessionId: string, level: number }` (0 to 1) | `undefined` |
| `setReceiverMuted` | `{ sessionId: string, muted: boolean }` | `undefined` |

Error codes: `invalid_parameter`, `extension_missing` (origin not allowed), `receiver_unavailable`, `cancel`, `timeout`,
`session_error`, `channel_error`.

#### `CastSessionServiceOptions`

| Option | Type | Description |
|---|---|---|
| `devices` | `DeviceSource` | Source of devices and change events. |
| `createClient` | `(device: CastDevice) => CastClientLike` | Creates a connection for a device. |
| `selectDevice` | `(devices, request) => Promise<DeviceChoice>` | As in [`selectDevice`](#selectdevice). |
| `allowOrigin` | `(origin: string) => boolean` (optional) | As for the manager. |
| `emit` | `(senderId: number, event: BridgeEvent) => void` | Receives every event for a sender. |

#### Other exports

| Export | Description |
|---|---|
| `capabilityNames(bits: number): string[]` | Capability bit mask to names, in bit order. |
| `DeviceSource` | `devices(): CastDevice[]` and `on`/`off` for `"deviceUp"`, `"deviceDown"`, `"deviceChanged"` (listener gets a `CastDevice`). `CastDiscovery` fits it. |
| `CastClientLike` | The part of `CastClient` the service uses: `connected`, `connect`, `close`, `send`, `launch`, `stop`, `setVolume`, `getStatus`, `connectTransport`, `closeTransport`, and `on` for `message`, `receiverStatus`, `transportClosed`, `close`. |
| `ClientMessage` | `{ namespace, sourceId, destinationId, data: string \| Buffer }`. |
| `SenderInfo` | `{ id: number, origin: string }`: a page (webContents id and frame origin). |
| `CastRequestInfo`, `DeviceChoice` | As above. |

### `CastClient`

```ts
class CastClient extends EventEmitter<CastClientEvents> {
  constructor(options: CastClientOptions)
  readonly senderId: string
  get connected(): boolean
  connect(): Promise<void>
  close(): void
  send(namespace: string, destinationId: string, payload: string | Uint8Array | object): void
  request<T = Record<string, unknown>>(namespace: string, destinationId: string,
    payload: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<T>
  getStatus(): Promise<ReceiverStatus>
  launch(appId: string): Promise<ReceiverApplication>
  stop(sessionId: string): Promise<ReceiverStatus>
  setVolume(volume: { level: number } | { muted: boolean }): Promise<ReceiverStatus>
  getAppAvailability(appIds: string[]): Promise<Record<string, boolean>>
  connectTransport(transportId: string): void
  closeTransport(transportId: string): void
}
```

A single-use Cast v2 client: one TLS connection to one receiver. After `close()` or a failure it cannot be
reconnected; make a new one. The TLS socket is opened with `rejectUnauthorized: false` (see
[SECURITY.md](../SECURITY.md#tls-and-device-authentication)).

#### `CastClientOptions`

| Option | Type | Default | Description |
|---|---|---|---|
| `host` | `string` | required | Receiver address. |
| `port` | `number` | `8009` | Receiver port. |
| `senderId` | `string` | `"sender-"` plus 8 random hex digits | The `sourceId` of the client's messages. |
| `connectTimeoutMs` | `number` | `10000` | Limit for the TLS handshake. |
| `requestTimeoutMs` | `number` | `10000` | Default limit for `request` and the calls built on it. |
| `launchTimeoutMs` | `number` | `30000` | Limit for `launch`. |
| `heartbeatIntervalMs` | `number` | `5000` | How often a PING is sent. |
| `heartbeatTimeoutMs` | `number` | `10000` | The connection fails after this long with no traffic. |
| `tls` | `Omit<tls.ConnectionOptions, "host" \| "port">` | none | Extra `tls.connect` options, applied after the defaults (so they can override `rejectUnauthorized`). |
| `connectPayload` | `Record<string, unknown>` | none | Extra fields merged into every CONNECT message. |

#### Methods

| Method | Description |
|---|---|
| `connect()` | Opens the TLS connection and sends CONNECT to the platform receiver (`receiver-0`). Rejects with `CastConnectionError` or `CastTimeoutError`. Only valid once, from the idle state. |
| `close()` | Sends CLOSE for every open transport and the receiver, ends the socket, rejects pending work with `CastConnectionError`, and emits `close`. Idempotent. |
| `send(namespace, destinationId, payload)` | Sends a message. A string is sent as is, an object as JSON, a `Uint8Array` as a binary payload. Throws `CastConnectionError` when not connected. |
| `request(namespace, destinationId, payload, options?)` | Adds a `requestId`, sends, and resolves with the matching reply. Rejects with `CastRequestError` for an error reply, `CastTimeoutError` on timeout, `CastConnectionError` if the connection ends. |
| `getStatus()` | The receiver's current status. |
| `launch(appId)` | Launches an app and resolves when it appears in a `RECEIVER_STATUS`. Rejects with `CastRequestError` (for `LAUNCH_ERROR` or `INVALID_REQUEST`) or `CastTimeoutError`. |
| `stop(sessionId)` | Stops a session. Resolves with the new status. |
| `setVolume(volume)` | Sets the device volume level (0 to 1) or muted flag. Resolves with the new status. |
| `getAppAvailability(appIds)` | Which of the apps the receiver can run. |
| `connectTransport(transportId)` | Opens a virtual connection to an app's transport. Idempotent. Needed before messaging the app. Ignored when not connected. |
| `closeTransport(transportId)` | Closes it. |

#### Events

| Event | Payload | When |
|---|---|---|
| `message` | `{ namespace, sourceId, destinationId, data: string \| Buffer }` | A message arrives on any namespace except heartbeat and connection control. |
| `receiverStatus` | `ReceiverStatus` | A `RECEIVER_STATUS` arrives. |
| `transportClosed` | `transportId: string` | The receiver closed a transport. |
| `close` | `error?: CastConnectionError` | The client closed. The error is absent after a deliberate `close()`. |

#### Constants and types

| Export | Description |
|---|---|
| `NS` | Namespace urns: `CONNECTION` (`urn:x-cast:com.google.cast.tp.connection`), `HEARTBEAT` (`...tp.heartbeat`), `RECEIVER` (`urn:x-cast:com.google.cast.receiver`) and `DEVICE_AUTH` (`...tp.deviceauth`). `DEVICE_AUTH` is defined but not used in v0.3.1. |
| `PLATFORM_RECEIVER_ID` | `"receiver-0"`, the destination id of the device itself. |
| `ReceiverApplication` | `{ appId, displayName, sessionId, transportId, namespaces: { name }[], statusText?, isIdleScreen?, iconUrl?, ... }` |
| `ReceiverVolume` | `{ level?, muted?, controlType?, stepInterval? }` |
| `ReceiverStatus` | `{ applications: ReceiverApplication[], volume: ReceiverVolume, ... }` |
| `CastClientOptions`, `CastClientEvents` | The option and event types above. |

#### Errors

All are `Error` subclasses with `name` set to the class name.

| Class | Thrown or rejected when | Extra fields |
|---|---|---|
| `CastConnectionError` | The connection could not be made, was closed, failed, or timed out on heartbeat; `send` while disconnected. | `cause` (the underlying error, if any) |
| `CastTimeoutError` | The TLS handshake, a request, or a launch did not finish in time. | none |
| `CastRequestError` | The receiver replied with an error: type `INVALID_REQUEST`, `LOAD_FAILED`, `LOAD_CANCELLED`, `INVALID_PLAYER_STATE`, or ending in `_ERROR`. | `type: string`, `reason: string \| undefined`, `response: Record<string, unknown>` |

### Discovery

#### `CastDiscovery`

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

Finds Cast devices by sending mDNS PTR queries on every external IPv4 interface and joining the answers into
`CastDevice`s. Interfaces that appear or disappear are picked up (checked every `interfaceCheckMs`).

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
| `interfaces` | `() => NetworkInterfaceInfo[]` | `listIPv4Interfaces()` | Which interfaces to use. |
| `openSocket` | `OpenMdnsSocket` | `openUdpMdnsSocket` | How to open a socket (for tests). |
| `followUpQueriesMs` | `number[]` | `[1000, 3000]` | Extra queries, in ms after `start()`. |
| `refreshMs` | `number` | `60000` | Query interval after the follow-ups. |
| `expireCheckMs` | `number` | `1000` | How often expired records are dropped (and `deviceDown` emitted). |
| `interfaceCheckMs` | `number` | `10000` | How often the interface list is re-read. |

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
| `NetworkInterfaceInfo` | `{ name: string, address: string }` |
| `MdnsSocket`, `MdnsSocketHandlers`, `OpenMdnsSocket` | The socket abstraction: `send(packet)` and `close()`; handlers `message(packet, from)` and `error(error)`. |
| `openUdpMdnsSocket(iface, handlers, options?)` | The default `OpenMdnsSocket`: multicast on port 5353 if it can bind, else a unicast socket on an ephemeral port. |
| `MDNS_GROUP`, `MDNS_PORT` | `"224.0.0.251"` and `5353`. |
| `CastDeviceCache` | A pure, time-explicit cache that joins records into devices. `new CastDeviceCache(serviceName?)`, `ingest(records, now): CacheChange`, `expire(now): CacheChange`, `devices(): CastDevice[]`. |
| `CacheChange` | `{ added, updated, removed }`, each a `CastDevice[]`. |
| `CastDevice` | See [`CastDevice`](#castdevice). |
| `decodeDnsPacket(buf)` | Parses a DNS packet into a `DnsPacket`. Throws `DnsFormatError` if it is malformed or truncated. |
| `encodeMdnsQuery(name, type, opts?)` | A one-question mDNS query as a `Buffer`. `opts.unicastResponse` sets the unicast-response bit. Throws `RangeError` for an empty or oversized label or name. |
| `formatIPv6(bytes)` | 16 bytes to an RFC 5952 string. |
| `RecordType` | `{ A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33 }` |
| `DnsFormatError`, `DnsQuestion`, `DnsRecord`, `DnsPacket` | DNS types. `DnsRecord` is a union discriminated by `type` (`A`, `AAAA`, `PTR`, `TXT`, `SRV`, `UNKNOWN`). |

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
| `CastProtocolError` | A message or frame broke the protocol. |
