import { test } from "node:test";
import assert from "node:assert/strict";
import { MirrorSettings, displaySizeInPixels, getCaptureResolutionConstraint, getClampedResolution } from "../../src/mirroring/mirror-settings.ts";
import {
  bandwidthBackoffParams, castStreaming60fps, castStreamingGradualBandwidthBackoff, castStreamingMaxVideoBitrate, castStreamingOfferHardwareFirst, castStreamingCongestionSignal, castStreamingPerformanceOverlay, featureParams, systemAudioCaptureSupported,
} from "../../src/electron/switches.ts";
import { VideoSender } from "../../src/mirroring/sender/video-sender.ts";
import type { PerformanceOverlayInfo, RawVideoFrame } from "../../src/mirroring/sender/video-sender.ts";
import { FrameSender } from "../../src/mirroring/sender/frame-sender.ts";

const commandLine = (args: string[]) => {
  const parsed = new Map(args.map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k!, v.join("=")] as const; }));
  return { hasSwitch: (n: string) => parsed.has(n), getSwitchValue: (n: string) => parsed.get(n) ?? "" };
};

test("GetClampedResolution: capped at 1080p in 160x90 steps, landscape, never below one step", () => {
  const cases: [[number, number], [number, number]][] = [
    [[3840, 2160], [1920, 1080]],
    [[2560, 1440], [1920, 1080]],
    [[1920, 1080], [1920, 1080]],
    [[1366, 768], [1280, 720]],      // 16:9 steps: 768 -> 720 high, 1280 wide
    [[1280, 800], [1280, 720]],      // 16:10 is wider than 16:9 limited by width: 1280x720
    [[1920, 1200], [1920, 1080]],
    [[3440, 1440], [1920, 1080]],    // ultrawide: height 1440 capped to 1080
    [[1080, 1920], [1920, 1080]],    // portrait is swapped to landscape
    [[1024, 768], [960, 540]],       // 4:3: limited by width, 1024 -> 960
    [[100, 50], [160, 90]],
    [[0, 0], [160, 90]],
  ];
  for (const [[w, h], [ew, eh]] of cases) assert.deepEqual(getClampedResolution({ width: w, height: h }), { width: ew, height: eh }, `${w}x${h}`);
});

test("GetSizeInPixel scales the DIP size and floors it; GetCaptureResolutionConstraint uses the primary display, else 1080p", () => {
  assert.deepEqual(displaySizeInPixels({ size: { width: 1093, height: 614 }, scaleFactor: 1.25 }), { width: 1366, height: 767 });
  assert.deepEqual(getCaptureResolutionConstraint({ getPrimaryDisplay: () => ({ size: { width: 1280, height: 720 }, scaleFactor: 1.5 }) }), { width: 1920, height: 1080 });
  assert.deepEqual(getCaptureResolutionConstraint({ getPrimaryDisplay: () => ({ size: { width: 1280, height: 720 }, scaleFactor: 1 }) }), { width: 1280, height: 720 });
  assert.deepEqual(getCaptureResolutionConstraint({ getPrimaryDisplay: () => ({ size: { width: 800, height: 600 }, scaleFactor: 1 }) }), { width: 800, height: 450 });
  assert.deepEqual(getCaptureResolutionConstraint(undefined), { width: 1920, height: 1080 });
  assert.deepEqual(getCaptureResolutionConstraint({ getPrimaryDisplay: () => { throw new Error("no screen"); } }), { width: 1920, height: 1080 });
});

test("FeatureParam syntax: --enable-features=Feature:name/value/name/value", () => {
  const p = (arg: string, feature = "F") => [...featureParams(commandLine([arg]), feature)];
  assert.deepEqual(p("--enable-features=F:a/1/b/two%20words"), [["a", "1"], ["b", "two words"]]);
  assert.deepEqual(p("--enable-features=Other,F<Trial.Group:a/1,G:a/2"), [["a", "1"]]);
  assert.deepEqual(p("--enable-features=F:a/1,F:a/2"), [["a", "1"]], "the first entry wins");
  assert.deepEqual(p("--enable-features=F:a"), [], "a name without a value is malformed");
  assert.deepEqual(p("--enable-features=F:a/1:b/2"), []);
  const both = commandLine(["--enable-features=F:a/1", "--disable-features=F"]);
  assert.equal(featureParams(both, "F").size, 0, "a disabled feature has no parameters");
  assert.equal(featureParams(undefined, "F").size, 0);
});

test("congestion_signal of CastStreamingGradualBandwidthBackoff", () => {
  const signal = (...args: string[]) => castStreamingCongestionSignal(commandLine(args));
  assert.equal(signal(), "before_or_after_encoding");
  assert.equal(signal("--enable-features=CastStreamingGradualBandwidthBackoff:congestion_signal/before_encoding"), "before_encoding");
  assert.equal(signal("--enable-features=CastStreamingGradualBandwidthBackoff:congestion_signal/after_encoding"), "after_encoding");
  assert.equal(signal("--enable-features=CastStreamingGradualBandwidthBackoff:congestion_signal/before_or_after_encoding"), "before_or_after_encoding");
  assert.equal(signal("--enable-features=CastStreamingGradualBandwidthBackoff"), "before_or_after_encoding");
  assert.equal(signal("--enable-features=CastStreamingGradualBandwidthBackoff:min_backoff_factor/0.6"), "before_or_after_encoding");
  const warnings: string[] = [];
  assert.equal(castStreamingCongestionSignal(commandLine(["--enable-features=CastStreamingGradualBandwidthBackoff:congestion_signal/bogus"]), (m) => warnings.push(m)), "before_or_after_encoding");
  assert.equal(warnings.length, 1);
  assert.equal(signal("--enable-features=CastStreamingGradualBandwidthBackoff:congestion_signal/after_encoding", "--disable-features=CastStreamingGradualBandwidthBackoff"), "before_or_after_encoding");
});

test("performance overlay and Pulseaudio loopback features default off; the loopback only matters on Linux", () => {
  assert.equal(castStreamingPerformanceOverlay(commandLine([])), false);
  assert.equal(castStreamingPerformanceOverlay(commandLine(["--enable-features=CastStreamingPerformanceOverlay"])), true);
  assert.equal(systemAudioCaptureSupported(commandLine([]), "linux"), false);
  assert.equal(systemAudioCaptureSupported(commandLine(["--enable-features=PulseaudioLoopbackForCast"]), "linux"), true);
  assert.equal(systemAudioCaptureSupported(commandLine([]), "win32"), true);
  assert.equal(systemAudioCaptureSupported(commandLine([]), "darwin"), true);
});

test("VideoSender hands the overlay its numbers only when the feature is on", () => {
  const seen: (PerformanceOverlayInfo | undefined)[] = [];
  const make = (overlay: boolean) => {
    const frameSender = { shouldDropNextFrame: () => "kNotDropped", needsKeyFrame: false, maxRate: 30, targetPlayoutDelay: 200 } as unknown as FrameSender;
    const sender = new VideoSender(
      frameSender,
      { generateKeyFrame() {}, setBitRate() {}, setMaxFrameRate() {}, encodeVideoFrame: (_f, _t, o) => { seen.push(o); return true; } },
      { minBitrate: 300_000, maxBitrate: 5_000_000, minPlayoutDelayMs: 200, maxPlayoutDelayMs: 200 },
      () => 8_000_000,
      () => {},
    );
    sender.performanceOverlay = overlay;
    return sender;
  };
  const frame = (rtp: number): RawVideoFrame => ({ rtpTimestamp: rtp, visibleRectEmpty: false });
  make(false).insertRawVideoFrame(frame(1000), 100);
  const on = make(true);
  on.insertRawVideoFrame(frame(1000), 100);
  on.insertRawVideoFrame(frame(4000), 133);
  assert.equal(seen[0], undefined);
  assert.deepEqual(seen[1], { targetPlayoutDelayMs: 200, lowLatencyMode: false, targetBitrate: 5_000_000, framesAgo: 1, encoderUtilization: -1, lossiness: -1 });
  assert.equal(seen[2]!.framesAgo, 2, "frames_in_encoder_ + 1");
});

test("CastStreaming60fps is off by default and the max frame rate follows it", () => {
  assert.equal(castStreaming60fps(commandLine([])), false);
  assert.equal(castStreaming60fps(commandLine(["--enable-features=CastStreaming60fps"])), true);
  assert.equal(castStreaming60fps(commandLine(["--enable-features=CastStreaming60fps", "--disable-features=CastStreaming60fps"])), false);
  assert.equal(new MirrorSettings(undefined, {}).maxFrameRate, 30);
  assert.equal(new MirrorSettings(undefined, {}, true).maxFrameRate, 60);
  assert.equal(new MirrorSettings(undefined, {}, true).getVideoConfig("vp8").maxFrameRate, 60);
});

test("CastStreamingMaxVideoBitrate: max_bitrate_mbps (default 5), the legacy 5 Mbps when the feature is off, start at most 10 Mbps", () => {
  const bitrate = (...args: string[]) => castStreamingMaxVideoBitrate(commandLine(args));
  assert.equal(bitrate(), 5_000_000);
  assert.equal(bitrate("--enable-features=CastStreamingMaxVideoBitrate"), 5_000_000);
  assert.equal(bitrate("--enable-features=CastStreamingMaxVideoBitrate:max_bitrate_mbps/8"), 8_000_000);
  assert.equal(bitrate("--enable-features=CastStreamingMaxVideoBitrate:max_bitrate_mbps/20"), 20_000_000);
  assert.equal(bitrate("--disable-features=CastStreamingMaxVideoBitrate", "--enable-features=CastStreamingMaxVideoBitrate:max_bitrate_mbps/8"), 5_000_000);
  const warnings: string[] = [];
  assert.equal(castStreamingMaxVideoBitrate(commandLine(["--enable-features=CastStreamingMaxVideoBitrate:max_bitrate_mbps/fast"]), (m) => warnings.push(m)), 5_000_000);
  assert.equal(warnings.length, 1);
  assert.equal(bitrate("--enable-features=CastStreamingMaxVideoBitrate:max_bitrate_mbps/"), 5_000_000);
  assert.equal(bitrate("--enable-features=CastStreamingMaxVideoBitrate:max_bitrate_mbps/6.5"), 5_000_000, "StringToInt rejects a fraction");
  const high = new MirrorSettings(undefined, {}, false, 20_000_000).getVideoConfig("vp8");
  assert.equal(high.maxBitrate, 20_000_000);
  assert.equal(high.startBitrate, 10_000_000);
  const low = new MirrorSettings(undefined, {}, false, 3_000_000).getVideoConfig("vp8");
  assert.equal(low.startBitrate, 3_000_000);
});

test("GradualBandwidthBackoff parameters are read as doubles and clamped as GetBandwidthBackoffParams clamps them", () => {
  const f = "--enable-features=CastStreamingGradualBandwidthBackoff:";
  assert.deepEqual(bandwidthBackoffParams(commandLine([])), { goodNetworkCitizenFactor: 0.8, minBackoffFactor: 0.5, maxBackoffFactor: 0.85, fastRecoveryIncrease: 1.5, conservativeIncrease: 1.1 });
  assert.deepEqual(
    bandwidthBackoffParams(commandLine([f + "good_network_citizen_factor/0.9/min_backoff_factor/0.3/max_backoff_factor/0.7/fast_recovery_increase/2/conservative_increase/1.25"])),
    { goodNetworkCitizenFactor: 0.9, minBackoffFactor: 0.3, maxBackoffFactor: 0.7, fastRecoveryIncrease: 2, conservativeIncrease: 1.25 },
  );
  // Out of range values are clamped; the maximum backoff is held to the minimum and the fast recovery to the conservative increase.
  assert.deepEqual(
    bandwidthBackoffParams(commandLine([f + "good_network_citizen_factor/5/min_backoff_factor/0.05/max_backoff_factor/0.01/fast_recovery_increase/1.2/conservative_increase/9"])),
    { goodNetworkCitizenFactor: 1, minBackoffFactor: 0.1, maxBackoffFactor: 0.1, fastRecoveryIncrease: 4, conservativeIncrease: 4 },
  );
  assert.equal(bandwidthBackoffParams(commandLine([f + "good_network_citizen_factor/0.01"])).goodNetworkCitizenFactor, 0.1);
  assert.equal(bandwidthBackoffParams(commandLine([f + "conservative_increase/0.5"])).conservativeIncrease, 1);
  assert.equal(bandwidthBackoffParams(commandLine([f + "conservative_increase/3"])).fastRecoveryIncrease, 3, "the fast recovery is at least the conservative increase");
  // An unparsable value is the default, with a warning; an empty one is the default quietly.
  const warnings: string[] = [];
  assert.equal(bandwidthBackoffParams(commandLine([f + "min_backoff_factor/half/max_backoff_factor/"]), (m) => warnings.push(m)).minBackoffFactor, 0.5);
  assert.equal(warnings.length, 1);
  // Parameters only count when the feature is enabled on the command line.
  assert.equal(bandwidthBackoffParams(commandLine([f + "min_backoff_factor/0.3", "--disable-features=CastStreamingGradualBandwidthBackoff"])).minBackoffFactor, 0.5);
});

test("CastStreamingGradualBandwidthBackoff and CastStreamingOfferHardwareFirst are on by default and --disable-features turns them off", () => {
  for (const [fn, name] of [[castStreamingGradualBandwidthBackoff, "CastStreamingGradualBandwidthBackoff"], [castStreamingOfferHardwareFirst, "CastStreamingOfferHardwareFirst"]] as const) {
    assert.equal(fn(commandLine([])), true);
    assert.equal(fn(commandLine([`--disable-features=${name}`])), false);
    assert.equal(fn(commandLine([`--disable-features=Other,${name}`, `--enable-features=${name}`])), false, "disable wins");
    assert.equal(fn(commandLine([`--enable-features=${name}`])), true);
  }
});
