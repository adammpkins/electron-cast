import { test } from "node:test";
import assert from "node:assert/strict";
import { FrameSender, MAX_FRAME_BURST, toFrameDropReason, type FrameSenderClient, type SenderEncodedFrame, type SenderView } from "../../src/mirroring/sender/frame-sender.ts";
import { VideoSender, type VideoEncoderPort, type RawVideoFrame } from "../../src/mirroring/sender/video-sender.ts";
import { AudioSender } from "../../src/mirroring/sender/audio-sender.ts";
import type { EncodedFrame } from "../../src/mirroring/rtp/frame.ts";
import type { EnqueueFrameResult } from "../../src/mirroring/sender/sender.ts";

class FakeSender implements SenderView {
  inFlightFrameCount = 0;
  nextFrameId = 0;
  needsKeyFrame = false;
  currentRoundTripTimeMs = 0;
  maxInFlight = 100;
  inFlightDuration = 0;
  result: EnqueueFrameResult = "OK";
  enqueued: EncodedFrame[] = [];
  getInFlightMediaDuration(): number {
    return this.inFlightDuration;
  }
  getMaxInFlightMediaDuration(): number {
    return this.maxInFlight;
  }
  enqueueFrame(f: EncodedFrame): EnqueueFrameResult {
    if (this.result === "OK") {
      this.enqueued.push(f);
      this.nextFrameId++;
      this.inFlightFrameCount++;
    }
    return this.result;
  }
}

const client = (inEncoder = 0, backlog = 0): FrameSenderClient => ({ getNumberOfFramesInEncoder: () => inEncoder, getEncoderBacklogDuration: () => backlog });

function make(over: { max?: number; min?: number; target?: number; fps?: number; audio?: boolean } = {}, c: FrameSenderClient = client()) {
  const sender = new FakeSender();
  let now = 0;
  const fs = new FrameSender(
    { maxFrameRate: over.fps ?? 30, isAudio: over.audio ?? false, minPlayoutDelayMs: over.min ?? 200, maxPlayoutDelayMs: over.max ?? 400 },
    sender,
    c,
    over.target ?? 200,
    () => now,
  );
  return { sender, fs, advance: (ms: number) => (now += ms) };
}

const frame = (id: number, over: Partial<SenderEncodedFrame> = {}): SenderEncodedFrame => ({
  isKeyFrame: id === 0,
  frameId: id,
  referencedFrameId: id === 0 ? 0 : id - 1,
  rtpTimestamp: 3000 * (id + 1),
  referenceTimeMs: 10 * id,
  newPlayoutDelayMs: 0,
  data: new Uint8Array(10).fill(1),
  encoderUtilization: 0.5,
  ...over,
});

test("openscreen enqueue results map to the drop reasons of ToFrameDropReason", () => {
  assert.equal(toFrameDropReason("OK"), "kNotDropped");
  assert.equal(toFrameDropReason("PAYLOAD_TOO_LARGE"), "kPayloadTooLarge");
  assert.equal(toFrameDropReason("REACHED_ID_SPAN_LIMIT"), "kReachedIdSpanLimit");
  assert.equal(toFrameDropReason("MAX_DURATION_IN_FLIGHT"), "kInFlightDurationTooHighAfterEncoding");
});

test("the first frame carries the target playout delay, and later frames do not repeat it", () => {
  const { fs, sender } = make({ target: 250 });
  assert.equal(fs.enqueueFrame(frame(0)), "kNotDropped");
  assert.equal(fs.enqueueFrame(frame(1)), "kNotDropped");
  assert.equal(sender.enqueued[0]!.newPlayoutDelayMs, 250);
  assert.equal(sender.enqueued[1]!.newPlayoutDelayMs, 0);
  fs.setTargetPlayoutDelay(300);
  fs.enqueueFrame(frame(2));
  assert.equal(sender.enqueued[2]!.newPlayoutDelayMs, 300);
});

test("the target playout delay is clamped to the configured range", () => {
  const { fs } = make({ min: 200, max: 400, target: 100 });
  assert.equal(fs.targetPlayoutDelay, 200);
  fs.setTargetPlayoutDelay(900);
  assert.equal(fs.targetPlayoutDelay, 400);
});

test("a frame is renumbered with the sender's id after a refusal, and one referencing a refused frame is dropped", () => {
  const { fs, sender } = make();
  assert.equal(fs.enqueueFrame(frame(0)), "kNotDropped");
  sender.result = "MAX_DURATION_IN_FLIGHT";
  assert.equal(fs.enqueueFrame(frame(1)), "kInFlightDurationTooHighAfterEncoding");
  sender.result = "OK";
  // Frame 2 references the refused frame 1: the receiver could not decode it.
  assert.equal(fs.enqueueFrame(frame(2)), "kInvalidReferencedFrameId");
  // A key frame references itself and is accepted under the sender's next id (1).
  assert.equal(fs.enqueueFrame(frame(3, { isKeyFrame: true, referencedFrameId: 3 })), "kNotDropped");
  assert.equal(sender.enqueued[1]!.frameId, 1);
  assert.equal(sender.enqueued[1]!.referencedFrameId, 1);
  // The next delta frame references frame 3 which the sender numbered 1.
  fs.enqueueFrame(frame(4));
  assert.equal(sender.enqueued[2]!.frameId, 2);
  assert.equal(sender.enqueued[2]!.referencedFrameId, 1);
});

test("shouldDropNextFrame applies the three limits in order", () => {
  const a = make({}, client(0, 0));
  a.sender.inFlightFrameCount = 120;
  assert.equal(a.fs.shouldDropNextFrame(33, 1), "kTooManyFramesInFlight");

  // 30 fps and 100 ms in flight allow 3 frames plus a burst of 5: 8 or more are refused.
  const b = make({}, client(0, 0));
  b.fs.enqueueFrame(frame(0));
  b.sender.inFlightFrameCount = 8;
  b.sender.inFlightDuration = 100;
  assert.equal(MAX_FRAME_BURST, 5);
  assert.equal(b.fs.shouldDropNextFrame(33, 9000), "kBurstThresholdExceeded");
  b.sender.inFlightFrameCount = 7;
  assert.equal(b.fs.shouldDropNextFrame(33, 9000), "kNotDropped");

  const c = make({}, client(0, 0));
  c.fs.enqueueFrame(frame(0));
  c.sender.inFlightDuration = 101;
  c.sender.maxInFlight = 100;
  assert.equal(c.fs.shouldDropNextFrame(33, 9000), "kInFlightDurationTooHigh");
});

test("with frames in the encoder the duration is the estimate plus the frame, not the sender's figure", () => {
  const { fs, sender } = make({}, client(1, 30));
  fs.enqueueFrame(frame(0));
  sender.inFlightDuration = 0; // the sender knows nothing about the frame in the encoder
  sender.maxInFlight = 50;
  // estimate = 30 ms backlog + min(sender duration 0, 1 * 33 ms) = 30; + 33 ms of the next frame > 50.
  assert.equal(fs.shouldDropNextFrame(33, 9000), "kInFlightDurationTooHigh");
  assert.equal(fs.shouldDropNextFrame(10, 9000), "kNotDropped");
});

class FakeEncoder implements VideoEncoderPort {
  keyFrames = 0;
  bitrates: number[] = [];
  accept = true;
  encoded: RawVideoFrame[] = [];
  generateKeyFrame(): void {
    this.keyFrames++;
  }
  setBitRate(b: number): void {
    this.bitrates.push(b);
  }
  setMaxFrameRate(): void {}
  encodeVideoFrame(f: RawVideoFrame): boolean {
    if (this.accept) this.encoded.push(f);
    return this.accept;
  }
}

function makeVideo(bandwidth: { v: number }) {
  const sender = new FakeSender();
  const encoder = new FakeEncoder();
  const delays: number[] = [];
  const feedback: number[] = [];
  // The VideoSender is the frame sender's client (it counts frames in the encoder).
  let vs: VideoSender;
  const proxy: FrameSenderClient = {
    getNumberOfFramesInEncoder: () => vs.getNumberOfFramesInEncoder(),
    getEncoderBacklogDuration: () => vs.getEncoderBacklogDuration(),
  };
  const fs = new FrameSender({ maxFrameRate: 30, isAudio: false, minPlayoutDelayMs: 200, maxPlayoutDelayMs: 400 }, sender, proxy, 200, () => 0);
  vs = new VideoSender(fs, encoder, { minBitrate: 300_000, maxBitrate: 5_000_000, minPlayoutDelayMs: 200, maxPlayoutDelayMs: 400 }, () => bandwidth.v, (d) => delays.push(d), (u) => feedback.push(u));
  return { sender, encoder, delays, feedback, fs, vs };
}

const raw = (n: number, over: Partial<RawVideoFrame> = {}): RawVideoFrame => ({ rtpTimestamp: 3000 * (n + 1), visibleRectEmpty: false, ...over });

test("VideoSender clamps the suggested bitrate and only updates the encoder on a change of more than 5%", () => {
  const bw = { v: 10_000_000 };
  const { vs, encoder, sender } = makeVideo(bw);
  sender.maxInFlight = 10_000;
  vs.insertRawVideoFrame(raw(0), 0);
  assert.deepEqual(encoder.bitrates, [5_000_000], "clamped to the maximum");
  bw.v = 4_900_000; // 2% lower
  vs.insertRawVideoFrame(raw(1), 33);
  assert.deepEqual(encoder.bitrates, [5_000_000]);
  bw.v = 4_000_000;
  vs.insertRawVideoFrame(raw(2), 66);
  assert.deepEqual(encoder.bitrates, [5_000_000, 4_000_000]);
  bw.v = 10_000;
  vs.insertRawVideoFrame(raw(3), 100);
  assert.equal(encoder.bitrates.at(-1), 300_000, "clamped to the minimum");
});

test("VideoSender drops a frame whose timestamps do not increase", () => {
  const { vs, encoder } = makeVideo({ v: 1_000_000 });
  vs.insertRawVideoFrame(raw(0), 0);
  vs.insertRawVideoFrame(raw(0), 33);
  vs.insertRawVideoFrame(raw(1), 0);
  assert.equal(encoder.encoded.length, 1);
});

test("VideoSender requests a key frame on a PLI at most once per max(500 ms, 6 * playout delay)", () => {
  const { vs, encoder, sender } = makeVideo({ v: 1_000_000 });
  sender.needsKeyFrame = true;
  vs.insertRawVideoFrame(raw(0), 0);
  assert.equal(encoder.keyFrames, 1);
  vs.insertRawVideoFrame(raw(1), 600);
  assert.equal(encoder.keyFrames, 1, "6 * 200 ms playout delay = 1200 ms is the interval");
  vs.insertRawVideoFrame(raw(2), 1300);
  assert.equal(encoder.keyFrames, 2);
});

test("VideoSender raises the playout delay to 4 round trips + 75 ms on a drop, capped at the maximum", () => {
  const { vs, sender, delays } = makeVideo({ v: 1_000_000 });
  sender.currentRoundTripTimeMs = 50;
  sender.inFlightFrameCount = 120;
  vs.insertRawVideoFrame(raw(0), 0);
  assert.deepEqual(delays, [275]);
  sender.currentRoundTripTimeMs = 200; // 875 ms, capped at 400
  vs.insertRawVideoFrame(raw(1), 33);
  assert.deepEqual(delays, [275, 400]);
  assert.equal(vs.framesDroppedBeforeEncoding, 2);
  assert.deepEqual([...vs.dropReasons], [["kTooManyFramesInFlight", 2]]);
});

test("interactive content drops to the minimum playout delay and prefers dropping frames to raising it", () => {
  const { vs, sender, delays } = makeVideo({ v: 1_000_000 });
  sender.currentRoundTripTimeMs = 50;
  sender.inFlightFrameCount = 120;
  vs.insertRawVideoFrame(raw(0, { interactiveContent: true }), 0);
  assert.deepEqual(delays, [200], "only the switch to low latency, no raise on the drop");
});

test("a frame refused after encoding makes the encoder produce a key frame", () => {
  const { vs, encoder, sender } = makeVideo({ v: 1_000_000 });
  vs.insertRawVideoFrame(raw(0), 0);
  sender.result = "MAX_DURATION_IN_FLIGHT";
  vs.onEncodedVideoFrame(0, frame(0));
  assert.equal(encoder.keyFrames, 1);
  assert.equal(vs.framesDroppedAfterEncoding, 1);
  assert.deepEqual([...vs.dropReasons], [["kInFlightDurationTooHighAfterEncoding", 1]]);
});

test("encoder utilization feedback is attenuated by 75%, key frames cap at 1, and an encoder drop reports at least 1", () => {
  const { vs, feedback } = makeVideo({ v: 1_000_000 });
  vs.insertRawVideoFrame(raw(0), 0);
  vs.insertRawVideoFrame(raw(1), 33);
  vs.insertRawVideoFrame(raw(2), 66);
  vs.onEncodedVideoFrame(0, frame(0, { encoderUtilization: 1.5 }));
  vs.onEncodedVideoFrame(33, frame(1, { encoderUtilization: 0.3 }));
  vs.onEncodedVideoFrame(66, frame(2, { data: new Uint8Array(0), encoderUtilization: 0.1 }));
  assert.equal(feedback[0], 1, "a key frame at 1.5 / 0.75 = 2 is capped");
  assert.ok(Math.abs(feedback[1]! - 0.4) < 1e-9);
  assert.ok(Math.abs(feedback[2]! - 1 / 0.75) < 1e-9);
  assert.equal(vs.framesDroppedByEncoder, 1);
  assert.deepEqual([...vs.dropReasons], [["kDroppedByEncoder", 1]]);
  assert.equal(vs.framesDroppedBeforeEncoding + vs.framesDroppedAfterEncoding, 0, "encoder drops are not part of GetFramesDropped");
});

test("AudioSender sets the max frame rate from samples per frame, counts partial frames, and drops under the limits", () => {
  const sender = new FakeSender();
  let as: AudioSender;
  const proxy: FrameSenderClient = { getNumberOfFramesInEncoder: () => as.getNumberOfFramesInEncoder(), getEncoderBacklogDuration: () => as.getEncoderBacklogDuration() };
  const fs = new FrameSender({ maxFrameRate: 100, isAudio: true, minPlayoutDelayMs: 200, maxPlayoutDelayMs: 400 }, sender, proxy, 200, () => 0);
  as = new AudioSender(fs, 48000, 480);
  assert.equal(fs.maxRate, 100);
  sender.maxInFlight = 1000;
  assert.equal(as.insertAudio(480), true);
  assert.equal(as.insertAudio(240), true);
  assert.equal(as.getNumberOfFramesInEncoder(), 1);
  assert.equal(as.getEncoderBacklogDuration(), 15);
  as.onEncodedAudioFrame(frame(0, { isKeyFrame: true, referencedFrameId: 0 }), 0);
  assert.equal(as.getEncoderBacklogDuration(), 5, "720 samples in, 480 out");
  as.onEncodedAudioFrame(frame(1, { isKeyFrame: true, referencedFrameId: 1 }), 0);
  assert.equal(as.getEncoderBacklogDuration(), 0, "the backlog never goes below zero");
  sender.inFlightFrameCount = 120;
  assert.equal(as.insertAudio(480), false);
  assert.equal(as.framesDropped, 1);
  assert.deepEqual([...as.dropReasons], [["kTooManyFramesInFlight", 1]]);
});
