/**
 * Statistics events, ported from openscreen `cast/streaming/impl/statistics_common.{h,cc}` (`StatisticsEvent`,
 * `FrameEvent`, `PacketEvent`, the wire event types of the receiver's RTCP event log) and the frame log messages the
 * RTCP parser hands over (`rtcp_common.h` `RtcpReceiverFrameLogMessage`, `RtcpReceiverEventLogMessage`).
 *
 * Times are milliseconds on a monotonic clock, fractional where the C++ keeps microseconds. `NO_TIME_MIN` and
 * `NO_TIME_MAX` stand for `Clock::time_point::min()` and `max()`. The RTP timestamp is the 64-bit `RtpTimeTicks`.
 */
import type { StreamType } from "../sender/packet-router.ts";

export const NO_TIME_MIN = Number.NEGATIVE_INFINITY;
export const NO_TIME_MAX = Number.POSITIVE_INFINITY;

/** `StatisticsEvent::Type`. */
export type StatisticsEventType =
  | "unknown"
  | "frameCaptureBegin"
  | "frameCaptureEnd"
  | "frameEncoded"
  | "frameAckReceived"
  | "frameAckSent"
  | "frameDecoded"
  | "framePlayedOut"
  | "packetSentToNetwork"
  | "packetRetransmitted"
  | "packetRtxRejected"
  | "packetReceived"
  | "frameDroppedByEncoder";

/** `StatisticsEvent::MediaType`. */
export type StatisticsMediaType = "unknown" | "audio" | "video";

/** `StatisticsEvent::ToMediaType`. */
export function toMediaType(type: StreamType | "unknown"): StatisticsMediaType {
  return type;
}

/** `StatisticsEvent::FromWireType`: the legacy audio and video values and the unified ones map to one type. */
export function fromWireType(wireType: number): StatisticsEventType {
  switch (wireType) {
    case 1:
    case 5:
    case 11:
      return "frameAckSent";
    case 2:
    case 6:
    case 12:
      return "framePlayedOut";
    case 3:
    case 7:
    case 13:
      return "frameDecoded";
    case 4:
    case 8:
    case 14:
      return "packetReceived";
    default:
      return "unknown";
  }
}

export interface StatisticsEvent {
  frameId: number;
  type: StatisticsEventType;
  mediaType: StatisticsMediaType;
  rtpTimestamp: number;
  /** Size of the packet, or of the frame the event is about. */
  size: number;
  /** When the event happened, on the clock of whoever logged it. */
  timestamp: number;
  /** When the sender learned of a receiver-side event. */
  receivedTimestamp: number;
}

/** `FrameEvent`. */
export interface FrameEvent extends StatisticsEvent {
  /** Only for played-out events: positive when the frame was late. */
  delayDelta: number;
  keyFrame: boolean;
}

/** `PacketEvent`. */
export interface PacketEvent extends StatisticsEvent {
  packetId: number;
  maxPacketId: number;
}

/** `RtcpReceiverEventLogMessage`. */
export interface RtcpReceiverEventLogMessage {
  type: StatisticsEventType;
  timestamp: number;
  /** For packet received events. */
  packetId: number;
  /** For played-out events. */
  delay: number;
}

/** `RtcpReceiverFrameLogMessage`. */
export interface RtcpReceiverFrameLogMessage {
  rtpTimestamp: number;
  messages: RtcpReceiverEventLogMessage[];
}

/**
 * `RtpTimeTicks::Expand`: the 64-bit value closest to `reference` whose low 32 bits are `lower32`, so a timestamp that
 * wrapped, or one a little behind the reference, expands correctly.
 */
export function expandRtpTimestamp(reference: number, lower32: number): number {
  const referenceLow = reference % 4294967296;
  const diff = (lower32 - referenceLow) | 0;
  return reference + diff;
}
