/**
 * Turns what the sender does and what the receiver reports into statistics events, ported from openscreen
 * `cast/streaming/impl/statistics_dispatcher.{h,cc}` (`StatisticsDispatcher`).
 *
 * The collector is read from the environment at each call, as in openscreen: statistics are on only while a stats
 * client is set on the session.
 */
import type { EncodedFrame } from "../rtp/frame.ts";
import type { StreamType } from "../sender/packet-router.ts";
import type { StatisticsCollector } from "./statistics-collector.ts";
import {
  NO_TIME_MIN,
  toMediaType,
  type FrameEvent,
  type PacketEvent,
  type RtcpReceiverFrameLogMessage,
  type StatisticsEventType,
} from "./statistics-common.ts";

/** What the dispatcher needs from an environment (`Environment::statistics_collector`, `now`). */
export interface StatisticsEnvironment {
  now(): number;
  statisticsCollector?: StatisticsCollector | undefined;
}

function frameEvent(type: StatisticsEventType, partial: Partial<FrameEvent>): FrameEvent {
  return {
    frameId: -1,
    type,
    mediaType: "unknown",
    rtpTimestamp: 0,
    size: 0,
    timestamp: NO_TIME_MIN,
    receivedTimestamp: NO_TIME_MIN,
    delayDelta: 0,
    keyFrame: false,
    ...partial,
  };
}

export class StatisticsDispatcher {
  private readonly environment: StatisticsEnvironment;

  constructor(environment: StatisticsEnvironment) {
    this.environment = environment;
  }

  /** `DispatchEnqueueEvents`: capture begin, capture end and encoded, for a frame the sender accepted. */
  dispatchEnqueueEvents(streamType: StreamType, frame: EncodedFrame): void {
    const collector = this.environment.statisticsCollector;
    if (collector === undefined) return;
    const mediaType = toMediaType(streamType);
    const now = this.environment.now();
    // Capture times are optional; a frame without them is logged as captured now.
    const captureBegin = frame.captureBeginTimeMs !== undefined && frame.captureBeginTimeMs > NO_TIME_MIN ? frame.captureBeginTimeMs : now;
    const captureEnd = frame.captureEndTimeMs !== undefined && frame.captureEndTimeMs > NO_TIME_MIN ? frame.captureEndTimeMs : now;
    collector.collectFrameEvent(frameEvent("frameCaptureBegin", { mediaType, rtpTimestamp: frame.rtpTimestamp, timestamp: captureBegin }));
    collector.collectFrameEvent(frameEvent("frameCaptureEnd", { mediaType, rtpTimestamp: frame.rtpTimestamp, timestamp: captureEnd }));
    collector.collectFrameEvent(
      frameEvent("frameEncoded", {
        mediaType,
        rtpTimestamp: frame.rtpTimestamp,
        frameId: frame.frameId,
        size: frame.data.length,
        timestamp: now,
        keyFrame: frame.dependency === "key",
      }),
    );
  }

  /** `DispatchAckEvent`. */
  dispatchAckEvent(streamType: StreamType, rtpTimestamp: number, frameId: number): void {
    const collector = this.environment.statisticsCollector;
    if (collector === undefined) return;
    collector.collectFrameEvent(
      frameEvent("frameAckReceived", { mediaType: toMediaType(streamType), rtpTimestamp, frameId, timestamp: this.environment.now() }),
    );
  }

  /** `DispatchFrameDropEvent`. */
  dispatchFrameDropEvent(streamType: StreamType, frameId: number, rtpTimestamp: number, dropTimeMs: number): void {
    const collector = this.environment.statisticsCollector;
    if (collector === undefined) return;
    collector.collectFrameEvent(
      frameEvent("frameDroppedByEncoder", { mediaType: toMediaType(streamType), rtpTimestamp, frameId, timestamp: dropTimeMs }),
    );
  }

  /** `DispatchFrameLogMessages`: the receiver's RTCP event log. */
  dispatchFrameLogMessages(streamType: StreamType, messages: RtcpReceiverFrameLogMessage[]): void {
    const collector = this.environment.statisticsCollector;
    if (collector === undefined) return;
    const now = this.environment.now();
    const mediaType = toMediaType(streamType);
    for (const log of messages) {
      for (const event of log.messages) {
        switch (event.type) {
          case "packetReceived": {
            const packetEvent: PacketEvent = {
              frameId: -1,
              type: event.type,
              mediaType,
              rtpTimestamp: log.rtpTimestamp,
              size: 0,
              timestamp: event.timestamp,
              receivedTimestamp: now,
              packetId: event.packetId,
              maxPacketId: 0,
            };
            collector.collectPacketEvent(packetEvent);
            break;
          }
          case "frameAckSent":
          case "frameDecoded":
          case "framePlayedOut":
            collector.collectFrameEvent(
              frameEvent(event.type, {
                mediaType,
                rtpTimestamp: log.rtpTimestamp,
                timestamp: event.timestamp,
                receivedTimestamp: now,
                ...(event.type === "framePlayedOut" ? { delayDelta: event.delay } : {}),
              }),
            );
            break;
          default:
            // An event type the sender does not expect from a receiver log.
            break;
        }
      }
    }
  }
}
