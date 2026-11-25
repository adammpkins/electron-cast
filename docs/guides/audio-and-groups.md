# Audio-only devices and speaker groups

How to tell a TV, a speaker and a speaker group apart in your picker, and what to expect when casting to each.

## Telling devices apart

Every `CastDevice` carries a capability bit mask (`capabilities`, from the mDNS TXT record `ca`) and an `isGroup` flag.

| Bit | Name | Meaning |
|---|---|---|
| 1 | `video_out` | Can show video: a Chromecast, a TV, a Nest Hub |
| 2 | `video_in` | Video input |
| 4 | `audio_out` | Can play audio |
| 8 | `audio_in` | Audio input |
| 32 | `multizone_group` | A speaker group |

`capabilityNames(bits)` turns a mask into those names. Devices set many more bits than these six (values like `464901`
and `199204` were seen on real devices), so test only the documented ones, as the library does.

- A **Chromecast or TV** has `video_out`.
- An **audio-only device**, such as a Google Home Mini, has `audio_out` and no `video_out`.
- A **group** has `multizone_group` (`isGroup` is `true`, `model` is `"Google Cast Group"`).

```ts
import { capabilityNames, type CastDevice } from "electron-cast";

type Kind = "tv" | "speaker" | "group";

function kindOf(device: CastDevice): Kind {
  if (device.isGroup) return "group";
  return device.capabilities & 1 ? "tv" : "speaker";
}

console.log(capabilityNames(5)); // ["video_out", "audio_out"]
```

The same decision is what Chrome makes for the icon (`GetCastSinkIconType`): `video_out` gives a Cast icon, else a multizone
group a group icon, else a speaker icon. A [`MediaSink`](../MAIN-API.md#sinks) from the sinks observer carries it already
as `iconType`: `"cast"`, `"cast_audio_group"` or `"cast_audio"`.

## Groups

A group is one device to the user and several to the network. Its facts, seen on real devices:

- A group answers on the **leader's address** but has **its own port** (for example 32044 and 32200 for two groups a Nest
  Hub Max leads) and its own id. electron-cast keys devices by their TXT `id`, never by address, so a group and its leader
  do not collide.
- A group's `id` is a dashed UUID; a single device's is 32 hex digits. Treat the id as an opaque string.
- Casting to a group is the same call as casting to a device: resolve the group's `CastDevice` from `selectDevice`.

Sort groups after devices in your picker, as the example in [Building your own device picker](device-picker.md) does.
mDNS answers arrive over several seconds, so a picker that [updates live](device-picker.md#a-picker-window-with-live-updates)
is worth having.

## Which devices a page can be shown

In the default mode the page asks for no capabilities, so `selectDevice` receives **every** device, audio-only and groups
included, and receiver availability is true as soon as one device is known. If your app only wants video devices, filter in
your picker (`devices.filter(d => d.capabilities & 1)`).

The page-side SDK can still ask for capabilities (`mode: "chromecast"`'s `requestSession` does); a device is offered only if
it has all of them, and `receiver_unavailable` comes back if none do.

## Device authentication and audio-only devices

Authentication reports a **policy** for the device certificate: `"unrestricted"`, or `"audio_only"` when a certificate in
the chain is audio-only. A Google Home Mini passes with `audio_only`. electron-cast reports the policy in
`CastClient.deviceAuth.policy` and **does nothing else with it**: it does not stop you launching a video app on such a
device. See [Device authentication](device-authentication.md).

## What was tested

Discovery and device authentication passed on a Chromecast, a Chromecast Ultra, a Google Home Mini (audio-only), a Nest Hub,
a Nest Hub Max and two Cast groups, from Windows, and again on all eight from Linux (Ubuntu under WSL2 with mirrored
networking). Casting end to end, from Windows, included speaker groups.
