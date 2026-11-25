/**
 * Compound RTCP parsing for a sender, ported from openscreen `cast/streaming/impl/compound_rtcp_parser.cc`
 * (`CompoundRtcpParser::ParseV1`, `ParseReceiverReport`, `ParseApplicationDefined`, `ParseFrameLogMessages`,
 * `ParseFeedback`, `ParseExtendedReports`, `ParsePictureLossIndicator`, `CanonicalizePacketNackVector`).
 *
 * As in the C++, the whole compound packet is validated first; if any element is malformed nothing is dispatched and
 * `parse` returns false. Events are then dispatched in a fixed order: reference time advanced, receiver report, frame
 * logs, checkpoint, received frames, packet NACKs, picture loss.
 */
import { ALL_PACKETS_LOST } from "../protocol/constants.ts";
import { expandGreaterThan, expandLessThanOrEqual } from "../protocol/frame-id.ts";
import { expandRtpTimestamp, fromWireType, type RtcpReceiverEventLogMessage, type RtcpReceiverFrameLogMessage } from "../stats/statistics-common.ts";
import type { NtpTimeConverter } from "./ntp.ts";
import { parseReportBlock, type RtcpReportBlock } from "./sender-report.ts";
import {
  RTCP_CAST_IDENTIFIER_WORD,
  RTCP_COMMON_HEADER_SIZE,
  RTCP_CST2_IDENTIFIER_WORD,
  RTCP_EXTENDED_REPORT_BLOCK_HEADER_SIZE,
  RTCP_EXTENDED_REPORT_HEADER_SIZE,
  RTCP_FEEDBACK_ACK_HEADER_SIZE,
  RTCP_FEEDBACK_HEADER_SIZE,
  RTCP_FEEDBACK_LOSS_FIELD_SIZE,
  RTCP_PICTURE_LOSS_INDICATOR_HEADER_SIZE,
  RTCP_RECEIVER_FRAME_LOG_MESSAGE_BLOCK_SIZE,
  RTCP_RECEIVER_FRAME_LOG_MESSAGE_HEADER_SIZE,
  RTCP_RECEIVER_REFERENCE_TIME_REPORT_BLOCK_TYPE,
  RTCP_RECEIVER_REPORT_SIZE,
  RTCP_TIME_SYNC_REQUEST_NAME,
  RtcpPacketType,
  RtcpSubtype,
  parseCommonHeader,
} from "./wire.ts";

/** rtcp_common.h / compound_rtcp_parser.h `PacketNack`. */
export interface PacketNack {
  frameId: number;
  packetId: number;
}

/** compound_rtcp_parser.h `CompoundRtcpParser::Client`. Every method is optional here (the C++ has empty defaults). */
export interface CompoundRtcpClient {
  onReceiverReferenceTimeAdvanced?(referenceTimeMs: number): void;
  onReceiverReport?(report: RtcpReportBlock): void;
  /** The receiver's RTCP event log (`OnCastReceiverFrameLogMessages`), only when it sent any. */
  onCastReceiverFrameLogMessages?(messages: RtcpReceiverFrameLogMessage[]): void;
  onReceiverCheckpoint?(frameId: number, playoutDelayMs: number): void;
  onReceiverHasFrames?(acks: number[]): void;
  onReceiverIsMissingPackets?(nacks: PacketNack[]): void;
  onReceiverIndicatesPictureLoss?(): void;
}

/** `CanonicalizePacketNackVector`: sort (all-lost first), de-duplicate, all-lost covers the frame's other packets. */
export function canonicalizePacketNacks(packets: PacketNack[]): PacketNack[] {
  // Map the packet id with + 1 mod 0x10000 so kAllPacketsLost sorts first.
  const key = (n: PacketNack): number => (n.packetId + 1) & 0xffff;
  const sorted = [...packets].sort((a, b) => a.frameId - b.frameId || key(a) - key(b));
  const out: PacketNack[] = [];
  for (const n of sorted) {
    const kept = out[out.length - 1];
    if (kept === undefined || n.frameId !== kept.frameId || (kept.packetId !== ALL_PACKETS_LOST && n.packetId !== kept.packetId)) {
      out.push(n);
    }
  }
  return out;
}

interface SessionIds {
  senderSsrc: number;
  receiverSsrc: number;
  ntp: NtpTimeConverter;
  /** `RtcpSession::start_time`: the base of the event timestamps in the receiver's log. */
  startTimeMs: number;
}

export class CompoundRtcpParser {
  private latestReceiverTimestampMs: number | undefined;
  private latestFrameLogRtpTimestamp = 0;
  private readonly session: SessionIds;
  private readonly client: CompoundRtcpClient;

  constructor(session: SessionIds, client: CompoundRtcpClient) {
    this.session = session;
    this.client = client;
  }

  /**
   * `Parse`. `maxFeedbackFrameId` is the newest frame id the sender has enqueued: feedback frame ids are 8 bits and are
   * expanded to the greatest value not above it.
   */
  parse(buffer: Uint8Array, maxFeedbackFrameId: number): boolean {
    const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let receiverReferenceTime: number | undefined;
    let receiverReport: RtcpReportBlock | undefined;
    let checkpointFrameId: number | undefined;
    let targetPlayoutDelayMs = 0;
    let receivedFrames: number[] = [];
    let packetNacks: PacketNack[] = [];
    let pictureLoss = false;
    const logMessages: RtcpReceiverFrameLogMessage[] = [];

    let pos = 0;
    while (pos < buffer.length) {
      const header = parseCommonHeader(buffer, pos);
      if (header === undefined) return false;
      pos += RTCP_COMMON_HEADER_SIZE;
      if (buffer.length - pos < header.payloadSize) return false;
      const start = pos;
      const end = pos + header.payloadSize;
      pos = end;

      switch (header.packetType) {
        case RtcpPacketType.receiverReport: {
          if (end - start < RTCP_RECEIVER_REPORT_SIZE) return false;
          if (dv.getUint32(start) === this.session.receiverSsrc) {
            receiverReport = parseReportBlock(buffer.subarray(0, end), start + 4, header.countOrSubtype, this.session.senderSsrc);
          }
          break;
        }
        case RtcpPacketType.applicationDefined:
          if (!this.parseApplicationDefined(dv, header.countOrSubtype, start, end, logMessages)) return false;
          break;
        case RtcpPacketType.payloadSpecific:
          if (header.countOrSubtype === RtcpSubtype.pictureLossIndicator) {
            if (end - start < RTCP_PICTURE_LOSS_INDICATOR_HEADER_SIZE) return false;
            if (dv.getUint32(start) === this.session.receiverSsrc && dv.getUint32(start + 4) === this.session.senderSsrc) {
              pictureLoss = true;
            }
          } else if (header.countOrSubtype === RtcpSubtype.feedback) {
            const fb = this.parseFeedback(dv, start, end, maxFeedbackFrameId, checkpointFrameId);
            if (fb === false) return false;
            if (fb !== undefined) {
              checkpointFrameId = fb.checkpoint;
              targetPlayoutDelayMs = fb.playoutDelayMs;
              receivedFrames = fb.receivedFrames;
              packetNacks = fb.nacks;
            }
          }
          break;
        case RtcpPacketType.extendedReports: {
          const t = this.parseExtendedReports(dv, start, end);
          if (t === false) return false;
          if (t !== undefined) receiverReferenceTime = t;
          break;
        }
        default:
          break;
      }
    }

    // A reference time stamps the packet: ignore packets older than the newest one seen.
    if (receiverReferenceTime !== undefined) {
      if (this.latestReceiverTimestampMs !== undefined && receiverReferenceTime < this.latestReceiverTimestampMs) return true;
      this.latestReceiverTimestampMs = receiverReferenceTime;
      this.client.onReceiverReferenceTimeAdvanced?.(receiverReferenceTime);
    }
    if (receiverReport !== undefined) this.client.onReceiverReport?.(receiverReport);
    if (logMessages.length > 0) this.client.onCastReceiverFrameLogMessages?.(logMessages);
    if (checkpointFrameId !== undefined) this.client.onReceiverCheckpoint?.(checkpointFrameId, targetPlayoutDelayMs);
    if (receivedFrames.length > 0) this.client.onReceiverHasFrames?.(receivedFrames);
    const nacks = canonicalizePacketNacks(packetNacks);
    if (nacks.length > 0) this.client.onReceiverIsMissingPackets?.(nacks);
    if (pictureLoss) this.client.onReceiverIndicatesPictureLoss?.();
    return true;
  }

  /** `ParseApplicationDefined` + `ParseFrameLogMessages`: the receiver's event log goes into `messages`. */
  private parseApplicationDefined(dv: DataView, subtype: number, start: number, end: number, messages: RtcpReceiverFrameLogMessage[]): boolean {
    if (end - start < 8) return false;
    const senderSsrc = dv.getUint32(start);
    const name = dv.getUint32(start + 4);
    if (senderSsrc !== this.session.receiverSsrc) return true;
    if (name !== RTCP_CAST_IDENTIFIER_WORD) return name === RTCP_TIME_SYNC_REQUEST_NAME;
    if (subtype !== RtcpSubtype.receiverLog) return true;
    let p = start + 8;
    while (p < end) {
      if (end - p < RTCP_RECEIVER_FRAME_LOG_MESSAGE_HEADER_SIZE) return false;
      const truncatedRtpTimestamp = dv.getUint32(p);
      const data = dv.getUint32(p + 4);
      p += RTCP_RECEIVER_FRAME_LOG_MESSAGE_HEADER_SIZE;
      // The low 24 bits are the events' base time, in milliseconds from when the session started.
      const eventTimestampBase = this.session.startTimeMs + (data & 0xffffff);
      // At least one event is required, so a count of 0 on the wire means one.
      const numEvents = 1 + (data >>> 24);
      const rtpTimestamp = expandRtpTimestamp(this.latestFrameLogRtpTimestamp, truncatedRtpTimestamp);
      const frameLog: RtcpReceiverFrameLogMessage = { rtpTimestamp, messages: [] };
      for (let i = 0; i < numEvents; i++) {
        if (end - p < RTCP_RECEIVER_FRAME_LOG_MESSAGE_BLOCK_SIZE) return false;
        const delayDeltaOrPacketId = dv.getUint16(p);
        const typeAndTimestampDelta = dv.getUint16(p + 2);
        p += RTCP_RECEIVER_FRAME_LOG_MESSAGE_BLOCK_SIZE;
        // Unknown event types are not useful.
        const type = fromWireType(typeAndTimestampDelta >> 12);
        if (type === "unknown") continue;
        const event: RtcpReceiverEventLogMessage = { type, timestamp: eventTimestampBase + (typeAndTimestampDelta & 0xfff), packetId: 0, delay: 0 };
        if (type === "packetReceived") event.packetId = delayDeltaOrPacketId;
        else event.delay = (delayDeltaOrPacketId << 16) >> 16;
        frameLog.messages.push(event);
      }
      this.latestFrameLogRtpTimestamp = rtpTimestamp;
      messages.push(frameLog);
    }
    return true;
  }

  /**
   * `ParseFeedback`. Returns false when malformed, undefined when it is to be ignored (other SSRCs, or a checkpoint
   * that would move backwards), else the feedback.
   */
  private parseFeedback(
    dv: DataView,
    start: number,
    end: number,
    maxFeedbackFrameId: number,
    previousCheckpoint: number | undefined,
  ):
    | { checkpoint: number; playoutDelayMs: number; receivedFrames: number[]; nacks: PacketNack[] }
    | undefined
    | false {
    if (end - start < RTCP_FEEDBACK_HEADER_SIZE) return false;
    if (dv.getUint32(start) !== this.session.receiverSsrc || dv.getUint32(start + 4) !== this.session.senderSsrc) return undefined;
    if (dv.getUint32(start + 8) !== RTCP_CAST_IDENTIFIER_WORD) return false;
    const feedbackFrameId = expandLessThanOrEqual(maxFeedbackFrameId, dv.getUint8(start + 12), 8);
    const lossFieldCount = dv.getUint8(start + 13);
    const playoutDelayMs = dv.getUint16(start + 14);
    // The client assumes a monotonically non-decreasing checkpoint.
    if (previousCheckpoint !== undefined && previousCheckpoint > feedbackFrameId) return undefined;
    let p = start + RTCP_FEEDBACK_HEADER_SIZE;
    if (end - p < RTCP_FEEDBACK_LOSS_FIELD_SIZE * lossFieldCount) return false;

    const nacks: PacketNack[] = [];
    for (let i = 0; i < lossFieldCount; i++) {
      const frameId = expandGreaterThan(feedbackFrameId, dv.getUint8(p), 8);
      let packetId = dv.getUint16(p + 1);
      let bits = dv.getUint8(p + 3);
      p += RTCP_FEEDBACK_LOSS_FIELD_SIZE;
      nacks.push({ frameId, packetId });
      if (packetId !== ALL_PACKETS_LOST) {
        // Each set bit is another missing packet id after this one.
        while (bits !== 0) {
          packetId++;
          if (bits & 1) nacks.push({ frameId, packetId });
          bits >>= 1;
        }
      }
    }

    const receivedFrames: number[] = [];
    // The optional CST2 frame-level ACKs; trailing bytes that are not 'CST2' are not an error.
    if (end - p >= RTCP_FEEDBACK_ACK_HEADER_SIZE && dv.getUint32(p) === RTCP_CST2_IDENTIFIER_WORD) {
      p += 4;
      p += 1; // feedback count, unused
      const octets = dv.getUint8(p);
      p += 1;
      if (end - p < octets) return false;
      // The first bit is checkpoint + 2 (rtp_defines.h, "plus two").
      let startingFrameId = feedbackFrameId + 2;
      for (let i = 0; i < octets; i++) {
        let bits = dv.getUint8(p + i);
        let frameId = startingFrameId;
        while (bits !== 0) {
          if (bits & 1) receivedFrames.push(frameId);
          frameId++;
          bits >>= 1;
        }
        startingFrameId += 8;
      }
    }
    return { checkpoint: feedbackFrameId, playoutDelayMs, receivedFrames, nacks };
  }

  /** `ParseExtendedReports`: the receiver reference time (block type 4), or undefined when absent or not ours. */
  private parseExtendedReports(dv: DataView, start: number, end: number): number | undefined | false {
    if (end - start < RTCP_EXTENDED_REPORT_HEADER_SIZE) return false;
    if (dv.getUint32(start) !== this.session.receiverSsrc) return undefined;
    let p = start + 4;
    let referenceTime: number | undefined;
    while (p < end) {
      if (end - p < RTCP_EXTENDED_REPORT_BLOCK_HEADER_SIZE) return false;
      const blockType = dv.getUint8(p);
      const blockDataSize = dv.getUint16(p + 2) * 4;
      p += RTCP_EXTENDED_REPORT_BLOCK_HEADER_SIZE;
      if (end - p < blockDataSize) return false;
      if (blockType === RTCP_RECEIVER_REFERENCE_TIME_REPORT_BLOCK_TYPE) {
        if (blockDataSize !== 8) return false;
        referenceTime = this.session.ntp.toLocalTime(dv.getBigUint64(p));
      }
      p += blockDataSize;
    }
    return referenceTime;
  }
}
