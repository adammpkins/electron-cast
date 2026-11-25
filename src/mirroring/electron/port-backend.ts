/**
 * The engine's `MirroringBackend` over a port to the capture agent. Frame ids are assigned here, as
 * `media::cast::VideoEncoder` / `AudioEncoder` assign them in Chromium: a key frame references itself, a delta frame
 * the frame before it; the RTP timestamp of audio is the running sample count.
 */
import { performance } from "node:perf_hooks";
import type {
  AudioCaptureSink, AudioEncoderCallbacks, AudioEncoderPort, MirroringBackend, VideoCaptureSink, VideoEncoderCallbacks,
} from "../backend.ts";
import type { FrameSenderConfig, VideoCaptureParams } from "../mirror-settings.ts";
import type { RawVideoFrame, VideoEncoderPort } from "../sender/video-sender.ts";
import type { AgentPort, AgentToEngine, CaptureSource } from "./agent-protocol.ts";

const toLocalMs = (epochMs: number): number => epochMs - performance.timeOrigin;

export class PortBackend implements MirroringBackend {
  private readonly port: AgentPort;
  private readonly source: CaptureSource;
  private videoSink: VideoCaptureSink | undefined;
  private audioSink: AudioCaptureSink | undefined;
  private videoCallbacks: VideoEncoderCallbacks | undefined;
  private audioCallbacks: AudioEncoderCallbacks | undefined;
  private lastVideoParams: string | undefined;
  private pendingVideo = new Map<number, number>();
  private nextVideoFrameId = 0;
  private lastVideoFrameId = -1;
  private nextAudioFrameId = 0;
  private audioSamples = 0;
  private currentAudioSeq = 0;
  private frameInterval = 1000 / 30;
  private audioConfig: { sampleRate: number; channels: number } | undefined;
  private audioSenderConfig: FrameSenderConfig | undefined;
  private stopped = false;

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
      case "error":
        if (m.where === "video") this.videoSink?.onCaptureError(m.message);
        else if (m.where === "audio") this.audioSink?.onCaptureError(m.message);
        else this.videoCallbacks?.onStatus("codec_runtime_error");
        break;
      case "frame":
        this.videoSink?.insertVideoFrame({ rtpTimestamp: m.rtp, referenceTimeMs: toLocalMs(m.refMs), visibleRectEmpty: false });
        break;
      case "video-chunk": {
        const ref = this.pendingVideo.get(m.rtp);
        this.pendingVideo.delete(m.rtp);
        if (ref === undefined) return;
        const frameId = this.nextVideoFrameId++;
        const referenced = m.key ? frameId : this.lastVideoFrameId;
        this.lastVideoFrameId = frameId;
        this.videoCallbacks?.onEncoded(ref, {
          isKeyFrame: m.key,
          frameId,
          referencedFrameId: referenced,
          rtpTimestamp: m.rtp,
          referenceTimeMs: ref,
          newPlayoutDelayMs: 0,
          data: Buffer.from(m.data),
          // How much of the frame interval the encoder needed, the utilization `VideoSender` feeds back.
          encoderUtilization: Math.max(0, m.encodeMs / this.frameInterval),
        });
        break;
      }
      case "audio-buffer": {
        this.currentAudioSeq = m.seq;
        const accepted = this.audioSink?.insertAudio(m.frames, toLocalMs(m.recMs)) ?? false;
        if (!accepted) this.port.postMessage({ t: "drop-audio", seq: m.seq });
        break;
      }
      case "audio-chunk": {
        const frameId = this.nextAudioFrameId++;
        const rtp = this.audioSamples;
        this.audioSamples += this.audioSenderConfig !== undefined ? this.audioSenderConfig.rtpTimebase / 100 : 480;
        this.audioCallbacks?.onEncoded(
          {
            isKeyFrame: true,
            frameId,
            referencedFrameId: frameId,
            rtpTimestamp: rtp,
            referenceTimeMs: performance.now(),
            newPlayoutDelayMs: 0,
            data: Buffer.from(m.data),
            encoderUtilization: -1,
          },
          0,
        );
        break;
      }
      case "encoder-status":
        (m.kind === "video" ? this.videoCallbacks : this.audioCallbacks)?.onStatus(m.status);
        break;
    }
  }

  createVideoEncoder(config: FrameSenderConfig, callbacks: VideoEncoderCallbacks): VideoEncoderPort {
    this.videoCallbacks = callbacks;
    this.frameInterval = 1000 / config.maxFrameRate;
    this.port.postMessage({ t: "set-codec", codec: (config.videoCodec ?? "vp8") as "vp8", codecString: config.codecParameter });
    this.port.postMessage({ t: "set-bitrate", bps: config.startBitrate });
    // The agent reports unsupported or failed codecs; "initialized" is the default until it says otherwise.
    queueMicrotask(() => callbacks.onStatus("initialized"));
    return {
      generateKeyFrame: () => this.port.postMessage({ t: "key-frame" }),
      setBitRate: (bps) => this.port.postMessage({ t: "set-bitrate", bps }),
      setMaxFrameRate: (rate) => {
        this.frameInterval = 1000 / rate;
      },
      encodeVideoFrame: (frame: RawVideoFrame, referenceTimeMs: number) => {
        this.pendingVideo.set(frame.rtpTimestamp, referenceTimeMs);
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
    this.port.postMessage({ t: "set-audio", bps: config.maxBitrate });
    queueMicrotask(() => callbacks.onStatus("initialized"));
    return {
      samplesPerFrame: config.rtpTimebase / 100,
      bitrate: config.maxBitrate,
      encode: () => this.port.postMessage({ t: "encode-audio", seq: this.currentAudioSeq }),
    };
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
    this.videoParams = { width: params.width, height: params.height, frameRate: params.frameRate };
    this.maybeStart();
  }

  private videoParams: { width: number; height: number; frameRate: number } | undefined;
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

  requestRefreshFrame(): void {
    this.port.postMessage({ t: "refresh" });
  }

  processFeedback(): void {}

  stopAll(): void {
    if (this.stopped) return;
    this.port.postMessage({ t: "stop" });
    this.stopped = true;
    this.port.close();
  }
}
