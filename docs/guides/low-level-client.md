# Using CastClient directly

Every layer of electron-cast is exported from the package root and runs in plain Node, so you can find devices, open the Cast
v2 channel and send messages with no Electron and no page.

Use this for tools, scripts, a headless controller, or to see what the library does under the Electron layer. The layers, from
the bottom: the protocol (`encodeCastMessage`, `frame`, `FrameDecoder`), discovery (`CastDiscovery`), the client (`CastClient`)
and the session service (`CastSessionService`). Import from the root, and **not** from a sandboxed preload (the root needs
Node's `tls` and `dgram`).

## Find a device

`CastDiscovery` sends mDNS queries for `_googlecast._tcp.local` on every external IPv4 interface and one IPv6 link-local
address per adapter, and turns the answers into `CastDevice`s. It only asks: it never advertises or answers.

`deviceUp`, `deviceChanged` and `deviceDown` report devices as they come and go; `socketError` reports an interface whose
socket failed while the others carry on. The repository's [examples/discover.ts](../../examples/discover.ts) prints all of
them (`node examples/discover.ts 15`, on a Node that runs TypeScript, such as 22.18 or 24). To list what discovery sees from
an installed package, see [Troubleshooting](../TROUBLESHOOTING.md#list-what-discovery-sees).

## Connect and ask a device what it is running

`CastClient` is a single-use client: one TLS connection to one receiver. `connect()` opens TLS, runs the device
authentication challenge and sends CONNECT to the platform receiver. After `close()` or a failure, make a new one.

```ts
import { once } from "node:events";
import { CastAuthError, CastClient, CastDiscovery, type CastDevice } from "electron-cast";

const discovery = new CastDiscovery();
try {
  await discovery.start();
  // A device already known, or the first one to answer within ten seconds.
  const [device] = discovery.devices().length > 0
    ? [discovery.devices()[0] as CastDevice]
    : ((await once(discovery, "deviceUp", { signal: AbortSignal.timeout(10_000) })) as [CastDevice]);
  const client = new CastClient({ host: device.host, port: device.port });
  client.on("close", (error) => console.log("closed", error?.message ?? "on purpose"));
  try {
    await client.connect();
    console.log(device.name, client.deviceAuth); // { policy, hashAlgorithm, nonceEchoed, usedFallbackCrl, revocationChecked }
    const status = await client.getStatus();
    console.log(status.applications.map((a) => a.displayName), status.volume);
  } catch (error) {
    if (error instanceof CastAuthError) console.error("not a Google-certified device:", error.reason);
    else throw error;
  } finally {
    client.close();
  }
} finally {
  discovery.stop();
}
```

A connection stays up by heartbeat: the client pings every 5 s and fails the connection after 10 s with no traffic
(`heartbeatIntervalMs`, `heartbeatTimeoutMs`), emitting `close` with an error. Pass `verifyDevice: false` for a receiver that is
not Google-certified ([why that is a security decision](device-authentication.md)).

## Launch an app and message it

An app runs under its own **transport id**. Open a virtual connection to it, then message it on its namespaces. A
`CastClient` method that expects a reply (`request`, `getStatus`, `launch`, `stop`, `setVolume`) resolves with the matching
reply and rejects with `CastRequestError` for an error reply or `CastTimeoutError`:

```ts
import { CastClient, type CastDevice } from "electron-cast";

const MEDIA = "urn:x-cast:com.google.cast.media";

export async function playOnDefaultReceiver(device: CastDevice, url: string): Promise<void> {
  const client = new CastClient({ host: device.host, port: device.port });
  await client.connect();
  try {
    const app = await client.launch("CC1AD845"); // the Default Media Receiver
    client.connectTransport(app.transportId);
    client.on("message", (message) => {
      if (message.namespace === MEDIA) console.log("media:", message.data);
    });
    await client.request(MEDIA, app.transportId, {
      type: "LOAD",
      autoplay: true,
      media: { contentId: url, contentType: "video/mp4", streamType: "BUFFERED" },
    });
  } finally {
    // Leave the app running on the device; client.stop(app.sessionId) would end it.
    client.close();
  }
}
```

`client.send(namespace, destinationId, payload)` sends without waiting (a string as is, an object as JSON, a `Uint8Array` as a
binary payload); `message` events deliver everything on any namespace except heartbeat and connection control.

## Below the client

- `encodeCastMessage`, `decodeCastMessage`, `frame` and `FrameDecoder` are the wire format: a 4-byte big-endian length, then
  a protobuf `CastMessage`, at most 65,536 bytes ([protocol notes](../DESIGN.md#protocol-layer-srcprotocol)).
- `CastDeviceCache`, `decodeDnsPacket` and `encodeMdnsQuery` are the pure mDNS pieces, usable with your own sockets
  (`CastDiscovery`'s `openSocket` option takes your own socket factory, which is how the tests run without a network).
- `CastSessionService` is the session logic behind `createCastManager`, with no Electron dependency: give it a
  `DeviceSource`, a `createClient`, a `selectDevice` and an `emit`, and call `handle(sender, method, params)`.

Every export is in the [API reference](../API.md#electron-cast-root).
