/**
 * Paced packet router, ported from openscreen `cast/streaming/impl/sender_packet_router.cc`
 * (`SenderPacketRouter`): senders ask for RTCP and RTP sends, and the router emits them in bursts of at most
 * `maxPacketsPerBurst` packets every `burstInterval` (RTCP first, then RTP by SSRC priority). It also owns the
 * `BandwidthEstimator`, as the C++ class derives from it.
 *
 * Pacing time and the socket come from an injected `SenderEnvironment`, so the same code runs against a real UDP
 * socket in the utility process and against a fake clock in tests.
 */
import { RTCP_REPORT_INTERVAL_MS, REQUIRED_NETWORK_PACKET_SIZE } from "../protocol/constants.ts";
import { BandwidthEstimator } from "./bandwidth-estimator.ts";
import { parseCommonHeader, RTCP_COMMON_HEADER_SIZE } from "../rtcp/wire.ts";

/** sender_packet_router.h `kDefaultMaxBurstBitrate` (24 << 20) and `kDefaultBurstInterval`. */
export const DEFAULT_MAX_BURST_BITRATE = 24 << 20;
export const DEFAULT_BURST_INTERVAL_MS = 10;
/** `kNever`; `Alarm::kImmediately` is any time at or before now. */
export const NEVER = Number.POSITIVE_INFINITY;
export const IMMEDIATELY = Number.NEGATIVE_INFINITY;

export type StreamType = "audio" | "video";

/** What the router needs from the environment: openscreen `Environment` (now, SendPacket, GetMaxPacketSize, Alarm). */
export interface SenderEnvironment {
  now(): number;
  sendPacket(packet: Buffer): void;
  readonly maxPacketSize: number;
  /** Run `cb` at `atMs`; returns a cancel function. */
  schedule(atMs: number, cb: () => void): () => void;
}

/** sender_packet_router.h `SenderPacketRouter::Sender`. */
export interface RoutedSender {
  onReceivedRtcpPacket(arrivalTimeMs: number, packet: Buffer): void;
  /** An empty (undefined) result means nothing to send. */
  getRtcpPacketForImmediateSend(sendTimeMs: number): Buffer | undefined;
  getRtpPacketForImmediateSend(sendTimeMs: number): Buffer | undefined;
  getRtpResumeTime(): number;
  readonly streamType: StreamType;
  readonly wasLastRtpPacketRetransmission: boolean;
}

interface SenderEntry {
  receiverSsrc: number;
  sender: RoutedSender;
  nextRtcpSendTime: number;
  nextRtpSendTime: number;
}

/** `ComputeMaxPacketsPerBurst`. */
export function computeMaxPacketsPerBurst(maxBurstBitrate: number, packetSize: number, burstIntervalMs: number): number {
  const maxPacketsPerSecond = Math.floor(maxBurstBitrate / 8 / packetSize);
  const burstsPerSecond = Math.floor(1000 / burstIntervalMs);
  return Math.max(Math.floor(maxPacketsPerSecond / burstsPerSecond), 1);
}

export class SenderPacketRouter extends BandwidthEstimator {
  readonly maxPacketSize: number;
  readonly maxPacketsPerBurst: number;
  readonly burstIntervalMs: number;
  private readonly env: SenderEnvironment;
  private readonly senders: SenderEntry[] = [];
  private lastBurstTime = Number.NEGATIVE_INFINITY;
  private cancelAlarm: (() => void) | undefined;

  constructor(env: SenderEnvironment, maxBurstBitrate: number = DEFAULT_MAX_BURST_BITRATE, burstIntervalMs: number = DEFAULT_BURST_INTERVAL_MS) {
    const maxPacketsPerBurst = computeMaxPacketsPerBurst(maxBurstBitrate, env.maxPacketSize, burstIntervalMs);
    super(maxPacketsPerBurst * env.maxPacketSize, burstIntervalMs, env.now());
    if (!(env.maxPacketSize > REQUIRED_NETWORK_PACKET_SIZE)) throw new RangeError("packet size too small");
    this.env = env;
    this.maxPacketSize = env.maxPacketSize;
    this.maxPacketsPerBurst = maxPacketsPerBurst;
    this.burstIntervalMs = burstIntervalMs;
  }

  /** `OnSenderCreated`. Entries stay ordered by transmission priority (`ComparePriority`: lower SSRC first). */
  onSenderCreated(receiverSsrc: number, sender: RoutedSender): void {
    if (this.findEntry(receiverSsrc) !== undefined) throw new Error("sender already registered");
    this.senders.push({ receiverSsrc, sender, nextRtcpSendTime: NEVER, nextRtpSendTime: NEVER });
    this.senders.sort((a, b) => a.receiverSsrc - b.receiverSsrc);
  }

  /** `OnSenderDestroyed`. */
  onSenderDestroyed(receiverSsrc: number): void {
    const i = this.senders.findIndex((e) => e.receiverSsrc === receiverSsrc);
    if (i < 0) throw new Error("unknown sender");
    this.senders.splice(i, 1);
    if (this.senders.length === 0) this.stop();
  }

  /** `RequestRtcpSend`. */
  requestRtcpSend(receiverSsrc: number): void {
    const e = this.findEntry(receiverSsrc);
    if (e === undefined) throw new Error("unknown sender");
    e.nextRtcpSendTime = IMMEDIATELY;
    this.scheduleNextBurst();
  }

  /** `RequestRtpSend`. */
  requestRtpSend(receiverSsrc: number): void {
    const e = this.findEntry(receiverSsrc);
    if (e === undefined) throw new Error("unknown sender");
    e.nextRtpSendTime = IMMEDIATELY;
    this.scheduleNextBurst();
  }

  /**
   * `OnReceivedPacket`, after the transport has checked the source endpoint. Only RTCP is routed, by the SSRC that
   * follows the common header (`InspectPacketForRoutingV1`).
   */
  onReceivedPacket(arrivalTimeMs: number, packet: Buffer): void {
    if (packet.length < RTCP_COMMON_HEADER_SIZE + 4) return;
    if (parseCommonHeader(packet, 0) === undefined) return;
    const ssrc = packet.readUInt32BE(RTCP_COMMON_HEADER_SIZE);
    this.findEntry(ssrc)?.sender.onReceivedRtcpPacket(arrivalTimeMs, packet);
  }

  /** Cancel the pending burst; the router can still be restarted by a new send request. */
  stop(): void {
    this.cancelAlarm?.();
    this.cancelAlarm = undefined;
  }

  private findEntry(receiverSsrc: number): SenderEntry | undefined {
    return this.senders.find((e) => e.receiverSsrc === receiverSsrc);
  }

  /** `ScheduleNextBurst`: the earliest wanted send time, never sooner than one interval after the last burst. */
  private scheduleNextBurst(): void {
    const earliestAllowed = this.lastBurstTime + this.burstIntervalMs;
    let next = NEVER;
    for (const e of this.senders) {
      const t = Math.min(e.nextRtcpSendTime, e.nextRtpSendTime);
      if (t >= next) continue;
      if (t <= earliestAllowed) {
        next = earliestAllowed;
        break;
      }
      next = t;
    }
    this.cancelAlarm?.();
    this.cancelAlarm = undefined;
    if (next !== NEVER) this.cancelAlarm = this.env.schedule(next, () => this.sendBurstOfPackets());
  }

  /** `SendBurstOfPackets`: RTCP first, then RTP up to the burst budget. */
  private sendBurstOfPackets(): void {
    this.cancelAlarm = undefined;
    const burstTime = this.env.now();
    const rtcp = this.sendJustTheRtcpPackets(burstTime);
    const rtp = this.sendJustTheRtpPackets(burstTime, this.maxPacketsPerBurst - rtcp.packets);
    this.lastBurstTime = burstTime;
    this.onBurstComplete(rtcp.bytes + rtp.bytes, burstTime);
    this.scheduleNextBurst();
  }

  private sendJustTheRtcpPackets(sendTime: number): { packets: number; bytes: number } {
    const sent = { packets: 0, bytes: 0 };
    for (const e of this.senders) {
      if (e.nextRtcpSendTime > sendTime) continue;
      const packet = e.sender.getRtcpPacketForImmediateSend(sendTime);
      if (packet !== undefined && packet.length > 0) {
        this.env.sendPacket(packet);
        e.nextRtcpSendTime = sendTime + RTCP_REPORT_INTERVAL_MS;
        sent.packets++;
        sent.bytes += packet.length;
      }
    }
    return sent;
  }

  private sendJustTheRtpPackets(sendTime: number, numPacketsToSend: number): { packets: number; bytes: number } {
    const sent = { packets: 0, bytes: 0 };
    for (const e of this.senders) {
      if (sent.packets >= numPacketsToSend) break;
      if (e.nextRtpSendTime > sendTime) continue;
      for (; sent.packets < numPacketsToSend; sent.packets++) {
        const packet = e.sender.getRtpPacketForImmediateSend(sendTime);
        if (packet === undefined || packet.length === 0) break;
        this.env.sendPacket(packet);
        sent.bytes += packet.length;
      }
      e.nextRtpSendTime = e.sender.getRtpResumeTime();
    }
    return sent;
  }
}
