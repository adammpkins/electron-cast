/**
 * Gathers frame and packet events until the analyzer takes them, ported from openscreen
 * `cast/streaming/impl/statistics_collector.{h,cc}` (`StatisticsCollector`).
 */
import type { StreamType } from "../sender/packet-router.ts";
import { expandRtpTimestamp, toMediaType, NO_TIME_MIN, type FrameEvent, type PacketEvent } from "./statistics-common.ts";

/** `PacketMetadata`: what the router knows about a packet it sends. */
export interface PacketMetadata {
  streamType: StreamType;
  /** The sender's latest RTP timestamp, the reference the packet's 32-bit timestamp is expanded against. */
  rtpTimestamp: number;
  /** True when this RTP packet was sent before. */
  isRetransmission?: boolean;
}

/** A packet's size plus the offsets `CollectPacketSentEvent` reads: RTP timestamp at 4, packet ids at 14 and 16. */
const MIN_PARSED_PACKET_SIZE = 18;

export class StatisticsCollector {
  private readonly now: () => number;
  private recentPacketEvents: PacketEvent[] = [];
  private recentFrameEvents: FrameEvent[] = [];

  constructor(now: () => number) {
    this.now = now;
  }

  /**
   * `CollectPacketSentEvent`: parses the wire packet. Every packet the router sends comes through here, as in openscreen
   * (`Environment::SendPacket`), so the sender reports are read as if they were RTP packets.
   */
  collectPacketSentEvent(packet: Uint8Array, metadata: PacketMetadata): void {
    // The C++ checks the packet is long enough; a shorter one cannot be sent by the router.
    if (packet.length < MIN_PARSED_PACKET_SIZE) return;
    const dv = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
    this.recentPacketEvents.push({
      frameId: -1,
      type: metadata.isRetransmission === true ? "packetRetransmitted" : "packetSentToNetwork",
      mediaType: toMediaType(metadata.streamType),
      rtpTimestamp: expandRtpTimestamp(metadata.rtpTimestamp, dv.getUint32(4)),
      size: packet.length,
      timestamp: this.now(),
      receivedTimestamp: NO_TIME_MIN,
      packetId: dv.getUint16(14),
      maxPacketId: dv.getUint16(16),
    });
  }

  collectPacketEvent(event: PacketEvent): void {
    this.recentPacketEvents.push(event);
  }

  collectFrameEvent(event: FrameEvent): void {
    this.recentFrameEvents.push(event);
  }

  takeRecentPacketEvents(): PacketEvent[] {
    const out = this.recentPacketEvents;
    this.recentPacketEvents = [];
    return out;
  }

  takeRecentFrameEvents(): FrameEvent[] {
    const out = this.recentFrameEvents;
    this.recentFrameEvents = [];
    return out;
  }
}
