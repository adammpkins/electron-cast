/**
 * Default mirroring settings, ported from Chromium `components/mirroring/service/mirror_settings.{h,cc}`
 * (`MirrorSettings`) and `media/cast/cast_config.h` (`FrameSenderConfig`), plus the codec parameter strings of
 * `media/cast/encoding/encoding_support.cc` (`GetCodecParameterString`).
 * Times are milliseconds, sizes pixels.
 */
import type { AudioCodec, VideoCodec } from "./protocol/constants.ts";

/** mirror_settings.cc anonymous-namespace constants. */
export const AUDIO_TIMEBASE = 48000;
export const VIDEO_TIMEBASE = 90000;
export const AUDIO_CHANNELS = 2;
/** `kAudioFramerate`: 100 FPS for 10 ms packets. */
export const AUDIO_FRAMERATE = 100;
export const MIN_VIDEO_BITRATE = 300_000;
export const MAX_START_VIDEO_BITRATE = 10_000_000;
export const DEFAULT_MAX_FRAME_RATE = 30;
export const TARGET_MAX_FRAME_RATE_60 = 60;
export const MAX_RESOLUTION = { width: 1920, height: 1080 } as const;
export const MIN_RESOLUTION = { width: 180, height: 180 } as const;
export const DEFAULT_AUDIO_MAX_BITRATE = 128_000;
/** `GetMaxVideoBitrate()` with `kCastStreamingMaxVideoBitrate` off: the legacy 5 Mbps. */
export const LEGACY_MAX_VIDEO_BITRATE = 5_000_000;
/** mirror_settings.h `kFrameRefreshInterval` and `kDefaultPlayoutDelay`. */
export const FRAME_REFRESH_INTERVAL_MS = 50;
export const DEFAULT_PLAYOUT_DELAY_MS = 200;
/** openscreen_session_host.cc ssrcs from `GetVideoConfig` / `GetAudioConfig`. */
export const VIDEO_SENDER_SSRC = 11;
export const VIDEO_RECEIVER_SSRC = 12;
export const AUDIO_SENDER_SSRC = 1;
export const AUDIO_RECEIVER_SSRC = 2;

/** media/cast/cast_config.h `FrameSenderConfig` (the fields mirroring uses). */
export interface FrameSenderConfig {
  senderSsrc: number;
  receiverSsrc: number;
  minPlayoutDelayMs: number;
  maxPlayoutDelayMs: number;
  rtpTimebase: number;
  channels: number;
  minBitrate: number;
  maxBitrate: number;
  startBitrate: number;
  maxFrameRate: number;
  audioCodec?: AudioCodec;
  videoCodec?: VideoCodec;
  /** `AudioCodecParams` / `VideoCodecParams` `codec_parameter`. */
  codecParameter: string;
  useHardwareEncoder: boolean;
}

export type ResolutionChangePolicy = "fixed_resolution" | "fixed_aspect_ratio" | "any_within_limit";

export interface VideoCaptureParams {
  width: number;
  height: number;
  frameRate: number;
  resolutionChangePolicy: ResolutionChangePolicy;
}

/** `GetPlayoutDelayImpl`: `CHROME_MIRRORING_PLAYOUT_DELAY` (1..65535 ms), else the 200 ms default. */
export function getPlayoutDelayMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.CHROME_MIRRORING_PLAYOUT_DELAY;
  if (raw === undefined || raw === "") return DEFAULT_PLAYOUT_DELAY_MS;
  const n = /^[+-]?\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) return DEFAULT_PLAYOUT_DELAY_MS;
  return n;
}

export class MirrorSettings {
  private readonly targetPlayoutDelayMs: number | undefined;
  private maxResolutionValue: { width: number; height: number } = { ...MAX_RESOLUTION };
  maxFrameRate: number;
  refreshIntervalMs = FRAME_REFRESH_INTERVAL_MS;
  private senderSideLetterboxing = true;
  private readonly playoutDelayMs: number;

  constructor(targetPlayoutDelayMs?: number, env: Record<string, string | undefined> = process.env, enable60fps = false) {
    this.targetPlayoutDelayMs = targetPlayoutDelayMs;
    this.maxFrameRate = enable60fps ? TARGET_MAX_FRAME_RATE_60 : DEFAULT_MAX_FRAME_RATE;
    this.playoutDelayMs = getPlayoutDelayMs(env);
  }

  get maxResolution(): { width: number; height: number } {
    return this.maxResolutionValue;
  }

  /** `SetMaxResolutionConstraints`: never below the minimum resolution. */
  setMaxResolutionConstraints(size: { width: number; height: number }): void {
    this.maxResolutionValue = { width: Math.max(size.width, MIN_RESOLUTION.width), height: Math.max(size.height, MIN_RESOLUTION.height) };
  }

  setSenderSideLetterboxingEnabled(enabled: boolean): void {
    this.senderSideLetterboxing = enabled;
  }

  /** `GetVideoConfig`. */
  getVideoConfig(codec: VideoCodec): FrameSenderConfig {
    const delay = this.targetPlayoutDelayMs ?? this.playoutDelayMs;
    const maxBitrate = LEGACY_MAX_VIDEO_BITRATE;
    return {
      senderSsrc: VIDEO_SENDER_SSRC,
      receiverSsrc: VIDEO_RECEIVER_SSRC,
      minPlayoutDelayMs: delay,
      maxPlayoutDelayMs: delay,
      rtpTimebase: VIDEO_TIMEBASE,
      channels: 1,
      minBitrate: MIN_VIDEO_BITRATE,
      maxBitrate,
      // Start at the maximum, up to 10 Mbps, so the quality budget is there at once; it drops if the network cannot take it.
      startBitrate: Math.min(maxBitrate, MAX_START_VIDEO_BITRATE),
      maxFrameRate: this.maxFrameRate,
      videoCodec: codec,
      codecParameter: "",
      useHardwareEncoder: false,
    };
  }

  /** `GetAudioConfig`. */
  getAudioConfig(codec: AudioCodec): FrameSenderConfig {
    const delay = this.targetPlayoutDelayMs ?? this.playoutDelayMs;
    return {
      senderSsrc: AUDIO_SENDER_SSRC,
      receiverSsrc: AUDIO_RECEIVER_SSRC,
      minPlayoutDelayMs: delay,
      maxPlayoutDelayMs: delay,
      rtpTimebase: AUDIO_TIMEBASE,
      channels: AUDIO_CHANNELS,
      minBitrate: 0,
      startBitrate: DEFAULT_AUDIO_MAX_BITRATE,
      maxBitrate: DEFAULT_AUDIO_MAX_BITRATE,
      maxFrameRate: AUDIO_FRAMERATE,
      audioCodec: codec,
      codecParameter: "",
      useHardwareEncoder: false,
    };
  }

  /** `GetVideoCaptureParams` (the `is_high_dpi_enabled` and `is_secure` fields have no counterpart here). */
  getVideoCaptureParams(): VideoCaptureParams {
    const r = this.maxResolutionValue;
    let resolutionChangePolicy: ResolutionChangePolicy;
    if (r.width === MIN_RESOLUTION.width && r.height === MIN_RESOLUTION.height) resolutionChangePolicy = "fixed_resolution";
    else if (this.senderSideLetterboxing) resolutionChangePolicy = "fixed_aspect_ratio";
    else resolutionChangePolicy = "any_within_limit";
    return { width: r.width, height: r.height, frameRate: this.maxFrameRate, resolutionChangePolicy };
  }

  /** `GetAudioCaptureParams`: stereo 48 kHz in 10 ms buffers. */
  getAudioCaptureParams(): { sampleRate: number; channels: number; framesPerBuffer: number } {
    return { sampleRate: AUDIO_TIMEBASE, channels: AUDIO_CHANNELS, framesPerBuffer: AUDIO_TIMEBASE / 100 };
  }
}

/** encoding_support.cc `kCodecParameterConfigs` and `GetCodecLevel`. */
const CODEC_PARAMETER_CONFIGS = {
  vp9: { prefix: "vp09.00.", suffix: ".08", low: "40", high: "41" },
  hevc: { prefix: "hev1.1.6.L", suffix: ".B0", low: "120", high: "123" },
  av1: { prefix: "av01.0.", suffix: ".08", low: "08M", high: "09M" },
} as const;

/**
 * `GetCodecParameterString`. Above 1080p or above 30 fps the high level is used. H.264 needs
 * `media::BuildH264MimeSuffix` (profile Main, level 40 or 42), which is ".%s%04x" (video_codecs.cc), e.g. "avc1.4d0028" for level 40.
 */
export function getCodecParameterString(codec: VideoCodec, width: number, height: number, frameRate: number): string {
  const high = width * height > 1920 * 1080 || frameRate > 30;
  if (codec === "h264") return `avc1.4d${(high ? 42 : 40).toString(16).padStart(4, "0")}`;
  if (codec === "vp8") return "";
  const c = CODEC_PARAMETER_CONFIGS[codec];
  return `${c.prefix}${high ? c.high : c.low}${c.suffix}`;
}
