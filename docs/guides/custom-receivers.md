# Custom receivers and the Default Media Receiver

Choosing which receiver app a cast launches, sending media to the Default Media Receiver, and talking to your own receiver
on a custom namespace.

A **receiver** is the app that runs on the Cast device (the web page the TV shows). A page asks for one by its **app id**.
electron-cast launches whatever app id the page's SDK asks for on the device the user picked; it does not choose or
restrict receivers. That is the SDK's job, and your `allowOrigin` and `selectDevice` decide whether the page may cast at all.

## The Default Media Receiver

App id `CC1AD845` (`chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID` in the SDK) is Google's generic media player. It needs
no registration, plays a media URL the device can fetch, and is what the [example app](../../examples/electron-app) uses:

```ts
declare const chrome: any;
declare const cast: any;

window.__onGCastApiAvailable = (available: boolean) => {
  if (!available) return;
  const context = cast.framework.CastContext.getInstance();
  context.setOptions({
    receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
    autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });
};

// After the user has started a session with the launcher button:
async function play(url: string, contentType: string): Promise<void> {
  const session = cast.framework.CastContext.getInstance().getCurrentSession();
  if (!session) return;
  const mediaInfo = new chrome.cast.media.MediaInfo(url, contentType);
  mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
  mediaInfo.metadata.title = "My video";
  const error = await session.loadMedia(new chrome.cast.media.LoadRequest(mediaInfo));
  if (error) console.error("Load failed", error);
}
declare global {
  interface Window { __onGCastApiAvailable?: (available: boolean) => void }
}
```

Only **starting** the session needs a user gesture (the launcher click). Loading media afterwards does not.

The device, not your app, fetches the media, so the URL has to be reachable from the device's network, and for HLS or
DASH it needs the CORS headers a receiver requires (the example uses a public HLS sample for that reason). With
`cast.framework` on a Nest Hub, session start, volume, HLS load, play, pause, seek, resume and stop were tested.

## Your own receiver

1. Build and register a receiver app in Google's Cast SDK Developer Console to get an app id. An unpublished app launches
   only on devices you registered as test devices there (Google's rule, not electron-cast's).
2. Use that id as the page's `receiverApplicationId` (or `SessionRequest`).
3. Talk to it on your own **namespace** (`urn:x-cast:com.example.chat`, say).

```ts
declare const chrome: any;

const NAMESPACE = "urn:x-cast:com.example.chat";

function listen(session: any): void {
  session.addMessageListener(NAMESPACE, (_namespace: string, message: string) => {
    console.log("from the receiver:", message);
  });
}

function say(session: any, text: string): void {
  session.sendMessage(NAMESPACE, { text }, () => {}, (error: unknown) => console.error(error));
}
```

How messages flow, and the limits:

- **Namespaces.** In the default mode the namespace must be one the receiver app lists in its status. A receiver declares
  them in its own configuration. A message to anything else is refused with an `invalid_parameter` error ("Invalid namespace") and never sent. (`mode: "chromecast"` lets the page name any
  namespace, but the destination is always the receiver app's own transport, never the platform receiver.)
- **Delivery.** Messages go to the receiver app's transport. What the device sends comes back only to the members of that
  session, routed by the app's transport id, so a session sees only its own app's traffic.
- **Sizes.** A page-to-receiver message over 1,048,576 characters is dropped, and the Cast wire limit of 65,536 bytes per
  message still applies below that: a larger message fails with an error instead of being sent.
- **Untrusted data.** Everything a device sends is untrusted data. The SDK may put a receiver's name into markup, so
  electron-cast HTML-escapes the friendly name it passes on, as Chrome does.

## Which app id the page used

`CastRequestInfo.appId` in `selectDevice` tells your picker which receiver the page wants. A page can launch any app on the
device the user picked, so if you only support one receiver, check it there and resolve `null` for anything else:

```ts
import { ipcMain } from "electron";
import { createCastManager } from "electron-cast/main";

const SUPPORTED = new Set(["CC1AD845", "ABCD1234"]);

export const cast = createCastManager({
  ipcMain,
  selectDevice: async (_devices, request) => {
    if (!SUPPORTED.has(request.appId)) return null;
    return null; // show your picker for the supported ones
  },
});
```

An app id is validated to `[A-Za-z0-9._-]{1,64}` before it gets anywhere near a device.

## Receivers that are not Google-certified

A receiver you wrote and run yourself on non-Google hardware has no Google certificate, so device authentication fails
for it. See [Device authentication](device-authentication.md#casting-to-a-receiver-that-is-not-google-certified).
