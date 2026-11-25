/**
 * Video frame policy, ported from Chromium `media/cast/sender/video_sender.cc` (`VideoSender`):
 * `InsertRawVideoFrame` (monotonic-time check, key frame requests on PLI, drop decision with playout-delay raise,
 * 5% bitrate hysteresis), `OnEncodedVideoFrame` (encoder backlog, enqueue, key frame on a post-encode drop),
 * `OnFrameDroppedByEncoder` and `ReportResourceUtilization`.
 *
 * The encoder is whatever the capture context provides (WebCodecs `VideoEncoder` in the renderer); it is reached
 * through `VideoEncoderPort`, the subset of `media/cast/sender/video_encoder.h` the policy uses. Metrics and tracing
 * (UMA, perfetto) are not ported.
 */
import { FrameSender, type FrameDropReason, type FrameSenderClient, type SenderEncodedFrame } from "./frame-sender.ts";

/** `kRoundTripsNeeded`, `kConstantTimeMs`, `kTargetUtilizationPercentage`, `kEncoderDroppedFrameUtilization`. */
export const ROUND_TRIPS_NEEDED = 4;
export const CONSTANT_TIME_MS = 75;
export const TARGET_UTILIZATION_PERCENTAGE = 75;
export const ENCODER_DROPPED_FRAME_UTILIZATION = 1.0;
/** `kMinKeyFrameRequestInterval` (500 ms) and `kMinKeyFrameRequestFrameInterval` (6 frames). */
export const MIN_KEY_FRAME_REQUEST_INTERVAL_MS = 500;
export const MIN_KEY_FRAME_REQUEST_FRAME_INTERVAL = 6;
/** `kBitrateThreshold` in `InsertRawVideoFrame`. */
export const BITRATE_HYSTERESIS = 0.05;

/** `media/cast/sender/video_encoder.h`, the part VideoSender calls. */
export interface VideoEncoderPort {
  generateKeyFrame(): void;
  setBitRate(bitsPerSecond: number): void;
  setMaxFrameRate(rate: number): void;
  /** False when the encoder refused the frame. The result arrives later through `onEncodedVideoFrame`. */
  encodeVideoFrame(frame: RawVideoFrame, referenceTimeMs: number): boolean;
}

export interface RawVideoFrame {
  /** Presentation timestamp in RTP ticks (90 kHz), `ToRtpTimeTicks(timestamp, kVideoFrequency)`. */
  rtpTimestamp: number;
  visibleRectEmpty: boolean;
  /** `VideoFrameMetadata::interactive_content`. */
  interactiveContent?: boolean;
  /** `VideoFrameMetadata::capture_begin_time` and `capture_end_time` (sender clock); they reach `FRAME_CAPTURE_BEGIN/END`. */
  captureBeginTimeMs?: number;
  captureEndTimeMs?: number;
}

export interface VideoSenderConfig {
  minBitrate: number;
  maxBitrate: number;
  minPlayoutDelayMs: number;
  maxPlayoutDelayMs: number;
}

export class VideoSender implements FrameSenderClient {
  private readonly frameSender: FrameSender;
  private readonly encoder: VideoEncoderPort;
  private readonly config: VideoSenderConfig;
  private readonly getBandwidth: () => number;
  private readonly onPlayoutDelayChange: (ms: number) => void;
  private readonly onFeedback: ((resourceUtilization: number) => void) | undefined;
  private framesInEncoder = 0;
  private durationInEncoderMs = 0;
  private lastEnqueuedRtpTimestamp: number | undefined;
  private lastEnqueuedReferenceTimeMs: number | undefined;
  private lastTimeAttemptedToResolvePli: number | undefined;
  private lowLatencyMode = false;
  private lastBitrate = 0;
  private lastReportedEncoderUtilization = -1;
  private lastReportedLossiness: number | undefined;
  framesInserted = 0;
  framesDroppedBeforeEncoding = 0;
  framesDroppedAfterEncoding = 0;
  framesDroppedByEncoder = 0;
  /** Drops by reason, the counterpart of the `CastStreaming.Sender.Video.FrameDropped` histogram (video_sender.cc `kHistogramFrameDropped`). */
  readonly dropReasons = new Map<FrameDropReason, number>();

  constructor(
    frameSender: FrameSender,
    encoder: VideoEncoderPort,
    config: VideoSenderConfig,
    getBandwidth: () => number,
    onPlayoutDelayChange: (ms: number) => void,
    onFeedback?: (resourceUtilization: number) => void,
  ) {
    if (config.maxBitrate < config.minBitrate) throw new RangeError("max bitrate below min bitrate");
    this.frameSender = frameSender;
    this.encoder = encoder;
    this.config = config;
    this.getBandwidth = getBandwidth;
    this.onPlayoutDelayChange = onPlayoutDelayChange;
    this.onFeedback = onFeedback;
  }

  get encoderBitrate(): number {
    return this.lastBitrate;
  }

  /** `GetEncoderUtilization`: -1 until an encoded frame reports one. */
  get encoderUtilization(): number {
    return this.lastReportedEncoderUtilization;
  }

  /** `GetLossiness`: -1 until an encoded frame reports one. */
  get lossiness(): number {
    return this.lastReportedLossiness ?? -1;
  }

  /** `GetFramesDropped`: before and after encoding, not the encoder's own drops. */
  get framesDropped(): number {
    return this.framesDroppedBeforeEncoding + this.framesDroppedAfterEncoding;
  }

  getNumberOfFramesInEncoder(): number {
    return this.framesInEncoder;
  }

  getEncoderBacklogDuration(): number {
    return this.durationInEncoderMs;
  }

  /** `InsertRawVideoFrame`. */
  insertRawVideoFrame(frame: RawVideoFrame, referenceTimeMs: number): void {
    const newLowLatencyMode = frame.interactiveContent === true;
    if (newLowLatencyMode && !this.lowLatencyMode) this.onPlayoutDelayChange(this.config.minPlayoutDelayMs);
    this.lowLatencyMode = newLowLatencyMode;

    // RTP and reference timestamps must both increase: durations assume it and every frame's RTP timestamp is unique.
    if (
      this.lastEnqueuedReferenceTimeMs !== undefined &&
      (frame.rtpTimestamp <= this.lastEnqueuedRtpTimestamp! || referenceTimeMs <= this.lastEnqueuedReferenceTimeMs)
    ) {
      return;
    }

    // A PLI asks for a key frame, at most once per max(500 ms, 6 * target playout delay).
    if (this.frameSender.needsKeyFrame) {
      const minAttemptInterval = Math.max(MIN_KEY_FRAME_REQUEST_INTERVAL_MS, MIN_KEY_FRAME_REQUEST_FRAME_INTERVAL * this.frameSender.targetPlayoutDelay);
      if (this.lastTimeAttemptedToResolvePli === undefined || referenceTimeMs - this.lastTimeAttemptedToResolvePli > minAttemptInterval) {
        this.encoder.generateKeyFrame();
        this.lastTimeAttemptedToResolvePli = referenceTimeMs;
      }
    }

    // Without frames in the encoder the added duration is a guess from the max frame rate; it is also capped by it so
    // idle gaps in a static screen capture do not inflate the in-flight estimate.
    const maxFrameDuration = 1000 / this.frameSender.maxRate;
    const durationAddedByNextFrame =
      this.framesInEncoder > 0 ? Math.min(referenceTimeMs - this.lastEnqueuedReferenceTimeMs!, maxFrameDuration) : maxFrameDuration;

    this.framesInserted++;
    const reason = this.frameSender.shouldDropNextFrame(durationAddedByNextFrame, frame.rtpTimestamp);
    if (reason !== "kNotDropped") {
      let newTargetDelay = Math.min(this.frameSender.currentRoundTripTime * ROUND_TRIPS_NEEDED + CONSTANT_TIME_MS, this.config.maxPlayoutDelayMs);
      // In low latency mode frame drops are preferred over a longer playout delay.
      if (!this.lowLatencyMode && newTargetDelay > this.frameSender.targetPlayoutDelay) {
        if (newTargetDelay < this.config.minPlayoutDelayMs) newTargetDelay = this.config.minPlayoutDelayMs;
        this.onPlayoutDelayChange(newTargetDelay);
      }
      this.framesDroppedBeforeEncoding++;
      this.dropReasons.set(reason, (this.dropReasons.get(reason) ?? 0) + 1);
      return;
    }

    if (frame.visibleRectEmpty) return;

    const suggestedBitrate = Math.min(Math.max(this.getBandwidth(), this.config.minBitrate), this.config.maxBitrate);
    // Do not thrash the encoder: update only when the suggestion moved by more than 5%.
    if (this.lastBitrate === 0 || Math.abs(suggestedBitrate - this.lastBitrate) > this.lastBitrate * BITRATE_HYSTERESIS) {
      this.encoder.setBitRate(suggestedBitrate);
      this.lastBitrate = suggestedBitrate;
    }

    if (this.encoder.encodeVideoFrame(frame, referenceTimeMs)) {
      this.framesInEncoder++;
      this.durationInEncoderMs += durationAddedByNextFrame;
      this.lastEnqueuedRtpTimestamp = frame.rtpTimestamp;
      this.lastEnqueuedReferenceTimeMs = referenceTimeMs;
    }
  }

  /** `SetTargetPlayoutDelay`. */
  setTargetPlayoutDelay(ms: number): void {
    this.frameSender.setTargetPlayoutDelay(ms);
  }

  /** `SetMaxFrameRate`. */
  setMaxFrameRate(rate: number): void {
    if (!(rate > 0)) throw new RangeError("max frame rate must be positive");
    this.frameSender.setMaxFrameRate(rate);
    this.encoder.setMaxFrameRate(rate);
  }

  /**
   * `OnEncodedVideoFrame`. `referenceTimeMs` is the reference time the raw frame was inserted with; `encoded` is
   * undefined when the encode failed and has empty data when the encoder dropped the frame.
   */
  onEncodedVideoFrame(referenceTimeMs: number, encoded: SenderEncodedFrame | undefined): void {
    this.framesInEncoder--;
    if (this.framesInEncoder < 0) throw new Error("more encoded frames than frames in the encoder");
    // Cap the backlog per frame so static screen gaps between queued frames do not inflate it.
    const maxBacklogDuration = this.framesInEncoder * (1000 / this.frameSender.maxRate);
    this.durationInEncoderMs = Math.min(this.lastEnqueuedReferenceTimeMs! - referenceTimeMs, maxBacklogDuration);

    if (encoded !== undefined) {
      this.lastReportedEncoderUtilization = encoded.encoderUtilization;
      if (encoded.data.length > 0) this.lastReportedLossiness = encoded.lossiness;
    }
    if (encoded === undefined) return;
    if (encoded.data.length === 0) {
      this.onFrameDroppedByEncoder(encoded);
      return;
    }
    this.reportResourceUtilization(Math.max(this.lastReportedEncoderUtilization, this.lastReportedLossiness ?? -1), encoded.isKeyFrame);
    const reason: FrameDropReason = this.frameSender.enqueueFrame(encoded);
    if (reason !== "kNotDropped") {
      this.framesDroppedAfterEncoding++;
      this.dropReasons.set(reason, (this.dropReasons.get(reason) ?? 0) + 1);
      // The encoder's reference chain is broken, so the next frame must be a key frame.
      this.encoder.generateKeyFrame();
    }
  }

  /** `OnFrameDroppedByEncoder`. */
  private onFrameDroppedByEncoder(encoded: SenderEncodedFrame): void {
    this.framesDroppedByEncoder++;
    this.frameSender.reportFrameDroppedByEncoder(encoded.rtpTimestamp);
    this.dropReasons.set("kDroppedByEncoder", (this.dropReasons.get("kDroppedByEncoder") ?? 0) + 1);
    this.lastReportedEncoderUtilization = encoded.encoderUtilization;
    this.reportResourceUtilization(
      Math.max(this.lastReportedEncoderUtilization, this.lastReportedLossiness ?? -1, ENCODER_DROPPED_FRAME_UTILIZATION),
      false,
    );
  }

  /** `ReportResourceUtilization`: attenuated so the target utilization is the maximum sustainable amount. */
  private reportResourceUtilization(utilization: number, isKeyFrame: boolean): void {
    const attenuated = utilization / (TARGET_UTILIZATION_PERCENTAGE / 100);
    if (attenuated < 0) return;
    // Key frames are capped at 1.0: their utilization is atypical and would mislead the producer of the input.
    this.onFeedback?.(isKeyFrame ? Math.min(1, attenuated) : attenuated);
  }
}
