import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAudioStream,
  createVideoStream,
  offerMessage,
  scrubOffer,
  getCapabilitiesMessage,
  parseFraction,
  type Offer,
} from "../../src/mirroring/protocol/offer.ts";
import { MessageParseError, parseAnswer, parseReceiverMessage } from "../../src/mirroring/protocol/answer.ts";
import { getRecommendations } from "../../src/mirroring/protocol/recommendations.ts";

const fixedRandom = (n: number) => Buffer.alloc(n, 0xab);

function offer(): Offer {
  return {
    castMode: "mirroring",
    audioStreams: [
      createAudioStream(0, { codec: "opus", channels: 2, bitRate: 128000, sampleRate: 48000, targetPlayoutDelayMs: 200 }, { random: fixedRandom, randomUnit: () => 0 }),
    ],
    videoStreams: [
      createVideoStream(
        1,
        {
          codec: "vp8",
          maxFrameRate: { numerator: 30, denominator: 1 },
          maxBitRate: 5_000_000,
          resolutions: [{ width: 1920, height: 1080 }],
          targetPlayoutDelayMs: 200,
        },
        { random: fixedRandom, randomUnit: () => 0 },
      ),
    ],
  };
}

test("OFFER carries the fields openscreen's Stream/AudioStream/VideoStream::ToJson writes", () => {
  const msg = offerMessage(7, offer()) as { type: string; seqNum: number; offer: { castMode: string; supportedStreams: Record<string, unknown>[] } };
  assert.equal(msg.type, "OFFER");
  assert.equal(msg.seqNum, 7);
  assert.equal(msg.offer.castMode, "mirroring");
  const [audio, video] = msg.offer.supportedStreams as [Record<string, unknown>, Record<string, unknown>];
  // Audio first (index 0), then video, with the Android RTP hack on by default (sender_session.h).
  assert.deepEqual(audio, {
    index: 0,
    type: "audio_source",
    channels: 2,
    rtpPayloadType: 127,
    rtpProfile: "cast",
    ssrc: 1,
    targetDelay: 200,
    aesKey: "ab".repeat(16),
    aesIvMask: "ab".repeat(16),
    receiverRtcpEventLog: true,
    timeBase: "1/48000",
    codecParameter: "",
    codecName: "opus",
    bitRate: 128000,
  });
  assert.deepEqual(video, {
    index: 1,
    type: "video_source",
    channels: 1,
    rtpPayloadType: 96,
    rtpProfile: "cast",
    ssrc: 50001,
    targetDelay: 200,
    aesKey: "ab".repeat(16),
    aesIvMask: "ab".repeat(16),
    receiverRtcpEventLog: true,
    timeBase: "1/90000",
    codecParameter: "",
    codecName: "vp8",
    maxFrameRate: "30/1",
    maxBitRate: 5_000_000,
    protection: "",
    profile: "",
    level: "",
    errorRecoveryMode: "",
    resolutions: [{ width: 1920, height: 1080 }],
  });
});

test("a video max bit rate under 300 kbps becomes 10 Mbps, audio below 32 kbps is raised (CreateStream)", () => {
  const v = createVideoStream(0, { codec: "vp9", maxFrameRate: { numerator: 30, denominator: 1 }, maxBitRate: 1000, resolutions: [{ width: 1, height: 1 }], targetPlayoutDelayMs: 1 }, { useAndroidRtpHack: false });
  assert.equal(v.maxBitRate, 10_000_000);
  assert.equal(v.stream.rtpPayloadType, 100);
  const a = createAudioStream(0, { codec: "opus", channels: 2, bitRate: 1, sampleRate: 48000, targetPlayoutDelayMs: 1 }, { useAndroidRtpHack: false });
  assert.equal(a.bitRate, 32000);
  assert.equal(a.stream.rtpPayloadType, 96);
});

test("the log copy of an OFFER redacts key and IV mask", () => {
  const scrubbed = JSON.stringify(scrubOffer(offerMessage(1, offer())));
  assert.ok(!scrubbed.includes("abab"));
  assert.equal((scrubbed.match(/\[REDACTED\]/g) ?? []).length, 4);
});

test("GET_CAPABILITIES", () => {
  assert.deepEqual(getCapabilitiesMessage(3), { type: "GET_CAPABILITIES", seqNum: 3 });
});

test("fractions", () => {
  assert.deepEqual(parseFraction("30000/1001"), { numerator: 30000, denominator: 1001 });
  assert.deepEqual(parseFraction(30), { numerator: 30, denominator: 1 });
  assert.equal(parseFraction("1/0"), undefined);
});

const answerJson = {
  udpPort: 50000,
  sendIndexes: [0, 1],
  ssrcs: [2, 50002],
  constraints: {
    audio: { maxSampleRate: 48000, maxChannels: 2, minBitRate: 32000, maxBitRate: 256000, maxDelay: 300 },
    video: {
      maxPixelsPerSecond: 62208000,
      minResolution: { width: 320, height: 180, frameRate: "30/1" },
      maxDimensions: { width: 1280, height: 720, frameRate: "30/1" },
      minBitRate: 300000,
      maxBitRate: 2500000,
      maxDelay: 250,
    },
  },
  display: { dimensions: { width: 1920, height: 1080, frameRate: "60/1" }, scaling: "sender" },
  receiverRtcpEventLog: [0, 1],
  rtpExtensions: [["adaptive_playout_delay"]],
};

test("parses an ANSWER and derives capture recommendations", () => {
  const answer = parseAnswer(answerJson);
  assert.equal(answer.udpPort, 50000);
  assert.deepEqual(answer.sendIndexes, [0, 1]);
  assert.deepEqual(answer.ssrcs, [2, 50002]);
  const r = getRecommendations(answer);
  // The display (1920x1080@60) caps the maximum first; the constraints (1280x720) are narrower and win.
  assert.deepEqual(r.video.maximum, { width: 1280, height: 720, frameRate: { numerator: 30, denominator: 1 } });
  assert.equal(r.video.supportsScaling, false);
  assert.deepEqual(r.video.bitRateLimits, { minimum: 300000, maximum: 2500000 });
  assert.equal(r.video.maxDelayMs, 250);
  assert.equal(r.audio.maxDelayMs, 300);
  assert.deepEqual(r.audio.bitRateLimits, { minimum: 32000, maximum: 256000 });
  // minimum width follows the display aspect ratio (16:9) at the minimum height.
  assert.deepEqual(r.video.minimum, { width: 426, height: 240 });
});

test("an ANSWER with variable scaling supports scaling; defaults apply without constraints", () => {
  const r = getRecommendations(parseAnswer({ udpPort: 1, sendIndexes: [0], ssrcs: [1], display: { scaling: "receiver", aspectRatio: "4:3" } }));
  assert.equal(r.video.supportsScaling, true);
  assert.equal(r.video.maximum.width, 1440);
  assert.equal(r.video.maximum.height, 1080);
  assert.equal(r.audio.maxChannels, 2);
});

test("invalid ANSWERs are rejected like Answer::IsValid", () => {
  assert.throws(() => parseAnswer({ ...answerJson, udpPort: 0 }), MessageParseError);
  assert.throws(() => parseAnswer({ ...answerJson, ssrcs: [] }), MessageParseError);
  assert.throws(() => parseAnswer({ ...answerJson, sendIndexes: [-1] }), MessageParseError);
  assert.throws(() => parseAnswer({ udpPort: 5, sendIndexes: [0] }), MessageParseError);
  assert.throws(() => parseAnswer({ ...answerJson, display: { scaling: "sender" } }), MessageParseError);
  assert.throws(() => parseAnswer({ ...answerJson, constraints: { ...answerJson.constraints, audio: { ...answerJson.constraints.audio, maxBitRate: 1 } } }), MessageParseError);
});

test("receiver messages: ANSWER ok, ANSWER error, capabilities, RPC", () => {
  const ok = parseReceiverMessage({ type: "ANSWER", seqNum: 4, result: "ok", answer: answerJson });
  assert.equal(ok.valid, true);
  assert.equal(ok.seqNum, 4);
  const err = parseReceiverMessage({ type: "answer", seqNum: 4, result: "error", error: { code: 5, description: "no" } });
  assert.deepEqual(err, { type: "ANSWER", seqNum: 4, valid: false, error: { code: 5, description: "no" } });
  const caps = parseReceiverMessage({ type: "CAPABILITIES_RESPONSE", seqNum: 9, result: "ok", capabilities: { remoting: 2, mediaCaps: ["audio", "vp8", "opus"] } });
  assert.deepEqual(caps.valid && caps.type === "CAPABILITIES_RESPONSE" ? caps.capabilities : undefined, { remotingVersion: 2, mediaCapabilities: ["audio", "vp8", "opus"] });
  const rpc = parseReceiverMessage({ type: "RPC", rpc: Buffer.from("hi").toString("base64") });
  assert.equal(rpc.valid && rpc.type === "RPC" ? rpc.data.toString() : undefined, "hi");
  // A negative or missing sequence number invalidates it.
  assert.equal(parseReceiverMessage({ type: "ANSWER", result: "ok", answer: answerJson }).valid, false);
});
