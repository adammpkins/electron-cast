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
/** cast_mirroring_service_host.cc and mirror_settings.cc `kMaxResolution`. */
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

/**
 * `CastMirroringServiceHost::GetClampedResolution` (chrome/browser/media/cast_mirroring_service_host.cc): the screen in
 * landscape, capped at `kMaxResolution` keeping the 16:9 shape and rounded down to a whole step of 160x90, at least one
 * step.
 */
export function getClampedResolution(screen: { width: number; height: number }): { width: number; height: number } {
  const widthStep = 160;
  const heightStep = 90;
  // Use landscape mode dimensions for screens in portrait mode.
  const [w, h] = screen.height > screen.width ? [screen.height, screen.width] : [screen.width, screen.height];
  let clampedWidth: number;
  let clampedHeight: number;
  if (MAX_RESOLUTION.height * w < MAX_RESOLUTION.width * h) {
    clampedWidth = Math.min(MAX_RESOLUTION.width, w);
    clampedWidth -= clampedWidth % widthStep;
    clampedHeight = Math.trunc((clampedWidth * heightStep) / widthStep);
  } else {
    clampedHeight = Math.min(MAX_RESOLUTION.height, h);
    clampedHeight -= clampedHeight % heightStep;
    clampedWidth = Math.trunc((clampedHeight * widthStep) / heightStep);
  }
  return { width: Math.max(clampedWidth, widthStep), height: Math.max(clampedHeight, heightStep) };
}

/** The part of Electron's `Display` that `Display::GetSizeInPixel` needs: `size` is in DIPs. */
export interface DisplaySizeLike {
  size: { width: number; height: number };
  scaleFactor: number;
}

/** The part of Electron's `screen` that is used. */
export interface PrimaryScreenLike {
  getPrimaryDisplay(): DisplaySizeLike;
}

/**
 * `Display::GetSizeInPixel` (ui/display/display.cc): `gfx::ScaleToFlooredSize(size(), device_scale_factor_)`, in the
 * float arithmetic Chromium uses. Electron's `Display` does not expose Chromium's `size_in_pixels_` (which, when set,
 * wins there), so the DIP size and the scale factor stand in for it.
 */
export function displaySizeInPixels(display: DisplaySizeLike): { width: number; height: number } {
  const scale = Number.isFinite(display.scaleFactor) && display.scaleFactor > 0 ? display.scaleFactor : 1;
  const floor = (dip: number): number => Math.floor(Math.fround(Math.fround(dip) * Math.fround(scale)));
  return { width: floor(display.size.width), height: floor(display.size.height) };
}

/**
 * `CastMirroringServiceHost::GetCaptureResolutionConstraint`: the clamped size of the primary display in pixels (for a
 * tab and for a desktop capture alike: Chrome asks `display::Screen::GetPrimaryDisplay()`, not the display the page or
 * the captured screen is on), or `kMaxResolution` when there is no screen to ask. It does not depend on
 * `kCastEnableStreamingWithHiDPI`, which only sets `VideoCaptureParams::is_high_dpi_enabled`.
 */
export function getCaptureResolutionConstraint(screen: PrimaryScreenLike | undefined): { width: number; height: number } {
  if (screen === undefined) return { ...MAX_RESOLUTION };
  let display: DisplaySizeLike;
  try {
    display = screen.getPrimaryDisplay();
  } catch {
    // "Cannot get the Screen object": std::nullopt, so the default applies.
    return { ...MAX_RESOLUTION };
  }
  return getClampedResolution(displaySizeInPixels(display));
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
 * `media::BuildH264MimeSuffix` (level 40 or 42), which is ".%s%04x" (video_codecs.cc): profile 4d (Main) gives
 * "avc1.4d0028" for level 40. `ToProfile` picks Baseline (42) on macOS (`kCastMacForceBaselineProfile`, on by default)
 * and Main elsewhere.
 */
export function getCodecParameterString(codec: VideoCodec, width: number, height: number, frameRate: number, h264Profile: "main" | "baseline" = "main"): string {
  const high = width * height > 1920 * 1080 || frameRate > 30;
  if (codec === "h264") return `avc1.${h264Profile === "baseline" ? "42" : "4d"}${(high ? 42 : 40).toString(16).padStart(4, "0")}`;
  if (codec === "vp8") return "";
  const c = CODEC_PARAMETER_CONFIGS[codec];
  return `${c.prefix}${high ? c.high : c.low}${c.suffix}`;
}
