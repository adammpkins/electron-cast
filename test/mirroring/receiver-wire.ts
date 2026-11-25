/**
 * The receiver half of the wire formats, for tests and the fake receiver only (the sender never needs it).
 *
 * - RTP parse: openscreen `cast/streaming/impl/rtp_packet_parser.cc` (`RtpPacketParser::Parse`).
 * - Compound RTCP build: openscreen `impl/compound_rtcp_builder.cc` (`BuildPacket`, `AppendReceiverReportPacket`,
 *   `AppendReceiverReferenceTimeReportPacket`, `AppendPictureLossIndicatorPacket`, `AppendCastFeedbackPacket`,
 *   `AppendCastFeedbackLossFields`, `AppendCastFeedbackAckFields`).
 */
import { ALL_PACKETS_LOST } from "../../src/mirroring/protocol/constants.ts";
import type { NtpTimeConverter } from "../../src/mirroring/rtcp/ntp.ts";
import { writeReportBlock, type RtcpReportBlock } from "../../src/mirroring/rtcp/sender-report.ts";
import {
  RTCP_CAST_IDENTIFIER_WORD,
  RTCP_CST2_IDENTIFIER_WORD,
  RTCP_RECEIVER_REFERENCE_TIME_REPORT_BLOCK_TYPE,
  RtcpPacketType,
  RtcpSubtype,
  writeCommonHeader,
} from "../../src/mirroring/rtcp/wire.ts";

export interface ParsedRtpPacket {
  payloadType: number;
  marker: boolean;
  sequenceNumber: number;
  rtpTimestamp: number;
  ssrc: number;
  isKeyFrame: boolean;
  /** Lower 8 bits, as on the wire. */
  frameId: number;
  packetId: number;
  maxPacketId: number;
  referencedFrameId: number;
  newPlayoutDelayMs: number;
  payload: Buffer;
}

/** `RtpPacketParser::Parse`: undefined for anything that is not a Cast RTP packet. */
export function parseRtpPacket(buf: Buffer): ParsedRtpPacket | undefined {
  if (buf.length < 19 || buf[0] !== 0x80) return undefined;
  const flags = buf[12]!;
  const hasReference = (flags & 0x40) !== 0;
  const extensionCount = flags & 0x3f;
  if (!hasReference) return undefined;
  let o = 19;
  let newPlayoutDelayMs = 0;
  if (extensionCount > 0) {
    // Only the adaptive latency extension (type 1, size 2) is defined.
    if ((flags & 1) === 0 || buf.length < o + 4) return undefined;
    const typeAndSize = buf.readUInt16BE(o);
    if (typeAndSize >> 10 !== 1 || (typeAndSize & 0x3ff) !== 2) return undefined;
    newPlayoutDelayMs = buf.readUInt16BE(o + 2);
    o += 4;
  }
  return {
    payloadType: buf[1]! & 0x7f,
    marker: (buf[1]! & 0x80) !== 0,
    sequenceNumber: buf.readUInt16BE(2),
    rtpTimestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    isKeyFrame: (flags & 0x80) !== 0,
    frameId: buf[13]!,
    packetId: buf.readUInt16BE(14),
    maxPacketId: buf.readUInt16BE(16),
    referencedFrameId: buf[18]!,
    newPlayoutDelayMs,
    payload: buf.subarray(o),
  };
}

export interface ReceiverRtcpOptions {
  receiverSsrc: number;
  senderSsrc: number;
  ntp: NtpTimeConverter;
  sendTimeMs: number;
  reportBlock?: RtcpReportBlock;
  pictureLoss?: boolean;
  checkpointFrameId: number;
  playoutDelayMs: number;
  /** Sorted, unique, all after the checkpoint. */
  nacks?: { frameId: number; packetId: number }[];
  /** Sorted, unique. */
  acks?: number[];
  /** The receiver event log: one frame log per entry, each with one event. */
  eventLog?: ReceiverLogEvent[];
}

/** One event of the receiver's RTCP event log, as `CompoundRtcpParser::ParseFrameLogMessages` reads it. */
export interface ReceiverLogEvent {
  /** Low 32 bits of the RTP timestamp. */
  rtpTimestamp: number;
  /** Receiver clock, whole milliseconds; only the low 24 bits fit the frame log's base time. */
  timestampMs: number;
  /** 4-bit wire type (11 ack sent, 12 played out, 13 decoded, 14 packet received). */
  wireType: number;
  /** Packet id for packet received, signed delay in milliseconds for played out. */
  value: number;
  /** Added to the base time, 0..4095. */
  deltaMs?: number;
}

/** The Cast receiver log, an application-defined RTCP packet (`AppendReceiverLogPacket`). */
export function buildReceiverLogPacket(receiverSsrc: number, events: ReceiverLogEvent[]): Buffer {
  const payload = 8 + events.length * 12;
  const b = Buffer.alloc(4 + payload);
  let p = writeCommonHeader(b, 0, RtcpPacketType.applicationDefined, RtcpSubtype.receiverLog, payload);
  p = b.writeUInt32BE(receiverSsrc, p);
  p = b.writeUInt32BE(RTCP_CAST_IDENTIFIER_WORD, p);
  for (const e of events) {
    p = b.writeUInt32BE(e.rtpTimestamp >>> 0, p);
    // One event per frame log: the count byte is the number of events minus one.
    p = b.writeUInt32BE(e.timestampMs & 0xffffff, p);
    p = b.writeUInt16BE(e.value & 0xffff, p);
    p = b.writeUInt16BE(((e.wireType & 0xf) << 12) | ((e.deltaMs ?? 0) & 0xfff), p);
  }
  return b;
}

/** `CompoundRtcpBuilder::BuildPacket`. */
export function buildReceiverRtcp(o: ReceiverRtcpOptions): Buffer {
  const parts: Buffer[] = [];

  // Receiver report (empty or with one block).
  {
    const payload = 4 + (o.reportBlock === undefined ? 0 : 24);
    const b = Buffer.alloc(4 + payload);
    let p = writeCommonHeader(b, 0, RtcpPacketType.receiverReport, o.reportBlock === undefined ? 0 : 1, payload);
    p = b.writeUInt32BE(o.receiverSsrc, p);
    if (o.reportBlock !== undefined) writeReportBlock(b, p, o.reportBlock);
    parts.push(b);
  }
  // Receiver reference time.
  {
    const b = Buffer.alloc(4 + 4 + 4 + 8);
    let p = writeCommonHeader(b, 0, RtcpPacketType.extendedReports, 0, 16);
    p = b.writeUInt32BE(o.receiverSsrc, p);
    b[p++] = RTCP_RECEIVER_REFERENCE_TIME_REPORT_BLOCK_TYPE;
    b[p++] = 0;
    p = b.writeUInt16BE(2, p);
    b.writeBigUInt64BE(o.ntp.toNtpTimestamp(o.sendTimeMs), p);
    parts.push(b);
  }
  if (o.pictureLoss === true) {
    const b = Buffer.alloc(4 + 8);
    const p = writeCommonHeader(b, 0, RtcpPacketType.payloadSpecific, RtcpSubtype.pictureLossIndicator, 8);
    b.writeUInt32BE(o.receiverSsrc, p);
    b.writeUInt32BE(o.senderSsrc, p + 4);
    parts.push(b);
  }
  // Cast feedback.
  {
    const loss: Buffer[] = [];
    const nacks = (o.nacks ?? []).filter((n) => n.frameId > o.checkpointFrameId);
    for (let i = 0; i < nacks.length && loss.length < 255; ) {
      const frameId = nacks[i]!.frameId;
      const first = nacks[i]!.packetId;
      let bits = 0;
      for (i++; i < nacks.length && nacks[i]!.frameId === frameId; i++) {
        const shift = nacks[i]!.packetId - first - 1;
        if (shift >= 8) break;
        bits |= 1 << shift;
      }
      const f = Buffer.alloc(4);
      f[0] = frameId & 0xff;
      f.writeUInt16BE(first, 1);
      f[3] = bits;
      loss.push(f);
    }
    // CST2 ACK vector: at least 2 octets, growing in steps of 4 (`kIncrement`), capped by `kRtcpMaxAckBitVectorOctets`.
    const first = o.checkpointFrameId + 2;
    let octets = 2;
    for (const a of o.acks ?? []) {
      const index = Math.floor((a - first) / 8);
      if (a - first >= 0 && index >= octets) octets += Math.ceil((index + 1 - octets) / 4) * 4;
    }
    const ack = Buffer.alloc(octets);
    for (const a of o.acks ?? []) {
      const bit = a - first;
      if (bit >= 0 && Math.floor(bit / 8) < octets) ack[Math.floor(bit / 8)]! |= 1 << bit % 8;
    }
    const payload = 16 + loss.length * 4 + 6 + octets;
    const b = Buffer.alloc(4 + payload);
    let p = writeCommonHeader(b, 0, RtcpPacketType.payloadSpecific, RtcpSubtype.feedback, payload);
    p = b.writeUInt32BE(o.receiverSsrc, p);
    p = b.writeUInt32BE(o.senderSsrc, p);
    p = b.writeUInt32BE(RTCP_CAST_IDENTIFIER_WORD, p);
    b[p++] = o.checkpointFrameId & 0xff;
    b[p++] = loss.length;
    p = b.writeUInt16BE(o.playoutDelayMs, p);
    for (const l of loss) p += l.copy(b, p);
    p = b.writeUInt32BE(RTCP_CST2_IDENTIFIER_WORD, p);
    b[p++] = 0;
    b[p++] = octets;
    ack.copy(b, p);
    parts.push(b);
  }
  if (o.eventLog !== undefined && o.eventLog.length > 0) parts.push(buildReceiverLogPacket(o.receiverSsrc, o.eventLog));
  return Buffer.concat(parts);
}

export { ALL_PACKETS_LOST };
