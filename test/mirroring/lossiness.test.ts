import { test } from "node:test";
import assert from "node:assert/strict";
import { PortBackend } from "../../src/mirroring/electron/port-backend.ts";
import type { AgentPort, AgentToEngine, CaptureSource, EngineToAgent } from "../../src/mirroring/electron/agent-protocol.ts";
import { FrameSender, type SenderEncodedFrame, type SenderView } from "../../src/mirroring/sender/frame-sender.ts";
import { VideoSender, type VideoEncoderPort } from "../../src/mirroring/sender/video-sender.ts";
import {
  EncoderUtilizationAverage, MAX_LOSSINESS, calculateEncoderUtilization, computeLossiness,
} from "../../src/mirroring/sender/video-encoder-metrics.ts";
import type { VideoCaptureParams } from "../../src/mirroring/mirror-settings.ts";

/** Expected values are worked out by hand from media/cast/encoding/media_video_encoder_wrapper.cc. */

test("lossiness is the frame's share of the target bitrate times its complexity, clamped to [0, 5]", () => {
  // 1500 bytes over 1/30 s is 360 kbps, 18% of a 2 Mbps target, times a complexity of 0.5.
  assert.ok(Math.abs(computeLossiness(1500, 1000 / 30, 2_000_000, 0.5) - 0.09) < 1e-9);
  assert.equal(computeLossiness(1500, 1000 / 30, 2_000_000, 0), 0, "a frame that is nothing new costs nothing");
  assert.equal(computeLossiness(10_000_000, 1000 / 30, 1_000_000, 1), MAX_LOSSINESS);
  assert.equal(computeLossiness(1500, 0, 2_000_000, 1), 0, "no duration, no rate");
  assert.throws(() => computeLossiness(1, 33, 0, 1), RangeError);
});

test("software encoder utilization is the processing time over the frame duration; hardware also weighs the backlog; both clamp to [0, 2]", () => {
  const frame = 1000 / 30;
  assert.ok(Math.abs(calculateEncoderUtilization(false, 3, frame / 2, frame) - 0.5) < 1e-9, "the backlog is ignored in software");
  assert.equal(calculateEncoderUtilization(false, 1, 5 * frame, frame), 2);
  assert.equal(calculateEncoderUtilization(false, 1, -1, frame), 0);
  // hardware: backlog 3 of 4, latency 1 frame of a pipeline of 3
  assert.equal(calculateEncoderUtilization(true, 3, frame, frame), 0.75);
  assert.ok(Math.abs(calculateEncoderUtilization(true, 1, 3 * frame, frame) - 1) < 1e-9);
});

test("the utilization average starts at the first value and then moves a tenth of the way to each new one", () => {
  const ema = new EncoderUtilizationAverage();
  assert.equal(ema.record(1), 1);
  assert.ok(Math.abs(ema.record(2) - 1.1) < 1e-9);
  assert.ok(Math.abs(ema.record(0) - 0.99) < 1e-9);
});

class FakePort implements AgentPort {
  readonly out: EngineToAgent[] = [];
  private l: ((m: AgentToEngine) => void) | undefined;
  postMessage(m: EngineToAgent) { this.out.push(m); }
  onMessage(l: (m: AgentToEngine) => void) { this.l = l; }
  close() {}
  emit(m: AgentToEngine) { this.l?.(m); }
}

const PARAMS: VideoCaptureParams = { width: 1920, height: 1080, frameRate: 30, resolutionChangePolicy: "any_within_limit" };

function backendWithVideo(params: VideoCaptureParams = PARAMS, bitrate = 2_000_000, source: CaptureSource = { kind: "tab", mediaSourceId: "x" }) {
  const port = new FakePort();
  const backend = new PortBackend(port, source);
  const encoded: SenderEncodedFrame[] = [];
  let feedbackFor: ((f: SenderEncodedFrame) => number) | undefined;
  const encoder = backend.createVideoEncoder(
    { maxFrameRate: params.frameRate, startBitrate: bitrate, codecParameter: "vp8", videoCodec: "vp8" } as never,
    {
      onEncoded: (_ref, f) => {
        if (f !== undefined) encoded.push(f);
        // What VideoSender does with the frame: report a resource utilization for it to the capture side.
        if (f !== undefined && f.data.length > 0 && feedbackFor !== undefined) backend.processFeedback(feedbackFor(f));
      },
      onStatus() {},
    },
  );
  const sink = {
    insertVideoFrame: (f: { rtpTimestamp: number; referenceTimeMs?: number }) =>
      void encoder.encodeVideoFrame({ rtpTimestamp: f.rtpTimestamp, visibleRectEmpty: false }, f.referenceTimeMs ?? 0),
    onCaptureError() {},
  };
  backend.startVideoCapture(params, sink);
  const t0 = performance.timeOrigin;
  let rtp = 1000;
  return {
    port, backend, encoded, encoder,
    useFeedback: (fn: (f: SenderEncodedFrame) => number) => { feedbackFor = fn; },
    /** One frame captured at `atMs` (relative), encoded, and its chunk delivered. */
    frame(atMs: number, chunk: Partial<Extract<AgentToEngine, { t: "video-chunk" }>> = {}, over: { width?: number; height?: number; refresh?: boolean } = {}) {
      rtp += 3000;
      port.emit({ t: "frame", rtp, refMs: t0 + atMs, width: over.width ?? 1920, height: over.height ?? 1080, refresh: over.refresh });
      port.emit({ t: "video-chunk", rtp, key: encoded.length === 0, data: new ArrayBuffer(1500), encodeMs: 10, ...chunk });
    },
    captureSizes: () => port.out.flatMap((m) => (m.t === "capture-size" ? [{ width: m.width, height: m.height }] : [])),
  };
}

test("port backend: an estimated complexity becomes the frame's lossiness against the current target bitrate and the frame's duration", () => {
  const t = backendWithVideo();
  t.frame(0, { complexity: 0.5, durationMs: 1000 / 30 });
  assert.ok(Math.abs(t.encoded[0]!.lossiness! - 0.09) < 1e-9);
  // A bitrate change applies to later frames, as Chrome reads options_.bitrate when the output arrives.
  t.encoder.setBitRate(1_000_000);
  t.frame(33, { complexity: 0.5, durationMs: 1000 / 30 });
  assert.ok(Math.abs(t.encoded[1]!.lossiness! - 0.18) < 1e-9);
  // Without a duration the frame interval is used, and without a complexity there is no lossiness.
  t.frame(66, { complexity: 1 });
  assert.ok(Math.abs(t.encoded[2]!.lossiness! - 0.36) < 1e-9);
  t.frame(99);
  assert.equal(t.encoded[3]!.lossiness, undefined);
});

test("port backend: the encoder utilization is the smoothed processing time over the frame interval", () => {
  const t = backendWithVideo();
  t.frame(0, { encodeMs: 1000 / 30 }); // 1.0
  t.frame(33, { encodeMs: 1000 / 30 / 2 }); // raw 0.5: 0.1 * 0.5 + 0.9 * 1
  t.frame(66, { encodeMs: 1000 }); // raw clamps to 2
  assert.equal(t.encoded[0]!.encoderUtilization, 1);
  assert.ok(Math.abs(t.encoded[1]!.encoderUtilization - 0.95) < 1e-9);
  assert.ok(Math.abs(t.encoded[2]!.encoderUtilization - (0.2 + 0.95 * 0.9)) < 1e-9);
});

test("port backend: utilization above 1 shrinks the size the agent encodes at, and relief brings it back (the VideoCaptureOracle path)", () => {
  const t = backendWithVideo();
  let phase: "overloaded" | "idle" = "overloaded";
  t.useFeedback(() => (phase === "overloaded" ? 2 : 0.2));
  for (let i = 0; i < 600; i++) t.frame(i * 33);
  const down = t.captureSizes();
  assert.deepEqual(down[0], { width: 1920, height: 1080 }, "the first frame announces the full size");
  assert.ok(down.length > 2, "several steps down");
  assert.ok(down[down.length - 1]!.height < 1080);
  for (const s of down) assert.equal((s.width % 2) + (s.height % 2), 0, "sizes are even");
  phase = "idle";
  // Frames this close together are animating content, which has to prove 30 s of under-utilization for each step up.
  for (let i = 600; i < 600 + 12000; i++) t.frame(i * 33);
  const all = t.captureSizes();
  assert.deepEqual(all[all.length - 1], { width: 1920, height: 1080 });
});

test("port backend: a fixed resolution is never resized, whatever the feedback", () => {
  const t = backendWithVideo({ ...PARAMS, resolutionChangePolicy: "fixed_resolution" });
  t.useFeedback(() => 3);
  for (let i = 0; i < 600; i++) t.frame(i * 33);
  assert.deepEqual(t.captureSizes(), [{ width: 1920, height: 1080 }]);
});

test("port backend: a desktop capture is never resized, as DesktopCaptureDevice ignores resource utilization", () => {
  const t = backendWithVideo(PARAMS, 2_000_000, { kind: "desktop", sourceId: "screen:0:0", audio: "loopback" });
  t.useFeedback(() => 3);
  for (let i = 0; i < 600; i++) t.frame(i * 33);
  assert.deepEqual(t.captureSizes(), []);
});

test("port backend: a source of another size is followed by the capture size", () => {
  const t = backendWithVideo();
  t.frame(0, {}, { width: 1280, height: 720 });
  t.frame(33, {}, { width: 1280, height: 720 });
  assert.deepEqual(t.captureSizes(), [{ width: 1280, height: 720 }]);
});

test("VideoSender reports the larger of the encoder utilization and the lossiness, attenuated", () => {
  const view: { -readonly [K in keyof SenderView]: SenderView[K] } = {
    inFlightFrameCount: 0, nextFrameId: 0, needsKeyFrame: false, currentRoundTripTimeMs: 0,
    getInFlightMediaDuration: () => 0, getMaxInFlightMediaDuration: () => 1000,
    enqueueFrame() { this.nextFrameId++; return "OK"; },
  };
  let vs: VideoSender;
  const fs = new FrameSender({ maxFrameRate: 30, isAudio: false, minPlayoutDelayMs: 200, maxPlayoutDelayMs: 400 }, view, {
    getNumberOfFramesInEncoder: () => vs.getNumberOfFramesInEncoder(), getEncoderBacklogDuration: () => vs.getEncoderBacklogDuration(),
  }, 200, () => 0);
  const feedback: number[] = [];
  const encoder: VideoEncoderPort = { generateKeyFrame() {}, setBitRate() {}, setMaxFrameRate() {}, encodeVideoFrame: () => true };
  vs = new VideoSender(fs, encoder, { minBitrate: 1, maxBitrate: 1e7, minPlayoutDelayMs: 200, maxPlayoutDelayMs: 400 }, () => 1e6, () => {}, (u) => feedback.push(u));
  const frame = (id: number, over: Partial<SenderEncodedFrame>): SenderEncodedFrame => ({
    isKeyFrame: false, frameId: id, referencedFrameId: id - 1, rtpTimestamp: 3000 * (id + 1), referenceTimeMs: 33 * id, newPlayoutDelayMs: 0,
    data: new Uint8Array(10), encoderUtilization: 0.3, ...over,
  });
  vs.insertRawVideoFrame({ rtpTimestamp: 3000, visibleRectEmpty: false }, 0);
  vs.insertRawVideoFrame({ rtpTimestamp: 6000, visibleRectEmpty: false }, 33);
  vs.onEncodedVideoFrame(0, frame(0, { lossiness: 0.15 }));
  vs.onEncodedVideoFrame(33, frame(1, { lossiness: 0.9 }));
  assert.ok(Math.abs(feedback[0]! - 0.4) < 1e-9, "utilization 0.3 beats lossiness 0.15");
  assert.ok(Math.abs(feedback[1]! - 1.2) < 1e-9, "lossiness 0.9 beats utilization 0.3");
});
