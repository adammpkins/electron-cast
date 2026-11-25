/**
 * A synthetic capture and encode backend: a 30 fps video source and a 10 ms audio source whose "encoded" frames are
 * structurally valid VP8 and Opus packets with deterministic bodies, sized by the bitrate the session asks for.
 */
import type { AudioCaptureSink, AudioEncoderCallbacks, AudioEncoderPort, MirroringBackend, VideoCaptureSink, VideoEncoderCallbacks } from "../../src/mirroring/backend.ts";
import type { FrameSenderConfig, VideoCaptureParams } from "../../src/mirroring/mirror-settings.ts";
import type { RawVideoFrame, VideoEncoderPort } from "../../src/mirroring/sender/video-sender.ts";
import { fakeFrameBody } from "./fake-receiver.ts";

/** A VP8 frame: RFC 6386 frame tag (+ key frame start code and size), then a deterministic body. */
export function makeVp8Frame(key: boolean, rtpTimestamp: number, size: number, width = 1280, height = 720): Buffer {
  const head = Buffer.alloc(10);
  const firstPartSize = 0;
  const tag = (key ? 0 : 1) | (0 << 1) | (1 << 4) | (firstPartSize << 5);
  head[0] = tag & 0xff;
  head[1] = (tag >> 8) & 0xff;
  head[2] = (tag >> 16) & 0xff;
  if (key) {
    head[3] = 0x9d;
    head[4] = 0x01;
    head[5] = 0x2a;
    head.writeUInt16LE(width, 6);
    head.writeUInt16LE(height, 8);
  }
  const headerLength = 10;
  return Buffer.concat([head, fakeFrameBody(rtpTimestamp, Math.max(0, size - headerLength))]);
}

export function makeOpusPacket(rtpTimestamp: number, size: number): Buffer {
  return Buffer.concat([Buffer.from([0x78]), fakeFrameBody(rtpTimestamp, Math.max(0, size - 1))]);
}

/** The timers the backend runs on: Node's by default, a VirtualClock's in deterministic tests. */
export interface FakeTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  setInterval(cb: () => void, ms: number): () => void;
}

const realTimers: FakeTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  setInterval: (cb, ms) => {
    const t = setInterval(cb, ms);
    return () => clearInterval(t);
  },
};

export class FakeBackend implements MirroringBackend {
  readonly videoBitrates: number[] = [];
  readonly keyFramesRequested: number[] = [];
  videoFramesProduced = 0;
  audioFramesProduced = 0;
  feedback: number[] = [];
  private cancelVideoTimer: (() => void) | undefined;
  private cancelAudioTimer: (() => void) | undefined;
  private paused = false;
  private videoSink: VideoCaptureSink | undefined;
  private lastVideoParams: VideoCaptureParams | undefined;
  private readonly now: () => number;
  private readonly t0: number;
  private videoBitrate = 0;
  private needKey = true;
  private nextVideoFrameId = 0;
  private lastVideoFrameId = -1;

  private readonly timers: FakeTimers;

  constructor(now: () => number, timers: FakeTimers = realTimers) {
    this.now = now;
    this.timers = timers;
    this.t0 = now();
  }

  createVideoEncoder(config: FrameSenderConfig, callbacks: VideoEncoderCallbacks): VideoEncoderPort {
    const fps = config.maxFrameRate;
    const self = this;
    queueMicrotask(() => callbacks.onStatus("initialized"));
    return {
      generateKeyFrame: () => {
        self.needKey = true;
        self.keyFramesRequested.push(self.now());
      },
      setBitRate: (bps) => {
        self.videoBitrate = bps;
        self.videoBitrates.push(bps);
      },
      setMaxFrameRate: () => {},
      encodeVideoFrame(frame: RawVideoFrame, referenceTimeMs: number): boolean {
        const key = self.needKey;
        self.needKey = false;
        const perFrame = Math.max(300, Math.round(self.videoBitrate / 8 / fps));
        const size = key ? perFrame * 3 : perFrame;
        const frameId = self.nextVideoFrameId++;
        const referenced = key ? frameId : self.lastVideoFrameId;
        self.lastVideoFrameId = frameId;
        const data = makeVp8Frame(key, frame.rtpTimestamp, size);
        self.timers.setTimeout(() => {
          self.videoFramesProduced++;
          callbacks.onEncoded(referenceTimeMs, {
            isKeyFrame: key,
            frameId,
            referencedFrameId: referenced,
            rtpTimestamp: frame.rtpTimestamp,
            referenceTimeMs,
            newPlayoutDelayMs: 0,
            data,
            encoderUtilization: 0.2,
          });
        }, 2);
        return true;
      },
    };
  }

  createAudioEncoder(config: FrameSenderConfig, callbacks: AudioEncoderCallbacks): AudioEncoderPort {
    const self = this;
    let nextId = 0;
    let samples = 0;
    queueMicrotask(() => callbacks.onStatus("initialized"));
    return {
      samplesPerFrame: 480,
      bitrate: config.maxBitrate,
      encode(frames: number, recordedTimeMs: number) {
        const frameId = nextId++;
        const rtp = samples;
        samples += frames;
        self.audioFramesProduced++;
        // Opus at 128 kbps: 160 bytes per 10 ms.
        callbacks.onEncoded(
          {
            isKeyFrame: true,
            frameId,
            referencedFrameId: frameId,
            rtpTimestamp: rtp,
            referenceTimeMs: recordedTimeMs,
            newPlayoutDelayMs: 0,
            data: makeOpusPacket(rtp, Math.round(config.maxBitrate / 8 / 100)),
            encoderUtilization: -1,
          },
          0,
        );
      },
    };
  }

  startAudioCapture(_params: { sampleRate: number; channels: number; framesPerBuffer: number }, sink: AudioCaptureSink): void {
    this.cancelAudioTimer = this.timers.setInterval(() => sink.insertAudio(480, this.now()), 10);
  }

  stopAudioCapture(): void {
    this.cancelAudioTimer?.();
    this.cancelAudioTimer = undefined;
  }

  startVideoCapture(params: VideoCaptureParams, sink: VideoCaptureSink): void {
    this.lastVideoParams = params;
    this.videoSink = sink;
    this.paused = false;
    let last = 0;
    this.cancelVideoTimer = this.timers.setInterval(() => {
      if (this.paused) return;
      const ref = this.now();
      let rtp = Math.round((ref - this.t0) * 90) + 3000;
      if (rtp <= last) rtp = last + 1;
      last = rtp;
      this.videoSink?.insertVideoFrame({ rtpTimestamp: rtp, referenceTimeMs: ref, visibleRectEmpty: false });
    }, 1000 / params.frameRate);
  }

  pauseVideoCapture(): void {
    this.paused = true;
  }

  resumeVideoCapture(params: VideoCaptureParams, sink: VideoCaptureSink): boolean {
    if (JSON.stringify(params) !== JSON.stringify(this.lastVideoParams)) return false;
    this.videoSink = sink;
    this.paused = false;
    return true;
  }

  requestRefreshFrame(): void {}

  processFeedback(resourceUtilization: number): void {
    this.feedback.push(resourceUtilization);
  }

  stopAll(): void {
    this.stopAudioCapture();
    this.cancelVideoTimer?.();
    this.cancelVideoTimer = undefined;
  }
}
