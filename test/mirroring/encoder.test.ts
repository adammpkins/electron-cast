import { test } from "node:test";
import assert from "node:assert/strict";
import type { VideoCodec } from "../../src/mirroring/protocol/constants.ts";
import { createEncodingSupport, hardwareCodecsToProbe, encodingPolicyFromCommandLine, softwareCodecsToProbe, SUPPORTED_VIDEO_CODECS } from "../../src/mirroring/encoding-support.ts";
import { getCodecParameterString } from "../../src/mirroring/mirror-settings.ts";
import { validateH264Frame } from "./media-validate.ts";
import { makeH264Frame } from "./fake-backend.ts";
import { shouldForceLetterboxing } from "../../src/mirroring/mirroring-activity.ts";
import { startHarness, sleep, type Harness } from "./session-harness.ts";

/**
 * Encoder selection and failure, as openscreen_session_host.cc does it: hardware codecs first and software only when
 * none was offered (or taken), a failed hardware encoder deny-listed and the session offered again, the fallback
 * offer after a receiver takes none of the hardware ones. The capture side is the fake backend; "hardware support
 * present or absent" is what `VideoEncoder.isConfigSupported` with `prefer-hardware` would have reported.
 */

const offered = (h: Harness): { codecName: string; codecParameter?: string }[] =>
  (h.receiver.lastOffer!.offer as { supportedStreams: { type: string; codecName: string; codecParameter?: string }[] }).supportedStreams.filter((s) => s.type === "video_source");

test("without a hardware encoder only the software codecs are offered", async () => {
  const h = await startHarness({ receiver: {} });
  try {
    await sleep(300);
    assert.deepEqual(offered(h).map((s) => s.codecName), ["vp8"]);
    assert.equal(h.backend.videoEncoderConfigs[0]!.useHardwareEncoder, false);
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});

test("with a hardware H.264 encoder only H.264 is offered, hardware first, with Chrome's codec parameter", async () => {
  const h = await startHarness({ hardware: ["h264"], receiver: { videoPreference: ["h264", "vp8"] } });
  try {
    await sleep(500);
    assert.deepEqual(offered(h).map((s) => [s.codecName, s.codecParameter]), [["h264", "avc1.4d0028"]], "software VP8 stays out of the offer while a hardware codec is in it");
    assert.equal(h.backend.videoEncoderConfigs[0]!.videoCodec, "h264");
    assert.equal(h.backend.videoEncoderConfigs[0]!.useHardwareEncoder, true);
    assert.ok(h.receiver.stats.videoFrames > 5);
    assert.deepEqual(h.errors, []);
  } finally {
    h.close();
  }
});

test("hardware codecs are offered in kSupportedVideoCodecs order: VP9, H.264, VP8", async () => {
  const h = await startHarness({ hardware: ["vp8", "h264", "vp9"], receiver: {} });
  try {
    await sleep(300);
    assert.deepEqual(SUPPORTED_VIDEO_CODECS, ["hevc", "av1", "vp9", "h264", "vp8"]);
    assert.deepEqual(offered(h).map((s) => s.codecName), ["vp9", "h264", "vp8"]);
  } finally {
    h.close();
  }
});

test("a Mac offers H.264 Baseline (ToProfile, kCastMacForceBaselineProfile)", async () => {
  const h = await startHarness({ hardware: ["h264"], platform: "darwin", receiver: {} });
  try {
    await sleep(300);
    assert.equal(offered(h)[0]!.codecParameter, "avc1.420028");
    assert.equal(getCodecParameterString("h264", 1920, 1080, 60), "avc1.4d002a");
  } finally {
    h.close();
  }
});

test("HEVC and AV1 are never offered by default, even when an encoder exists", async () => {
  const h = await startHarness({ hardware: ["hevc", "av1", "h264"], software: ["vp8", "av1"], receiver: {} });
  try {
    await sleep(300);
    assert.deepEqual(offered(h).map((s) => s.codecName), ["h264"]);
  } finally {
    h.close();
  }
});

test("a hardware encoder that fails mid-session is deny-listed and the session offers again, in software", async () => {
  const denied: VideoCodec[] = [];
  const h = await startHarness({ hardware: ["h264"], receiver: { videoPreference: ["h264", "vp8"] }, onDenyListed: (c) => denied.push(c) });
  try {
    await sleep(500);
    assert.equal(h.backend.videoEncoderConfigs[0]!.videoCodec, "h264");
    const framesBefore = h.receiver.stats.videoFrames;
    h.backend.videoCallbacks!.onStatus("codec_runtime_error", "EncodingError: GPU lost");
    await sleep(900);
    assert.deepEqual(denied, ["h264"]);
    assert.deepEqual(h.errors, [], "an encoder failure that can be worked around is not a session error");
    assert.equal(h.stopped(), false);
    assert.deepEqual(offered(h).map((s) => s.codecName), ["vp8"], "the second offer has no H.264");
    assert.equal(h.backend.videoEncodersCreated, 2);
    assert.deepEqual(h.backend.videoEncoderConfigs.map((c) => [c.videoCodec, c.useHardwareEncoder]), [["h264", true], ["vp8", false]]);
    assert.ok(h.log.some((l) => l.includes("video encoder codec_runtime_error: EncodingError: GPU lost")));
    assert.ok(h.receiver.stats.videoFrames > framesBefore + 5, "frames flow again after the new offer");
    assert.equal(h.receiver.stats.invalidFrames, 0);
  } finally {
    h.close();
  }
});

test("unsupported_codec and codec_init_failed take the same path as a runtime error", async () => {
  for (const status of ["unsupported_codec", "codec_init_failed"] as const) {
    const denied: VideoCodec[] = [];
    const h = await startHarness({ hardware: ["h264"], receiver: { videoPreference: ["h264", "vp8"] }, onDenyListed: (c) => denied.push(c) });
    try {
      await sleep(300);
      h.backend.videoCallbacks!.onStatus(status);
      await sleep(700);
      assert.deepEqual(denied, ["h264"], status);
      assert.deepEqual(h.errors, [], status);
      assert.equal(h.backend.videoEncoderConfigs.at(-1)!.videoCodec, "vp8", status);
    } finally {
      h.close();
    }
  }
});

test("a second status from the failed encoder is ignored, and one from the old encoder does not hit the new one", async () => {
  const denied: VideoCodec[] = [];
  const h = await startHarness({ hardware: ["h264"], receiver: { videoPreference: ["h264", "vp8"] }, onDenyListed: (c) => denied.push(c) });
  try {
    await sleep(300);
    const old = h.backend.videoCallbacks!;
    old.onStatus("codec_runtime_error");
    old.onStatus("codec_runtime_error");
    await sleep(700);
    old.onStatus("codec_runtime_error");
    assert.deepEqual(denied, ["h264"]);
    assert.deepEqual(h.errors, []);
    assert.equal(h.stopped(), false);
    assert.equal(h.backend.videoEncodersCreated, 2);
  } finally {
    h.close();
  }
});

test("a software encoder that fails ends the session, as there is nothing to fall back to", async () => {
  const h = await startHarness({ receiver: {} });
  try {
    await sleep(300);
    h.backend.videoCallbacks!.onStatus("codec_runtime_error");
    assert.deepEqual(h.errors, [{ error: "ENCODING_ERROR", message: "Fatal error in codec runtime." }]);
    assert.equal(h.stopped(), true);
  } finally {
    h.close();
  }
});

test("a hardware encoder that was deny-listed in an earlier session is not offered again", async () => {
  const h = await startHarness({ hardware: ["h264"], denyListed: new Set<VideoCodec>(["h264"]), receiver: { videoPreference: ["h264", "vp8"] } });
  try {
    await sleep(300);
    assert.deepEqual(offered(h).map((s) => s.codecName), ["vp8"]);
    assert.equal(h.backend.videoEncoderConfigs[0]!.useHardwareEncoder, false);
  } finally {
    h.close();
  }
});

test("a receiver that takes none of the hardware codecs gets one more offer with the software codecs", async () => {
  const h = await startHarness({ type: "video_only", hardware: ["h264"], receiver: { videoPreference: ["vp8"] } });
  try {
    await sleep(800);
    assert.deepEqual(offered(h).map((s) => s.codecName), ["h264", "vp8"], "the fallback offer keeps the hardware codec and adds the software ones");
    assert.deepEqual(h.errors, []);
    assert.equal(h.backend.videoEncoderConfigs[0]!.videoCodec, "vp8");
    assert.equal(h.backend.videoEncoderConfigs[0]!.useHardwareEncoder, false);
    assert.ok(h.log.some((l) => l.includes("Attempting fallback to software codecs")));
    assert.ok(h.receiver.stats.videoFrames > 5);
  } finally {
    h.close();
  }
});

test("the fallback offer is made once: a receiver that takes nothing from it ends the session", async () => {
  const h = await startHarness({ type: "video_only", hardware: ["h264"], receiver: { videoPreference: [] } });
  try {
    await sleep(800);
    assert.equal(h.log.filter((l) => l.includes("Attempting fallback")).length, 1);
    assert.equal(h.errors[0]?.error, "ANSWER_NO_AUDIO_OR_VIDEO");
    assert.equal(h.stopped(), true);
  } finally {
    h.close();
  }
});

test("the fallback offer is sent after any NoStreamSelected, hardware offered or not, as Chrome does (OnError)", async () => {
  const h = await startHarness({ type: "video_only", receiver: { videoPreference: ["h264"] } });
  try {
    await sleep(500);
    assert.equal(h.log.filter((l) => l.includes("Attempting fallback")).length, 1);
    assert.equal(h.errors[0]?.error, "ANSWER_NO_AUDIO_OR_VIDEO");
  } finally {
    h.close();
  }
});

// encoding_support.cc

/** A command line as Electron's `app.commandLine` answers for it. */
function cl(...args: string[]) {
  const parsed = new Map(args.map((a) => { const [k, ...v] = a.replace(/^--/, "").split("="); return [k!, v.join("=")] as const; }));
  return { hasSwitch: (n: string) => parsed.has(n), getSwitchValue: (n: string) => parsed.get(n) ?? "" };
}

test("the force-enable and force-disable switches decide which hardware codecs are asked about", () => {
  assert.deepEqual(hardwareCodecsToProbe(encodingPolicyFromCommandLine(cl(), "win32")), ["h264", "vp8", "vp9"], "HEVC and AV1 are off by default");
  const p = encodingPolicyFromCommandLine(cl("--cast-streaming-force-enable-hardware-hevc", "--cast-streaming-force-disable-hardware-vp9", "--cast-streaming-force-disable-hardware-h264", "--cast-streaming-force-enable-hardware-h264", "--other"), "win32");
  assert.deepEqual(hardwareCodecsToProbe(p), ["hevc", "vp8"], "disable wins over enable");
  const support = createEncodingSupport({ hardware: new Set<VideoCodec>(["hevc", "h264", "vp9"]), software: new Set<VideoCodec>() }, { policy: p });
  assert.deepEqual((["hevc", "h264", "vp9", "vp8"] as VideoCodec[]).map((c) => support.isHardwareEnabled(c)), [true, false, false, false]);
});

test("--enable-features and --disable-features switch the CastStreaming codec features", () => {
  const sw = (...args: string[]) => softwareCodecsToProbe(encodingPolicyFromCommandLine(cl(...args), "linux"));
  assert.deepEqual(sw(), ["vp8", "vp9"], "VP8 and VP9 are on by default, AV1 off, H.264 and HEVC have no software encoder");
  assert.deepEqual(sw("--disable-features=CastStreamingVp9"), ["vp8"]);
  assert.deepEqual(sw("--enable-features=CastStreamingAv1:foo/bar,Unrelated"), ["vp8", "vp9", "av1"]);
  assert.deepEqual(sw("--enable-features=CastStreamingAv1", "--disable-features=CastStreamingAv1"), ["vp8", "vp9"], "disable wins");
  const hw = (platform: string, ...args: string[]) => hardwareCodecsToProbe(encodingPolicyFromCommandLine(cl(...args), platform));
  assert.deepEqual(hw("win32", "--disable-features=CastStreamingWinHardwareH264"), ["vp8", "vp9"]);
  assert.deepEqual(hw("darwin", "--disable-features=CastStreamingWinHardwareH264"), ["h264", "vp8", "vp9"], "the Windows feature does not apply on macOS");
  assert.deepEqual(hw("win32", "--enable-features=CastStreamingHardwareHevc"), ["h264", "hevc", "vp8", "vp9"]);
});

test("a codec can be deny-listed once, and then it is not hardware-enabled", () => {
  const seen: VideoCodec[] = [];
  const support = createEncodingSupport({ hardware: new Set<VideoCodec>(["h264"]), software: new Set<VideoCodec>() }, { onDenyListed: (c) => seen.push(c) });
  assert.equal(support.isHardwareEnabled("h264"), true);
  support.denyListHardwareCodec("h264");
  assert.equal(support.isHardwareEnabled("h264"), false);
  assert.equal(support.isHardwareDenyListed("h264"), true);
  assert.throws(() => support.denyListHardwareCodec("h264"));
  assert.deepEqual(seen, ["h264"]);
});

// The receiver's H.264 check (Annex B, parameter sets in the key frame), which is what keeps the encoder honest.

test("the fake receiver accepts Annex B H.264 and refuses length-prefixed AVC", () => {
  assert.deepEqual(validateH264Frame(makeH264Frame(true, 1, 200))?.nalTypes, [7, 8, 5]);
  assert.equal(validateH264Frame(makeH264Frame(false, 1, 200))?.key, false);
  const avc = Buffer.concat([Buffer.from([0, 0, 0, 5, 0x65]), Buffer.alloc(40, 0x55)]);
  assert.equal(validateH264Frame(avc), undefined);
  assert.equal(validateH264Frame(Buffer.concat([Buffer.from([0, 0, 0, 1, 0x65]), Buffer.alloc(40, 0x55)])), undefined, "an IDR with no parameter sets is not a key frame a decoder can start on");
});

test("the H.264 check reads the picture size from the SPS (1920x1080 High profile, cropped from 1088)", () => {
  const sps = Buffer.from("67640028acd940780227e5c044000003000400000300f03c60c658", "hex");
  const frame = Buffer.concat([Buffer.from([0, 0, 0, 1]), sps, Buffer.from([0, 0, 0, 1, 0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0, 0, 0, 0, 1, 0x65, 0x88, 0x84, 0x00])]);
  const info = validateH264Frame(frame);
  assert.deepEqual([info?.key, info?.width, info?.height], [true, 1920, 1080]);
});

// Letterboxing: the capture's resolution_change_policy (openscreen_session_host.cc SetConstraints, mirror_settings.cc GetVideoCaptureParams).

test("a receiver that cannot scale gets sender-side letterboxing: a fixed aspect ratio capture", async () => {
  const h = await startHarness({ receiver: { aspectRatioConstraint: "fixed" } });
  try {
    await sleep(300);
    assert.deepEqual(h.backend.videoCaptureStarts.map((p) => [p.width, p.height, p.resolutionChangePolicy]), [[1920, 1080, "fixed_aspect_ratio"]]);
  } finally {
    h.close();
  }
});

test("a receiver that scales gets any size within the limit, unless the model forces letterboxing", async () => {
  const free = await startHarness({ receiver: { aspectRatioConstraint: "variable" } });
  const forced = await startHarness({ receiver: { aspectRatioConstraint: "variable" }, forceLetterboxing: true });
  try {
    await sleep(300);
    assert.equal(free.backend.videoCaptureStarts[0]!.resolutionChangePolicy, "any_within_limit");
    assert.equal(forced.backend.videoCaptureStarts[0]!.resolutionChangePolicy, "fixed_aspect_ratio");
  } finally {
    free.close();
    forced.close();
  }
});

test("a Nest Hub is always letterboxed, unless --disable-cast-letterboxing", () => {
  assert.equal(shouldForceLetterboxing("Google Nest Hub", cl()), true);
  assert.equal(shouldForceLetterboxing("Google Nest Hub Max", cl()), true);
  assert.equal(shouldForceLetterboxing("Chromecast Ultra", cl()), false);
  assert.equal(shouldForceLetterboxing("Google Nest Hub", cl("--disable-cast-letterboxing")), false);
});
