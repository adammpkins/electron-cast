# Device authentication

What electron-cast checks before it talks to a Cast device, what a failure looks like to the user and to you, and how to
cast to a receiver that is not Google-certified.

## What it is

A Cast device on your network presents a self-signed TLS certificate, so ordinary certificate validation cannot tell a
genuine device from anyone who answers mDNS. Chrome therefore runs a second check, the **device authentication
challenge** on the `urn:x-cast:com.google.cast.tp.deviceauth` namespace, and electron-cast ports it. After the TLS
handshake and before CONNECT, `CastClient.connect()`:

1. sends a challenge (a random 16-byte nonce, SHA-256);
2. checks that the TLS certificate is currently valid and lives no more than four days;
3. builds the device's certificate chain from what it sent and validates it to Google's built-in Cast root certificates;
4. checks revocation against the CRL the device sent, or else a fallback CRL built into the package;
5. verifies the device's signature over the nonce and **this connection's TLS certificate**, which ties the proof to the
   connection so it cannot be replayed on another.

There are no dependencies and no network access: the root certificates and the fallback CRL ship in the package. The
steps, and where electron-cast differs from Chromium, are in [DESIGN.md](../DESIGN.md#device-authentication-srcclientauth). The
Chromium sources it ports are in the [Chromium map](../CHROMIUM-MAP.md#cast-v2-channel-and-device-authentication).

It happens **when the channel opens**, which the manager does for every device discovery finds, before listing it.

**Tested:** it passed on 8 real devices from Windows (a Chromecast, a Chromecast Ultra, a Google Home Mini, a Nest Hub, a
Nest Hub Max and two Cast groups), and again on all 8 from Linux on 2026-11-25. The Google Home Mini passed with the
`audio_only` policy.

## The policy: on by default

| Where | Option | Default |
|---|---|---|
| `createCastManager` | `verifyDevices` | `true` |
| `CastClient` | `verifyDevice` | `true` |

With it on, a device that fails is never used. With it off, **nothing** is checked: the connection is encrypted but the
device is not authenticated, so anyone on the local network who can answer mDNS, or sit between you and the device, can
pose as a Cast device. If the user picks it, that party receives whatever the page sends (media URLs, app messages and
tokens). It does not get cookies or anything else from the page ([SECURITY.md](../../SECURITY.md#tls-and-device-authentication)).

## What failure looks like

- **To the user.** The device is **never listed**, as in Chrome: a device is a sink only once its channel has passed
  authentication, so it does not reach your picker. The attempt is retried with Chrome's backoff (15 s, 3 attempts), then
  given up.
- **To the page.** The device is not there: availability does not count it and `start()` does not offer it. The page
  learns nothing about why.
- **To you.** `CastClient.connect()` rejects with `CastAuthError`, which has a `reason` (`untrusted_chain`, `revoked`,
  `bad_signature`, `timeout`, and so on; [the full list](../API.md#errors)) and the device's `host`. The manager treats it as
  an unreachable device, so to log it, wrap the client you hand the manager. `createClient` gets the attempt's timeouts as
  its second argument; pass them on:

```ts
import { ipcMain } from "electron";
import { CastAuthError, CastClient, type CastDevice } from "electron-cast";
import { createCastManager, type ChannelParams } from "electron-cast/main";

function createClient(device: CastDevice, params: ChannelParams): CastClient {
  const client = new CastClient({
    host: device.host,
    port: device.port,
    connectTimeoutMs: params.connectTimeoutMs,
    heartbeatTimeoutMs: params.livenessTimeoutMs,
  });
  const connect = client.connect.bind(client);
  client.connect = async () => {
    try {
      await connect();
      console.log(`cast: ${device.name} verified`, client.deviceAuth);
    } catch (error) {
      if (error instanceof CastAuthError) console.warn(`cast: ${device.name} refused (${error.reason})`, error.message);
      throw error;
    }
  };
  return client;
}

export const cast = createCastManager({
  ipcMain,
  selectDevice: async () => null, // your picker
  createClient, // verifyDevices is ignored when you give createClient: pass verifyDevice to your own CastClient
});
```

`client.deviceAuth` is a `DeviceAuthResult`: the `policy` (`"unrestricted"` or `"audio_only"`), the digest the device
signed with, whether it echoed the nonce, and whether the fallback CRL was used and whether revocation was checked.

## Casting to a receiver that is not Google-certified

An open-source receiver, or one you built for your own hardware, carries no Google certificate. For those, turn the check
off. Prefer doing it for the receivers you mean, not for everything:

```ts
import { ipcMain } from "electron";
import { CastClient, type CastDevice } from "electron-cast";
import { createCastManager, type ChannelParams } from "electron-cast/main";

// Ids of the receivers you run yourself (CastDevice.id, the mDNS TXT `id`).
const OWN_RECEIVERS = new Set(["0123456789abcdef0123456789abcdef"]);

export const cast = createCastManager({
  ipcMain,
  selectDevice: async () => null, // your picker
  createClient: (device: CastDevice, params: ChannelParams) =>
    new CastClient({
      host: device.host,
      port: device.port,
      connectTimeoutMs: params.connectTimeoutMs,
      heartbeatTimeoutMs: params.livenessTimeoutMs,
      verifyDevice: !OWN_RECEIVERS.has(device.id),
    }),
});
```

An id from the network is not a secret and can be copied by an attacker on the same network. This narrows the exposure; it
does not remove it. If you need all of your receivers pinned, give `CastClient` a `tls` option that pins their certificates
(it is applied after the defaults, so it can override `rejectUnauthorized`), and see
[SECURITY.md](../../SECURITY.md#tls-and-device-authentication).

A private Cast deployment with its own certificate authority can keep verification on and replace the trust anchors with the
`deviceAuth` option (`roots`, `crlRoots`, `fallbackCrl`, `now`). That option exists for tests and such deployments: an app
that sets it decides what counts as genuine.

## Old releases and the stale fallback CRL

Revocation uses the CRL the device sends. A device that sends none falls back to a CRL built into the package, which
counts for **20 weeks** from the package's build time. After that, and only for a device that sent no valid CRL, the
revocation check is skipped instead of refusing the device, and `deviceAuth.revocationChecked` is `false`. Chromium would
refuse here; Chrome updates itself and an Electron app might not, so it would start refusing every such device about 20 weeks
after your electron-cast release. Everything else is still enforced. Update electron-cast regularly, and treat
`revocationChecked: false` as a prompt to do so. Why this is the one deliberate difference from Chromium:
[DESIGN.md](../DESIGN.md#device-authentication-srcclientauth).

## Diagnosing a refused device

| `reason` | Usually means |
|---|---|
| `timeout` | No reply to the challenge within `authTimeoutMs` (10 s) of the TLS handshake |
| `untrusted_chain`, `invalid_certificate` | Not a Google-certified device, or its certificate chain is outside its validity dates |
| `tls_certificate_invalid` | The TLS certificate is expired, not yet valid or valid longer than four days; a system clock that is far off does this |
| `revoked` | Google revoked the device certificate or a CA, by the device's CRL or the fallback |
| `bad_signature`, `malformed_reply`, `unsupported_algorithm`, `device_error`, `no_tls_certificate`, `crl_invalid` | See [the table](../API.md#errors) |

Commands for working through one: [Troubleshooting](../TROUBLESHOOTING.md#a-device-is-refused-or-casting-fails-after-picking-it).
