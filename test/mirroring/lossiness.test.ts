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

function backendWithVideo(
  params: VideoCaptureParams = PARAMS,
  bitrate = 2_000_000,
  source: CaptureSource = { kind: "tab", mediaSourceId: "x" },
  codec: "vp8" | "vp9" | "h264" | "hevc" = "vp8",
  // H.264 and HEVC are only ever offered for a hardware encoder; VP8 and VP9 have both kinds.
  hardware = codec === "h264" || codec === "hevc",
) {
  const port = new FakePort();
  const backend = new PortBackend(port, source);
  const encoded: SenderEncodedFrame[] = [];
  let feedbackFor: ((f: SenderEncodedFrame) => number) | undefined;
  const encoder = backend.createVideoEncoder(
    { maxFrameRate: params.frameRate, startBitrate: bitrate, codecParameter: codec, videoCodec: codec, useHardwareEncoder: hardware } as never,
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

/** The start of real encoders' frames (see h264-quantizer.test.ts and its neighbours), padded to a frame of `bytes`. */
const H264_KEY_QP34 = "0000000109100000000167640028ac2b403b010ff36022000007d00001d4c01e3855400000000168ee3cb00000000165b804087f0b6e47ffbaa0ad8955fd4c73";
const H264_DELTA_QP33 = "0000000109300000000161e0223bfffe9da8fd4bffffc3e7";
const H264_DELTA_QP51 = "0000000109300000000161e0220cbffee8c20b63fff06654";
// libvpx at the largest quantizer Chrome lets it use (58 of 63: q index 112 in VP8, 232 in VP9), and at lower ones.
const VP8_KEY_Q58 = "90be059d012a0005d0023971002a1c22161622661220e03fffac1ff7fdcfeb57";
const VP8_DELTA_Q58 = "711601e4f87fe8cec673fbe05e30225ffdffbd1cafe6ffc7";
const VP8_DELTA_Q42 = "d1fe00e439ffe8cec3799b235c5567e7ff0dcec3fe27f76f";
const VP9_KEY_Q58 = "82498342404ff02cf67e38241c19d01803945f57fe6fc3ff3fedafb81ff86ff2";
const VP9_DELTA_Q58 = "8600409273c1740dfec040580c07ef3380c13c8a6c000006";
const VP9_DELTA_Q33 = "8600c092f12140860057769fdccc5ca6f6dee3b799372f74";
const HEVC_KEY_QP35 =
  "000000014601100000000140010c01ffff01600000030090000003000003005dac090000000142010101600000030090000003000003005da00280802e1f1396b4a421192c2010000003001000000301e080000000014401c1f7c0cc90000000012601af0960f3176ffa119f00609e53";
const HEVC_DELTA_QP42 = "00000001460130000000010201d008be4106f77ce5b87c1d2ba03a42";
function h264Frame(start: string, bytes: number): ArrayBuffer {
  const data = new Uint8Array(bytes).fill(0xff);
  data.set(Buffer.from(start, "hex"));
  return data.buffer;
}

test("port backend: an H.264 frame's lossiness comes from the quantizer the encoder used, not from the estimate", () => {
  const t = backendWithVideo(PARAMS, 2_000_000, undefined, "h264");
  // 1500 bytes over 1/30 s is 18% of 2 Mbps; the estimate of 0.1 is ignored for the QP over 51.
  t.frame(0, { key: true, data: h264Frame(H264_KEY_QP34, 1500), complexity: 0.1, durationMs: 1000 / 30 });
  assert.ok(Math.abs(t.encoded[0]!.lossiness! - 0.18 * (34 / 51)) < 1e-9);
  t.frame(33, { data: h264Frame(H264_DELTA_QP33, 1500), complexity: 0.1, durationMs: 1000 / 30 });
  assert.ok(Math.abs(t.encoded[1]!.lossiness! - 0.18 * (33 / 51)) < 1e-9);
  // Against a target the encoder cannot reach at its largest quantizer, the frame is as lossy as it is over the target.
  t.encoder.setBitRate(265_000);
  t.frame(66, { data: h264Frame(H264_DELTA_QP51, 3900), durationMs: 1000 / 30 });
  assert.ok(Math.abs(t.encoded[2]!.lossiness! - (3900 * 8 * 30) / 265_000) < 1e-9);
});

test("port backend: the agent estimates complexity only while the encoder's frames carry no quantizer (encoder_reports_qp_)", () => {
  const t = backendWithVideo(PARAMS, 2_000_000, undefined, "h264");
  const switches = () => t.port.out.flatMap((m) => (m.t === "estimate-complexity" ? [m.on] : []));
  t.frame(0, { key: true, data: h264Frame(H264_KEY_QP34, 1500), complexity: 0.1 });
  assert.deepEqual(switches(), [false], "the first frame with a quantizer turns the estimate off");
  t.frame(33, { data: h264Frame(H264_DELTA_QP33, 1500) });
  t.frame(66, { data: h264Frame(H264_DELTA_QP33, 1500) });
  assert.deepEqual(switches(), [false], "said once");
  // A frame that was in the encoder when the estimate was turned off still carries one: nothing more to say.
  // The agent's new encoder (another capture size) estimates again until it hears otherwise.
  t.frame(99, { key: true, data: h264Frame(H264_KEY_QP34, 1500), complexity: 0.2 });
  assert.deepEqual(switches(), [false, false]);
  // A frame without a readable quantizer has the estimate turned back on, and has no lossiness of its own.
  t.frame(132, { data: new ArrayBuffer(1500) });
  assert.deepEqual(switches(), [false, false, true]);
  assert.equal(t.encoded.at(-1)!.lossiness, undefined);
  t.frame(165, { data: new ArrayBuffer(1500), complexity: 0.5, durationMs: 1000 / 30 });
  assert.deepEqual(switches(), [false, false, true]);
  assert.ok(Math.abs(t.encoded.at(-1)!.lossiness! - 0.09) < 1e-9, "the estimate stands in again");
});

test("port backend: a software VP8 or VP9 frame's lossiness comes from libvpx's quantizer over 63, as VpxVideoEncoder reports it", () => {
  // 1500 bytes over 1/30 s is 18% of 2 Mbps; the estimate of 0.1 is ignored.
  const vp8 = backendWithVideo();
  vp8.frame(0, { key: true, data: h264Frame(VP8_KEY_Q58, 1500), complexity: 0.1, durationMs: 1000 / 30 });
  assert.ok(Math.abs(vp8.encoded[0]!.lossiness! - 0.18 * (58 / 63)) < 1e-9);
  vp8.frame(33, { data: h264Frame(VP8_DELTA_Q42, 1500), durationMs: 1000 / 30 });
  assert.ok(Math.abs(vp8.encoded[1]!.lossiness! - 0.18 * (42 / 63)) < 1e-9);
  const vp9 = backendWithVideo(PARAMS, 2_000_000, undefined, "vp9");
  vp9.frame(0, { key: true, data: h264Frame(VP9_KEY_Q58, 1500), complexity: 0.1, durationMs: 1000 / 30 });
  assert.ok(Math.abs(vp9.encoded[0]!.lossiness! - 0.18 * (58 / 63)) < 1e-9);
  vp9.frame(33, { data: h264Frame(VP9_DELTA_Q33, 1500), durationMs: 1000 / 30 });
  assert.ok(Math.abs(vp9.encoded[1]!.lossiness! - 0.18 * (33 / 63)) < 1e-9);
  // The estimate is turned off once, as for H.264.
  for (const t of [vp8, vp9]) assert.deepEqual(t.port.out.flatMap((m) => (m.t === "estimate-complexity" ? [m.on] : [])), [false]);
});

test("port backend: a hardware VP8, VP9 or HEVC frame's lossiness uses the scale VideoEncodeAcceleratorAdapter normalizes by", () => {
  const vp8 = backendWithVideo(PARAMS, 2_000_000, undefined, "vp8", true);
  vp8.frame(0, { key: true, data: h264Frame(VP8_KEY_Q58, 1500), durationMs: 1000 / 30 });
  assert.ok(Math.abs(vp8.encoded[0]!.lossiness! - 0.18 * (112 / 127)) < 1e-9);
  const vp9 = backendWithVideo(PARAMS, 2_000_000, undefined, "vp9", true);
  vp9.frame(0, { key: true, data: h264Frame(VP9_KEY_Q58, 1500), durationMs: 1000 / 30 });
  assert.ok(Math.abs(vp9.encoded[0]!.lossiness! - 0.18 * (232 / 255)) < 1e-9);
  const hevc = backendWithVideo(PARAMS, 2_000_000, undefined, "hevc");
  hevc.frame(0, { key: true, data: h264Frame(HEVC_KEY_QP35, 1500), complexity: 0.1, durationMs: 1000 / 30 });
  assert.ok(Math.abs(hevc.encoded[0]!.lossiness! - 0.18 * (35 / 51)) < 1e-9);
  hevc.frame(33, { data: h264Frame(HEVC_DELTA_QP42, 1500), durationMs: 1000 / 30 });
  assert.ok(Math.abs(hevc.encoded[1]!.lossiness! - 0.18 * (42 / 51)) < 1e-9);
  assert.deepEqual(hevc.port.out.flatMap((m) => (m.t === "estimate-complexity" ? [m.on] : [])), [false]);
});

test("port backend: a frame whose header cannot be read keeps the estimate, which is never turned off", () => {
  const t = backendWithVideo();
  // The bytes of an H.264 frame mean nothing in another codec.
  t.frame(0, { key: true, data: h264Frame(H264_KEY_QP34, 1500), complexity: 0.5, durationMs: 1000 / 30 });
  assert.ok(Math.abs(t.encoded[0]!.lossiness! - 0.09) < 1e-9);
  assert.ok(!t.port.out.some((m) => m.t === "estimate-complexity"));
});

/**
 * A 1888x1062 tab against a 265 kbps video target, as a live session had it: the encoder is at its largest quantizer
 * and its delta frames still come to 3.9 KB, three and a half times the target. `feedback` is what VideoSender
 * reports for a frame (video_sender.cc): the larger of the encoder utilization and the lossiness over the target
 * utilization of 75%, at most 1 for a key frame.
 */
function overTargetSession(codec: "vp8" | "vp9" | "h264", frames: { key: string; delta: string }, complexity: number | undefined) {
  const params: VideoCaptureParams = { width: 1920, height: 1080, frameRate: 30, resolutionChangePolicy: "fixed_aspect_ratio" };
  const t = backendWithVideo(params, 265_000, undefined, codec);
  t.useFeedback((f) => {
    const reported = Math.max(f.encoderUtilization, f.lossiness ?? -1) / 0.75;
    return f.isKeyFrame ? Math.min(1, reported) : reported;
  });
  const size = { width: 1888, height: 1062 };
  let firstChangeMs: number | undefined;
  for (let i = 0; i < 30 * 60; i++) {
    const key = i === 0;
    const chunk = { key, data: h264Frame(key ? frames.key : frames.delta, key ? 12_700 : 3900), durationMs: 1000 / 30, encodeMs: 9 };
    t.frame(i * (1000 / 30), complexity === undefined ? chunk : { ...chunk, complexity }, size);
    if (firstChangeMs === undefined && t.captureSizes().length > 1) firstChangeMs = i * (1000 / 30);
  }
  return { sizes: t.captureSizes(), firstChangeMs };
}

const H264_AT_QP51 = { key: H264_KEY_QP34, delta: H264_DELTA_QP51 };

/** The capture stepped down as an overloaded consumer makes Chrome's oracle step it. */
function assertShrankWithinSeconds({ sizes, firstChangeMs }: ReturnType<typeof overTargetSession>) {
  assert.deepEqual(sizes[0], { width: 1888, height: 1062 });
  assert.ok(sizes.length > 1, "the capture size steps down");
  // HasSufficientRecentFeedback wants three seconds of feedback (kDefaultMinSizeChangePeriod) before the first change.
  assert.ok(firstChangeMs! >= 3000 && firstChangeMs! < 4000, `first change after ${firstChangeMs} ms`);
  // The first step already answers a utilization of about 3.5 / 0.75: well under half the area.
  assert.ok(sizes[1]!.width * sizes[1]!.height < (1888 * 1062) / 2, `first step ${sizes[1]!.width}x${sizes[1]!.height}`);
  for (const s of sizes) assert.ok(Math.abs(s.width / s.height - 16 / 9) < 0.02, "the aspect ratio is kept");
}

test("port backend: an encoder stuck over its target at the largest quantizer makes the capture shrink within seconds", () => {
  assertShrankWithinSeconds(overTargetSession("h264", H264_AT_QP51, undefined));
});

test("port backend: software VP8 and VP9 stuck over their target at Chrome's largest quantizer (58 of 63) shrink the capture too", () => {
  // The lossiness is 3.53 * 58 / 63 = 3.25, whatever the complexity estimate says.
  assertShrankWithinSeconds(overTargetSession("vp8", { key: VP8_KEY_Q58, delta: VP8_DELTA_Q58 }, 0.15));
  assertShrankWithinSeconds(overTargetSession("vp9", { key: VP9_KEY_Q58, delta: VP9_DELTA_Q58 }, undefined));
});

test("port backend: the same frames judged by a low complexity estimate never shrink the capture", () => {
  // What a session did before the quantizer was read (here: frames whose header cannot be read): an estimate of 0.15
  // puts the lossiness at 0.53, under the 0.75 that counts as full utilization.
  const { sizes } = overTargetSession("vp8", H264_AT_QP51, 0.15);
  assert.deepEqual(sizes, [{ width: 1888, height: 1062 }]);
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

test("port backend: a switch to another tab starts a new oracle at the full size, as a new capture device does", async () => {
  const t = backendWithVideo();
  t.useFeedback(() => 2);
  for (let i = 0; i < 600; i++) t.frame(i * 33);
  assert.ok(t.captureSizes().at(-1)!.height < 1080, "shrunk under load first");
  await Promise.resolve();
  t.backend.setSource({ kind: "tab", mediaSourceId: "y" });
  t.backend.switchVideoCaptureHost();
  await Promise.resolve();
  assert.ok(t.port.out.some((m) => m.t === "switch"));
  t.useFeedback(() => 0.5);
  t.frame(600 * 33);
  assert.deepEqual(t.captureSizes().at(-1), { width: 1920, height: 1080 }, "VideoCaptureClient::SwitchVideoCaptureHost starts a new device");
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
