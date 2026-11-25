/**
 * RTP packetizer for the Cast RTP profile, ported from openscreen `cast/streaming/impl/rtp_packetizer.cc`
 * (`RtpPacketizer::GeneratePacket`, `ComputeNumberOfPackets`) with the wire constants of `impl/rtp_defines.h`.
 *
 * Layout (big-endian): RTP byte0 0x80 (`kRtpRequiredFirstByte`), byte1 marker 0x80 on the last packet | payload type,
 * uint16 sequence number, uint32 RTP timestamp, uint32 SSRC; Cast header: flags (0x80 key frame, 0x40 has reference
 * frame id, bit 0 adaptive latency extension), uint8 frame id, uint16 packet id, uint16 max packet id, uint8 reference
 * frame id; then, on packet 0 only and only when the frame carries a new playout delay, uint16 (type 1 << 10 | size 2)
 * and uint16 delay in milliseconds.
 */
import { MAX_ALLOWED_FRAME_PACKET_ID, RTP_PACKET_MIN_VALID_SIZE } from "../protocol/constants.ts";
import type { EncryptedFrame } from "./frame.ts";

/** rtp_defines.h `kRtpRequiredFirstByte`, `kRtpMarkerBitMask`, `kRtpKeyFrameBitMask`, `kRtpHasReferenceFrameIdBitMask`. */
export const RTP_REQUIRED_FIRST_BYTE = 0x80;
export const RTP_MARKER_BIT_MASK = 0b10000000;
export const RTP_KEY_FRAME_BIT_MASK = 0b10000000;
export const RTP_HAS_REFERENCE_FRAME_ID_BIT_MASK = 0b01000000;
/** rtp_defines.h `kAdaptiveLatencyRtpExtensionType` and `kNumExtensionDataSizeFieldBits`. */
export const ADAPTIVE_LATENCY_RTP_EXTENSION_TYPE = 1;
export const NUM_EXTENSION_DATA_SIZE_FIELD_BITS = 10;
/** rtp_defines.h `kBaseRtpHeaderSize` (`kRtpPacketMinValidSize` + 1), `kAdaptiveLatencyHeaderSize`, `kMaxRtpHeaderSize`. */
export const BASE_RTP_HEADER_SIZE = RTP_PACKET_MIN_VALID_SIZE + 1;
export const ADAPTIVE_LATENCY_HEADER_SIZE = 4;
export const MAX_RTP_HEADER_SIZE = BASE_RTP_HEADER_SIZE + ADAPTIVE_LATENCY_HEADER_SIZE;

export class RtpPacketizer {
  private sequenceNumber: number;
  private readonly payloadType: number;
  private readonly senderSsrc: number;
  private readonly maxPacketSize: number;

  constructor(
    payloadType: number,
    senderSsrc: number,
    maxPacketSize: number,
    /** The C++ starts at a random uint16 (`GenerateRandomSequenceNumberStart`); tests pin it. */
    initialSequenceNumber: number = Math.floor(Math.random() * 0x10000),
  ) {
    this.payloadType = payloadType;
    this.senderSsrc = senderSsrc;
    this.maxPacketSize = maxPacketSize;
    if (!(payloadType >= 0 && payloadType < 128)) throw new RangeError("payload type must fit 7 bits");
    if (!(maxPacketSize > MAX_RTP_HEADER_SIZE)) throw new RangeError("max packet size too small");
    this.sequenceNumber = initialSequenceNumber & 0xffff;
  }

  get maxPayloadSize(): number {
    return this.maxPacketSize - MAX_RTP_HEADER_SIZE;
  }

  /** `ComputeNumberOfPackets`: at least 1; -1 when the packet ids would overflow. */
  computeNumberOfPackets(frame: EncryptedFrame): number {
    const n = Math.max(1, Math.ceil(frame.data.length / this.maxPayloadSize));
    return n <= MAX_ALLOWED_FRAME_PACKET_ID ? n : -1;
  }

  /** `GeneratePacket`. The sequence number increments on every call, retransmissions included. */
  generatePacket(frame: EncryptedFrame, packetId: number): Buffer {
    const numPackets = this.computeNumberOfPackets(frame);
    if (numPackets <= 0) throw new RangeError("frame needs too many packets");
    if (packetId >= numPackets) throw new RangeError("packet id out of range");
    const isLast = packetId === numPackets - 1;

    const includeAdaptiveLatency = packetId === 0 && frame.newPlayoutDelayMs > 0;
    if (includeAdaptiveLatency && frame.newPlayoutDelayMs > 0xffff) throw new RangeError("playout delay exceeds uint16");
    let packetSize = BASE_RTP_HEADER_SIZE + (includeAdaptiveLatency ? ADAPTIVE_LATENCY_HEADER_SIZE : 0);
    const chunkStart = this.maxPayloadSize * packetId;
    const chunkSize = isLast ? frame.data.length - chunkStart : this.maxPayloadSize;
    packetSize += chunkSize;

    const out = Buffer.allocUnsafe(packetSize);
    let o = 0;
    out[o++] = RTP_REQUIRED_FIRST_BYTE;
    out[o++] = (isLast ? RTP_MARKER_BIT_MASK : 0) | this.payloadType;
    o = out.writeUInt16BE(this.sequenceNumber, o);
    this.sequenceNumber = (this.sequenceNumber + 1) & 0xffff;
    o = out.writeUInt32BE(frame.rtpTimestamp >>> 0, o);
    o = out.writeUInt32BE(this.senderSsrc >>> 0, o);
    out[o++] =
      (frame.dependency === "key" ? RTP_KEY_FRAME_BIT_MASK : 0) |
      RTP_HAS_REFERENCE_FRAME_ID_BIT_MASK |
      (includeAdaptiveLatency ? 1 : 0);
    out[o++] = frame.frameId & 0xff;
    o = out.writeUInt16BE(packetId, o);
    o = out.writeUInt16BE(numPackets - 1, o);
    out[o++] = frame.referencedFrameId & 0xff;
    if (includeAdaptiveLatency) {
      o = out.writeUInt16BE((ADAPTIVE_LATENCY_RTP_EXTENSION_TYPE << NUM_EXTENSION_DATA_SIZE_FIELD_BITS) | 2, o);
      o = out.writeUInt16BE(frame.newPlayoutDelayMs, o);
    }
    out.set(frame.data.subarray(chunkStart, chunkStart + chunkSize), o);
    return out;
  }
}
