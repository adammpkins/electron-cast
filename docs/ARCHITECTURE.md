# Architecture

How electron-cast is laid out across processes and frames, how a cast starts, how a session is rejoined, how a device is
authenticated, and what the words mean. The diagrams render on GitHub.

For module-by-module behaviour and where it differs from Chromium, read [DESIGN.md](DESIGN.md). For which Chromium file each
module mirrors, read the [Chromium map](CHROMIUM-MAP.md).

## Process and frame layout

```mermaid
flowchart LR
  subgraph renderer["Renderer process (one per window, view or iframe site)"]
    subgraph page["Page, main world"]
      sdk["Google's Cast SDK<br/>cast_sender.js, cast.framework"]
      standin["Presentation API stand-in<br/>presentation-standin.ts"]
      sdk --> standin
    end
    subgraph preload["Preload, isolated world"]
      bridge["bridge object<br/>preload.ts"]
    end
    standin -- "window-level bridge<br/>(contextBridge)" --> bridge
  end

  subgraph main["Main process"]
    manager["CastManager<br/>main.ts: senders, IPC, frames"]
    handler["CastPresentationHandler<br/>presentation-handler.ts<br/>presentation-envelope.ts"]
    service["CastSessionService<br/>session-service.ts"]
    discovery["CastDiscovery<br/>mDNS"]
    client["CastClient per device<br/>Cast v2 over TLS"]
    picker["your selectDevice<br/>and allowOrigin"]
    manager --> handler --> service
    service --> discovery
    service --> client
    service --> picker
  end

  bridge -- "IPC electron-cast:presentation<br/>:presentation:send, :presentation:event" --> manager
  discovery -- "mDNS multicast, UDP 5353" --> lan(("local network"))
  client -- "TLS, TCP 8009 (or the advertised port)" --> device["Cast device<br/>receiver app"]
  lan --- device
```

Reading it:

- **The page** runs Google's SDK unmodified. It finds `navigator.presentation`, and the stand-in answers. The stand-in knows
  nothing about Cast: it checks the user gesture as Blink does, allows one `start()` at a time, and moves strings over the
  bridge.
- **The preload** exposes the bridge and installs the stand-in with `contextBridge.executeInMainWorld`. In `start` calls it reads
  `navigator.userActivation.isActive` itself and sends that, replacing anything the page passed.
- **The main process** owns every secret and every socket: it decides which pages may cast (`allowOrigin`), which device was
  picked (`selectDevice`), and does discovery and the device channels, one kept open to each device as in Chrome. The page
  never sees a device's IP address or port.
- **The IPC channels** (`electron-cast:presentation` invoke, `:presentation:send` and `:presentation:event`; for
  `mode: "chromecast"` `electron-cast:call` and `:event`) are the only way across. What is validated on each is in
  [SECURITY.md](../SECURITY.md#what-crosses-the-ipc-boundary).
- **Nothing Electron is imported below `src/electron/`.** The manager and preload take Electron's objects as parameters, so the
  protocol, discovery, client and session service run and test in plain Node.

### Frames and senders

```mermaid
flowchart TB
  subgraph wc["One webContents (id 7)"]
    mf["Main frame, origin A<br/>sender 7"]
    f1["iframe, origin B<br/>sender 2^30"]
    f2["iframe, origin A<br/>sender 2^30 + 1"]
    mf --- f1
    mf --- f2
  end
  mf & f1 & f2 -- "each frame's preload calls IPC<br/>(iframes need nodeIntegrationInSubFrames)" --> mgr["CastManager"]
  mgr -- "senderFrame.origin is the frame's own,<br/>browser-provided" --> allow{"allowOrigin(origin)"}
  mgr -- "frame.send to one frame only" --> mf
```

A **sender** is a frame. A main frame's sender id is its `webContents.id`; a subframe gets a synthetic id from 2^30 up, keyed by
`frameTreeNodeId` so it survives navigations. Watches, connections and sessions belong to a sender and events go only to it.
This mirrors Chromium's per-`RenderFrameHost` `PresentationServiceImpl`.

## What happens when a page starts a cast

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant SDK as Google's SDK (page)
  participant SI as Stand-in (page)
  participant PL as Bridge (preload)
  participant M as CastManager (main)
  participant H as PresentationHandler
  participant S as SessionService
  participant UI as your selectDevice
  participant C as CastClient
  participant D as Cast device

  Note over S,D: Before any page asks: a channel to each device found
  S->>C: connect() (after a random delay of up to 5 s)
  C->>D: TLS handshake, device authentication challenge
  D-->>C: auth reply, checked (see below)
  C->>D: CONNECT to receiver-0, GET_STATUS (the device is listed now)
  User->>SDK: clicks the cast button
  SDK->>SI: PresentationRequest.start()
  SI->>SI: user activation? (else InvalidAccessError)
  SI->>PL: call("start", {connectionId, urls})
  PL->>PL: add hasGesture from navigator.userActivation
  PL->>M: invoke electron-cast:presentation "start"
  M->>M: origin from senderFrame, hasGesture must be true (else AbortError)
  M->>H: startPresentation(urls, origin, senderId)
  H->>H: parse the Cast presentation URL, take the app id
  H->>S: handle("requestSession", {appId, appAvailability})
  S->>S: allowOrigin(origin)
  S->>C: GET_APP_AVAILABILITY on each open channel, unless an answer stands
  S->>UI: selectDevice(devices that have the app, request, picker)
  UI-->>S: a CastDevice
  S->>C: launch(appId) on that device's open channel
  C->>D: LAUNCH
  D-->>C: RECEIVER_STATUS with the app and its transportId
  S->>C: connectTransport(transportId), getStatus()
  S-->>H: session snapshot
  H-->>M: connection handle
  M-->>PL: reply ok, then events on presentation:event
  H->>PL: envelope receiver_action, then new_session
  PL->>SI: events
  SI->>SDK: connection messages
  SDK->>User: session started
```

Notes on the steps:

- Steps 1 to 4 happen once per device, not per cast (Chrome's `CastMediaSinkServiceImpl`), and again when a channel fails.
  A device that fails device authentication (step 3) rejects `connect()` with `CastAuthError` and is never listed, so it
  never reaches the picker.
- Step 7: the page-side refusal is a compatibility behaviour; the real check is the main process's (steps 9 and 11, and
  [SECURITY.md](../SECURITY.md#user-gesture)).
- Step 15: if `allowOrigin` returns false the request fails as "no receivers".
- Step 16: a device that does not have the app is not offered; if none has it, `start()` rejects with `NotFoundError`. The
  same answers serve the page's `getAvailability()` ([API](API.md#app-availability)).
- Steps 17 and 18: the time your picker is open does not count against the page's launch timeout.
- The envelope in the last steps is the JSON format Chrome's Media Router speaks to the SDK (see the glossary).
- App messages, media requests, volume and stop flow the other way through the same connection: the SDK sends an `app_message`
  or `v2_message` envelope, the handler maps it (for example to a `LOAD` on the media namespace to the app's transport) and the
  receiver's replies come back as envelopes.

## Reconnect and rejoin

`PresentationRequest.reconnect(id)` takes one of two ids, and the SDK sends both.

```mermaid
sequenceDiagram
  autonumber
  participant SDK as Google's SDK (page)
  participant H as PresentationHandler
  participant S as SessionService
  participant C as CastClient (each device's open channel)
  participant D as Cast devices

  Note over SDK,D: Reload: auto-join
  SDK->>H: reconnect("auto-join")
  H->>S: handle("initialize", {appId, autoJoinPolicy})
  S->>S: a session of this app and origin this run holds?<br/>origin_scoped: any sender of the origin<br/>tab_and_origin_scoped: only a sender that held or parked it
  S-->>H: joined sessions (parked ones are rejoined)
  H-->>SDK: new_session

  Note over SDK,D: App restart: join by id
  SDK->>H: reconnect("cast-session_<id>")
  H->>S: handle("joinRunningSession", {sessionId, appId})
  alt this run already holds the session
    S-->>H: join it, no origin check
  else not held
    D-->>C: RECEIVER_STATUS, whenever it changes (followed all along)
    S->>S: the session tracker: which device runs that sessionId and app
    S->>C: connectTransport(transportId) on that device's channel
    S-->>H: a session owned by the caller's origin
  end
  H-->>SDK: new_session, or NotFoundError if no device runs it
```

- **Auto-join** only finds sessions this run holds, as Chrome's `FindActivityForAutoJoin` skips activities that are not local.
- **A page reload** parks its sessions (`senderNavigated`): they stay open on the device, get no events, and the next page of
  the same frame rejoins them. `senderGone` (a destroyed webContents or removed frame) ends the sender's share for good.
- **Join by id** is answered from the session tracker, which follows every device's receiver status over its open channel,
  as Chrome's `CastSessionTracker` does; nothing is looked up when asked. The app supplies the id
  ([guide](guides/restart-rejoin.md)).

## Device authentication

```mermaid
sequenceDiagram
  autonumber
  participant C as CastClient
  participant D as Cast device

  C->>D: TCP and TLS handshake (rejectUnauthorized: false)
  C->>C: no_tls_certificate if the device presented none
  C->>D: AuthChallenge: 16-byte nonce, SHA-256<br/>(binary CastMessage, sender-0 to receiver-0, deviceauth namespace)
  D-->>C: AuthResponse: signature, device certificate, intermediates, optional CRL
  C->>C: TLS certificate valid now and for at most 4 days
  C->>C: chain from the device certificate to the Cast Root CA or Eureka Root CA
  C->>C: device certificate: digitalSignature, common name, usable key
  C->>C: revocation: the device's CRL (verified against the Cast CRL Root CA), else the fallback CRL
  C->>C: signature over sender_nonce + DER of the TLS certificate verifies
  alt every check passes
    C->>D: CONNECT to receiver-0
    Note over C: connect() resolves, deviceAuth holds the result
  else a check fails
    Note over C: connect() rejects with CastAuthError(reason), socket closed
  end
```

Each failure maps to a `CastAuthError.reason` ([list](API.md#errors)). Verification runs when the channel opens, which the
sink service does for every device discovery finds, before the device is listed. Details, and the one deliberate difference from Chromium (a stale built-in CRL skips revocation rather than refusing):
[DESIGN.md](DESIGN.md#device-authentication-srcclientauth).

## Glossary

| Term | Meaning |
|---|---|
| **Sender** | In Cast, an app that casts to a device. In electron-cast, a **frame** with the preload: its own watches, connections and sessions. A page can also be said to be a sender in Google's docs; here the frame is the unit |
| **Receiver** | The Cast device, and the app running on it. "Receiver app" is the app (an app id such as `CC1AD845`); "the platform receiver" is the device's own endpoint, `receiver-0` |
| **Sink** | Chrome's Media Router word for a device you can cast to (`MediaSink`). Here a discovered `CastDevice`, seen through `registerMediaSinksObserver` |
| **Route** | Chrome's word for a running cast on a sink (`MediaRoute`). Here a Cast session; its id is the Cast session id. A route is **parked** when its pages navigated away and none is attached |
| **Presentation** | The W3C Presentation API: a `PresentationRequest` for a URL, whose `start()` or `reconnect()` gives a `PresentationConnection` (a message channel between page and receiver). Google's SDK uses a Cast URL such as `https://google.com/cast#__castAppId__=<appId>/...` |
| **Session** | The receiver app running on a device, identified by a `sessionId`. It outlives the page and the TLS connection |
| **Transport** | The receiver app's `transportId`: the destination id for messages to that app. A **virtual connection** (CONNECT and CLOSE on the connection namespace) to it must be open before messaging the app |
| **Namespace** | A message channel inside a Cast connection (`urn:x-cast:com.google.cast.media`, a custom app namespace, the platform's `receiver`, `heartbeat`, `connection` and `deviceauth`) |
| **Envelope** | The private JSON message format (`{type, message, sequenceNumber, timeoutMillis, clientId}`) that Google's SDK and Chrome's Media Router exchange over the `PresentationConnection`. electron-cast translates between it and the session service. Not a Cast v2 message; Cast v2 is the protobuf `CastMessage` to the device |
| **Auto-join** | The SDK rejoining a session on reload by `reconnect("auto-join")`, per its `autoJoinPolicy` |
| **Device authentication** | The `deviceauth` challenge that proves a device is Google-certified |
| **Picker** | Your `selectDevice` function: the UI that resolves the device a cast goes to |

## Layers and files

| Layer | Where | Depends on |
|---|---|---|
| Protocol | `src/protocol/`: `CastMessage`, framing, `DeviceAuthMessage` | Node only |
| Client | `src/client/`: `CastClient`, device authentication in `src/client/auth/` | protocol, `tls`, `crypto` |
| Discovery | `src/discovery/`: `CastDiscovery`, device cache, DNS codec | `dgram`, `os` |
| Session service | `src/electron/session-service.ts`, `manager-api.ts` | client, discovery types |
| Presentation | `src/electron/presentation-handler.ts`, `presentation-envelope.ts` | session service |
| Manager | `src/electron/main.ts` (`createCastManager`) | all of the above, Electron objects passed in |
| Preload and page | `src/electron/preload.ts`, `src/polyfill/` | page side only; no Node |
| Legacy polyfill | `src/polyfill/install.ts` (`mode: "chromecast"`) | frozen |
