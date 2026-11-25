/**
 * One RTP stream's sender, ported from openscreen `cast/streaming/impl/sender_impl.cc` (`SenderImpl`) with the
 * public contract of `public/sender.h` (`Sender`, `Sender::Observer`, `EnqueueFrameResult`).
 *
 * The sender owns the per-frame state (encrypted frame, which packets still need sending, when each was last sent),
 * answers the router's "give me the next packet" calls, builds sender reports, and reacts to the receiver's RTCP:
 * checkpoint ACKs, per-frame ACKs, NACK retransmission, picture loss, and round-trip time from receiver reports.
 *
 * Times are milliseconds on the environment clock (`SenderEnvironment.now`); durations the C++ keeps in `Clock::duration`
 * (microseconds) are fractional milliseconds here.
 */
import { MAX_UNACKED_FRAMES, DEFAULT_FRAME_RATE } from "../protocol/constants.ts";
import { NtpTimeConverter } from "../rtcp/ntp.ts";
import { CompoundRtcpParser, type CompoundRtcpClient, type PacketNack } from "../rtcp/parser.ts";
import { buildSenderReport, type RtcpReportBlock } from "../rtcp/sender-report.ts";
import { FrameCrypto } from "../rtp/frame-crypto.ts";
import type { EncodedFrame, EncryptedFrame } from "../rtp/frame.ts";
import { RtpPacketizer, BASE_RTP_HEADER_SIZE } from "../rtp/packetizer.ts";
import { NEVER, type RoutedSender, type SenderEnvironment, type SenderPacketRouter, type StreamType } from "./packet-router.ts";

/** public/sender.h `Sender::EnqueueFrameResult`. */
export type EnqueueFrameResult = "OK" | "PAYLOAD_TOO_LARGE" | "REACHED_ID_SPAN_LIMIT" | "MAX_DURATION_IN_FLIGHT";

/** public/sender.h `Sender::Observer`. */
export interface SenderObserver {
  onFrameCanceled(frameId: number): void;
  onPictureLost(): void;
  onPacketsRetransmitted?(count: number): void;
}

/** public/session_config.h `SessionConfig`. */
export interface SessionConfig {
  senderSsrc: number;
  receiverSsrc: number;
  rtpTimebase: number;
  channels: number;
  targetPlayoutDelayMs: number;
  aesSecretKey: Uint8Array;
  aesIvMask: Uint8Array;
  isPliEnabled: boolean;
  streamType: StreamType;
  senderKeyframeCooldownMs?: number;
  maxInFlightMediaDurationMs?: number;
}

/** sender_impl.cc `kMinInFlightFrames`, `kInFlightJitterAllowance`, `kMinSenderInFlight` (81667 us), `kMaxUnpausedFrameDuration`. */
const MIN_IN_FLIGHT_FRAMES = 2;
const IN_FLIGHT_JITTER_ALLOWANCE_MS = 15;
export const MIN_SENDER_IN_FLIGHT_MS = (MIN_IN_FLIGHT_FRAMES * 1000) / DEFAULT_FRAME_RATE + IN_FLIGHT_JITTER_ALLOWANCE_MS;
const MAX_UNPAUSED_FRAME_DURATION_MS = 50;
/** sender_impl.cc `kNearZeroRoundTripTime` (75 us) and `kReportIdPrecision` (32 us). */
const NEAR_ZERO_ROUND_TRIP_TIME_MS = 0.075;
const REPORT_ID_PRECISION_MS = 0.032;

interface PendingFrameSlot {
  frame: EncryptedFrame;
  /** One flag per packet; true means the packet still needs sending. */
  sendFlags: boolean[];
  packetSentTimes: number[];
  mediaDurationMs: number;
}

interface ChosenPacket {
  slot: PendingFrameSlot;
  packetId: number;
}

export class Sender implements RoutedSender, CompoundRtcpClient {
  readonly streamType: StreamType;
  private readonly config: SessionConfig;
  private readonly router: SenderPacketRouter;
  private readonly env: SenderEnvironment;
  private readonly ntp: NtpTimeConverter;
  private readonly rtcpParser: CompoundRtcpParser;
  private readonly packetizer: RtpPacketizer;
  private readonly crypto: FrameCrypto;
  private observer: SenderObserver | undefined;

  private readonly slots = new Map<number, PendingFrameSlot>();
  private numFramesInFlight = 0;
  private inFlightMediaDurationMs = 0;
  private lastEnqueuedFrameId = -1;
  private checkpointFrameId = -1;
  private latestExpectedFrameId = -1;
  private playoutDelayChangeAtFrameId = 0;
  private targetPlayoutDelayMs: number;
  private roundTripTimeMs = 0;
  private rtcpPacketArrivalTime = NEVER;
  private firstSenderReportTime = NEVER;
  private pendingReport = { referenceTimeMs: NEVER, rtpTimestamp: 0, sendPacketCount: 0, sendOctetCount: 0 };
  private lastRtpPacketWasRetransmission = false;
  private pictureLostAtFrameId = -1;
  private lastEnqueuedKeyFrameId = -1;
  private lastEnqueuedKeyFrameTime = NEVER;
  private pendingCancellations: number[] = [];

  /** `SenderImpl::SenderImpl`; registers itself with the router. */
  constructor(env: SenderEnvironment, router: SenderPacketRouter, config: SessionConfig, rtpPayloadType: number, wallClockSeconds: number = Date.now() / 1000) {
    if (config.senderSsrc === config.receiverSsrc) throw new Error("sender and receiver SSRC must differ");
    if (!(config.rtpTimebase > 0 && config.targetPlayoutDelayMs > 0)) throw new RangeError("invalid session config");
    this.config = config;
    this.env = env;
    this.router = router;
    this.streamType = config.streamType;
    this.ntp = new NtpTimeConverter(env.now(), wallClockSeconds);
    this.rtcpParser = new CompoundRtcpParser({ senderSsrc: config.senderSsrc, receiverSsrc: config.receiverSsrc, ntp: this.ntp }, this);
    this.packetizer = new RtpPacketizer(rtpPayloadType, config.senderSsrc, router.maxPacketSize);
    this.crypto = new FrameCrypto(config.aesSecretKey, config.aesIvMask);
    this.targetPlayoutDelayMs = config.targetPlayoutDelayMs;
    router.onSenderCreated(config.receiverSsrc, this);
  }

  destroy(): void {
    this.router.onSenderDestroyed(this.config.receiverSsrc);
  }

  setObserver(observer: SenderObserver | undefined): void {
    this.observer = observer;
  }

  get inFlightFrameCount(): number {
    return this.numFramesInFlight;
  }

  get currentRoundTripTimeMs(): number {
    return this.roundTripTimeMs;
  }

  get targetPlayoutDelay(): number {
    return this.targetPlayoutDelayMs;
  }

  get nextFrameId(): number {
    return this.lastEnqueuedFrameId + 1;
  }

  get checkpoint(): number {
    return this.checkpointFrameId;
  }

  /** `Sender::NeedsKeyFrame`. */
  get needsKeyFrame(): boolean {
    return this.lastEnqueuedKeyFrameId <= this.pictureLostAtFrameId;
  }

  get wasLastRtpPacketRetransmission(): boolean {
    return this.lastRtpPacketWasRetransmission;
  }

  /** `GetInFlightMediaDuration`: what is in flight now plus the step the next frame would add. */
  getInFlightMediaDuration(nextFrameRtpTimestamp: number): number {
    if (this.numFramesInFlight === 0) return 0;
    let total = this.inFlightMediaDurationMs;
    const newest = this.activeSlot(this.lastEnqueuedFrameId);
    if (newest !== undefined) {
      const tailStep = ((nextFrameRtpTimestamp - newest.frame.rtpTimestamp) * 1000) / this.config.rtpTimebase;
      total += Math.min(Math.max(tailStep, 0), MAX_UNPAUSED_FRAME_DURATION_MS);
    }
    return total;
  }

  /** `GetMaxInFlightMediaDuration`. */
  getMaxInFlightMediaDuration(): number {
    if (this.config.maxInFlightMediaDurationMs !== undefined) return this.config.maxInFlightMediaDurationMs;
    if (this.config.streamType === "audio") return Math.max(MIN_SENDER_IN_FLIGHT_MS, this.targetPlayoutDelayMs);
    const maxInFlight = Math.max(MIN_SENDER_IN_FLIGHT_MS, (this.targetPlayoutDelayMs * 2) / 3);
    return Math.min(Math.max(this.roundTripTimeMs * 2, MIN_SENDER_IN_FLIGHT_MS), maxInFlight);
  }

  /** `EnqueueFrame`. The frame id must be `nextFrameId`; the data is encrypted into a copy. */
  enqueueFrame(frame: EncodedFrame): EnqueueFrameResult {
    if (frame.frameId !== this.nextFrameId) throw new Error(`frame id ${frame.frameId} is not the next (${this.nextFrameId})`);
    if (frame.referencedFrameId < 0) throw new RangeError("referenced frame id must not precede the first frame");
    if (frame.frameId !== 0 && !(frame.rtpTimestamp > this.pendingReport.rtpTimestamp)) {
      throw new RangeError("RTP timestamps must increase");
    }
    if (frame.frameId - this.checkpointFrameId > MAX_UNACKED_FRAMES) return "REACHED_ID_SPAN_LIMIT";

    const inFlight = this.getInFlightMediaDuration(frame.rtpTimestamp);
    if (inFlight > this.getMaxInFlightMediaDuration()) return "MAX_DURATION_IN_FLIGHT";

    const encrypted = this.crypto.encrypt(frame);
    const packetCount = this.packetizer.computeNumberOfPackets(encrypted);
    if (packetCount <= 0) return "PAYLOAD_TOO_LARGE";
    const slot: PendingFrameSlot = {
      frame: encrypted,
      sendFlags: new Array<boolean>(packetCount).fill(true),
      packetSentTimes: new Array<number>(packetCount).fill(NEVER),
      mediaDurationMs: 0,
    };
    this.slots.set(frame.frameId, slot);

    if (this.lastEnqueuedFrameId !== -1) {
      const prev = this.activeSlot(this.lastEnqueuedFrameId);
      if (prev !== undefined) {
        const prevDuration = ((encrypted.rtpTimestamp - prev.frame.rtpTimestamp) * 1000) / this.config.rtpTimebase;
        prev.mediaDurationMs = Math.min(Math.max(prevDuration, 0), MAX_UNPAUSED_FRAME_DURATION_MS);
        this.inFlightMediaDurationMs += prev.mediaDurationMs;
      }
    }

    this.numFramesInFlight++;
    this.lastEnqueuedFrameId = encrypted.frameId;
    if (encrypted.dependency === "key") {
      this.lastEnqueuedKeyFrameId = encrypted.frameId;
      this.lastEnqueuedKeyFrameTime = this.env.now();
    }
    if (encrypted.newPlayoutDelayMs > 0) {
      this.targetPlayoutDelayMs = encrypted.newPlayoutDelayMs;
      this.playoutDelayChangeAtFrameId = encrypted.frameId;
    }
    this.pendingReport.referenceTimeMs =
      frame.frameId === 0 ? encrypted.referenceTimeMs : Math.max(encrypted.referenceTimeMs, this.pendingReport.referenceTimeMs);
    this.pendingReport.rtpTimestamp = encrypted.rtpTimestamp;

    // Until a round trip is known, get a sender report out first so the receiver can answer it.
    if (this.roundTripTimeMs === 0) this.router.requestRtcpSend(this.config.receiverSsrc);
    this.router.requestRtpSend(this.config.receiverSsrc);
    return "OK";
  }

  /** `CancelInFlightData`: drop everything not yet acknowledged (session teardown). */
  cancelInFlightData(): void {
    while (this.checkpointFrameId < this.lastEnqueuedFrameId) {
      this.checkpointFrameId++;
      this.cancelPendingFrame(this.checkpointFrameId, false);
    }
    this.dispatchCancellations();
  }

  /** `OnReceivedRtcpPacket`. */
  onReceivedRtcpPacket(arrivalTimeMs: number, packet: Buffer): void {
    this.rtcpPacketArrivalTime = arrivalTimeMs;
    if (this.rtcpParser.parse(packet, this.lastEnqueuedFrameId)) {
      this.router.onRtcpReceived(arrivalTimeMs, this.roundTripTimeMs);
    }
  }

  /** `GetRtcpPacketForImmediateSend`: a sender report, once a frame has been enqueued. */
  getRtcpPacketForImmediateSend(sendTimeMs: number): Buffer | undefined {
    if (this.pendingReport.referenceTimeMs === NEVER) return undefined;
    const rtpTimestamp =
      this.pendingReport.rtpTimestamp +
      Math.round(((sendTimeMs - this.pendingReport.referenceTimeMs) * this.config.rtpTimebase) / 1000);
    if (this.firstSenderReportTime === NEVER) this.firstSenderReportTime = sendTimeMs;
    const { packet } = buildSenderReport(this.config.senderSsrc, this.ntp, {
      referenceTimeMs: sendTimeMs,
      rtpTimestamp,
      sendPacketCount: this.pendingReport.sendPacketCount,
      sendOctetCount: this.pendingReport.sendOctetCount,
    });
    return packet;
  }

  /** `GetRtpPacketForImmediateSend`: the oldest packet that needs sending, else a kickstart packet when due. */
  getRtpPacketForImmediateSend(sendTimeMs: number): Buffer | undefined {
    let chosen = this.chooseNextRtpPacketNeedingSend();
    if (chosen === undefined) {
      const kick = this.chooseKickstartPacket();
      if (kick === undefined || kick.when > sendTimeMs) return undefined;
      chosen = kick;
    }
    const { slot, packetId } = chosen;
    this.lastRtpPacketWasRetransmission = slot.packetSentTimes[packetId] !== NEVER;
    const packet = this.packetizer.generatePacket(slot.frame, packetId);
    slot.sendFlags[packetId] = false;
    slot.packetSentTimes[packetId] = sendTimeMs;
    this.pendingReport.sendPacketCount++;
    // Approximate octet count: packet size minus the base RTP header (sender_impl.cc).
    this.pendingReport.sendOctetCount += packet.length - BASE_RTP_HEADER_SIZE;
    return packet;
  }

  /** `GetRtpResumeTime`. */
  getRtpResumeTime(): number {
    if (this.chooseNextRtpPacketNeedingSend() !== undefined) return -Infinity;
    return this.chooseKickstartPacket()?.when ?? NEVER;
  }

  // CompoundRtcpParser::Client

  onReceiverReferenceTimeAdvanced(_referenceTimeMs: number): void {}

  /** `OnReceiverReport`: round-trip time from the echoed sender report id (`SmoothRoundTripTime`). */
  onReceiverReport(report: RtcpReportBlock): void {
    if (report.lastStatusReportId === 0 || this.firstSenderReportTime === NEVER) return;
    const reportTime = this.ntp.getRecentReportTime(report.lastStatusReportId, this.rtcpPacketArrivalTime);
    if (reportTime + REPORT_ID_PRECISION_MS < this.firstSenderReportTime) return;
    const totalDelay = this.rtcpPacketArrivalTime - reportTime;
    // delay_since_last_report is in 1/65536 s units.
    const nonNetworkDelay = (report.delaySinceLastReport * 1000) / 65536;
    const measurement = Math.max(totalDelay - nonNetworkDelay, NEAR_ZERO_ROUND_TRIP_TIME_MS);
    const clamped = Math.min(measurement, this.targetPlayoutDelayMs);
    this.roundTripTimeMs = smoothRoundTripTime(this.roundTripTimeMs, clamped);
  }

  /** `OnReceiverIndicatesPictureLoss`. */
  onReceiverIndicatesPictureLoss(): void {
    let keyframeTimedOut = false;
    if (this.config.senderKeyframeCooldownMs !== undefined && this.lastEnqueuedKeyFrameTime !== NEVER) {
      keyframeTimedOut = this.env.now() - this.lastEnqueuedKeyFrameTime > this.config.senderKeyframeCooldownMs;
    }
    // A key frame already in flight will fix the picture.
    if (this.checkpointFrameId < this.lastEnqueuedKeyFrameId && !keyframeTimedOut) return;
    this.pictureLostAtFrameId = Math.max(this.checkpointFrameId, this.lastEnqueuedKeyFrameId);
    this.observer?.onPictureLost();
  }

  /** `OnReceiverCheckpoint`: everything up to `frameId` is acknowledged. */
  onReceiverCheckpoint(frameId: number, playoutDelayMs: number): void {
    if (frameId > this.lastEnqueuedFrameId) return;
    while (this.checkpointFrameId < frameId) {
      this.checkpointFrameId++;
      if (this.activeSlot(this.checkpointFrameId) !== undefined) this.cancelPendingFrame(this.checkpointFrameId, true);
    }
    this.latestExpectedFrameId = Math.max(this.latestExpectedFrameId, frameId);
    this.dispatchCancellations();
    void playoutDelayMs; // A disagreement with the receiver's delay is only logged by openscreen.
  }

  /** `OnReceiverHasFrames`: individual frames the receiver has, past the checkpoint. */
  onReceiverHasFrames(acks: number[]): void {
    if (acks[acks.length - 1]! > this.lastEnqueuedFrameId) return;
    for (const id of acks) this.cancelPendingFrame(id, true);
    this.latestExpectedFrameId = Math.max(this.latestExpectedFrameId, acks[acks.length - 1]!);
    this.dispatchCancellations();
  }

  /** `OnReceiverIsMissingPackets`: flag packets for retransmission unless sent too recently to be lost. */
  onReceiverIsMissingPackets(nacks: PacketNack[]): void {
    const tooRecentASendTime = this.rtcpPacketArrivalTime - this.roundTripTimeMs;
    let needToSend = false;
    let totalRetransmitted = 0;
    for (let i = 0; i < nacks.length; ) {
      const frameId = nacks[i]!.frameId;
      const slot = frameId <= this.lastEnqueuedFrameId ? this.activeSlot(frameId) : undefined;
      if (slot === undefined) {
        while (i < nacks.length && nacks[i]!.frameId === frameId) i++;
        continue;
      }
      this.latestExpectedFrameId = Math.max(this.latestExpectedFrameId, frameId);
      const handle = (packetId: number): void => {
        if (slot.packetSentTimes[packetId]! <= tooRecentASendTime) {
          slot.sendFlags[packetId] = true;
          needToSend = true;
          totalRetransmitted++;
        }
      };
      const rangeEnd = slot.packetSentTimes.length;
      if (nacks[i]!.packetId === 0xffff) {
        for (let p = 0; p < rangeEnd; p++) handle(p);
        i++;
      } else {
        for (; i < nacks.length && nacks[i]!.frameId === frameId; i++) {
          if (nacks[i]!.packetId < rangeEnd) handle(nacks[i]!.packetId);
        }
      }
    }
    if (totalRetransmitted > 0) this.observer?.onPacketsRetransmitted?.(totalRetransmitted);
    if (needToSend) this.router.requestRtpSend(this.config.receiverSsrc);
  }

  // Internals

  private activeSlot(frameId: number): PendingFrameSlot | undefined {
    return this.slots.get(frameId);
  }

  /** `ChooseNextRtpPacketNeedingSend`. */
  private chooseNextRtpPacketNeedingSend(): ChosenPacket | undefined {
    for (let id = this.checkpointFrameId + 1; id <= this.lastEnqueuedFrameId; id++) {
      const slot = this.activeSlot(id);
      if (slot === undefined) continue;
      const packetId = slot.sendFlags.indexOf(true);
      if (packetId >= 0) return { slot, packetId };
    }
    return undefined;
  }

  /**
   * `ChooseKickstartPacket`: when the receiver has not acknowledged the newest frame, resend its last packet after
   * max(playout delay / 20, 2 * RTT) so the receiver learns that frames exist even if every packet of it was lost.
   */
  private chooseKickstartPacket(): (ChosenPacket & { when: number }) | undefined {
    if (this.latestExpectedFrameId >= this.lastEnqueuedFrameId) return undefined;
    const slot = this.activeSlot(this.lastEnqueuedFrameId);
    if (slot === undefined) return undefined;
    const packetId = slot.sendFlags.length - 1;
    const timeLastSent = slot.packetSentTimes[packetId]!;
    if (timeLastSent === NEVER) return undefined;
    const interval = Math.max(this.targetPlayoutDelayMs / 20, this.roundTripTimeMs * 2);
    return { slot, packetId, when: timeLastSent + interval };
  }

  /** `CancelPendingFrame`. */
  private cancelPendingFrame(frameId: number, wasAcked: boolean): void {
    const slot = this.activeSlot(frameId);
    if (slot === undefined) return;
    if (wasAcked) this.router.onPayloadReceived(slot.frame.data.length, this.rtcpPacketArrivalTime, this.roundTripTimeMs);
    this.inFlightMediaDurationMs -= slot.mediaDurationMs;
    if (this.inFlightMediaDurationMs < 0) this.inFlightMediaDurationMs = 0;
    this.slots.delete(frameId);
    this.numFramesInFlight--;
    if (this.numFramesInFlight === 0) this.inFlightMediaDurationMs = 0;
    if (this.observer !== undefined) this.pendingCancellations.push(frameId);
  }

  private dispatchCancellations(): void {
    const pending = this.pendingCancellations;
    this.pendingCancellations = [];
    for (const id of pending) this.observer?.onFrameCanceled(id);
  }
}

/** `SenderImpl::SmoothRoundTripTime`. */
export function smoothRoundTripTime(estimate: number, measurement: number): number {
  if (estimate === 0) return measurement;
  if (measurement > estimate) return (estimate + measurement) / 2;
  const INERTIA = 7;
  return (INERTIA * estimate + measurement) / (INERTIA + 1);
}
