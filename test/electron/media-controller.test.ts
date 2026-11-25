// getMediaController: Chrome's MediaController and MediaStatusObserver for a route (CastMediaController).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createCastManager, MediaRouteError, type IpcMainLike, type MediaStatus,
} from "../../src/electron/main.ts";
import { FakeDevices, FakeClient, TV, tick } from "./fakes.ts";

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
    ipcMain: ipc,
    discovery: new Discovery(),
    createClient: (d) => { const c = new FakeClient(d); c.echoReplies = true; clients.push(c); return c; },
    selectDevice: async (devices) => devices.find((d) => d.id === TV.id) ?? null,
  });
  const wc = new FakeWc(1);
  const call = (method: string, params: unknown) =>
    Promise.resolve(ipc.handlers.get("electron-cast:call")!({ sender: wc, senderFrame: { url: `${ORIGIN}/x`, origin: ORIGIN } }, method, params));
  await call("initialize", { appId: YT, capabilities: ["audio_out"], autoJoinPolicy: "origin_scoped" });
  const r = (await call("requestSession", { appId: YT, capabilities: ["audio_out"], timeoutMs: 5000 })) as { value: { sessionId: string; transportId: string } };
  const client = clients[0]!;
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

test("an unchanged status is not reported twice; close() stops the reports", async () => {
  const t = await setup();
  const seen: MediaStatus[] = [];
  const c = t.manager.getMediaController(t.sessionId, { onMediaStatusUpdated: (s) => seen.push(s) });
  const n = seen.length;
  t.client.pushStatus();
  assert.equal(seen.length, n);
  c.close();
  t.status({ status: [{ mediaSessionId: 1, playerState: "PAUSED" }] });
  assert.equal(seen.length, n);
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
