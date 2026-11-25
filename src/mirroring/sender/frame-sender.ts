/**
 * Frame-drop and playout-delay policy shared by the audio and video senders, ported from Chromium
 * `media/cast/sender/openscreen_frame_sender.cc` (`OpenscreenFrameSender`) and its interface
 * `media/cast/sender/frame_sender.h` (`FrameSender`, `FrameSender::Client`).
 *
 * The openscreen `Sender` is reached through `SenderView`, the subset of `Sender` this policy reads, so that the
 * renderer (which decides drops before encoding) can use a snapshot proxy and the utility process the real `Sender`.
 * Times are milliseconds.
 */
import { MAX_UNACKED_FRAMES } from "../protocol/constants.ts";
import type { EncodedFrame } from "../rtp/frame.ts";
import type { EnqueueFrameResult, SenderObserver } from "./sender.ts";

/** `media/cast/sender/openscreen_frame_sender.cc` `kMaxFrameBurst`. */
export const MAX_FRAME_BURST = 5;

/** media::cast `CastStreamingFrameDropReason`, with the values used by `OpenscreenFrameSender`/`VideoSender`. */
export type FrameDropReason =
  | "kNotDropped"
  | "kPayloadTooLarge"
  | "kReachedIdSpanLimit"
  | "kInFlightDurationTooHighAfterEncoding"
  | "kInvalidReferencedFrameId"
  | "kTooManyFramesInFlight"
  | "kBurstThresholdExceeded"
  | "kInFlightDurationTooHigh"
  | "kDroppedByEncoder";

/** `ToFrameDropReason`. */
export function toFrameDropReason(result: EnqueueFrameResult): FrameDropReason {
  switch (result) {
    case "OK":
      return "kNotDropped";
    case "PAYLOAD_TOO_LARGE":
      return "kPayloadTooLarge";
    case "REACHED_ID_SPAN_LIMIT":
      return "kReachedIdSpanLimit";
    case "MAX_DURATION_IN_FLIGHT":
      return "kInFlightDurationTooHighAfterEncoding";
  }
}

/** `SenderEncodedFrame` (media/cast/common/sender_encoded_frame.h) with the `EncodedFrame` fields we carry. */
export interface SenderEncodedFrame {
  isKeyFrame: boolean;
  frameId: number;
  referencedFrameId: number;
  rtpTimestamp: number;
  referenceTimeMs: number;
  newPlayoutDelayMs: number;
  data: Uint8Array;
  /** -1 when not computed. */
  encoderUtilization: number;
  lossiness?: number;
}

/** The parts of the openscreen `Sender` the policy needs. */
export interface SenderView {
  readonly inFlightFrameCount: number;
  readonly nextFrameId: number;
  readonly needsKeyFrame: boolean;
  readonly currentRoundTripTimeMs: number;
  /** Highest frame id the receiver acknowledged in order (`checkpoint_frame_id_`); for the drop log only. */
  readonly checkpoint?: number;
  getInFlightMediaDuration(nextFrameRtpTimestamp: number): number;
  getMaxInFlightMediaDuration(): number;
  /** Absent on a read-only snapshot used before encoding. */
  enqueueFrame?(frame: EncodedFrame): EnqueueFrameResult;
  setObserver?(observer: SenderObserver | undefined): void;
}

/** `FrameSender::Client`. */
export interface FrameSenderClient {
  getNumberOfFramesInEncoder(): number;
  /** The difference between the timestamps of the last frame to enter and the last to leave the encoder (ms). */
  getEncoderBacklogDuration(): number;
  onFrameCanceled?(frameId: number): void;
}

export interface FrameSenderConfig {
  maxFrameRate: number;
  isAudio: boolean;
  minPlayoutDelayMs: number;
  maxPlayoutDelayMs: number;
}

const UINT16_MAX = 65535;

export class FrameSender implements SenderObserver {
  readonly isAudio: boolean;
  private readonly sender: SenderView;
  private readonly client: FrameSenderClient;
  private maxFrameRate: number;
  private readonly minPlayoutDelayMs: number;
  private readonly maxPlayoutDelayMs: number;
  private targetPlayoutDelayMs = 0;
  private sendTargetPlayoutDelay = false;
  private lastEnqueuedFrameId = -1;
  private lastAckedFrameId = -1;
  private lastSendTimeMs = Number.NEGATIVE_INFINITY;
  private lastAccepted: { frameId: number; openscreenFrameId: number } | undefined;
  /** `frame_rtp_timestamps_`: indexed by the low 8 bits of the frame id. */
  private readonly frameRtpTimestamps = new Array<number | undefined>(256).fill(undefined);
  private readonly now: () => number;
  /** Receives a description of a dropped frame, at most one per second per sender (the rest are counted). */
  onDropLog: ((message: string) => void) | undefined;
  private lastDropLogAt = Number.NEGATIVE_INFINITY;
  private suppressedDropLogs = 0;

  constructor(config: FrameSenderConfig, sender: SenderView, client: FrameSenderClient, targetPlayoutDelayMs: number, now: () => number) {
    this.isAudio = config.isAudio;
    this.sender = sender;
    this.client = client;
    this.maxFrameRate = config.maxFrameRate;
    this.minPlayoutDelayMs = Math.min(config.minPlayoutDelayMs, UINT16_MAX);
    this.maxPlayoutDelayMs = Math.min(config.maxPlayoutDelayMs, UINT16_MAX);
    this.now = now;
    this.setTargetPlayoutDelay(targetPlayoutDelayMs);
    sender.setObserver?.(this);
  }

  dispose(): void {
    this.sender.setObserver?.(undefined);
  }

  get needsKeyFrame(): boolean {
    return this.sender.needsKeyFrame;
  }

  /** `SetTargetPlayoutDelay`. */
  setTargetPlayoutDelay(newTargetMs: number): void {
    if (this.sendTargetPlayoutDelay && this.targetPlayoutDelayMs === newTargetMs) return;
    const clamped = Math.min(Math.max(newTargetMs, this.minPlayoutDelayMs), this.maxPlayoutDelayMs);
    this.targetPlayoutDelayMs = clamped;
    this.sendTargetPlayoutDelay = true;
  }

  get targetPlayoutDelay(): number {
    return this.targetPlayoutDelayMs;
  }

  get maxRate(): number {
    return this.maxFrameRate;
  }

  setMaxFrameRate(rate: number): void {
    this.maxFrameRate = rate;
  }

  get currentRoundTripTime(): number {
    return this.sender.currentRoundTripTimeMs;
  }

  get lastSendTime(): number {
    return this.lastSendTimeMs;
  }

  get lastAcked(): number {
    return this.lastAckedFrameId;
  }

  get unacknowledgedFrameCount(): number {
    return this.sender.inFlightFrameCount;
  }

  // SenderObserver
  onFrameCanceled(frameId: number): void {
    if (frameId > this.lastAckedFrameId) this.lastAckedFrameId = frameId;
    this.client.onFrameCanceled?.(frameId);
  }

  onPictureLost(): void {}

  /** `GetRecordedRtpTimestamp`. */
  getRecordedRtpTimestamp(frameId: number): number | undefined {
    if (Math.abs(this.lastEnqueuedFrameId - frameId) >= this.frameRtpTimestamps.length) return undefined;
    return this.frameRtpTimestamps[frameId & 0xff];
  }

  /** `GetInFlightMediaDuration`: encoder backlog plus the sender's in-flight duration, capped per frame. */
  getInFlightMediaDuration(): number {
    let duration = this.client.getEncoderBacklogDuration();
    if (this.lastEnqueuedFrameId !== -1) {
      const newest = this.getRecordedRtpTimestamp(this.lastEnqueuedFrameId);
      const maxInFlight = this.unacknowledgedFrameCount * (1000 / this.maxFrameRate);
      duration += Math.min(newest === undefined ? 0 : this.sender.getInFlightMediaDuration(newest), maxInFlight);
    }
    return duration;
  }

  /** `EnqueueFrame`. */
  enqueueFrame(frame: SenderEncodedFrame): FrameDropReason {
    if (this.sender.enqueueFrame === undefined) throw new Error("this FrameSender has a read-only sender view");
    if (frame.frameId < this.lastEnqueuedFrameId) throw new Error("enqueued frames out of order");
    const newPlayoutDelayMs = this.sendTargetPlayoutDelay ? this.targetPlayoutDelayMs : frame.newPlayoutDelayMs;
    // The sender does not advance its frame id for a frame it refuses, so ids can diverge: always use the sender's.
    const openscreenFrameId = this.sender.nextFrameId;
    if (frame.frameId < openscreenFrameId) throw new Error("frame id behind the sender's");
    const referenced = this.getOpenscreenReferencedFrameId(frame, openscreenFrameId);
    if (referenced === undefined) return "kInvalidReferencedFrameId";
    const result = this.sender.enqueueFrame({
      dependency: frame.isKeyFrame ? "key" : "dependent",
      frameId: openscreenFrameId,
      referencedFrameId: referenced,
      rtpTimestamp: frame.rtpTimestamp,
      referenceTimeMs: frame.referenceTimeMs,
      newPlayoutDelayMs,
      data: frame.data,
    });
    if (result === "OK") {
      this.lastAccepted = { frameId: frame.frameId, openscreenFrameId };
      this.lastEnqueuedFrameId = frame.frameId;
      this.lastSendTimeMs = this.now();
      this.sendTargetPlayoutDelay = false;
      this.frameRtpTimestamps[frame.frameId & 0xff] = frame.rtpTimestamp;
    }
    const reason = toFrameDropReason(result);
    if (reason !== "kNotDropped") this.logDrop(reason, undefined);
    return reason;
  }

  /** `GetOpenscreenReferencedFrameId`: producers reference either the frame itself or the one before it. */
  private getOpenscreenReferencedFrameId(frame: SenderEncodedFrame, openscreenFrameId: number): number | undefined {
    if (frame.referencedFrameId === frame.frameId) return openscreenFrameId;
    if (this.lastAccepted !== undefined && frame.referencedFrameId === this.lastAccepted.frameId) return this.lastAccepted.openscreenFrameId;
    return undefined;
  }

  /** Debug aid, not in Chromium: what the in-flight limits looked like when a frame was dropped. */
  private logDrop(reason: FrameDropReason, wouldBeInFlightMs: number | undefined): void {
    if (this.onDropLog === undefined) return;
    const t = this.now();
    if (t - this.lastDropLogAt < 1000) {
      this.suppressedDropLogs++;
      return;
    }
    const skipped = this.suppressedDropLogs;
    this.suppressedDropLogs = 0;
    this.lastDropLogAt = t;
    const r = (n: number) => Math.round(n * 10) / 10;
    this.onDropLog(
      `${this.isAudio ? "audio" : "video"} frame dropped (${reason}): ` +
        `would-be in flight ${wouldBeInFlightMs === undefined ? "n/a" : r(wouldBeInFlightMs)} ms, limit ${r(this.sender.getMaxInFlightMediaDuration())} ms, ` +
        `encoder backlog ${r(this.client.getEncoderBacklogDuration())} ms (${this.client.getNumberOfFramesInEncoder()} frames), ` +
        `unacked ${this.unacknowledgedFrameCount}, rtt ${r(this.sender.currentRoundTripTimeMs)} ms, target delay ${this.targetPlayoutDelayMs} ms, ` +
        `oldest unacked ${(this.sender.checkpoint ?? this.lastAckedFrameId) + 1}, last enqueued ${this.lastEnqueuedFrameId}, last acked ${this.lastAckedFrameId}, ` +
        `checkpoint ${this.sender.checkpoint ?? "n/a"}${skipped > 0 ? `, ${skipped} more drops since the last line` : ""}`,
    );
  }

  /** `ShouldDropNextFrame`. */
  shouldDropNextFrame(frameDurationMs: number, nextFrameRtpTimestamp: number | undefined): FrameDropReason {
    const reason = this.decideDrop(frameDurationMs, nextFrameRtpTimestamp);
    return reason;
  }

  private decideDrop(frameDurationMs: number, nextFrameRtpTimestamp: number | undefined): FrameDropReason {
    const countFramesInFlight = this.unacknowledgedFrameCount + this.client.getNumberOfFramesInEncoder();
    if (countFramesInFlight >= MAX_UNACKED_FRAMES) {
      this.logDrop("kTooManyFramesInFlight", undefined);
      return "kTooManyFramesInFlight";
    }

    const durationInFlight = this.getInFlightMediaDuration();
    const maxFramesInFlight = (this.maxFrameRate * durationInFlight) / 1000;
    if (countFramesInFlight >= maxFramesInFlight + MAX_FRAME_BURST) {
      this.logDrop("kBurstThresholdExceeded", durationInFlight);
      return "kBurstThresholdExceeded";
    }

    // Frames still in the encoder are unknown to the sender, which caps each step and would undercount them.
    const useSenderDuration =
      nextFrameRtpTimestamp !== undefined && this.unacknowledgedFrameCount > 0 && this.client.getNumberOfFramesInEncoder() === 0;
    const durationWouldBeInFlight = useSenderDuration ? this.sender.getInFlightMediaDuration(nextFrameRtpTimestamp) : durationInFlight + frameDurationMs;
    if (durationWouldBeInFlight > this.sender.getMaxInFlightMediaDuration()) {
      this.logDrop("kInFlightDurationTooHigh", durationWouldBeInFlight);
      return "kInFlightDurationTooHigh";
    }
    return "kNotDropped";
  }
}
