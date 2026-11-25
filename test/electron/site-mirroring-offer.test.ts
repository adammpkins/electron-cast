// A page's Cast Streaming URL decides how its mirroring session starts: `MirroringActivity::StartSession`
// (chrome/browser/media/router/providers/cast/mirroring_activity.cc) takes the session type from the sink's capabilities and
// `CastMediaSource::ProvidesStreamingAudioCapture()` (false when the URL says `streamingCaptureAudio=0`), and the session's
// target playout delay from `CastMediaSource::target_playout_delay()` (`streamingTargetPlayoutDelayMillis`). The mirroring
// service puts that delay in every stream of the OFFER (`MirrorSettings::GetVideoConfig` / `GetAudioConfig`:
// `target_playout_delay_.value_or(GetPlayoutDelay())`, components/mirroring/service/mirror_settings.cc).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { MirroringClient } from "../../src/mirroring/mirroring-activity.ts";
import { MirroringManager } from "../../src/mirroring/mirroring-manager.ts";
import type { SessionParameters } from "../../src/mirroring/session-host.ts";
import type { CastDevice } from "../../src/discovery/index.ts";
import { parseCastMediaSource } from "../../src/electron/cast-media-source.ts";
import { siteMirroringSource } from "../../src/electron/mirroring-to-flinging.ts";
import { sleep, startHarness } from "../mirroring/session-harness.ts";

class FakeClient extends EventEmitter implements MirroringClient {
  readonly senderId = "sender-fake01";
  async connect(): Promise<void> {}
  close(): void {}
  send(): void {}
  async launch(appId: string) {
    return { appId, displayName: "Fake Streaming", sessionId: "s1", transportId: "transport-s1", namespaces: [] };
  }
  async stop() {
    return { applications: [], volume: {} };
  }
  connectTransport(): void {}
  closeTransport(): void {}
}

const TV: CastDevice = { id: "dev-1", name: "dev-1", model: "Fake", host: "127.0.0.1", addresses: ["127.0.0.1"], port: 8009, capabilities: 5, isGroup: false, statusText: "", instanceName: "dev-1", txt: {} };

/** The parameters the mirroring service is started with for a page's URL, the way main.ts builds its source. */
async function paramsFor(url: string): Promise<SessionParameters> {
  let params: SessionParameters | undefined;
  const manager = new MirroringManager({
    findDevice: () => TV,
    createClient: () => new FakeClient(),
    createService: (p) => {
      params = p;
      return { onMessage() {}, stop() {} };
    },
  });
  const parsed = parseCastMediaSource(url);
  const source = siteMirroringSource(url, 5, parsed ?? {});
  assert.ok(source, url);
  await manager.startSiteInitiatedMirroring(TV.id, source);
  assert.ok(params, "the service was started");
  return params;
}

const streamTypes = (offer: Record<string, unknown> | undefined): string[] =>
  [...new Set(((offer?.offer as { supportedStreams: { type: string }[] }).supportedStreams).map((s) => s.type))].sort();
const delays = (offer: Record<string, unknown> | undefined): number[] =>
  [...new Set(((offer?.offer as { supportedStreams: { targetDelay: number }[] }).supportedStreams).map((s) => s.targetDelay))];

test("streamingTargetPlayoutDelayMillis reaches the session parameters and every stream's targetDelay in the OFFER", async () => {
  const params = await paramsFor("cast:0F5096E8?streamingTargetPlayoutDelayMillis=450");
  assert.equal(params.targetPlayoutDelayMs, 450);
  const h = await startHarness({ type: params.type, ...(params.targetPlayoutDelayMs !== undefined ? { targetPlayoutDelayMs: params.targetPlayoutDelayMs } : {}) });
  try {
    await sleep(300);
    assert.deepEqual(delays(h.receiver.lastOffer), [450]);
  } finally {
    h.close();
  }
});

test("a URL without a delay leaves the session parameter unset, so the mirroring service's default applies", async () => {
  assert.equal((await paramsFor("cast:0F5096E8")).targetPlayoutDelayMs, undefined);
  assert.equal((await paramsFor("cast:0F5096E8?streamingTargetPlayoutDelayMillis=0")).targetPlayoutDelayMs, undefined, "Chrome ignores a delay that is not positive");
});

test("the legacy URL form asks for sound through the app's audio_out capability and the OFFER has audio and video", async () => {
  const params = await paramsFor("https://google.com/cast#__castAppId__=0F5096E8(video_out,audio_out)/__castClientId__=1");
  assert.equal(params.type, "audio_video");
  const h = await startHarness({ type: params.type });
  try {
    await sleep(300);
    assert.deepEqual(streamTypes(h.receiver.lastOffer), ["audio_source", "video_source"]);
  } finally {
    h.close();
  }
});

test("a URL with no audio capability is a video-only session: no audio stream in the OFFER", async () => {
  // ProvidesStreamingAudioCapture needs a streaming app that requires audio_out
  const params = await paramsFor("cast:0F5096E8?streamingCaptureAudio=0");
  assert.equal(params.type, "video_only");
  const h = await startHarness({ type: params.type });
  try {
    await sleep(300);
    assert.deepEqual(streamTypes(h.receiver.lastOffer), ["video_source"]);
  } finally {
    h.close();
  }
});

test("streamingCaptureAudio=0 makes a session video-only even where the app requires audio_out", async () => {
  const source = siteMirroringSource("cast:0F5096E8", 5, { appInfos: [{ appId: "0F5096E8", requiredCapabilities: 5 }], siteRequestedAudioCapture: false });
  const wants = siteMirroringSource("cast:0F5096E8", 5, { appInfos: [{ appId: "0F5096E8", requiredCapabilities: 5 }], siteRequestedAudioCapture: true });
  const types: string[] = [];
  for (const s of [source, wants]) {
    let type = "";
    const manager = new MirroringManager({
      findDevice: () => TV,
      createClient: () => new FakeClient(),
      createService: (p) => {
        type = p.type;
        return { onMessage() {}, stop() {} };
      },
    });
    await manager.startSiteInitiatedMirroring(TV.id, s!);
    types.push(type);
  }
  assert.deepEqual(types, ["video_only", "audio_video"]);
});
