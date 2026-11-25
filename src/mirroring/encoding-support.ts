/**
 * Which video codecs the session offers, ported from Chromium `media/cast/encoding/encoding_support.cc`
 * (`IsSoftwareEnabled`, `IsHardwareEnabled`) with the feature defaults of `media/base/media_switches.cc`.
 *
 * Chromium asks the GPU process for the hardware encoder profiles; here the capture side probes WebCodecs
 * (`VideoEncoder.isConfigSupported`, with `hardwareAcceleration` set to `prefer-hardware` or `prefer-software`) and
 * passes the result as `EncodingProbe`. A codec is offered only if both the probe and Chromium's default feature
 * state allow it.
 */
import type { VideoCodec } from "./protocol/constants.ts";

/** What the capture side found WebCodecs able to encode at the session's resolution and frame rate. */
export interface EncodingProbe {
  hardware: ReadonlySet<VideoCodec>;
  software: ReadonlySet<VideoCodec>;
}

/**
 * Codecs Chromium may encode in hardware by default: `GetHardwareCodecParameters` ties H.264 to
 * `kCastStreamingMac/WinHardwareH264` (enabled by default, none elsewhere), HEVC to `kCastStreamingHardwareHevc`
 * (disabled by default), VP8 to `kCastStreamingVp8` and VP9 to `kCastStreamingVp9` (enabled), AV1 to
 * `kCastStreamingAv1` (disabled).
 */
const HARDWARE_ALLOWED: Record<VideoCodec, boolean> = { h264: true, hevc: false, vp8: true, vp9: true, av1: false };
/** `IsSoftwareEnabled`: VP8 and VP9 by feature (enabled by default), AV1 by `kCastStreamingAv1` (disabled), others never. */
const SOFTWARE_ALLOWED: Record<VideoCodec, boolean> = { h264: false, hevc: false, vp8: true, vp9: true, av1: false };

export interface EncodingSupport {
  isHardwareEnabled(codec: VideoCodec): boolean;
  isSoftwareEnabled(codec: VideoCodec): boolean;
}

export function createEncodingSupport(probe: EncodingProbe, denyListed: ReadonlySet<VideoCodec> = new Set()): EncodingSupport {
  return {
    isHardwareEnabled: (codec) => HARDWARE_ALLOWED[codec] && probe.hardware.has(codec) && !denyListed.has(codec),
    isSoftwareEnabled: (codec) => SOFTWARE_ALLOWED[codec] && probe.software.has(codec),
  };
}

/** openscreen_session_host.cc `kSupportedVideoCodecs`, in order of priority. */
export const SUPPORTED_VIDEO_CODECS: readonly VideoCodec[] = ["hevc", "av1", "vp9", "h264", "vp8"];
