import { test } from "node:test";
import assert from "node:assert/strict";
import { RtpPacketizer } from "../../src/mirroring/rtp/packetizer.ts";
import { FrameCrypto } from "../../src/mirroring/rtp/frame-crypto.ts";
import { expandGreaterThan, expandLessThanOrEqual } from "../../src/mirroring/protocol/frame-id.ts";
import { MAX_RTP_PACKET_SIZE_IPV4, RtpPayloadType } from "../../src/mirroring/protocol/constants.ts";
import type { EncodedFrame } from "../../src/mirroring/rtp/frame.ts";
import { parseRtpPacket } from "./receiver-wire.ts";

// Vectors: openscreen cast/streaming/impl/rtp_packetizer_unittest.cc (payload sizes and packet counts).
const SSRC = 12345;

function frameOf(frameId: number, key: boolean, delay: number, size: number): EncodedFrame {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = i & 0xff;
  return {
    dependency: key ? "key" : "dependent",
    frameId,
    referencedFrameId: key ? frameId : frameId - 1,
    rtpTimestamp: 987,
    referenceTimeMs: 0,
    newPlayoutDelayMs: delay,
    data,
  };
}

function checkAll(frame: EncodedFrame, expectedPackets: number, startSeq = 65530): void {
  const p = new RtpPacketizer(RtpPayloadType.audioOpus, SSRC, MAX_RTP_PACKET_SIZE_IPV4, startSeq);
  assert.equal(p.computeNumberOfPackets(frame), expectedPackets);
  const payload = MAX_RTP_PACKET_SIZE_IPV4 - 23;
  let seq = startSeq;
  for (let id = 0; id < expectedPackets; id++) {
    const wire = p.generatePacket(frame, id);
    const parsed = parseRtpPacket(wire)!;
    assert.ok(parsed);
    assert.equal(parsed.payloadType, RtpPayloadType.audioOpus);
    assert.equal(parsed.sequenceNumber, seq);
    seq = (seq + 1) & 0xffff;
    assert.equal(parsed.rtpTimestamp, 987);
    assert.equal(parsed.ssrc, SSRC);
    assert.equal(parsed.isKeyFrame, frame.dependency === "key");
    assert.equal(parsed.frameId, frame.frameId & 0xff);
    assert.equal(parsed.packetId, id);
    assert.equal(parsed.maxPacketId, expectedPackets - 1);
    assert.equal(parsed.referencedFrameId, frame.referencedFrameId & 0xff);
    assert.equal(parsed.marker, id === expectedPackets - 1);
    assert.equal(parsed.newPlayoutDelayMs, id === 0 ? Math.max(frame.newPlayoutDelayMs, 0) : 0);
    const expected = frame.data.subarray(id * payload, id === expectedPackets - 1 ? undefined : (id + 1) * payload);
    assert.deepEqual(new Uint8Array(parsed.payload), new Uint8Array(expected));
    assert.ok(wire.length <= MAX_RTP_PACKET_SIZE_IPV4);
  }
}

test("packetizes a key frame (34 packets) and delta frames (7 packets) as openscreen does", () => {
  checkAll(frameOf(0, true, 0, 48269), 34);
  checkAll(frameOf(1, false, 0, 10000), 7);
});

test("only packet 0 carries the playout delay change (27 packets)", () => {
  checkAll(frameOf(42, true, 543, 38383), 27);
});

test("a frame with no payload is one packet", () => {
  checkAll(frameOf(99, false, 0, 0), 1);
});

test("a retransmitted packet gets a fresh sequence number", () => {
  const p = new RtpPacketizer(RtpPayloadType.audioOpus, SSRC, MAX_RTP_PACKET_SIZE_IPV4, 7);
  const frame = frameOf(0, true, 0, 16384);
  assert.equal(p.computeNumberOfPackets(frame), 12);
  const seqs = Array.from({ length: 5 }, () => parseRtpPacket(p.generatePacket(frame, 3))!.sequenceNumber);
  assert.deepEqual(seqs, [7, 8, 9, 10, 11]);
});

test("a frame needing more than 65534 packets is refused", () => {
  const p = new RtpPacketizer(RtpPayloadType.videoVp8, SSRC, 100, 0);
  assert.equal(p.computeNumberOfPackets({ ...frameOf(0, true, 0, 0), data: new Uint8Array((100 - 23) * 65535) }), -1);
});

test("key frame wire layout is the Cast RTP profile", () => {
  const p = new RtpPacketizer(RtpPayloadType.videoVp8, 0x01020304, MAX_RTP_PACKET_SIZE_IPV4, 0x1122);
  const f: EncodedFrame = { dependency: "key", frameId: 0x1ff, referencedFrameId: 0x1ff, rtpTimestamp: 0x0a0b0c0d, referenceTimeMs: 0, newPlayoutDelayMs: 300, data: Uint8Array.of(9, 8) };
  assert.equal(p.generatePacket(f, 0).toString("hex"), "80e41122" + "0a0b0c0d" + "01020304" + "c1" + "ff" + "0000" + "0000" + "ff" + "0402" + "012c" + "0908");
});

// Frame ids: openscreen impl/expanded_value_base.h (ExpandLessThanOrEqual, ExpandGreaterThan).
test("expands truncated frame ids", () => {
  // The worked example in expanded_value_base.h: 0x202 is the greatest valid value, 0xfe expands to 0x1fe.
  assert.equal(expandLessThanOrEqual(0x202, 0xfe, 8), 0x1fe);
  assert.equal(expandLessThanOrEqual(0x202, 0x01, 8), 0x201);
  assert.equal(expandLessThanOrEqual(5, 3, 8), 3);
  assert.equal(expandLessThanOrEqual(-1, 0xff, 8), -1);
  assert.equal(expandGreaterThan(0x1fe, 0xff, 8), 0x1ff);
  assert.equal(expandGreaterThan(0x1fe, 0x00, 8), 0x200);
  assert.equal(expandGreaterThan(0x1fe, 0xfe, 8), 0x2fe);
});

// frame_crypto.cc: nonce = 12 zero bytes + BE uint32 frame id lower bits at offset 8 ... XOR iv mask, AES-128-CTR.
test("frame crypto round trips and matches a hand-built AES-CTR nonce", async () => {
  const { createCipheriv } = await import("node:crypto");
  const key = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
  const mask = Buffer.from("f0e0d0c0b0a090807060504030201000", "hex");
  const crypto = new FrameCrypto(key, mask);
  const plain = Buffer.from("The quick brown fox jumps over the lazy dog.");
  const frame = frameOf(300, false, 0, 0);
  const enc = crypto.encrypt({ ...frame, data: plain });
  assert.notDeepEqual(enc.data, plain);
  const nonce = Buffer.alloc(16);
  nonce.writeUInt32BE(300, 8);
  for (let i = 0; i < 16; i++) nonce[i] = nonce[i]! ^ mask[i]!;
  const c = createCipheriv("aes-128-ctr", key, nonce);
  assert.deepEqual(Buffer.from(enc.data), Buffer.concat([c.update(plain), c.final()]));
  // Different frame ids produce different ciphertext; decrypting chunks as a continuous stream recovers the plaintext.
  assert.notDeepEqual(crypto.encrypt({ ...frame, frameId: 301, data: plain }).data, enc.data);
  assert.deepEqual(crypto.decrypt(300, [Buffer.from(enc.data).subarray(0, 10), Buffer.from(enc.data).subarray(10)]), plain);
});

test("the CTR counter carries across the low 32 bits of the nonce", () => {
  // Frame id 0xffffffff puts the nonce counter field at all-ones next to the zero counter bytes; the stream must
  // still be 128-bit big-endian counted, so two blocks differ and decrypt cleanly.
  const crypto = new FrameCrypto(Buffer.alloc(16, 1), Buffer.alloc(16, 0));
  const f = { ...frameOf(0xffffffff, false, 0, 0), data: Buffer.alloc(48, 7) };
  const enc = crypto.encrypt(f);
  assert.notDeepEqual(Buffer.from(enc.data).subarray(0, 16), Buffer.from(enc.data).subarray(16, 32));
  assert.deepEqual(crypto.decrypt(0xffffffff, [Buffer.from(enc.data)]), Buffer.from(f.data));
});
