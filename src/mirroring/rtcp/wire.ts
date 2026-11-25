/**
 * RTCP wire constants and the common header, from openscreen `cast/streaming/impl/rtp_defines.h` and
 * `impl/rtcp_common.cc` (`RtcpCommonHeader::AppendFields`, `ParseV1`).
 */

/** rtp_defines.h `RtcpPacketType`. */
export const RtcpPacketType = {
  senderReport: 200,
  receiverReport: 201,
  sourceDescription: 202,
  applicationDefined: 204,
  payloadSpecific: 206,
  extendedReports: 207,
} as const;

/** rtp_defines.h `RtcpSubtype`. */
export const RtcpSubtype = {
  null: 0,
  pictureLossIndicator: 1,
  receiverLog: 2,
  feedback: 15,
} as const;

export const RTCP_COMMON_HEADER_SIZE = 4;
export const RTCP_SENDER_REPORT_SIZE = 24;
export const RTCP_RECEIVER_REPORT_SIZE = 4;
export const RTCP_REPORT_BLOCK_SIZE = 24;
export const RTCP_FEEDBACK_HEADER_SIZE = 16;
export const RTCP_FEEDBACK_LOSS_FIELD_SIZE = 4;
export const RTCP_FEEDBACK_ACK_HEADER_SIZE = 6;
export const RTCP_EXTENDED_REPORT_HEADER_SIZE = 4;
export const RTCP_EXTENDED_REPORT_BLOCK_HEADER_SIZE = 4;
export const RTCP_PICTURE_LOSS_INDICATOR_HEADER_SIZE = 8;
export const RTCP_RECEIVER_FRAME_LOG_MESSAGE_HEADER_SIZE = 8;
export const RTCP_RECEIVER_FRAME_LOG_MESSAGE_BLOCK_SIZE = 4;
/** rtp_defines.h `kRtcpRequiredVersionAndPaddingBits`, `kRtcpReportCountFieldNumBits`. */
export const RTCP_REQUIRED_VERSION_AND_PADDING_BITS = 0b100;
export const RTCP_REPORT_COUNT_FIELD_NUM_BITS = 5;
/** rtp_defines.h `kRtcpCastIdentifierWord` ('CAST'), `kRtcpCst2IdentifierWord` ('CST2'). */
export const RTCP_CAST_IDENTIFIER_WORD = 0x43415354;
export const RTCP_CST2_IDENTIFIER_WORD = 0x43535432;
/** compound_rtcp_parser.cc `kTimeSyncRequestName` ('TIME'). */
export const RTCP_TIME_SYNC_REQUEST_NAME = 0x54494d45;
/** rtp_defines.h `kRtcpReceiverReferenceTimeReportBlockType`. */
export const RTCP_RECEIVER_REFERENCE_TIME_REPORT_BLOCK_TYPE = 4;
/** rtp_defines.h `kRtcpCumulativePacketsFieldNumBits`. */
export const RTCP_CUMULATIVE_PACKETS_FIELD_NUM_BITS = 24;

export interface RtcpCommonHeader {
  packetType: number;
  /** Report count (SR/RR) or subtype (APP/PSFB). */
  countOrSubtype: number;
  payloadSize: number;
}

/** `RtcpCommonHeader::AppendFields`. */
export function writeCommonHeader(out: Buffer, offset: number, packetType: number, countOrSubtype: number, payloadSize: number): number {
  if (payloadSize % 4 !== 0) throw new RangeError("RTCP payload must be a whole number of words");
  out[offset] = (RTCP_REQUIRED_VERSION_AND_PADDING_BITS << RTCP_REPORT_COUNT_FIELD_NUM_BITS) | countOrSubtype;
  out[offset + 1] = packetType;
  out.writeUInt16BE(payloadSize / 4, offset + 2);
  return offset + RTCP_COMMON_HEADER_SIZE;
}

const KNOWN_PACKET_TYPES: ReadonlySet<number> = new Set(Object.values(RtcpPacketType));

/** `RtcpCommonHeader::ParseV1`; undefined when the header is not a valid RTCP one. */
export function parseCommonHeader(buf: Uint8Array, offset: number): RtcpCommonHeader | undefined {
  if (buf.length - offset < RTCP_COMMON_HEADER_SIZE) return undefined;
  const byte0 = buf[offset]!;
  if (byte0 >> RTCP_REPORT_COUNT_FIELD_NUM_BITS !== RTCP_REQUIRED_VERSION_AND_PADDING_BITS) return undefined;
  const packetType = buf[offset + 1]!;
  if (!KNOWN_PACKET_TYPES.has(packetType)) return undefined;
  const words = (buf[offset + 2]! << 8) | buf[offset + 3]!;
  return { packetType, countOrSubtype: byte0 & 0b11111, payloadSize: words * 4 };
}
