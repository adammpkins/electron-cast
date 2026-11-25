/**
 * The engine's `MirroringBackend` over a port to the capture agent. Frame ids are assigned here, as
 * `media::cast::VideoEncoder` / `AudioEncoder` assign them in Chromium: a key frame references itself, a delta frame
 * the frame before it; the RTP timestamp of audio is the running sample count.
 */
import { performance } from "node:perf_hooks";
import type {
  AudioCaptureSink, AudioEncoderCallbacks, AudioEncoderPort, MirroringBackend, VideoCaptureSink, VideoEncoderCallbacks,
} from "../backend.ts";
import type { FrameSenderConfig, ResolutionChangePolicy, VideoCaptureParams } from "../mirror-settings.ts";
import { CaptureSizeOracle, suggestConstraints } from "../sender/capture-size-oracle.ts";
import { EncoderUtilizationAverage, calculateEncoderUtilization, computeLossiness } from "../sender/video-encoder-metrics.ts";
import type { RawVideoFrame, VideoEncoderPort } from "../sender/video-sender.ts";
import type { AgentPort, AgentToEngine, CaptureSource } from "./agent-protocol.ts";

const toLocalMs = (epochMs: number): number => epochMs - performance.timeOrigin;

/** Debug aid, not in Chrome: mean and maximum of each pipeline stage, written to the log every five seconds. */
export class StageStats {
  private readonly stages = new Map<string, { n: number; sum: number; max: number }>();
  private since = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly log: () => ((message: string) => void) | undefined;

  constructor(now: () => number, log: () => ((message: string) => void) | undefined) {
    this.now = now;
    this.log = log;
  }

  add(stage: string, ms: number): void {
    const t = this.now();
    if (this.since === Number.NEGATIVE_INFINITY) this.since = t;
    const s = this.stages.get(stage) ?? { n: 0, sum: 0, max: 0 };
    s.n++;
    s.sum += ms;
    s.max = Math.max(s.max, ms);
    this.stages.set(stage, s);
    if (t - this.since < 5000) return;
    const r = (n: number) => Math.round(n * 10) / 10;
    this.log()?.(`latency stages (mean / max ms): ${[...this.stages].map(([k, v]) => `${k} ${r(v.sum / v.n)} / ${r(v.max)}`).join("; ")}`);
    this.stages.clear();
    this.since = t;
  }
}

/** media/cast/encoding/audio_encoder.cc `kUnderrunSkipThreshold`. */
export const UNDERRUN_SKIP_THRESHOLD = 3;

/**
 * `FrameSinkVideoCapturerImpl::GetPipelineUtilization`: frames in flight over `kDesignLimitMaxFrames` (10) times
 * `kTargetPipelineUtilization` (0.6).
 */
const PIPELINE_CAPACITY = 10 * 0.6;
/** Frames this close together count as animating content, standing in for `AnimatedContentSampler`'s detection. */
const ANIMATION_MAX_GAP_MS = 200;

/** What `ImplBase::EncodeAudio` decided for one buffer: the frame's timestamps and the samples skipped before it. */
interface AudioMeta {
  frameId: number;
  rtp: number;
  referenceTimeMs: number;
}

export class PortBackend implements MirroringBackend {
  private readonly port: AgentPort;
  private source: CaptureSource;
  private videoSink: VideoCaptureSink | undefined;
  private audioSink: AudioCaptureSink | undefined;
  private videoCallbacks: VideoEncoderCallbacks | undefined;
  private audioCallbacks: AudioEncoderCallbacks | undefined;
  private lastVideoParams: string | undefined;
  private pendingVideo = new Map<number, { ref: number; captureBegin: number | undefined; captureEnd: number | undefined }>();
  private nextVideoFrameId = 0;
  private lastVideoFrameId = -1;
  private nextAudioFrameId = 0;
  private audioRtp = 0;
  private audioCaptureTimeMs: number | undefined;
  private samplesDroppedFromBuffer = 0;
  private audioMeta = new Map<number, AudioMeta>();
  private currentAudioSeq = 0;
  private frameInterval = 1000 / 30;
  private targetBitrate = 0;
  private isHardwareEncoder = false;
  private readonly utilizationAverage = new EncoderUtilizationAverage();
  private oracle: CaptureSizeOracle | undefined;
  private oracleFrames = new Map<number, number>();
  private feedbackFrame: number | undefined;
  private lastContentFrameMs: number | undefined;
  private sentCaptureSize: string | undefined;
  private audioConfig: { sampleRate: number; channels: number } | undefined;
  private audioSenderConfig: FrameSenderConfig | undefined;
  private stopped = false;
  private readonly wakes = new Map<number, () => void>();
  private nextWakeId = 0;
  log: ((message: string) => void) | undefined;
  private readonly stages = new StageStats(() => performance.now(), () => this.log);

  constructor(port: AgentPort, source: CaptureSource) {
    this.port = port;
    this.source = source;
    port.onMessage((m) => this.onAgentMessage(m));
  }

  private onAgentMessage(m: AgentToEngine): void {
    if (this.stopped || typeof m !== "object" || m === null) return;
    switch (m.t) {
      case "ready":
        break;
      case "wake": {
        const wake = this.wakes.get(m.id);
        this.wakes.delete(m.id);
        wake?.();
        break;
      }
      case "error":
        if (m.where === "video") this.videoSink?.onCaptureError(m.message);
        else if (m.where === "audio") this.audioSink?.onCaptureError(m.message);
        else this.videoCallbacks?.onStatus("codec_runtime_error", m.message);
        break;
      case "frame":
        this.observeCapturedFrame(m.rtp, toLocalMs(m.refMs), m.width, m.height, m.refresh === true);
        this.stages.add("video capture to engine", performance.now() - toLocalMs(m.refMs));
        this.videoSink?.insertVideoFrame({
          rtpTimestamp: m.rtp,
          referenceTimeMs: toLocalMs(m.refMs),
          visibleRectEmpty: false,
          ...(typeof m.captureBeginMs === "number" ? { captureBeginTimeMs: toLocalMs(m.captureBeginMs) } : {}),
          ...(typeof m.captureEndMs === "number" ? { captureEndTimeMs: toLocalMs(m.captureEndMs) } : {}),
        });
        break;
      case "video-chunk": {
        const pending = this.pendingVideo.get(m.rtp);
        // The frame still counts in the backlog while its own output is processed (`recent_metadata_` is popped last).
        const backlog = this.pendingVideo.size;
        this.pendingVideo.delete(m.rtp);
        if (pending === undefined) return;
        const ref = pending.ref;
        this.stages.add("video encode (agent)", m.encodeMs);
        this.stages.add("video capture to encoded", performance.now() - ref);
        this.stages.add(m.key ? "video key frame bytes" : "video delta frame bytes", m.data.byteLength);
        const frameId = this.nextVideoFrameId++;
        const referenced = m.key ? frameId : this.lastVideoFrameId;
        this.lastVideoFrameId = frameId;
        const data = Buffer.from(m.data);
        // OnFrameEncodeDone: WebCodecs reports no quantizer, so the frame's estimated complexity stands in for it and
        // only frames that were estimated have a lossiness.
        const lossiness =
          m.complexity !== undefined && this.targetBitrate > 0
            ? computeLossiness(data.length, m.durationMs ?? this.frameInterval, this.targetBitrate, m.complexity)
            : undefined;
        this.feedbackFrame = this.oracleFrames.get(m.rtp);
        this.videoCallbacks?.onEncoded(ref, {
          isKeyFrame: m.key,
          frameId,
          referencedFrameId: referenced,
          rtpTimestamp: m.rtp,
          referenceTimeMs: ref,
          newPlayoutDelayMs: 0,
          data,
          ...(pending.captureBegin !== undefined ? { captureBeginTimeMs: pending.captureBegin } : {}),
          ...(pending.captureEnd !== undefined ? { captureEndTimeMs: pending.captureEnd } : {}),
          // ComputeAndRecordUtilization: how much of the frame interval the encoder needed, smoothed.
          encoderUtilization: this.utilizationAverage.record(
            calculateEncoderUtilization(this.isHardwareEncoder, backlog, m.encodeMs, this.frameInterval),
          ),
          lossiness,
        });
        this.feedbackFrame = undefined;
        break;
      }
      case "video-drop": {
        // The agent could not produce a chunk. Chrome's encoder reports that as a frame with no data
        // (VideoSender::OnFrameDroppedByEncoder), which also frees the frame's slot in `framesInEncoder`.
        const ref = this.pendingVideo.get(m.rtp)?.ref;
        if (ref === undefined) return;
        this.pendingVideo.delete(m.rtp);
        this.feedbackFrame = this.oracleFrames.get(m.rtp);
        this.videoCallbacks?.onEncoded(ref, {
          isKeyFrame: false,
          frameId: this.nextVideoFrameId,
          referencedFrameId: this.lastVideoFrameId,
          rtpTimestamp: m.rtp,
          referenceTimeMs: ref,
          newPlayoutDelayMs: 0,
          data: new Uint8Array(0),
          encoderUtilization: -1,
        });
        this.feedbackFrame = undefined;
        break;
      }
      case "audio-drop": {
        // A buffer that never became a frame: its samples are reported as skipped with the next frame, which is how
        // AudioSender::OnEncodedAudioFrame learns they left the encoder.
        const meta = this.audioMeta.get(m.seq);
        if (meta === undefined) return;
        this.audioMeta.delete(m.seq);
        this.samplesDroppedFromBuffer += this.samplesPerAudioFrame();
        break;
      }
      case "audio-buffer": {
        this.currentAudioSeq = m.seq;
        this.stages.add("audio capture to engine", performance.now() - toLocalMs(m.recMs));
        const accepted = this.audioSink?.insertAudio(m.frames, toLocalMs(m.recMs)) ?? false;
        if (!accepted) this.port.postMessage({ t: "drop-audio", seq: m.seq });
        break;
      }
      case "audio-chunk": {
        const meta = this.audioMeta.get(m.seq);
        if (meta === undefined) return;
        this.audioMeta.delete(m.seq);
        const skipped = this.samplesDroppedFromBuffer;
        this.samplesDroppedFromBuffer = 0;
        this.audioCallbacks?.onEncoded(
          {
            isKeyFrame: true,
            frameId: meta.frameId,
            referencedFrameId: meta.frameId,
            rtpTimestamp: meta.rtp,
            referenceTimeMs: meta.referenceTimeMs,
            newPlayoutDelayMs: 0,
            data: Buffer.from(m.data),
            encoderUtilization: -1,
            // Chrome's audio source also uses the capture time for both.
            captureBeginTimeMs: meta.referenceTimeMs,
            captureEndTimeMs: meta.referenceTimeMs,
          },
          skipped,
        );
        break;
      }
      case "log":
        if (typeof m.message === "string") this.log?.(m.message);
        break;
      case "encoder-status":
        if (m.kind === "video") this.videoCallbacks?.onStatus(m.status, m.message);
        else this.audioCallbacks?.onStatus(m.status);
        break;
    }
  }

  createVideoEncoder(config: FrameSenderConfig, callbacks: VideoEncoderCallbacks): VideoEncoderPort {
    this.videoCallbacks = callbacks;
    this.frameInterval = 1000 / config.maxFrameRate;
    // A new encoder numbers its frames from 0 and owns no frames of the one before (a renegotiation after an encoder
    // failure replaces it while the capture goes on); answers to the old one's frames are ignored from here on.
    this.pendingVideo.clear();
    this.nextVideoFrameId = 0;
    this.lastVideoFrameId = -1;
    this.targetBitrate = config.startBitrate;
    // CalculateEncoderUtilization treats hardware and software encoders differently; the session host says which one
    // this is (a WebCodecs hardware encoder was found for the codec).
    this.isHardwareEncoder = config.useHardwareEncoder;
    this.port.postMessage({ t: "set-codec", codec: config.videoCodec ?? "vp8", codecString: config.codecParameter, hardware: config.useHardwareEncoder });
    this.port.postMessage({ t: "set-bitrate", bps: config.startBitrate });
    // The agent reports unsupported or failed codecs; "initialized" is the default until it says otherwise.
    queueMicrotask(() => callbacks.onStatus("initialized"));
    return {
      generateKeyFrame: () => this.port.postMessage({ t: "key-frame" }),
      setBitRate: (bps) => {
        this.targetBitrate = bps;
        this.port.postMessage({ t: "set-bitrate", bps });
      },
      setMaxFrameRate: (rate) => {
        this.frameInterval = 1000 / rate;
      },
      encodeVideoFrame: (frame: RawVideoFrame, referenceTimeMs: number) => {
        this.pendingVideo.set(frame.rtpTimestamp, { ref: referenceTimeMs, captureBegin: frame.captureBeginTimeMs, captureEnd: frame.captureEndTimeMs });
        // Frames the agent never hears about again are closed by its own bounded queue; forget stale references too.
        if (this.pendingVideo.size > 64) this.pendingVideo.delete(this.pendingVideo.keys().next().value!);
        this.port.postMessage({ t: "encode", rtp: frame.rtpTimestamp });
        return true;
      },
    };
  }

  createAudioEncoder(config: FrameSenderConfig, callbacks: AudioEncoderCallbacks): AudioEncoderPort {
    this.audioCallbacks = callbacks;
    this.audioSenderConfig = config;
    this.nextAudioFrameId = 0;
    this.audioRtp = 0;
    this.audioCaptureTimeMs = undefined;
    this.samplesDroppedFromBuffer = 0;
    this.audioMeta.clear();
    this.port.postMessage({ t: "set-audio", bps: config.maxBitrate });
    queueMicrotask(() => callbacks.onStatus("initialized"));
    return {
      samplesPerFrame: config.rtpTimebase / 100,
      bitrate: config.maxBitrate,
      encode: (_frames, recordedTimeMs) => this.encodeAudio(recordedTimeMs),
    };
  }

  private samplesPerAudioFrame(): number {
    return this.audioSenderConfig !== undefined ? this.audioSenderConfig.rtpTimebase / 100 : 480;
  }

  /**
   * The timeline of `ImplBase::EncodeAudio` (media/cast/encoding/audio_encoder.cc). The agent hands over whole 10 ms
   * buffers, so the encoder's partial-buffer fill is always empty here. A recorded time more than
   * `kUnderrunSkipThreshold` frames ahead of the audio processed so far is an underrun: the RTP timestamp skips
   * ahead by the frames missed. An overrun (time behind) is not resolved. The frame id advances for every buffer, as
   * `++frame_id_` does even when the encoder produced nothing.
   */
  private encodeAudio(recordedTimeMs: number): void {
    const samplesPerFrame = this.samplesPerAudioFrame();
    const frameDurationMs = (samplesPerFrame * 1000) / (this.audioSenderConfig?.rtpTimebase ?? 48000);
    if (this.audioCaptureTimeMs !== undefined) {
      const missed = Math.trunc((recordedTimeMs - this.audioCaptureTimeMs) / frameDurationMs);
      if (missed > UNDERRUN_SKIP_THRESHOLD) {
        // samples_dropped_from_buffer_ gains only the partial buffer's fill, which is empty here.
        this.audioRtp += missed * samplesPerFrame;
      }
    }
    // frame_capture_time_ = recorded_time - buffer_fill_duration (always empty here).
    const referenceTimeMs = recordedTimeMs;
    const meta: AudioMeta = { frameId: this.nextAudioFrameId++, rtp: this.audioRtp, referenceTimeMs };
    this.audioMeta.set(this.currentAudioSeq, meta);
    this.audioRtp += samplesPerFrame;
    this.audioCaptureTimeMs = referenceTimeMs + frameDurationMs;
    this.port.postMessage({ t: "encode-audio", seq: this.currentAudioSeq });
  }

  startAudioCapture(params: { sampleRate: number; channels: number; framesPerBuffer: number }, sink: AudioCaptureSink): void {
    this.audioSink = sink;
    this.audioConfig = { sampleRate: params.sampleRate, channels: params.channels };
    this.maybeStart();
  }

  stopAudioCapture(): void {
    this.audioSink = undefined;
  }

  startVideoCapture(params: VideoCaptureParams, sink: VideoCaptureSink): void {
    this.videoSink = sink;
    this.lastVideoParams = JSON.stringify(params);
    this.videoParams = { width: params.width, height: params.height, frameRate: params.frameRate, resolutionChangePolicy: params.resolutionChangePolicy };
    this.resetOracle();
    this.maybeStart();
  }

  /**
   * A capture device of its own, with its own oracle: at the start, and when a switch moves the capture to another tab
   * (`VideoCaptureClient::SwitchVideoCaptureHost` binds the new tab's host and starts a new device on it). Only the
   * capturer of a tab (viz's FrameSinkVideoCapturerImpl) acts on resource utilization. A desktop capture
   * (DesktopCaptureDevice) has the same CaptureResolutionChooser but never narrows it: it always captures at the
   * largest size the constraints allow.
   */
  private resetOracle(): void {
    const params = this.videoParams;
    this.oracle =
      params !== undefined && this.source.kind === "tab"
        ? new CaptureSizeOracle({
            ...suggestConstraints({ width: params.width, height: params.height }, params.resolutionChangePolicy),
            minCapturePeriodMs: 1000 / params.frameRate,
          })
        : undefined;
    this.oracleFrames.clear();
    this.lastContentFrameMs = undefined;
    this.sentCaptureSize = undefined;
  }

  private videoParams: { width: number; height: number; frameRate: number; resolutionChangePolicy: ResolutionChangePolicy } | undefined;
  private started = false;

  /** Audio and video capture start together, as one `getUserMedia` or `getDisplayMedia` call can serve both. */
  private maybeStart(): void {
    if (this.started) return;
    queueMicrotask(() => {
      if (this.started || this.stopped) return;
      this.started = true;
      this.port.postMessage({ t: "start", source: this.source, video: this.videoParams, audio: this.audioConfig });
    });
  }

  pauseVideoCapture(): void {
    this.port.postMessage({ t: "pause" });
  }

  resumeVideoCapture(params: VideoCaptureParams, sink: VideoCaptureSink): boolean {
    if (JSON.stringify(params) !== this.lastVideoParams || !this.started) return false;
    this.videoSink = sink;
    this.port.postMessage({ t: "resume" });
    return true;
  }

  /** The capture source the next start or switch uses: what `CastMirroringServiceHost::source_media_id_` is in Chrome. */
  setSource(source: CaptureSource): void {
    this.source = source;
  }

  private switchPending: { video: boolean; audio: boolean } | undefined;

  /**
   * One `switch` for both streams, since one `getUserMedia` call serves both tracks. Before capture has started there is
   * nothing to move: the start message carries the new source already.
   */
  private requestSwitch(kind: "video" | "audio"): void {
    if (!this.started || this.stopped) return;
    if (this.switchPending === undefined) {
      const pending = { video: false, audio: false };
      this.switchPending = pending;
      queueMicrotask(() => {
        this.switchPending = undefined;
        if (!this.stopped) this.port.postMessage({ t: "switch", source: this.source, video: pending.video, audio: pending.audio });
      });
    }
    this.switchPending[kind] = true;
  }

  switchVideoCaptureHost(): void {
    if (!this.started || this.stopped) return;
    this.resetOracle();
    this.requestSwitch("video");
  }

  restartAudioCapture(): void {
    this.requestSwitch("audio");
  }

  suspendVideoDevice(): void {
    this.port.postMessage({ t: "freeze" });
  }

  resumeVideoDevice(): void {
    this.port.postMessage({ t: "unfreeze" });
  }

  requestRefreshFrame(): void {
    this.port.postMessage({ t: "refresh" });
  }

  /**
   * `VideoCaptureClient::ProcessFeedback`. Chrome keeps the feedback for the next buffer it releases and the capture
   * device's oracle takes it from there (`FrameSinkVideoCapturerImpl`, `VideoCaptureOracle::RecordConsumerFeedback`);
   * here it goes to the oracle at once, for the frame whose output produced it.
   */
  processFeedback(resourceUtilization: number): void {
    if (this.oracle === undefined || this.feedbackFrame === undefined) return;
    this.oracle.recordConsumerFeedback(this.feedbackFrame, resourceUtilization);
  }

  /**
   * The oracle sees each captured frame as `FrameSinkVideoCapturerImpl::MaybeCaptureFrame` shows it one: the source
   * size, the event, then the capture with the pipeline's utilization. The size it proposes goes to the agent when it
   * changes.
   */
  private observeCapturedFrame(rtp: number, refMs: number, width: number, height: number, refresh: boolean): void {
    const oracle = this.oracle;
    if (oracle === undefined) return;
    const animating = !refresh && this.lastContentFrameMs !== undefined && refMs - this.lastContentFrameMs <= ANIMATION_MAX_GAP_MS;
    if (!refresh) this.lastContentFrameMs = refMs;
    oracle.setSourceSize({ width, height });
    oracle.observeEvent(refMs, animating);
    this.oracleFrames.set(rtp, oracle.nextFrameNumber);
    if (this.oracleFrames.size > 64) this.oracleFrames.delete(this.oracleFrames.keys().next().value!);
    oracle.recordCapture(this.pendingVideo.size / PIPELINE_CAPACITY);

    // The encoder wants even dimensions (I420 chroma); the capture constraints round their maximum to even for the same reason.
    const { width: w, height: h } = oracle.captureSize;
    const size = { width: w - (w % 2), height: h - (h % 2) };
    const key = `${size.width}x${size.height}`;
    if (key !== this.sentCaptureSize) {
      this.sentCaptureSize = key;
      this.port.postMessage({ t: "capture-size", ...size });
    }
  }

  /**
   * `WakeSource`: the agent's renderer has Chromium's timers, which keep time on Windows where Node's wait for the
   * 15.6 ms system tick. The caller keeps its own Node timer, so a busy or stopped agent costs punctuality, not the task.
   */
  requestWake(delayMs: number, wake: () => void): void {
    if (this.stopped) return;
    const id = this.nextWakeId++;
    this.wakes.set(id, wake);
    this.port.postMessage({ t: "wake", id, ms: delayMs });
  }

  stopAll(): void {
    if (this.stopped) return;
    this.port.postMessage({ t: "stop" });
    this.stopped = true;
    this.wakes.clear();
    this.port.close();
  }
}
