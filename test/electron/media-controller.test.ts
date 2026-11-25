// getMediaController: Chrome's MediaController and MediaStatusObserver for a route (CastMediaController).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createCastManager, MediaRouteError, type IpcMainLike, type MediaStatus,
} from "../../src/electron/main.ts";
import { FakeDevices, FakeClient, TV, tick, FAST_SINKS } from "./fakes.ts";

const YT = "233637DE";
const ORIGIN = "https://music.youtube.com";
const MEDIA = "urn:x-cast:com.google.cast.media";

class FakeIpc implements IpcMainLike {
  handlers = new Map<string, (event: any, ...args: any[]) => unknown>();
  handle(c: string, l: (event: any, ...args: any[]) => unknown): void { this.handlers.set(c, l); }
  removeHandler(c: string): void { this.handlers.delete(c); }
  on(): unknown { return this; }
  removeListener(): unknown { return this; }
}
class FakeWc extends EventEmitter {
  readonly id: number;
  constructor(id: number) { super(); this.id = id; }
  send(): void {}
  isDestroyed(): boolean { return false; }
}
class Discovery extends FakeDevices {
  async start(): Promise<void> {}
  stop(): void {}
}

async function setup() {
  const clients: FakeClient[] = [];
  const ipc = new FakeIpc();
  const manager = createCastManager({
    sinks: FAST_SINKS,
    ipcMain: ipc,
    discovery: new Discovery(),
    createClient: (d) => { const c = new FakeClient(d); c.echoReplies = true; clients.push(c); return c; },
    selectDevice: async (devices) => devices.find((d) => d.id === TV.id) ?? null,
  });
  // every device gets a channel; the session is on the TV's, once it is open
  await manager.settled();
  const wc = new FakeWc(1);
  const call = (method: string, params: unknown) =>
    Promise.resolve(ipc.handlers.get("electron-cast:call")!({ sender: wc, senderFrame: { url: `${ORIGIN}/x`, origin: ORIGIN } }, method, params));
  await call("initialize", { appId: YT, capabilities: ["audio_out"], autoJoinPolicy: "origin_scoped" });
  const r = (await call("requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 })) as { value: { sessionId: string; transportId: string } };
  const client = clients.find((c) => c.device.id === TV.id)!;
  const media = () => client.sent.filter((s) => s.namespace === MEDIA).map((s) => JSON.parse(s.payload as string));
  const status = (m: object) => client.pushMessage(r.value.transportId, MEDIA, JSON.stringify({ type: "MEDIA_STATUS", requestId: 0, ...m }));
  return { manager, client, sessionId: r.value.sessionId, transportId: r.value.transportId, media, status };
}

test("binding asks the receiver for its media status and reports the receiver volume at once", async () => {
  const t = await setup();
  const seen: MediaStatus[] = [];
  const c = t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => seen.push(s) });
  assert.equal(t.media().length, 1);
  assert.equal(t.media()[0].type, "GET_STATUS");
  assert.ok(Number.isInteger(t.media()[0].requestId));
  assert.equal(seen.length, 1);
  // FakeClient's volume is { level: 0.5, muted: false, controlType: "attenuation" }
  assert.deepEqual([seen[0]!.volume, seen[0]!.isMuted, seen[0]!.canSetVolume, seen[0]!.canMute], [0.5, false, true, true]);
  assert.equal(seen[0]!.playState, "playing", "mojom's first PlayState is the default");
  c.close();
});

test("a fixed-volume receiver cannot set volume or mute", async () => {
  const t = await setup();
  t.client.volume.controlType = "fixed";
  t.client.pushStatus();
  const seen: MediaStatus[] = [];
  t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => seen.push(s) });
  assert.deepEqual([seen[0]!.canSetVolume, seen[0]!.canMute], [false, false]);
});

test("MEDIA_STATUS fills the status as CastMediaController::UpdateMediaStatus does", async () => {
  const t = await setup();
  const seen: MediaStatus[] = [];
  t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => seen.push(s) });
  t.status({
    status: [{
      mediaSessionId: 7, playerState: "PAUSED", currentTime: 12.5, supportedMediaCommands: 1 | 2 | 4 | 8 | 64,
      media: {
        duration: 200,
        metadata: {
          title: "Song", subtitle: "Artist",
          images: [{ url: "https://img.test/a.jpg", width: 300, height: 200 }, { url: "http://img.test/b.jpg" }, { url: "https://img.test/c.jpg", width: 0, height: 9 }, { nope: 1 }],
        },
      },
    }],
  });
  const s = seen.at(-1)!;
  assert.equal(s.title, "Song");
  assert.equal(s.secondaryTitle, "Artist");
  assert.equal(s.playState, "paused");
  assert.equal(s.currentTime, 12.5);
  assert.equal(s.duration, 200);
  assert.deepEqual([s.canPlayPause, s.canSeek, s.canSkipToNextTrack, s.canSkipToPreviousTrack], [true, true, true, false]);
  assert.deepEqual(s.images, [{ url: "https://img.test/a.jpg", size: { width: 300, height: 200 } }, { url: "https://img.test/c.jpg", size: null }]);
});

test("an incremental MEDIA_STATUS keeps what the receiver left out (CopySavedMediaFieldsToMediaList)", async () => {
  const t = await setup();
  const seen: MediaStatus[] = [];
  t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => seen.push(s) });
  t.status({ status: [{ mediaSessionId: 3, playerState: "PLAYING", currentTime: 1, media: { duration: 90, metadata: { title: "T" } } }] });
  t.status({ status: [{ mediaSessionId: 3, playerState: "BUFFERING", currentTime: 2 }] });
  const s = seen.at(-1)!;
  assert.equal(s.playState, "buffering");
  assert.equal(s.currentTime, 2);
  assert.equal(s.duration, 90);
  assert.equal(s.title, "T");
});

test("commands go to the receiver in Chrome's message shapes, with the media session id learned from the status", async () => {
  const t = await setup();
  const c = t.manager.getMediaController(t.sessionId);
  const before = t.media().length;
  await c.play();
  assert.equal(t.media()[before].mediaSessionId, -1, "-1 until a status names the media session, as in Chrome");
  t.status({ status: [{ mediaSessionId: 9, playerState: "PLAYING" }] });
  await c.play();
  await c.pause();
  await c.seek(42.5);
  await c.nextTrack();
  await c.previousTrack();
  const sent = t.media().slice(before + 1);
  const shape = (m: Record<string, unknown>) => ({ ...m, requestId: typeof m.requestId });
  assert.deepEqual(sent.map(shape), [
    { mediaSessionId: 9, sessionId: t.sessionId, type: "PLAY", requestId: "number" },
    { mediaSessionId: 9, sessionId: t.sessionId, type: "PAUSE", requestId: "number" },
    { mediaSessionId: 9, sessionId: t.sessionId, type: "SEEK", currentTime: 42.5, requestId: "number" },
    { mediaSessionId: 9, sessionId: t.sessionId, type: "QUEUE_UPDATE", jump: 1, requestId: "number" },
    { mediaSessionId: 9, sessionId: t.sessionId, type: "QUEUE_UPDATE", jump: -1, requestId: "number" },
  ]);
  assert.equal(new Set(sent.map((m) => m.requestId)).size, sent.length);
  assert.ok(t.client.sent.filter((s) => s.namespace === MEDIA).every((s) => s.destinationId === t.transportId));
});

test("volume and mute are the receiver's SET_VOLUME and update the status", async () => {
  const t = await setup();
  const seen: MediaStatus[] = [];
  const c = t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => seen.push(s) });
  await c.setVolume(0.25);
  await c.setMute(true);
  assert.ok(t.client.calls.includes('volume {"level":0.25}'));
  assert.ok(t.client.calls.includes('volume {"muted":true}'));
  assert.deepEqual([seen.at(-1)!.volume, seen.at(-1)!.isMuted], [0.25, true]);
  await assert.rejects(c.setVolume(1.5), RangeError);
  await assert.rejects(c.setMute("yes" as never), TypeError);
  await assert.rejects(c.seek(-1), RangeError);
});

// Chrome's CastMediaController::SetSession and SetMediaStatus call OnMediaStatusUpdated on every observer each time
// (cast_media_controller.cc), so a repeated status is reported again; the de-duplication electron-cast had is gone.
test("every receiver status and every MEDIA_STATUS is reported, repeated or not; close() stops the reports", async () => {
  const t = await setup();
  const seen: MediaStatus[] = [];
  const c = t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => seen.push(s) });
  const n = seen.length;
  t.client.pushStatus();
  t.client.pushStatus();
  assert.equal(seen.length, n + 2, "SetSession on each RECEIVER_STATUS");
  t.status({ status: [{ mediaSessionId: 1, playerState: "PAUSED" }] });
  t.status({ status: [{ mediaSessionId: 1, playerState: "PAUSED" }] });
  assert.equal(seen.length, n + 4, "SetMediaStatus on each MEDIA_STATUS");
  assert.deepEqual(seen.at(-1), seen.at(-2));
  c.close();
  t.status({ status: [{ mediaSessionId: 1, playerState: "PLAYING" }] });
  t.client.pushStatus();
  assert.equal(seen.length, n + 4);
});

test("binding another controller tells every observer of the route, as SetSession does", async () => {
  const t = await setup();
  const a: MediaStatus[] = [];
  t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => a.push(s) });
  const before = a.length;
  t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: () => {} });
  assert.equal(a.length, before + 1);
});

test("the media status is the session tracker's: any MEDIA_STATUS on the device's channel counts, with saved fields filled in", async () => {
  const t = await setup();
  const seen: MediaStatus[] = [];
  t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => seen.push(s) });
  // CastSessionTracker::HandleMediaStatusMessage credits a media status to the session the device runs, whoever sent it
  t.client.pushMessage("receiver-0", MEDIA, JSON.stringify({
    type: "MEDIA_STATUS", status: [{ mediaSessionId: 4, playerState: "PLAYING", supportedMediaCommands: 1, media: { metadata: { title: "Elsewhere" } } }],
  }));
  t.client.pushMessage("receiver-0", MEDIA, JSON.stringify({ type: "MEDIA_STATUS", status: [{ mediaSessionId: 4, playerState: "PAUSED" }] }));
  const s = seen.at(-1)!;
  assert.deepEqual([s.title, s.playState, s.canPlayPause], ["Elsewhere", "paused", true]);
});

test("a non-local route has a media controller over the device's channel (AddNonLocalActivity makes an AppActivity)", async () => {
  const clients: FakeClient[] = [];
  const manager = createCastManager({
    sinks: FAST_SINKS,
    ipcMain: new FakeIpc(),
    discovery: new Discovery(),
    createClient: (d) => {
      const c = new FakeClient(d);
      c.echoReplies = true;
      if (d.id === TV.id) {
        // a session another sender started
        c.apps = [{ appId: "CC1AD845", sessionId: "other-s", transportId: "other-t", displayName: "Default Media Receiver", statusText: "", namespaces: [{ name: MEDIA }] }];
      }
      clients.push(c);
      return c;
    },
    selectDevice: async () => null,
  });
  await manager.settled();
  await tick();
  const route = manager.getRoutes().find((r) => r.id === "other-s");
  assert.equal(route?.isLocal, false);
  const tv = clients.find((c) => c.device.id === TV.id)!;
  const seen: MediaStatus[] = [];
  const c = manager.getMediaController("other-s", { onMediaStatusUpdated: (s) => seen.push(s) });
  assert.equal(seen.length, 1, "the tracked session's volume is reported at once");
  assert.equal(seen[0]!.volume, 0.5);
  assert.ok(tv.calls.includes("connectTransport other-t"), "a virtual connection to the session's transport, as EnsureConnection opens");
  const media = () => tv.sent.filter((m) => m.namespace === MEDIA).map((m) => ({ to: m.destinationId, ...JSON.parse(m.payload as string) }));
  assert.equal(media()[0].type, "GET_STATUS");
  assert.equal(media()[0].to, "other-t");
  tv.pushMessage("other-t", MEDIA, JSON.stringify({ type: "MEDIA_STATUS", status: [{ mediaSessionId: 2, playerState: "PLAYING", media: { metadata: { title: "Remote" } } }] }));
  assert.equal(seen.at(-1)!.title, "Remote");
  await c.pause();
  assert.deepEqual({ ...media().at(-1), requestId: 0 }, { to: "other-t", mediaSessionId: 2, sessionId: "other-s", type: "PAUSE", requestId: 0 });
  await c.setVolume(0.3);
  assert.ok(tv.calls.includes('volume {"level":0.3}'));
  assert.equal(seen.at(-1)!.volume, 0.3);
  await manager.dispose();
});

test("two controllers on a route share the status and each observer hears it", async () => {
  const t = await setup();
  const a: MediaStatus[] = [];
  const b: MediaStatus[] = [];
  t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => a.push(s) });
  t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => b.push(s) });
  t.status({ status: [{ mediaSessionId: 1, playerState: "PAUSED", media: { metadata: { title: "X" } } }] });
  assert.equal(a.at(-1)!.title, "X");
  assert.equal(b.at(-1)!.title, "X");
});

test("an unknown route throws and a controller whose route ended rejects", async () => {
  const t = await setup();
  assert.throws(() => t.manager.getMediaController("nope"), (e: unknown) => e instanceof MediaRouteError && e.code === "route_not_found");
  const c = t.manager.getMediaController(t.sessionId);
  await t.manager.terminateRoute(t.sessionId);
  await tick();
  await assert.rejects(c.play(), (e: unknown) => e instanceof MediaRouteError && e.code === "route_not_found");
});
