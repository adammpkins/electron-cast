# Building your own device picker

electron-cast ships no picker UI: you give `createCastManager` a `selectDevice` function and show whatever you like.

In Chrome the user picks a device in the Cast dialog, a piece of browser UI. Electron has none, so the page's own cast
button ends up calling your function. This guide goes from the contract to a picker window that updates while it is open.

## The contract

```ts no-check
selectDevice(devices: CastDevice[], request: CastRequestInfo, picker: DevicePickerContext): Promise<DeviceChoice>
```

- `devices` is the list at the moment the page asked, already filtered to devices that can serve the request. In the
  default mode the page asks for no capabilities, so it holds every device found.
- `request` says who is asking: `origin` (show it), `appId`, `capabilities`, `senderId`, and `session` when this sender is
  already casting that app, with `{ sessionId, deviceId }`.
- `picker` streams devices that appear while your UI is open, and an `AbortSignal` that fires when the request no
  longer waits for an answer. A function that declares only the first two parameters keeps working.
- Resolve a `CastDevice` to cast to it, `null` when the user cancels, or `"stop"` to stop `request.session`. Choosing the
  device that `request.session` is already on returns the existing session instead of relaunching.
- A rejection fails the request with `session_error`. The time your UI is open does not count against the page's launch
  timeout.

Two rules that follow from the [security model](../../SECURITY.md#user-gesture): this is the real consent step, so always
show a prompt, show `request.origin`, and never auto-pick; and device names come from the network, so render them as
plain text, never as HTML.

If no device matches when the page asks, the request fails with `receiver_unavailable` before `selectDevice` is called.

## The smallest picker: a native menu

The [README](../../README.md#quick-start) shows a `Menu` picker. It is enough to start with, and it has one subtlety:
a menu's close callback can run before the clicked item's handler, so a close only counts as a cancel after a short
grace period (the `setTimeout(..., 100)`).

## A picker window with live updates

mDNS answers trickle in for several seconds, so a picker that only shows the list from the moment of the click can
look empty. This one re-renders as devices come and go. It follows what Chrome's dialog does (it registers a sinks
observer while it is open) through the third argument.

Main process:

```ts
import { BrowserWindow, ipcMain } from "electron";
import {
  createCastManager,
  type CastDevice,
  type CastRequestInfo,
  type DeviceChoice,
  type DevicePickerContext,
} from "electron-cast/main";

// Speakers and TVs first, then groups, each alphabetical.
const order = (a: CastDevice, b: CastDevice) => Number(a.isGroup) - Number(b.isGroup) || a.name.localeCompare(b.name);

function pickDevice(devices: CastDevice[], request: CastRequestInfo, picker: DevicePickerContext): Promise<DeviceChoice> {
  return new Promise((resolve) => {
    const known = new Map(devices.map((d) => [d.id, d]));
    const win = new BrowserWindow({
      width: 320,
      height: 420,
      resizable: false,
      webPreferences: { preload: "/absolute/path/to/picker-preload.cjs", sandbox: true, contextIsolation: true },
    });

    const render = () => {
      if (win.isDestroyed() || win.webContents.isLoading()) return;
      win.webContents.send("picker:state", {
        origin: request.origin,
        canStop: request.session !== undefined,
        devices: [...known.values()].sort(order).map(({ id, name, model, isGroup }) => ({ id, name, model, isGroup })),
      });
    };

    let settled = false;
    const settle = (choice: DeviceChoice) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("picker:choose", onChoose);
      stopWatching();
      if (!win.isDestroyed()) win.close();
      resolve(choice);
    };

    // The renderer sends a device id, "stop" or null. Only this window's messages count, and an id has to be one we listed.
    const onChoose = (event: { sender: unknown }, choice: unknown) => {
      if (event.sender !== win.webContents) return;
      if (choice === null) settle(null);
      else if (choice === "stop" && request.session !== undefined) settle("stop");
      else if (typeof choice === "string") {
        const device = known.get(choice);
        if (device !== undefined) settle(device);
      }
    };
    ipcMain.on("picker:choose", onChoose);

    // Called now with the current list, then whenever a device appears, changes or goes.
    const stopWatching = picker.registerMediaSinksObserver({
      onSinksUpdated(sinks) {
        known.clear();
        for (const sink of sinks) known.set(sink.device.id, sink.device);
        render();
      },
    });

    win.on("closed", () => settle(null)); // the user closed the window
    picker.signal.addEventListener("abort", () => settle(null)); // the page went away, or the manager was disposed
    win.webContents.once("did-finish-load", render);
    void win.loadFile("picker.html");
  });
}

export const cast = createCastManager({
  ipcMain,
  allowOrigin: (origin) => origin === "https://music.youtube.com",
  selectDevice: pickDevice,
});
```

The picker's preload exposes two calls and nothing else:

```ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("picker", {
  onState: (listener: (state: unknown) => void) => ipcRenderer.on("picker:state", (_event, state) => listener(state)),
  choose: (choice: string | null) => ipcRenderer.send("picker:choose", choice),
});
```

And `picker.html` draws the list with `textContent`:

```html
<ul id="devices"></ul>
<button id="stop" hidden>Stop casting</button>
<button id="cancel">Cancel</button>
<script>
  const list = document.getElementById("devices");
  window.picker.onState((state) => {
    list.replaceChildren(
      ...state.devices.map((d) => {
        const li = document.createElement("li");
        li.textContent = `${d.name} (${d.model})`; // never innerHTML: names come from the network
        li.onclick = () => window.picker.choose(d.id);
        return li;
      }),
    );
    document.getElementById("stop").hidden = !state.canStop;
  });
  document.getElementById("stop").onclick = () => window.picker.choose("stop");
  document.getElementById("cancel").onclick = () => window.picker.choose(null);
</script>
```

Notes:

- `registerMediaSinksObserver` on the picker context lists only devices that can serve this request, the same way `devices`
  was filtered, and it is dropped when `picker.signal` aborts. Its list replaces yours; `sink.device` is the `CastDevice`
  to resolve with.
- Resolving the window's `closed` event as a cancel keeps the page from waiting on a window the user dismissed.
- A page can only have one request pending: a second `start` is refused until the first resolves, so you never need two
  pickers for one frame. Windows can each have one.
- A request that is cancelled from outside (the page navigated, its window closed, the manager was disposed) aborts
  `picker.signal`, so the picker never outlives the request it answers.

## Icons and labels

A `MediaSink` (from the observer) carries `iconType`, following Chrome's `GetCastSinkIconType`: a device with video out is
`"cast"`, otherwise a multizone group is `"cast_audio_group"`, otherwise `"cast_audio"`. Use it to pick an icon, or work
it out from `CastDevice.capabilities` and `isGroup` yourself. See [Audio-only devices and speaker
groups](audio-and-groups.md).

Next: [Rejoining a session after a restart](restart-rejoin.md).
