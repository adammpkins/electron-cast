/**
 * The mirroring session driver, ported from Chromium `components/mirroring/service/openscreen_session_host.cc`
 * (`OpenscreenSessionHost`): it builds the offer from the codecs the encoders can produce, turns the negotiated
 * senders into audio and video senders with their encoders, starts capture, applies the receiver's recommendations
 * (`SetConstraints`), adapts the target bitrate every 500 ms (`UpdateBandwidthEstimate`, the gradual-backoff variant
 * that is enabled by default), asks for refresh frames on a static screen, and maps failures to session errors.
 *
 * A hardware encoder that fails is deny-listed and the session negotiates again (`OnVideoEncoderStatus`,
 * `MaybeDenylistHardwareCodecAndRenegotiate`); a hardware-first offer the receiver takes nothing from is repeated with
 * the software codecs (`OnError`, `offering_fallback_codecs_`).
 *
 * Not ported: remoting (`NegotiateRemoting`, `MediaRemoter`, `RemotingStreamData`), GPU factories (the hardware
 * encoder lives in the capture page's WebCodecs), UMA metrics.
 */
import { SUPPORTED_VIDEO_CODECS, type EncodingSupport } from "./encoding-support.ts";
import { type MirroringBackend, type CapturedVideoFrame, type OperationalStatus, operationalStatusErrorMessage } from "./backend.ts";
import { MirrorSettings, getCodecParameterString, LEGACY_MAX_VIDEO_BITRATE, type FrameSenderConfig } from "./mirror-settings.ts";
import { ErrorCode, type SessionError } from "./protocol/errors.ts";
import type { VideoCodec } from "./protocol/constants.ts";
import type { MessagePort } from "./protocol/messenger.ts";
import type { AudioCaptureConfig, VideoCaptureConfig } from "./protocol/offer.ts";
import type { Recommendations } from "./protocol/recommendations.ts";
import { AudioSender } from "./sender/audio-sender.ts";
import { FrameSender } from "./sender/frame-sender.ts";
import { type SenderPacketRouter } from "./sender/packet-router.ts";
import { SenderSession, type ConfiguredSenders, type SenderSessionClient, type RemotingCapabilities, type SessionEnvironment } from "./sender/sender-session.ts";
import type { Sender } from "./sender/sender.ts";
import { OpenscreenStatsClient } from "./stats/openscreen-stats-client.ts";
import type { MirroringStats } from "./stats/statistics.ts";
import { VideoSender, type VideoEncoderPort } from "./sender/video-sender.ts";

/** `kBandwidthUpdateInterval`. */
/** `kDefaultBitrate` (openscreen_session_host.h). */
export const DEFAULT_BITRATE = 10_000_000;
export const BANDWIDTH_UPDATE_INTERVAL_MS = 500;
/** media/cast/cast_config.h `kMinRequiredBitrate` (384 << 10). */
export const MIN_REQUIRED_BITRATE = 384 << 10;

/** mirroring_features.cc defaults of `kCastStreamingGradualBandwidthBackoff` (`GetBandwidthBackoffParams` clamps them). */
export const BANDWIDTH_BACKOFF = {
  goodNetworkCitizenFactor: 0.8,
  minBackoffFactor: 0.5,
  maxBackoffFactor: 0.85,
  fastRecoveryIncrease: 1.5,
  conservativeIncrease: 1.1,
} as const;

/** mirroring_service_types.mojom `SessionType` and `SessionError`. */
export type SessionType = "audio_only" | "video_only" | "audio_video";
export type MirroringError =
  | "ANSWER_TIME_OUT"
  | "ANSWER_NOT_OK"
  | "ANSWER_MISMATCHED_CAST_MODE"
  | "ANSWER_MISMATCHED_SSRC_LENGTH"
  | "ANSWER_SELECT_MULTIPLE_AUDIO"
  | "ANSWER_SELECT_MULTIPLE_VIDEO"
  | "ANSWER_SELECT_INVALID_INDEX"
  | "ANSWER_NO_AUDIO_OR_VIDEO"
  | "AUDIO_CAPTURE_ERROR"
  | "VIDEO_CAPTURE_ERROR"
  | "RTP_STREAM_ERROR"
  | "ENCODING_ERROR"
  | "CAST_TRANSPORT_ERROR"
  | "OPENSCREEN_SESSION_ERROR";

/** `SessionObserver`. */
export interface SessionObserver {
  didStart?(): void;
  didStop?(): void;
  onError?(error: MirroringError, message: string): void;
  logInfo?(message: string): void;
}

export interface SessionParameters {
  type: SessionType;
  receiverAddress: string;
  sourceId: string;
  destinationId: string;
  /** `target_playout_delay`; falls back to `CHROME_MIRRORING_PLAYOUT_DELAY` or 200 ms. */
  targetPlayoutDelayMs?: number;
  /** `force_letterboxing`. */
  forceLetterboxing?: boolean;
  /** `enable_rtcp_reporting`: collect and analyze the receiver's RTCP event log for `getMirroringStats`. */
  enableRtcpReporting?: boolean;
}

export interface SessionHostDeps {
  environment: SessionEnvironment;
  router: SenderPacketRouter;
  messagePort: MessagePort;
  backend: MirroringBackend;
  encodingSupport: EncodingSupport;
  observer: SessionObserver;
  env?: Record<string, string | undefined>;
  /** Decides the H.264 profile of the offer (`ToProfile`: Baseline on macOS); default `process.platform`. */
  platform?: string;
}

type State = "initializing" | "mirroring" | "stopped";

/** A clamp that does not reorder its bounds, `std::clamp`. */
const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

export class OpenscreenSessionHost implements SenderSessionClient {
  private readonly params: SessionParameters;
  private readonly deps: SessionHostDeps;
  private readonly settings: MirrorSettings;
  private readonly session: SenderSession;
  private readonly statsClient: OpenscreenStatsClient | undefined;
  private state: State = "initializing";
  private lastOfferedAudioConfig: FrameSenderConfig | undefined;
  private lastOfferedVideoConfigs: FrameSenderConfig[] = [];
  private audioSenderCore: Sender | undefined;
  private videoSenderCore: Sender | undefined;
  private audioSender: AudioSender | undefined;
  private audioFrameSender: FrameSender | undefined;
  private audioEncoder: ReturnType<MirroringBackend["createAudioEncoder"]> | undefined;
  private videoSender: VideoSender | undefined;
  private videoFrameSender: FrameSender | undefined;
  private videoEncoder: VideoEncoderPort | undefined;
  private activeVideoConfig: FrameSenderConfig | undefined;
  /** `usable_bandwidth_` initial value: min(kDefaultBitrate (10 Mbps), MirrorSettings::GetMaxVideoBitrate()) (openscreen_session_host.h). */
  private usableBandwidth = Math.min(DEFAULT_BITRATE, LEGACY_MAX_VIDEO_BITRATE);
  private usableBandwidthBeforeBackoff = 0;
  private numVideoFramesDropped = 0;
  private cancelBandwidthTimer: (() => void) | undefined;
  private cancelRefreshTimer: (() => void) | undefined;
  private expectingARefreshFrame = false;
  private videoCaptureStarted = false;
  private initiallyStarted = false;
  private capabilities: RemotingCapabilities | undefined;
  /** `offering_fallback_codecs_`: the hardware-first offer got no stream, so software codecs go in the next one. */
  private offeringFallbackCodecs = false;

  constructor(params: SessionParameters, deps: SessionHostDeps) {
    this.params = params;
    this.deps = deps;
    this.settings = new MirrorSettings(params.targetPlayoutDelayMs, deps.env);
    this.session = new SenderSession({
      remoteAddress: params.receiverAddress,
      client: this,
      environment: deps.environment,
      router: deps.router,
      messagePort: deps.messagePort,
      messageSourceId: params.sourceId,
      messageDestinationId: params.destinationId,
      timers: { setTimeout: (cb, ms) => deps.environment.schedule(deps.environment.now() + ms, cb) },
    });
    if (params.enableRtcpReporting === true) {
      this.statsClient = new OpenscreenStatsClient();
      this.session.setStatsClient(this.statsClient);
    }
    this.scheduleBandwidthUpdate();
  }

  /**
   * `GetMirroringStats`: the analyzer's latest statistics (empty without `enableRtcpReporting`), and the senders' own
   * counters merged into the "video" and "audio" dictionaries.
   */
  getMirroringStats(): MirroringStats {
    const stats: MirroringStats = this.statsClient?.getStats() ?? {};
    const video = this.videoSender;
    if (video !== undefined) {
      stats.video = {
        ...stats.video,
        TARGET_BITRATE: video.encoderBitrate / 1000,
        ENCODER_UTILIZATION: video.encoderUtilization * 100,
        LOSSINESS: video.lossiness * 100,
        FRAMES_INSERTED: video.framesInserted,
        FRAMES_DROPPED: video.framesDropped,
      };
    }
    const audio = this.audioSender;
    if (audio !== undefined) {
      stats.audio = { ...stats.audio, FRAMES_INSERTED: audio.framesInserted, FRAMES_DROPPED: audio.framesDropped };
    }
    return stats;
  }

  get isStopped(): boolean {
    return this.state === "stopped";
  }

  get currentUsableBandwidth(): number {
    return this.usableBandwidth;
  }

  get currentVideoBitrate(): number {
    return this.videoSender?.encoderBitrate ?? 0;
  }

  get video(): VideoSender | undefined {
    return this.videoSender;
  }

  /** `AsyncInitialize` + `OnAsyncInitialized`: negotiate the first offer. */
  start(): void {
    if (this.state !== "initializing") throw new Error("session already started");
    this.state = "mirroring";
    this.negotiateMirroring();
  }

  /** A message from the receiver (the `CastMessageChannel::Send` the browser relays inbound). */
  onMessage(sourceId: string, messageNamespace: string, message: string): void {
    this.session.onMessage(sourceId, messageNamespace, message);
  }

  /** `NegotiateMirroring`. */
  private negotiateMirroring(): void {
    const { encodingSupport, router } = this.deps;
    this.lastOfferedAudioConfig = undefined;
    this.lastOfferedVideoConfigs = [];
    const audioConfigs: AudioCaptureConfig[] = [];
    const videoConfigs: VideoCaptureConfig[] = [];
    if (this.params.type !== "video_only") {
      this.lastOfferedAudioConfig = this.settings.getAudioConfig("opus");
      audioConfigs.push(toAudioCaptureConfig(this.lastOfferedAudioConfig));
    }
    if (this.params.type !== "audio_only") {
      const resolution = this.settings.maxResolution;
      const h264Profile = (this.deps.platform ?? process.platform) === "darwin" ? "baseline" : "main";
      let offeredHardwareCodec = false;
      // Hardware encoders first.
      for (const codec of SUPPORTED_VIDEO_CODECS) {
        const config = this.settings.getVideoConfig(codec);
        if (encodingSupport.isHardwareEnabled(codec)) {
          config.useHardwareEncoder = true;
          config.codecParameter = getCodecParameterString(codec, resolution.width, resolution.height, config.maxFrameRate, h264Profile);
          this.lastOfferedVideoConfigs.push(config);
          videoConfigs.push(toVideoCaptureConfig(config));
          offeredHardwareCodec = true;
        }
      }
      // kCastStreamingOfferHardwareFirst is enabled by default: software only when no hardware codec was offered, or
      // when the receiver took none of the hardware ones (`offering_fallback_codecs_`).
      if (this.offeringFallbackCodecs || !offeredHardwareCodec) {
        for (const codec of SUPPORTED_VIDEO_CODECS) {
          const config = this.settings.getVideoConfig(codec);
          if (!encodingSupport.isHardwareEnabled(codec) && encodingSupport.isSoftwareEnabled(codec)) {
            config.codecParameter = getCodecParameterString(codec, resolution.width, resolution.height, config.maxFrameRate, h264Profile);
            this.lastOfferedVideoConfigs.push(config);
            videoConfigs.push(toVideoCaptureConfig(config));
          }
        }
      }
    }
    if (audioConfigs.length === 0 && videoConfigs.length === 0) {
      this.reportAndLogError("ENCODING_ERROR", "No codec can be encoded here.");
      return;
    }
    const error = this.session.negotiate(audioConfigs, videoConfigs);
    if (error !== undefined) this.reportAndLogError("OPENSCREEN_SESSION_ERROR", error.message);
  }

  // SenderSessionClient

  /** `OnNegotiated`. */
  onNegotiated(_session: SenderSession, senders: ConfiguredSenders, recommendations: Recommendations): void {
    this.offeringFallbackCodecs = false;
    if (this.state === "stopped") {
      senders.audioSender?.destroy();
      senders.videoSender?.destroy();
      return;
    }
    let audioConfig: FrameSenderConfig | undefined;
    if (this.lastOfferedAudioConfig !== undefined && senders.audioSender !== undefined) audioConfig = { ...this.lastOfferedAudioConfig };
    let videoConfig: FrameSenderConfig | undefined;
    if (senders.videoSender !== undefined) {
      // One configuration is offered per codec, so the selected one is found by its codec.
      const negotiatedCodec = senders.videoConfig!.codec;
      const found = this.lastOfferedVideoConfigs.find((c) => c.videoCodec === negotiatedCodec);
      if (found === undefined) throw new Error("negotiated a video codec that was not offered");
      videoConfig = { ...found };
    }

    this.stopStreaming();
    this.state = "mirroring";
    this.setConstraints(recommendations, audioConfig, videoConfig);

    if (senders.audioSender !== undefined && audioConfig !== undefined) {
      this.audioSenderCore = senders.audioSender;
      this.createAudioPipeline(senders.audioSender, audioConfig);
    }
    if (senders.videoSender !== undefined && videoConfig !== undefined) {
      this.videoSenderCore = senders.videoSender;
      this.createVideoPipeline(senders.videoSender, videoConfig);
    }
    if (!this.initiallyStarted) {
      this.initiallyStarted = true;
      // Requested once, as in Chrome: a receiver does not change its remoting capabilities during a session.
      this.session.requestCapabilities();
      this.deps.observer.didStart?.();
    }
    this.deps.observer.logInfo?.(
      `negotiated a new mirroring session. audio codec=${audioConfig?.audioCodec ?? "none"}, video codec=${videoConfig?.videoCodec ?? "none"} (${videoConfig ? (videoConfig.useHardwareEncoder ? "hardware" : "software") : "n/a"})`,
    );
  }

  private createAudioPipeline(core: Sender, config: FrameSenderConfig): void {
    let audioSender: AudioSender | undefined;
    const encoder = this.deps.backend.createAudioEncoder(config, {
      onEncoded: (frame, skipped) => { if (this.audioSender === audioSender) audioSender?.onEncodedAudioFrame(frame, skipped); },
      onStatus: (status) => this.onAudioEncoderStatus(status),
    });
    this.audioEncoder = encoder;
    const frameSender = new FrameSender(
      { maxFrameRate: config.maxFrameRate, isAudio: true, minPlayoutDelayMs: config.minPlayoutDelayMs, maxPlayoutDelayMs: config.maxPlayoutDelayMs },
      core,
      { getNumberOfFramesInEncoder: () => audioSender!.getNumberOfFramesInEncoder(), getEncoderBacklogDuration: () => audioSender!.getEncoderBacklogDuration() },
      core.targetPlayoutDelay,
      () => this.deps.environment.now(),
    );
    audioSender = new AudioSender(frameSender, config.rtpTimebase, encoder.samplesPerFrame);
    this.audioFrameSender = frameSender;
    this.audioSender = audioSender;
    // StartCapturingAudio: the capture asks the sender whether a buffer may be encoded.
    this.deps.backend.startAudioCapture(this.settings.getAudioCaptureParams(), {
      insertAudio: (frames, recordedTimeMs) => {
        if (this.audioSender === undefined || !this.audioSender.insertAudio(frames)) return false;
        this.audioEncoder?.encode(frames, recordedTimeMs);
        return true;
      },
      onCaptureError: (message) => this.reportAndLogError("AUDIO_CAPTURE_ERROR", message),
    });
  }

  private createVideoPipeline(core: Sender, config: FrameSenderConfig): void {
    let videoSender: VideoSender | undefined;
    const encoder = this.deps.backend.createVideoEncoder(config, {
      onEncoded: (referenceTimeMs, frame) => { if (this.videoSender === videoSender) videoSender?.onEncodedVideoFrame(referenceTimeMs, frame); },
      // Chrome binds the status callback to the encoder it belongs to, and a destroyed encoder reports nothing.
      onStatus: (status, message) => { if (this.videoSender === videoSender) this.onVideoEncoderStatus(config, status, message); },
    });
    this.videoEncoder = encoder;
    const frameSender = new FrameSender(
      { maxFrameRate: config.maxFrameRate, isAudio: false, minPlayoutDelayMs: config.minPlayoutDelayMs, maxPlayoutDelayMs: config.maxPlayoutDelayMs },
      core,
      { getNumberOfFramesInEncoder: () => videoSender!.getNumberOfFramesInEncoder(), getEncoderBacklogDuration: () => videoSender!.getEncoderBacklogDuration() },
      core.targetPlayoutDelay,
      () => this.deps.environment.now(),
    );
    videoSender = new VideoSender(
      frameSender,
      encoder,
      { minBitrate: config.minBitrate, maxBitrate: config.maxBitrate, minPlayoutDelayMs: config.minPlayoutDelayMs, maxPlayoutDelayMs: config.maxPlayoutDelayMs },
      () => this.getVideoNetworkBandwidth(),
      (delay) => this.setTargetPlayoutDelay(delay),
      (utilization) => this.deps.backend.processFeedback(utilization),
    );
    this.videoFrameSender = frameSender;
    this.videoSender = videoSender;
    this.activeVideoConfig = config;
    this.numVideoFramesDropped = 0;
    this.usableBandwidthBeforeBackoff = 0;
    this.expectingARefreshFrame = false;
    if (this.settings.refreshIntervalMs > 0) this.resetRefreshTimer();
    // Pause first so the capture's callback is replaced, then resume, or start a new capture if it cannot be resumed.
    this.pauseCapturingVideo();
    if (!this.tryResumeCapturingVideo()) this.startCapturingVideo();
  }

  /**
   * `OnCapabilitiesDetermined`. Chrome builds its MediaRemoter from these; this library has no remoter (see DESIGN.md),
   * so they are kept for `receiverCapabilities`.
   */
  onCapabilitiesDetermined(_session: SenderSession, capabilities: RemotingCapabilities): void {
    if (this.state === "stopped") return;
    this.capabilities = capabilities;
  }

  /** What the receiver reported in CAPABILITIES_RESPONSE; undefined until then, or when it sent none or an error. */
  get receiverCapabilities(): RemotingCapabilities | undefined {
    return this.capabilities;
  }

  /** `OnError`. */
  onError(_session: SenderSession, error: SessionError): void {
    switch (error.code) {
      case ErrorCode.AnswerTimeout:
        this.reportAndLogError("ANSWER_TIME_OUT", error.message);
        return;
      case ErrorCode.InvalidAnswer:
        this.reportAndLogError("ANSWER_NOT_OK", error.message);
        return;
      case ErrorCode.NoStreamSelected:
        // The receiver took none of the hardware-first offer: offer the software codecs too, once.
        if (!this.offeringFallbackCodecs && this.state === "mirroring") {
          this.deps.observer.logInfo?.("No stream selected for ideal, hardware-accelerated codecs. Attempting fallback to software codecs.");
          this.offeringFallbackCodecs = true;
          this.negotiateMirroring();
          return;
        }
        this.reportAndLogError("ANSWER_NO_AUDIO_OR_VIDEO", error.message);
        return;
      case ErrorCode.RemotingNotSupported:
        // The session continues without a media remoter (a failed remoting OFFER is not possible here).
        this.deps.observer.logInfo?.(`Remoting is disabled for this session. error=${error.message}`);
        return;
      default:
        this.reportAndLogError("OPENSCREEN_SESSION_ERROR", error.message);
    }
  }

  /** `SetConstraints`. */
  private setConstraints(r: Recommendations, audioConfig: FrameSenderConfig | undefined, videoConfig: FrameSenderConfig | undefined): void {
    if (videoConfig !== undefined) {
      // Pixels, not width and height, so that a different aspect ratio does not count as stricter.
      const currentPixels = this.settings.maxResolution.width * this.settings.maxResolution.height;
      const recommendedPixels = r.video.maximum.width * r.video.maximum.height;
      if (recommendedPixels < currentPixels) this.settings.setMaxResolutionConstraints({ width: r.video.maximum.width, height: r.video.maximum.height });
      videoConfig.minBitrate = Math.max(videoConfig.minBitrate, r.video.bitRateLimits.minimum);
      videoConfig.maxBitrate = Math.min(videoConfig.maxBitrate, r.video.bitRateLimits.maximum);
      videoConfig.startBitrate = clamp(videoConfig.startBitrate, videoConfig.minBitrate, videoConfig.maxBitrate);
      videoConfig.minPlayoutDelayMs = Math.min(videoConfig.maxPlayoutDelayMs, r.video.maxDelayMs);
      // A non-positive frame rate means the ANSWER's display.dimensions omitted frameRate: ignore it.
      const recommendedFrameRate = r.video.maximum.frameRate.numerator / r.video.maximum.frameRate.denominator;
      if (recommendedFrameRate > 0) {
        videoConfig.maxFrameRate = Math.min(videoConfig.maxFrameRate, recommendedFrameRate);
        this.settings.maxFrameRate = Math.min(this.settings.maxFrameRate, videoConfig.maxFrameRate);
      }
      // Sender-side letterboxing unless the receiver opts in to variable aspect ratio video.
      this.settings.setSenderSideLetterboxingEnabled(this.params.forceLetterboxing === true ? true : !r.video.supportsScaling);
    }
    if (audioConfig !== undefined) {
      audioConfig.minBitrate = Math.max(audioConfig.minBitrate, r.audio.bitRateLimits.minimum);
      audioConfig.maxBitrate = Math.min(audioConfig.maxBitrate, r.audio.bitRateLimits.maximum);
      audioConfig.startBitrate = clamp(audioConfig.startBitrate, audioConfig.minBitrate, audioConfig.maxBitrate);
      audioConfig.maxPlayoutDelayMs = Math.min(audioConfig.maxPlayoutDelayMs, r.audio.maxDelayMs);
      audioConfig.minPlayoutDelayMs = Math.min(audioConfig.maxPlayoutDelayMs, r.audio.maxDelayMs);
      // Chrome supports stereo only, so audio.maxChannels is ignored.
    }
  }

  // Capture

  private videoSink = {
    insertVideoFrame: (frame: CapturedVideoFrame): void => this.insertVideoFrame(frame),
    onCaptureError: (message: string): void => this.reportAndLogError("VIDEO_CAPTURE_ERROR", message),
  };

  /** `GetVideoCaptureParams`: the frame rate never exceeds the sender's. */
  private getVideoCaptureParams(): ReturnType<MirrorSettings["getVideoCaptureParams"]> {
    const params = this.settings.getVideoCaptureParams();
    const senderMax = this.videoFrameSender?.maxRate ?? 0;
    if (senderMax > 0) params.frameRate = Math.min(params.frameRate, senderMax);
    return params;
  }

  private startCapturingVideo(): void {
    const params = this.getVideoCaptureParams();
    this.deps.observer.logInfo?.(`Starting video capture with params ${JSON.stringify(params)}`);
    this.deps.backend.startVideoCapture(params, this.videoSink);
    this.videoCaptureStarted = true;
  }

  private pauseCapturingVideo(): void {
    if (this.videoCaptureStarted) this.deps.backend.pauseVideoCapture();
  }

  private tryResumeCapturingVideo(): boolean {
    if (!this.videoCaptureStarted || this.videoSender === undefined) return false;
    return this.deps.backend.resumeVideoCapture(this.getVideoCaptureParams(), this.videoSink);
  }

  /** `InsertVideoFrame`. */
  private insertVideoFrame(frame: CapturedVideoFrame): void {
    if (this.videoSender === undefined) return;
    if (frame.referenceTimeMs === undefined) {
      this.reportAndLogError("RTP_STREAM_ERROR", "Missing REFERENCE_TIME.");
      return;
    }
    this.expectingARefreshFrame = false;
    this.videoSender.insertRawVideoFrame(frame, frame.referenceTimeMs);
    if (this.settings.refreshIntervalMs > 0) this.resetRefreshTimer();
  }

  private resetRefreshTimer(): void {
    this.cancelRefreshTimer?.();
    this.cancelRefreshTimer = this.deps.environment.schedule(this.deps.environment.now() + this.settings.refreshIntervalMs, () => this.onRefreshTimerFired());
  }

  /** `OnRefreshTimerFired`: ask once for a new frame, and stop asking if none arrives. */
  private onRefreshTimerFired(): void {
    this.cancelRefreshTimer = undefined;
    if (this.expectingARefreshFrame) return;
    this.expectingARefreshFrame = true;
    this.deps.backend.requestRefreshFrame();
    this.resetRefreshTimer();
  }

  // Encoder status

  /** `OnAudioEncoderStatus`. */
  private onAudioEncoderStatus(status: OperationalStatus): void {
    const message = operationalStatusErrorMessage(status);
    if (message !== undefined) this.reportAndLogError("ENCODING_ERROR", message);
  }

  /** `OnVideoEncoderStatus`. */
  private onVideoEncoderStatus(config: FrameSenderConfig, status: OperationalStatus, message?: string): void {
    switch (status) {
      case "uninitialized":
        break;
      case "codec_reinit_pending":
        this.pauseCapturingVideo();
        break;
      case "initialized":
        if (this.state !== "stopped") this.tryResumeCapturingVideo();
        break;
      default:
        if (message !== undefined) this.deps.observer.logInfo?.(`video encoder ${status}: ${message}`);
        // A failed hardware encoder is not the end: try 30 fps in place, then stop offering the codec in hardware and
        // negotiate again (software, or another hardware codec, is offered then).
        if (config.useHardwareEncoder) {
          if (this.state !== "mirroring") return;
          if (this.maybeFallbackHardwareFrameRate(config, status)) return;
          this.maybeDenyListHardwareCodecAndRenegotiate(config.videoCodec!);
          return;
        }
        this.reportAndLogError("ENCODING_ERROR", operationalStatusErrorMessage(status) ?? "Encoder failed.");
    }
  }

  /**
   * `SwitchSourceTab` for mirroring: the session is not renegotiated. The video capture client moves to the capture
   * host of the new tab and restarts with the same parameters and callback, and the audio input device is stopped
   * and started so its stream is created for the new tab. Senders, encoders, the target bitrate and the RTP
   * timelines carry on. (Not ported: the remoting branch.)
   */
  switchSourceTab(): void {
    if (this.state !== "mirroring") return;
    this.deps.observer.logInfo?.("Switching the mirroring source tab");
    if (this.videoCaptureStarted && this.videoSender !== undefined) this.deps.backend.switchVideoCaptureHost();
    if (this.audioEncoder !== undefined) this.deps.backend.restartAudioCapture();
  }

  /**
   * `MaybeFallbackHardwareFrameRate`: hardware encoding at 30 fps is preferred over software at 60, so a hardware
   * encoder that fails above 30 fps is lowered to 30 in place and the capture is restarted at that rate. Capture is
   * limited to 30 fps here (`kCastStreaming60fps` is off and not exposed), so this is never taken today.
   */
  private maybeFallbackHardwareFrameRate(config: FrameSenderConfig, status: OperationalStatus): boolean {
    const defaultMaxFrameRate = 30;
    if (this.videoSender === undefined || this.videoFrameSender === undefined || this.videoFrameSender.maxRate <= defaultMaxFrameRate) return false;
    this.deps.observer.logInfo?.(
      `Hardware ${config.videoCodec} encoder failed at ${this.videoFrameSender.maxRate.toFixed(0)} FPS (${operationalStatusErrorMessage(status)}). Lowering to ${defaultMaxFrameRate} FPS hardware encoding in-place.`,
    );
    this.videoSender.setMaxFrameRate(defaultMaxFrameRate);
    if (this.videoCaptureStarted) {
      // `VideoCaptureClient::RestartWithParams`.
      this.deps.backend.pauseVideoCapture();
      this.startCapturingVideo();
    }
    return true;
  }

  /** `MaybeDenylistHardwareCodecAndRenegotiate`: once per codec. */
  private maybeDenyListHardwareCodecAndRenegotiate(codec: VideoCodec): void {
    const { encodingSupport } = this.deps;
    if (encodingSupport.isHardwareDenyListed(codec)) return;
    encodingSupport.denyListHardwareCodec(codec);
    this.deps.observer.logInfo?.(`Hardware ${codec} encoding is disabled for this app run; negotiating again.`);
    this.stopStreaming();
    if (this.state === "mirroring") this.negotiateMirroring();
  }

  /** `SetTargetPlayoutDelay`. */
  private setTargetPlayoutDelay(delayMs: number): void {
    let updated = false;
    if (this.audioSender !== undefined && this.audioFrameSender!.targetPlayoutDelay !== delayMs) {
      this.audioFrameSender!.setTargetPlayoutDelay(delayMs);
      updated = true;
    }
    if (this.videoSender !== undefined && this.videoFrameSender!.targetPlayoutDelay !== delayMs) {
      this.videoSender.setTargetPlayoutDelay(delayMs);
      updated = true;
    }
    if (updated) this.deps.observer.logInfo?.(`Updated target playout delay to ${delayMs}ms`);
  }

  // Bandwidth

  /** `GetVideoNetworkBandwidth`: what is usable minus the audio stream. */
  getVideoNetworkBandwidth(): number {
    if (this.audioEncoder !== undefined) {
      const audioBitrate = this.audioEncoder.bitrate;
      return this.usableBandwidth > audioBitrate ? this.usableBandwidth - audioBitrate : 0;
    }
    return this.usableBandwidth;
  }

  private scheduleBandwidthUpdate(): void {
    const env = this.deps.environment;
    this.cancelBandwidthTimer = env.schedule(env.now() + BANDWIDTH_UPDATE_INTERVAL_MS, () => {
      this.cancelBandwidthTimer = undefined;
      if (this.state === "stopped") return;
      this.updateBandwidthEstimate(this.session.getEstimatedNetworkBandwidth());
      this.scheduleBandwidthUpdate();
    });
  }

  /** `UpdateBandwidthEstimate(int)`. Public so that tests can drive it with a chosen estimate. */
  updateBandwidthEstimate(bandwidthEstimate: number): void {
    if (this.videoSender === undefined) return;
    // The cumulative drop count (before or after encoding, the default congestion signal) is compared to the last update.
    const currentFramesDropped = this.videoSender.framesDroppedBeforeEncoding + this.videoSender.framesDroppedAfterEncoding;
    const isCongested = currentFramesDropped > this.numVideoFramesDropped;
    this.numVideoFramesDropped = currentFramesDropped;
    if (bandwidthEstimate <= 0) return;
    const p = BANDWIDTH_BACKOFF;
    // Never use all of the bandwidth, but never go below the absolute minimum requirement either.
    const usableBandwidth = Math.max(Math.trunc(p.goodNetworkCitizenFactor * bandwidthEstimate), MIN_REQUIRED_BITRATE);
    const before = this.usableBandwidth;
    this.updateBandwidthGradualBackoff(isCongested, usableBandwidth);
    // openscreen_session_host.cc logs this at VLOG(2) ("updated available bandwidth"); here it is only a change.
    if (this.usableBandwidth !== before) {
      this.deps.observer.logInfo?.(`bandwidth ${before} -> ${this.usableBandwidth} (estimate ${bandwidthEstimate}, ${isCongested ? "frames dropped" : "no drops"})`);
    }
  }

  /** `UpdateBandwidthGradualBackoff`. */
  private updateBandwidthGradualBackoff(isCongested: boolean, usableBandwidth: number): void {
    const p = BANDWIDTH_BACKOFF;
    if (isCongested) {
      // Back off multiplicatively toward the estimate rather than snapping to it.
      const backedOff = clamp(usableBandwidth, Math.trunc(this.usableBandwidth * p.minBackoffFactor), Math.trunc(this.usableBandwidth * p.maxBackoffFactor));
      // Remember the level in use before backing off so it can be recovered quickly once congestion clears.
      this.usableBandwidthBeforeBackoff = this.usableBandwidth;
      this.usableBandwidth = Math.max(backedOff, MIN_REQUIRED_BITRATE);
    } else if (usableBandwidth > this.usableBandwidth) {
      const isRecovering = this.usableBandwidth < this.usableBandwidthBeforeBackoff;
      let increased = Math.trunc(this.usableBandwidth * (isRecovering ? p.fastRecoveryIncrease : p.conservativeIncrease));
      if (isRecovering) {
        increased = Math.min(increased, Math.max(this.usableBandwidthBeforeBackoff, Math.trunc(this.usableBandwidth * p.conservativeIncrease)));
      }
      this.usableBandwidth = Math.min(increased, usableBandwidth);
    }
    // Otherwise a lower estimate without frame drops (a static screen sends little) is not evidence of congestion.
  }

  // Teardown

  /** `ReportAndLogError`. */
  private reportAndLogError(error: MirroringError, message: string): void {
    this.deps.observer.logInfo?.(`error ${error}: ${message}`);
    this.deps.observer.onError?.(error, message);
    this.stopSession();
  }

  /** `StopStreaming`. */
  private stopStreaming(): void {
    const reasons = (m: ReadonlyMap<string, number> | undefined) => (m === undefined ? "" : [...m].map(([k, n]) => `${k}=${n}`).join(" ") || "none");
    if (this.videoSender !== undefined) {
      this.deps.observer.logInfo?.(
        `video frames: inserted ${this.videoSender.framesInserted}, dropped ${this.videoSender.framesDroppedBeforeEncoding + this.videoSender.framesDroppedAfterEncoding} (${reasons(this.videoSender.dropReasons)}), by encoder ${this.videoSender.framesDroppedByEncoder}`,
      );
    }
    if (this.audioSender !== undefined) {
      this.deps.observer.logInfo?.(`audio frames: inserted ${this.audioSender.framesInserted}, dropped ${this.audioSender.framesDropped} (${reasons(this.audioSender.dropReasons)})`);
    }
    this.deps.backend.stopAudioCapture();
    this.pauseCapturingVideo();
    this.audioFrameSender?.dispose();
    this.videoFrameSender?.dispose();
    this.audioSender = undefined;
    this.audioFrameSender = undefined;
    this.audioEncoder = undefined;
    this.videoSender = undefined;
    this.videoFrameSender = undefined;
    this.videoEncoder = undefined;
    this.audioSenderCore?.destroy();
    this.videoSenderCore?.destroy();
    this.audioSenderCore = undefined;
    this.videoSenderCore = undefined;
    this.cancelRefreshTimer?.();
    this.cancelRefreshTimer = undefined;
  }

  /** `StopSession`. */
  stopSession(): void {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.offeringFallbackCodecs = false;
    this.stopStreaming();
    this.cancelBandwidthTimer?.();
    this.cancelBandwidthTimer = undefined;
    this.deps.router.stop();
    this.session.dispose();
    this.deps.observer.didStop?.();
  }
}

/** openscreen_conversion_helpers.cc `ToOpenscreenAudioConfig`. */
export function toAudioCaptureConfig(config: FrameSenderConfig): AudioCaptureConfig {
  return {
    codec: config.audioCodec!,
    channels: config.channels,
    bitRate: config.maxBitrate,
    sampleRate: config.rtpTimebase,
    targetPlayoutDelayMs: config.maxPlayoutDelayMs,
    codecParameter: config.codecParameter,
  };
}

/** `ToOpenscreenVideoConfig`: the resolution is hardcoded to 1080p and the frame rate is an integer. */
export function toVideoCaptureConfig(config: FrameSenderConfig): VideoCaptureConfig {
  return {
    codec: config.videoCodec!,
    maxFrameRate: { numerator: Math.trunc(config.maxFrameRate), denominator: 1 },
    maxBitRate: config.maxBitrate,
    resolutions: [{ width: 1920, height: 1080 }],
    targetPlayoutDelayMs: config.maxPlayoutDelayMs,
    codecParameter: config.codecParameter,
  };
}

