/**
 * RTCP sender report, ported from openscreen `cast/streaming/impl/sender_report_builder.cc`
 * (`SenderReportBuilder::BuildPacket`) and `RtcpReportBlock::AppendFields` (rtcp_common.cc).
 */
import type { NtpTimeConverter } from "./ntp.ts";
import { toStatusReportId } from "./ntp.ts";
import {
  RTCP_CUMULATIVE_PACKETS_FIELD_NUM_BITS,
  RTCP_REPORT_BLOCK_SIZE,
  RTCP_SENDER_REPORT_SIZE,
  RtcpPacketType,
  writeCommonHeader,
} from "./wire.ts";

/** rtcp_common.h `RtcpReportBlock`. `delaySinceLastReport` is in 1/65536 s units. */
export interface RtcpReportBlock {
  ssrc: number;
  packetFractionLostNumerator: number;
  cumulativePacketsLost: number;
  extendedHighSequenceNumber: number;
  jitter: number;
  lastStatusReportId: number;
  delaySinceLastReport: number;
}

/** rtcp_common.h `RtcpSenderReport`. */
export interface RtcpSenderReport {
  referenceTimeMs: number;
  rtpTimestamp: number;
  sendPacketCount: number;
  sendOctetCount: number;
  reportBlock?: RtcpReportBlock;
}

/** `RtcpReportBlock::AppendFields`: ssrc, (fraction << 24 | cumulative lost), highest seq, jitter, last SR, delay. */
export function writeReportBlock(out: Buffer, offset: number, b: RtcpReportBlock): number {
  out.writeUInt32BE(b.ssrc >>> 0, offset);
  out.writeUInt32BE(
    (((b.packetFractionLostNumerator << RTCP_CUMULATIVE_PACKETS_FIELD_NUM_BITS) | (b.cumulativePacketsLost & 0xffffff)) >>> 0) >>> 0,
    offset + 4,
  );
  out.writeUInt32BE(b.extendedHighSequenceNumber >>> 0, offset + 8);
  out.writeUInt32BE(b.jitter >>> 0, offset + 12);
  out.writeUInt32BE(b.lastStatusReportId >>> 0, offset + 16);
  out.writeUInt32BE(b.delaySinceLastReport >>> 0, offset + 20);
  return offset + RTCP_REPORT_BLOCK_SIZE;
}

/** `RtcpReportBlock::ParseOneV1`: the block for `ssrc`, skipping blocks meant for others. */
export function parseReportBlock(buf: Uint8Array, start: number, reportCount: number, ssrc: number): RtcpReportBlock | undefined {
  if (buf.length - start < RTCP_REPORT_BLOCK_SIZE * reportCount) return undefined;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let result: RtcpReportBlock | undefined;
  for (let i = 0; i < reportCount; i++) {
    const o = start + i * RTCP_REPORT_BLOCK_SIZE;
    if (dv.getUint32(o) !== ssrc) continue;
    const second = dv.getUint32(o + 4);
    result = {
      ssrc,
      packetFractionLostNumerator: second >>> RTCP_CUMULATIVE_PACKETS_FIELD_NUM_BITS,
      cumulativePacketsLost: second & 0xffffff,
      extendedHighSequenceNumber: dv.getUint32(o + 8),
      jitter: dv.getUint32(o + 12),
      lastStatusReportId: dv.getUint32(o + 16),
      delaySinceLastReport: dv.getUint32(o + 20),
    };
  }
  return result;
}

/** `BuildPacket`: the packet and the `StatusReportId` the receiver will echo in its report block. */
export function buildSenderReport(
  senderSsrc: number,
  ntp: NtpTimeConverter,
  report: RtcpSenderReport,
): { packet: Buffer; statusReportId: number } {
  const payloadSize = RTCP_SENDER_REPORT_SIZE + (report.reportBlock === undefined ? 0 : RTCP_REPORT_BLOCK_SIZE);
  const out = Buffer.allocUnsafe(4 + payloadSize);
  let o = writeCommonHeader(out, 0, RtcpPacketType.senderReport, report.reportBlock === undefined ? 0 : 1, payloadSize);
  o = out.writeUInt32BE(senderSsrc >>> 0, o);
  const ntpTimestamp = ntp.toNtpTimestamp(report.referenceTimeMs);
  o = out.writeBigUInt64BE(ntpTimestamp, o);
  o = out.writeUInt32BE(report.rtpTimestamp >>> 0, o);
  o = out.writeUInt32BE(report.sendPacketCount >>> 0, o);
  o = out.writeUInt32BE(report.sendOctetCount >>> 0, o);
  if (report.reportBlock !== undefined) writeReportBlock(out, o, report.reportBlock);
  return { packet: out, statusReportId: toStatusReportId(ntpTimestamp) };
}
