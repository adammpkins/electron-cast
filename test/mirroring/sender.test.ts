import { test } from "node:test";
import assert from "node:assert/strict";
import { BandwidthEstimator } from "../../src/mirroring/sender/bandwidth-estimator.ts";
import { SenderPacketRouter, computeMaxPacketsPerBurst } from "../../src/mirroring/sender/packet-router.ts";
import { Sender, smoothRoundTripTime, MIN_SENDER_IN_FLIGHT_MS, type SessionConfig } from "../../src/mirroring/sender/sender.ts";
import { FrameCrypto } from "../../src/mirroring/rtp/frame-crypto.ts";
import type { EncodedFrame } from "../../src/mirroring/rtp/frame.ts";
import { NtpTimeConverter } from "../../src/mirroring/rtcp/ntp.ts";
import { ALL_PACKETS_LOST } from "../../src/mirroring/protocol/constants.ts";
import { FakeEnvironment } from "./fake-clock.ts";
import { buildReceiverRtcp, parseRtpPacket } from "./receiver-wire.ts";

// ---- BandwidthEstimator: vectors from openscreen impl/bandwidth_estimator_unittest.cc ----

const MAX_PACKETS_PER_TIMESLICE = 10;
const PACKET_SIZE = 1000;
const SLICE_MS = 10;
const START = 1234567.89;

test("the estimator gives 0 without input, without feedback, or without anything received", () => {
  const e = new BandwidthEstimator(MAX_PACKETS_PER_TIMESLICE * PACKET_SIZE, SLICE_MS, START);
  assert.equal(e.computeNetworkBandwidth(), 0);
  let now = START;
  for (let i = 0; i < 3; i++) {
    const end = now + 2560;
    for (; now < end; now += SLICE_MS) {
      e.onBurstComplete(i * PACKET_SIZE, now);
      e.onRtcpReceived(now + 1, 1);
      assert.equal(e.computeNetworkBandwidth(), 0);
    }
  }
});

test("the estimator measures received bytes over the time the bursts would have taken (100%, 50%, 20% saturation)", () => {
  const e = new BandwidthEstimator(MAX_PACKETS_PER_TIMESLICE * PACKET_SIZE, SLICE_MS, START);
  const receivedPerSecond = 256000;
  const receivedPerSlice = receivedPerSecond / 100;
  let now = START;
  for (const divisor of [1, 2, 5]) {
    const end = now + 2560;
    for (; now < end; now += SLICE_MS) {
      e.onBurstComplete(Math.floor(MAX_PACKETS_PER_TIMESLICE / divisor) * PACKET_SIZE, now);
      e.onPayloadReceived(receivedPerSlice, now + 1, 1);
      e.onRtcpReceived(now + 1, 1);
    }
    assert.equal(e.computeNetworkBandwidth(), divisor * receivedPerSecond * 8);
  }
});

// ---- SenderPacketRouter + Sender on a fake clock ----

const SENDER_SSRC = 7;
const RECEIVER_SSRC = 8;

function makeSession(over: Partial<SessionConfig> = {}, maxBurstBitrate?: number) {
  const env = new FakeEnvironment();
  const router = new SenderPacketRouter(env, maxBurstBitrate);
  const key = Buffer.alloc(16, 3);
  const mask = Buffer.alloc(16, 5);
  const config: SessionConfig = {
    senderSsrc: SENDER_SSRC,
    receiverSsrc: RECEIVER_SSRC,
    rtpTimebase: 90000,
    channels: 1,
    targetPlayoutDelayMs: 400,
    aesSecretKey: key,
    aesIvMask: mask,
    isPliEnabled: true,
    streamType: "video",
    ...over,
  };
  const sender = new Sender(env, router, config, 100, 1_700_000_000);
  const canceled: number[] = [];
  let pictureLost = 0;
  sender.setObserver({ onFrameCanceled: (id) => canceled.push(id), onPictureLost: () => pictureLost++ });
  const ntp = new NtpTimeConverter(env.now(), 1_700_000_000);
  return { env, router, sender, crypto: new FrameCrypto(key, mask), ntp, canceled, pictureLost: () => pictureLost };
}

function frame(id: number, size: number, opts: Partial<EncodedFrame> = {}): EncodedFrame {
  return {
    dependency: id === 0 ? "key" : "dependent",
    frameId: id,
    referencedFrameId: id === 0 ? 0 : id - 1,
    rtpTimestamp: 3000 * (id + 1),
    referenceTimeMs: 0,
    newPlayoutDelayMs: 0,
    data: new Uint8Array(size).fill(id + 1),
    ...opts,
  };
}

test("max packets per burst follows the 24 Mbps default and 10 ms interval", () => {
  assert.equal(computeMaxPacketsPerBurst(24 << 20, 1472, 10), Math.floor(Math.floor((24 << 20) / 8 / 1472) / 100));
});

test("the first RTCP is a sender report, sent before RTP; RTP is paced in bursts", () => {
  const { env, sender } = makeSession({}, 8 * 1472 * 100 * 4); // 4 packets per 10 ms burst
  assert.equal(sender.enqueueFrame(frame(0, 20 * 1449)), "OK"); // 20 packets
  assert.equal(env.sent.length, 0);
  env.advance(0);
  const first = env.takeSent();
  assert.equal(first[0]![1], 200, "sender report first");
  assert.equal(first.length, 4, "one RTCP + three RTP in the first burst");
  env.advance(10);
  const second = env.takeSent();
  assert.equal(second.length, 4);
  env.advance(100);
  const rest = env.takeSent();
  // 20 RTP packets total (+ a second sender report after 500 ms is not yet due).
  // Kickstart repeats of the last packet follow ChooseKickstartPacket (sender_impl.cc) while nothing is acknowledged.
  assert.ok(rest.length >= 20 - 3 - 4);
  const ids = [...first.slice(1), ...second, ...rest].map((p) => parseRtpPacket(p)!.packetId).slice(0, 20);
  assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => i));
});

test("a checkpoint acknowledges frames, reports cancellations and feeds the bandwidth estimator", () => {
  const { env, sender, ntp, canceled } = makeSession();
  sender.enqueueFrame(frame(0, 3000));
  sender.enqueueFrame(frame(1, 3000, { rtpTimestamp: 6000 + 3000 }));
  env.advance(20);
  env.takeSent();
  const rtcp = buildReceiverRtcp({ receiverSsrc: RECEIVER_SSRC, senderSsrc: SENDER_SSRC, ntp, sendTimeMs: env.now(), checkpointFrameId: 0, playoutDelayMs: 400 });
  sender.onReceivedRtcpPacket(env.now(), rtcp);
  assert.equal(sender.inFlightFrameCount, 1);
  assert.deepEqual(canceled, [0]);
  assert.equal(sender.checkpoint, 0);
});

test("a NACK retransmits the packet, with a new sequence number", () => {
  const { env, sender, ntp } = makeSession();
  sender.enqueueFrame(frame(0, 3 * 1449 - 10)); // 3 packets
  env.advance(30);
  const original = env.takeSent().filter((p) => p[1]! !== 200 && (p[1]! & 0x7f) === 100);
  // Kickstart repeats of the last packet are expected (sender_impl_unittest.cc ProvidesKickstartPacketsIfReceiverDoesNotACK), so count distinct ids.
  assert.equal(new Set(original.map((p) => parseRtpPacket(p)!.packetId)).size, 3);
  env.advance(200);
  env.takeSent();
  const nack = (): Buffer =>
    buildReceiverRtcp({ receiverSsrc: RECEIVER_SSRC, senderSsrc: SENDER_SSRC, ntp, sendTimeMs: env.now(), checkpointFrameId: -1, playoutDelayMs: 400, nacks: [{ frameId: 0, packetId: 1 }] });
  sender.onReceivedRtcpPacket(env.now(), nack());
  env.advance(20);
  const resent = env.takeSent().filter((p) => p[1] !== 200 && (p[1]! & 0x7f) === 100);
  assert.equal(resent.length, 1);
  const parsed = parseRtpPacket(resent[0]!)!;
  assert.equal(parsed.packetId, 1);
  assert.notEqual(parsed.sequenceNumber, parseRtpPacket(original[1]!)!.sequenceNumber);
  assert.deepEqual(parsed.payload, parseRtpPacket(original[1]!)!.payload);
  assert.equal(sender.wasLastRtpPacketRetransmission, true);
});

test("an all-lost NACK resends every packet of the frame", () => {
  const { env, sender, ntp } = makeSession();
  sender.enqueueFrame(frame(0, 2 * 1449 + 1));
  env.advance(300);
  env.takeSent();
  sender.onReceivedRtcpPacket(
    env.now(),
    buildReceiverRtcp({ receiverSsrc: RECEIVER_SSRC, senderSsrc: SENDER_SSRC, ntp, sendTimeMs: env.now(), checkpointFrameId: -1, playoutDelayMs: 400, nacks: [{ frameId: 0, packetId: ALL_PACKETS_LOST }] }),
  );
  env.advance(30);
  assert.deepEqual(env.takeSent().filter((p) => (p[1]! & 0x7f) === 100).map((p) => parseRtpPacket(p)!.packetId), [0, 1, 2]);
});

test("payloads decrypt with the negotiated key and mask", () => {
  const { env, sender, crypto } = makeSession();
  const f = frame(5 - 5, 100);
  sender.enqueueFrame(f);
  env.advance(30);
  const rtp = env.takeSent().filter((p) => (p[1]! & 0x7f) === 100);
  // sender_impl.cc ChooseKickstartPacket: the last packet of the newest frame is resent while the receiver has not acknowledged it
  // (sender_impl_unittest.cc ProvidesKickstartPacketsIfReceiverDoesNotACK expects the same packet over and over).
  assert.ok(rtp.length >= 1);
  assert.deepEqual(crypto.decrypt(0, [parseRtpPacket(rtp[0]!)!.payload]), Buffer.from(f.data));
});

test("a picture loss indicator makes the sender want a key frame until one is enqueued; one in flight satisfies it", () => {
  const { env, sender, ntp, pictureLost } = makeSession();
  assert.equal(sender.needsKeyFrame, true, "the very first frame is a key frame");
  sender.enqueueFrame(frame(0, 100));
  assert.equal(sender.needsKeyFrame, false);
  const pli = (): Buffer =>
    buildReceiverRtcp({ receiverSsrc: RECEIVER_SSRC, senderSsrc: SENDER_SSRC, ntp, sendTimeMs: env.now(), checkpointFrameId: -1, playoutDelayMs: 400, pictureLoss: true });
  // The key frame 0 is still unacknowledged, so the PLI is ignored.
  sender.onReceivedRtcpPacket(env.now(), pli());
  assert.equal(pictureLost(), 0);
  sender.onReceivedRtcpPacket(
    env.now() + 1,
    buildReceiverRtcp({ receiverSsrc: RECEIVER_SSRC, senderSsrc: SENDER_SSRC, ntp, sendTimeMs: env.now() + 1, checkpointFrameId: 0, playoutDelayMs: 400, pictureLoss: true }),
  );
  assert.equal(pictureLost(), 1);
  assert.equal(sender.needsKeyFrame, true);
  sender.enqueueFrame(frame(1, 100, { dependency: "key", referencedFrameId: 1 }));
  assert.equal(sender.needsKeyFrame, false);
});

test("the in-flight media duration limit refuses frames; the id span limit refuses the 121st frame without an ack", () => {
  const { sender } = makeSession({ targetPlayoutDelayMs: 100 });
  // Video: clamp(2*RTT, 81.667 ms, max(81.667, 2/3 of 100 ms)) with no RTT yet is the 81.667 ms floor.
  let result = "OK";
  let id = 0;
  while (result === "OK" && id < 20) result = sender.enqueueFrame(frame(id, 10, { rtpTimestamp: 3000 * (id + 1), dependency: id === 0 ? "key" : "dependent" })), id++;
  assert.equal(result, "MAX_DURATION_IN_FLIGHT");
  assert.ok(id * (1000 / 30) > MIN_SENDER_IN_FLIGHT_MS - 40);
  const audio = makeSession({ streamType: "audio", rtpTimebase: 48000, targetPlayoutDelayMs: 4000 });
  let r2 = "OK";
  for (let i = 0; i < 125 && r2 === "OK"; i++) r2 = audio.sender.enqueueFrame(frame(i, 10, { rtpTimestamp: 480 * (i + 1), dependency: "key", referencedFrameId: i }));
  assert.equal(r2, "REACHED_ID_SPAN_LIMIT");
  // sender_impl_unittest.cc RejectsEnqueuingBeforeProtocolDesignLimit: kMaxUnackedFrames (120) frames are accepted, the next is refused;
  // sender_impl.cc EnqueueFrame refuses when frame_id - checkpoint > kMaxUnackedFrames, and FrameId::first() is 0, leader() is -1.
  assert.equal(audio.sender.nextFrameId, 120);
});

test("a receiver report gives a smoothed round-trip time that caps at the playout delay", () => {
  const { env, sender, ntp } = makeSession();
  sender.enqueueFrame(frame(0, 100));
  env.advance(1); // sender report goes out at the first burst
  const sr = env.takeSent().find((p) => p[1] === 200)!;
  const ntpTs = sr.readBigUInt64BE(8);
  const lastSr = Number((ntpTs >> 16n) & 0xffffffffn);
  env.advance(40);
  const block = { ssrc: SENDER_SSRC, packetFractionLostNumerator: 0, cumulativePacketsLost: 0, extendedHighSequenceNumber: 0, jitter: 0, lastStatusReportId: lastSr, delaySinceLastReport: Math.round(0.01 * 65536) };
  sender.onReceivedRtcpPacket(env.now(), buildReceiverRtcp({ receiverSsrc: RECEIVER_SSRC, senderSsrc: SENDER_SSRC, ntp, sendTimeMs: env.now(), reportBlock: block, checkpointFrameId: -1, playoutDelayMs: 400 }));
  assert.ok(Math.abs(sender.currentRoundTripTimeMs - 30) < 2, `${sender.currentRoundTripTimeMs}`);
});

test("round-trip smoothing is openscreen's (first as is, up by half, down by one eighth)", () => {
  assert.equal(smoothRoundTripTime(0, 10), 10);
  assert.equal(smoothRoundTripTime(10, 20), 15);
  assert.equal(smoothRoundTripTime(16, 8), 15);
});

test("a kickstart packet is resent when the newest frame is not acknowledged", () => {
  const { env, sender } = makeSession({ targetPlayoutDelayMs: 400 });
  sender.enqueueFrame(frame(0, 5 * 1449));
  env.advance(30);
  env.takeSent();
  // Wait for max(400/20, 2*RTT) = 20 ms after the last packet was sent.
  env.advance(40);
  const kick = env.takeSent().filter((p) => (p[1]! & 0x7f) === 100);
  assert.equal(kick.length >= 1, true);
  assert.equal(parseRtpPacket(kick[0]!)!.packetId, 4);
});

test("a NACK for a packet sent less than one round trip ago is ignored (RTT > 0)", () => {
  // sender_impl.cc OnReceiverIsMissingPackets: too_recent_a_send_time = rtcp_packet_arrival_time_ - round_trip_time_;
  // HandleIndividualNack retransmits only when packet_sent_times[id] <= too_recent_a_send_time, else counts it ignored.
  const { env, sender, ntp } = makeSession();
  sender.enqueueFrame(frame(0, 3 * 1449 - 10)); // 3 packets; the kickstart only ever resends the last one
  env.advance(1);
  const sr = env.takeSent().find((p) => p[1] === 200)!;
  const lastSr = Number((sr.readBigUInt64BE(8) >> 16n) & 0xffffffffn);
  env.advance(40);
  env.takeSent();
  const block = { ssrc: SENDER_SSRC, packetFractionLostNumerator: 0, cumulativePacketsLost: 0, extendedHighSequenceNumber: 0, jitter: 0, lastStatusReportId: lastSr, delaySinceLastReport: Math.round(0.01 * 65536) };
  sender.onReceivedRtcpPacket(env.now(), buildReceiverRtcp({ receiverSsrc: RECEIVER_SSRC, senderSsrc: SENDER_SSRC, ntp, sendTimeMs: env.now(), reportBlock: block, checkpointFrameId: -1, playoutDelayMs: 400 }));
  const rtt = sender.currentRoundTripTimeMs;
  assert.ok(rtt > 20, `rtt ${rtt}`);
  const nack = (): Buffer =>
    buildReceiverRtcp({ receiverSsrc: RECEIVER_SSRC, senderSsrc: SENDER_SSRC, ntp, sendTimeMs: env.now(), checkpointFrameId: -1, playoutDelayMs: 400, nacks: [{ frameId: 0, packetId: 0 }] });
  const packet0 = (): number => env.takeSent().filter((p) => (p[1]! & 0x7f) === 100 && parseRtpPacket(p)!.packetId === 0).length;
  sender.onReceivedRtcpPacket(env.now(), nack());
  env.advance(11);
  assert.equal(packet0(), 1, "sent long ago, so it is resent");
  env.advance(rtt / 2);
  sender.onReceivedRtcpPacket(env.now(), nack());
  env.advance(11);
  assert.equal(packet0(), 0, "resent less than one round trip ago, so the NACK is ignored");
  env.advance(rtt * 2);
  sender.onReceivedRtcpPacket(env.now(), nack());
  env.advance(11);
  assert.equal(packet0(), 1, "more than one round trip later it is resent again");
});
