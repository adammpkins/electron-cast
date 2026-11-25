import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { createEncodingSupport } from "../../src/mirroring/encoding-support.ts";
import { createMirroringServiceFactory } from "../../src/mirroring/engine.ts";
import { MirroringManager, type MirroringRoute } from "../../src/mirroring/mirroring-manager.ts";
import type { MirroringClient } from "../../src/mirroring/mirroring-activity.ts";
import {
  chooseAppId, desktopMediaSource, desktopStreamId, mirroringNamespace, mirroringSourceFor, routeDescription, scrubbedLogMessage,
  sessionTypeFor, tabMediaSource,
} from "../../src/mirroring/routing.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import { FakeBackend } from "./fake-backend.ts";
import { FakeReceiver } from "./fake-receiver.ts";
import { sleep } from "./session-harness.ts";

// Chromium sources: cast_media_source.cc (CastMediaSourceForTabMirroring / ForDesktopMirroring, CastAppInfo),
// cast_activity_manager.cc ChooseAppId, mirroring_activity.cc StartSession / GetMirroringNamespace / GetScrubbedLogMessage.

const AV = 1 | 4;
const AUDIO = 4;
const VIDEO = 1;

test("tab sources offer both streaming apps; the app follows the capabilities of the sink", () => {
  const tab = mirroringSourceFor(tabMediaSource(7))!;
  assert.equal(tab.id, "urn:x-org.chromium.media:source:tab:7");
  assert.deepEqual(tab.appInfos.map((a) => a.appId), ["0F5096E8", "85CDB22F"]);
  assert.equal(chooseAppId(tab, AV), "0F5096E8");
  assert.equal(chooseAppId(tab, AUDIO), "85CDB22F");
});

test("desktop sources: with audio both apps, without audio the video app only (no audio_out required)", () => {
  const withAudio = mirroringSourceFor(desktopMediaSource("screen:0:0", true))!;
  assert.equal(withAudio.id, "urn:x-org.chromium.media:source:desktop:screen:0:0?with_audio=true");
  assert.equal(desktopStreamId(withAudio.id), "screen:0:0");
  assert.deepEqual(withAudio.appInfos.map((a) => a.appId), ["0F5096E8", "85CDB22F"]);
  const noAudio = mirroringSourceFor(desktopMediaSource("screen:0:0", false))!;
  assert.deepEqual(noAudio.appInfos, [{ appId: "0F5096E8", requiredCapabilities: VIDEO }]);
  assert.equal(chooseAppId(noAudio, VIDEO), "0F5096E8");
});

test("StartSession: audio needs sink audio_out and a source that provides it; no streams means stop", () => {
  const tab = mirroringSourceFor(tabMediaSource(1))!;
  assert.equal(sessionTypeFor(tab, AV), "audio_video");
  assert.equal(sessionTypeFor(tab, AUDIO), "audio_only");
  assert.equal(sessionTypeFor(tab, VIDEO), "video_only");
  assert.equal(sessionTypeFor(tab, 0), undefined);
  const quiet = { ...tab, siteRequestedAudioCapture: false };
  assert.equal(sessionTypeFor(quiet, AV), "video_only");
  assert.equal(sessionTypeFor(quiet, AUDIO), undefined);
});

test("route descriptions, namespaces and log scrubbing", () => {
  assert.equal(routeDescription("tab"), "Casting tab");
  assert.equal(routeDescription("desktop"), "Casting screen");
  assert.equal(mirroringNamespace({ type: "RPC" }), "urn:x-cast:com.google.cast.remoting");
  assert.equal(mirroringNamespace({ type: "OFFER" }), "urn:x-cast:com.google.cast.webrtc");
  const scrubbed = scrubbedLogMessage({ type: "OFFER", offer: { supportedStreams: [{ aesKey: "ab", aesIvMask: "cd", index: 0 }] } });
  assert.ok(scrubbed.includes("[REDACTED]") && !scrubbed.includes('"ab"') && !scrubbed.includes('"cd"'));
});

/** A fake Cast client in front of the fake receiver: no real device is involved. */
class FakeClient extends EventEmitter implements MirroringClient {
  readonly launched: string[] = [];
  readonly stopped: string[] = [];
  readonly sent: { ns: string; dest: string; source: string }[] = [];
  readonly senderId = "sender-fake01";
  /** The source id of the last message the receiver got: a real device replies to that. */
  lastSource = "";
  closed = false;
  connectedTransport: string | undefined;
  receiver!: FakeReceiver;
  async connect(): Promise<void> {}
  close(): void {
    this.closed = true;
  }
  send(namespace: string, destinationId: string, payload: string): void {
    this.sent.push({ ns: namespace, dest: destinationId, source: this.senderId });
    this.lastSource = this.senderId;
    setImmediate(() => this.receiver.onControlMessage(namespace, payload));
  }
  async launch(appId: string) {
    this.launched.push(appId);
    return { appId, displayName: "Fake Streaming", sessionId: "sess-1", transportId: "transport-1", namespaces: [] };
  }
  async stop(sessionId: string) {
    this.stopped.push(sessionId);
    return { applications: [], volume: {} };
  }
  connectTransport(transportId: string): void {
    this.connectedTransport = transportId;
  }
  closeTransport(): void {}
}

function device(capabilities: number): CastDevice {
  return { id: "dev-1", name: "Fake TV", model: "Fake", host: "127.0.0.1", addresses: ["127.0.0.1"], port: 8009, capabilities, isGroup: false, statusText: "", instanceName: "fake", txt: {} };
}

async function startManager(capabilities: number, extra: { systemAudioCapture?: boolean } = {}) {
  const receiver = await FakeReceiver.create({ verifyBody: true });
  const client = new FakeClient();
  client.receiver = receiver;
  const manager = new MirroringManager({
    findDevice: (id) => (id === "dev-1" ? device(capabilities) : undefined),
    createClient: () => client,
    ...extra,
    createService: createMirroringServiceFactory({
      createBackend: () => new FakeBackend(() => performance.now()),
      encodingSupport: createEncodingSupport({ hardware: new Set(), software: new Set(["vp8"]) }),
      env: {},
    }),
  });
  // A receiver addresses its reply to the source id of the message it answers; it does not know any other id.
  receiver.sendControl = (json) =>
    setImmediate(() => client.emit("message", { namespace: "urn:x-cast:com.google.cast.webrtc", sourceId: "transport-1", destinationId: client.lastSource, data: json }));
  const routesSeen: MirroringRoute[][] = [];
  manager.observe(() => routesSeen.push(manager.routes()));
  return { receiver, client, manager, routesSeen };
}

test("a tab route launches the AV app, relays OFFER and ANSWER, streams to the receiver and stops with the app", async () => {
  const h = await startManager(AV);
  try {
    const route = await h.manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
    assert.deepEqual(h.client.launched, ["0F5096E8"]);
    assert.equal(h.client.connectedTransport, "transport-1");
    assert.equal(route.description, "Casting tab");
    assert.equal(route.mediaSource, "urn:x-org.chromium.media:source:tab:5");
    assert.ok(route.id.startsWith("urn:x-org.chromium:media:route:mr_") && route.id.endsWith("/dev-1/urn:x-org.chromium.media:source:tab:5"));
    assert.equal(route.isConnecting, false);
    await sleep(1200);
    assert.ok(h.client.sent.every((m) => m.dest === "transport-1" && m.ns === "urn:x-cast:com.google.cast.webrtc" && m.source === "sender-fake01"));
    assert.ok(h.receiver.stats.validVideoFrames > 10, `video ${h.receiver.stats.validVideoFrames}`);
    assert.ok(h.receiver.stats.validAudioFrames > 30, `audio ${h.receiver.stats.validAudioFrames}`);
    assert.equal(h.receiver.stats.invalidFrames, 0);
    assert.equal(h.manager.routes().length, 1);
    assert.ok(h.manager.terminate(route.id));
    assert.deepEqual(h.manager.routes(), []);
    await sleep(50);
    assert.deepEqual(h.client.stopped, ["sess-1"]);
    assert.equal(h.client.closed, true);
    assert.equal(h.manager.terminate(route.id), false);
    assert.ok(h.routesSeen.length >= 3);
  } finally {
    h.manager.dispose();
    h.receiver.close();
  }
});

test("an audio-only sink gets the audio-only app and an audio-only session", async () => {
  const h = await startManager(AUDIO);
  try {
    const route = await h.manager.startMirroring("dev-1", { castMode: "desktop_mirror", desktopSourceId: "screen:0:0", withAudio: true });
    assert.deepEqual(h.client.launched, ["85CDB22F"]);
    assert.equal(route.description, "Casting screen");
    await sleep(600);
    const streams = (h.receiver.lastOffer!.offer as { supportedStreams: { type: string }[] }).supportedStreams;
    assert.deepEqual(streams.map((s) => s.type), ["audio_source"]);
    assert.equal(h.receiver.stats.videoFrames, 0);
  } finally {
    h.manager.dispose();
    h.receiver.close();
  }
});

test("a sink that cannot run the source is refused, an unknown sink too", async () => {
  const h = await startManager(AUDIO);
  try {
    await assert.rejects(h.manager.startMirroring("dev-1", { castMode: "desktop_mirror", desktopSourceId: "screen:0:0", withAudio: false }), { code: "unable_to_cast" });
    await assert.rejects(h.manager.startMirroring("nope", { castMode: "tab_mirror", webContentsId: 1 }), { code: "sink_not_found" });
    assert.deepEqual(h.manager.routes(), []);
  } finally {
    h.manager.dispose();
    h.receiver.close();
  }
});

test("the receiver ending the app ends the route", async () => {
  const h = await startManager(AV);
  try {
    await h.manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
    h.client.emit("receiverStatus", { applications: [], volume: {} });
    assert.deepEqual(h.manager.routes(), []);
  } finally {
    h.manager.dispose();
    h.receiver.close();
  }
});

test("a frozen route stops sending video on its last frame while audio goes on, and unfreezing resumes it; a tab switch carries on in the same session", async () => {
  // The fake capture runs on real timers, whose rate depends on the machine (Windows rounds a 10 ms interval up to
  // about 16 ms), so each step waits for what it checks instead of for a fixed time.
  const waitFor = async (what: string, done: () => boolean) => {
    for (const end = Date.now() + 10_000; !done(); await sleep(10)) if (Date.now() > end) assert.fail(`timed out waiting: ${what}`);
  };
  const h = await startManager(AV);
  try {
    const route = await h.manager.startMirroring("dev-1", { castMode: "tab_mirror", webContentsId: 5 });
    await waitFor("capture exists once the session started", () => h.manager.routes()[0]!.freezeInfo.canFreeze);
    await waitFor("video before freezing", () => h.receiver.stats.videoFrames > 3);
    h.manager.freezeRoute(route.id);
    await waitFor("the route reports frozen", () => h.manager.routes()[0]!.freezeInfo.isFrozen);
    // Frames already in flight when the freeze came may still arrive; let them land.
    await sleep(300);
    const frozenVideo = h.receiver.stats.videoFrames;
    const frozenAudio = h.receiver.stats.audioFrames;
    await waitFor("audio is not frozen", () => h.receiver.stats.audioFrames - frozenAudio > 30);
    assert.ok(h.receiver.stats.videoFrames - frozenVideo <= 1, `video while frozen: ${h.receiver.stats.videoFrames - frozenVideo}`);

    h.manager.unfreezeRoute(route.id);
    await waitFor("the route reports unfrozen", () => !h.manager.routes()[0]!.freezeInfo.isFrozen);
    await waitFor("video resumed", () => h.receiver.stats.videoFrames - frozenVideo > 8);

    const offer = h.receiver.lastOffer;
    h.manager.switchMirroringSourceTab(route.id, 6);
    const before = h.receiver.stats.videoFrames;
    await waitFor("video carries on", () => h.receiver.stats.videoFrames - before > 8);
    assert.equal(h.receiver.lastOffer, offer, "no renegotiation");
    assert.equal(h.receiver.stats.invalidFrames, 0);
    assert.equal(h.manager.routes()[0]!.webContentsId, 6);
  } finally {
    h.manager.dispose();
    h.receiver.close();
  }
});

test("without system audio capture (Linux without PulseaudioLoopbackForCast) withAudio is ignored, as Chrome's picker offers no audio", async () => {
  const h = await startManager(AV, { systemAudioCapture: false });
  try {
    const route = await h.manager.startMirroring("dev-1", { castMode: "desktop_mirror", desktopSourceId: "screen:0:0", withAudio: true });
    assert.ok(!route.mediaSource.includes("with_audio"), route.mediaSource);
  } finally {
    h.manager.dispose();
    h.receiver.close();
  }
});
