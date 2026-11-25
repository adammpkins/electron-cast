/**
 * The capture and encode side as the session host sees it. In Chromium these are the `VideoCaptureHost` /
 * `AudioInputDevice` resources of `mojom::ResourceProvider` and `media::cast::VideoEncoder` / `AudioEncoder`
 * (`components/mirroring/service/openscreen_session_host.cc`); here the implementation is the renderer-side agent
 * (src/mirroring/capture/) and tests provide fakes.
 */
import type { SenderEncodedFrame } from "./sender/frame-sender.ts";
import type { VideoEncoderPort, RawVideoFrame } from "./sender/video-sender.ts";
import type { FrameSenderConfig, VideoCaptureParams } from "./mirror-settings.ts";

/** media/cast/constants.h `OperationalStatus`. */
export type OperationalStatus =
  | "uninitialized"
  | "codec_reinit_pending"
  | "initialized"
  | "invalid_configuration"
  | "unsupported_codec"
  | "codec_init_failed"
  | "codec_runtime_error";

/** `AsErrorMessage` of openscreen_session_host.cc; undefined for statuses that are not errors. */
export function operationalStatusErrorMessage(status: OperationalStatus): string | undefined {
  switch (status) {
    case "uninitialized":
    case "codec_reinit_pending":
    case "initialized":
      return undefined;
    case "invalid_configuration":
      return "Invalid encoder configuration.";
    case "unsupported_codec":
      return "Unsupported codec.";
    case "codec_init_failed":
      return "Failed to initialize codec.";
    case "codec_runtime_error":
      return "Fatal error in codec runtime.";
  }
}

/** A raw video frame with the reference time the capture assigned (`VideoFrameMetadata::reference_time`). */
export interface CapturedVideoFrame extends RawVideoFrame {
  referenceTimeMs?: number;
}

export interface VideoCaptureSink {
  insertVideoFrame(frame: CapturedVideoFrame): void;
  onCaptureError(message: string): void;
}

export interface AudioCaptureSink {
  /** A buffer of `frames` samples per channel was captured at `recordedTimeMs`; true when it will be encoded. */
  insertAudio(frames: number, recordedTimeMs: number): boolean;
  onCaptureError(message: string): void;
}

export interface AudioEncoderPort {
  readonly samplesPerFrame: number;
  /** `AudioEncoder::GetBitrate`. */
  readonly bitrate: number;
  /** Encode the buffer that `AudioCaptureSink.insertAudio` accepted. */
  encode(frames: number, recordedTimeMs: number): void;
}

export interface VideoEncoderCallbacks {
  /** `referenceTimeMs` is the one the raw frame was inserted with; `frame` is undefined when the encode failed. */
  onEncoded(referenceTimeMs: number, frame: SenderEncodedFrame | undefined): void;
  /** `message` is the encoder's own description of a failure, for the log. */
  onStatus(status: OperationalStatus, message?: string): void;
}

export interface AudioEncoderCallbacks {
  onEncoded(frame: SenderEncodedFrame, samplesSkipped: number): void;
  onStatus(status: OperationalStatus): void;
}

/** Everything a session owns. `stopAll` releases captures and encoders once, when the session ends. */
export interface MirroringBackend {
  stopAll?(): void;
  createAudioEncoder(config: FrameSenderConfig, callbacks: AudioEncoderCallbacks): AudioEncoderPort;
  createVideoEncoder(config: FrameSenderConfig, callbacks: VideoEncoderCallbacks): VideoEncoderPort;
  startAudioCapture(params: { sampleRate: number; channels: number; framesPerBuffer: number }, sink: AudioCaptureSink): void;
  stopAudioCapture(): void;
  startVideoCapture(params: VideoCaptureParams, sink: VideoCaptureSink): void;
  pauseVideoCapture(): void;
  /** True when the existing capture can be reused with the same parameters. */
  resumeVideoCapture(params: VideoCaptureParams, sink: VideoCaptureSink): boolean;
  requestRefreshFrame(): void;
  processFeedback(resourceUtilization: number): void;
}
