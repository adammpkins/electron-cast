import { test } from "node:test";
import assert from "node:assert/strict";
import { CaptureResolutionChooser, CaptureSizeOracle, FeedbackSignalAccumulator, suggestConstraints } from "../../src/mirroring/sender/capture-size-oracle.ts";

/** Values worked out from media/capture/content/capture_resolution_chooser.cc and video_capture_oracle.cc. */

test("suggestConstraints follows VideoCaptureParams::SuggestConstraints for each resolution change policy", () => {
  const max = { width: 1921, height: 1081 };
  assert.deepEqual(suggestConstraints(max, "fixed_resolution"), { minSize: { width: 1920, height: 1080 }, maxSize: { width: 1920, height: 1080 }, fixedAspectRatio: false });
  assert.deepEqual(suggestConstraints(max, "any_within_limit").minSize, { width: 2, height: 2 });
  const fixedAspect = suggestConstraints({ width: 1920, height: 1080 }, "fixed_aspect_ratio");
  assert.deepEqual(fixedAspect.minSize, { width: 320, height: 180 });
  assert.equal(fixedAspect.fixedAspectRatio, true);
  assert.deepEqual(suggestConstraints({ width: 320, height: 180 }, "fixed_aspect_ratio").minSize, { width: 320, height: 180 });
});

test("the chooser snaps to steps of 90 lines that shrink the area by at least 15%, and picks the size nearest a target area", () => {
  const chooser = new CaptureResolutionChooser();
  chooser.setConstraints({ width: 2, height: 2 }, { width: 1920, height: 1080 }, false);
  chooser.setSourceSize({ width: 1920, height: 1080 });
  assert.deepEqual(chooser.captureSize, { width: 1920, height: 1080 }, "the largest size is the target until a smaller area is asked for");
  const step = (h: number) => ({ width: (h * 16) / 9, height: h });
  assert.deepEqual(chooser.findSmallerFrameSize(1920 * 1080, 1), step(990));
  assert.deepEqual(chooser.findSmallerFrameSize(1920 * 1080, 2), step(900));
  chooser.setTargetFrameArea(1280 * 720);
  assert.deepEqual(chooser.captureSize, step(720));
  assert.deepEqual(chooser.findLargerFrameSize(1280 * 720, 1), step(810));
  chooser.setTargetFrameArea(0);
  assert.ok(chooser.captureSize.height <= 90, "the smallest snapped size is at most one step high");
});

test("a source smaller than the maximum caps the snapped sizes, and a larger one is scaled into the maximum", () => {
  const chooser = new CaptureResolutionChooser();
  chooser.setConstraints({ width: 2, height: 2 }, { width: 1280, height: 720 }, false);
  chooser.setSourceSize({ width: 640, height: 360 });
  assert.deepEqual(chooser.captureSize, { width: 640, height: 360 });
  chooser.setSourceSize({ width: 3840, height: 2160 });
  assert.deepEqual(chooser.captureSize, { width: 1280, height: 720 });
});

test("a fixed resolution has a single size, however much feedback says the consumer is overloaded", () => {
  const oracle = run({ policy: "fixed_resolution", seconds: 20, utilization: () => 3 });
  assert.deepEqual(oracle.captureSize, { width: 1920, height: 1080 });
});

test("with no feedback the capture size never leaves the source size", () => {
  const oracle = run({ policy: "any_within_limit", seconds: 20, utilization: undefined });
  assert.deepEqual(oracle.captureSize, { width: 1920, height: 1080 });
  assert.equal(oracle.isThrottlingActive, false);
});

test("zero or negative utilization is 'not available' and does not start throttling", () => {
  const oracle = run({ policy: "any_within_limit", seconds: 20, utilization: () => 0 });
  assert.equal(oracle.isThrottlingActive, false);
  assert.deepEqual(oracle.captureSize, { width: 1920, height: 1080 });
});

test("sustained overload steps the capture size down, no more often than the minimum size change period, and recovery steps it back up", () => {
  const changes: { at: number; height: number }[] = [];
  const overloaded = run({
    policy: "any_within_limit", seconds: 20, utilization: () => 2,
    onSize: (at, size) => changes.push({ at, height: size.height }),
  });
  assert.equal(overloaded.isThrottlingActive, true);
  assert.ok(overloaded.captureSize.height < 1080, "the size went down");
  // With utilization 2 the consumer is estimated to handle half the area: about 1080 / sqrt(2) lines.
  assert.ok(overloaded.captureSize.height <= 810, `settled at ${overloaded.captureSize.height}`);
  for (let i = 1; i < changes.length; i++) assert.ok(changes[i]!.at - changes[i - 1]!.at >= 3000, "size changes are 3 s apart at least");

  // The same oracle, now lightly loaded and with no animation detected, climbs back to the maximum.
  const recovered = run({ policy: "any_within_limit", seconds: 120, utilization: (t) => (t < 20_000 ? 2 : 0.2) });
  assert.deepEqual(recovered.captureSize, { width: 1920, height: 1080 });
});

test("while content animates, the system has to be under-utilized for 30 s before the size increases", () => {
  const animated = run({ policy: "any_within_limit", seconds: 40, animating: true, utilization: (t) => (t < 10_000 ? 2 : 0.2) });
  assert.ok(animated.captureSize.height < 1080, "no increase yet, 30 s of proof are needed");
  const later = run({ policy: "any_within_limit", seconds: 80, animating: true, utilization: (t) => (t < 10_000 ? 2 : 0.2) });
  assert.ok(later.captureSize.height > animated.captureSize.height, "after the proving period it steps up");
});

test("FeedbackSignalAccumulator is an exponential average with the documented half life, and keeps the greatest value per timestamp", () => {
  const a = new FeedbackSignalAccumulator(1000);
  a.reset(0, 0);
  a.update(1, 1000);
  assert.equal(a.current, 0.5);
  a.update(0.5, 1000); // same timestamp, not greater: ignored
  assert.equal(a.current, 0.5);
  assert.equal(a.update(5, 500), false, "out of order");
  a.update(2, 1000);
  assert.ok(a.current > 0.5);
});

interface RunOptions {
  policy: "fixed_resolution" | "any_within_limit" | "fixed_aspect_ratio";
  seconds: number;
  /** Utilization to report for the frame captured at the given ms, or none. */
  utilization: ((ms: number) => number) | undefined;
  animating?: boolean;
  onSize?: (ms: number, size: { width: number; height: number }) => void;
}

/** 1080p at 30 fps for `seconds` of virtual time, with the consumer's feedback attached to each frame. */
function run(o: RunOptions): CaptureSizeOracle {
  const oracle = new CaptureSizeOracle({ ...suggestConstraints({ width: 1920, height: 1080 }, o.policy), minCapturePeriodMs: 1000 / 30 });
  const t0 = 1_000_000;
  let last = oracle.captureSize;
  for (let i = 0; i * 33 <= o.seconds * 1000; i++) {
    const at = i * 33;
    oracle.setSourceSize({ width: 1920, height: 1080 });
    oracle.observeEvent(t0 + at, o.animating ?? false);
    const frame = oracle.nextFrameNumber;
    oracle.recordCapture(0.1);
    if (o.utilization !== undefined) oracle.recordConsumerFeedback(frame, o.utilization(at));
    if (o.onSize !== undefined && (oracle.captureSize.width !== last.width || oracle.captureSize.height !== last.height)) o.onSize(at, oracle.captureSize);
    last = oracle.captureSize;
  }
  return oracle;
}
