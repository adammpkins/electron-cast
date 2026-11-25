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
 * `kCastStreamingMac/WinHardwareH264` (enabled by default; no feature at all elsewhere, which counts as enabled), HEVC
 * to `kCastStreamingHardwareHevc` (disabled by default), VP8 to `kCastStreamingVp8` and VP9 to `kCastStreamingVp9`
 * (enabled), AV1 to `kCastStreamingAv1` (disabled).
 */
const HARDWARE_ALLOWED: Record<VideoCodec, boolean> = { h264: true, hevc: false, vp8: true, vp9: true, av1: false };
/** `IsSoftwareEnabled`: VP8 and VP9 by feature (enabled by default), AV1 by `kCastStreamingAv1` (disabled), others never. */
const SOFTWARE_ALLOWED: Record<VideoCodec, boolean> = { h264: false, hevc: false, vp8: true, vp9: true, av1: false };

/** media_switches.cc `kCastStreamingForceEnableHardware*` / `kCastStreamingForceDisableHardware*`. */
export interface HardwareSwitches {
  forceEnable: ReadonlySet<VideoCodec>;
  forceDisable: ReadonlySet<VideoCodec>;
}

const ALL_CODECS: readonly VideoCodec[] = ["h264", "hevc", "vp8", "vp9", "av1"];

/** The switches among command-line arguments (`--cast-streaming-force-enable-hardware-h264`). */
export function hardwareSwitchesFromArgv(argv: readonly string[]): HardwareSwitches {
  const forceEnable = new Set<VideoCodec>();
  const forceDisable = new Set<VideoCodec>();
  for (const arg of argv) {
    const m = /^--cast-streaming-force-(enable|disable)-hardware-(h264|hevc|vp8|vp9|av1)$/.exec(arg);
    if (m) (m[1] === "enable" ? forceEnable : forceDisable).add(m[2] as VideoCodec);
  }
  return { forceEnable, forceDisable };
}

/** The part of `IsHardwareEnabled` that does not depend on the encoder: the switches, then the feature default. */
export function isHardwareCodecAllowed(codec: VideoCodec, switches: HardwareSwitches): boolean {
  if (switches.forceDisable.has(codec)) return false;
  return HARDWARE_ALLOWED[codec] || switches.forceEnable.has(codec);
}

/** Codecs worth asking the encoder about in hardware. */
export function hardwareCodecsToProbe(switches: HardwareSwitches): VideoCodec[] {
  return ALL_CODECS.filter((c) => isHardwareCodecAllowed(c, switches));
}

export interface EncodingSupport {
  isHardwareEnabled(codec: VideoCodec): boolean;
  isSoftwareEnabled(codec: VideoCodec): boolean;
  isHardwareDenyListed(codec: VideoCodec): boolean;
  /** `DenyListHardwareCodec`: stop offering the codec in hardware, for the rest of the app's run. Chrome CHECKs it is not already listed. */
  denyListHardwareCodec(codec: VideoCodec): void;
}

export interface EncodingSupportOptions {
  /**
   * Chromium's process-wide `GetHardwareCodecDenyList()`: a codec whose hardware encoder failed stays out of every
   * later session's offer. The engine runs in its own process per session, so the owner of the list (the main
   * process) passes it in and `onDenyListed` reports an addition back.
   */
  denyListed?: Set<VideoCodec>;
  onDenyListed?: (codec: VideoCodec) => void;
  switches?: HardwareSwitches;
}

export function createEncodingSupport(probe: EncodingProbe, options: EncodingSupportOptions = {}): EncodingSupport {
  const denyListed = options.denyListed ?? new Set<VideoCodec>();
  const switches = options.switches ?? { forceEnable: new Set(), forceDisable: new Set() };
  return {
    isHardwareEnabled: (codec) => !denyListed.has(codec) && isHardwareCodecAllowed(codec, switches) && probe.hardware.has(codec),
    isSoftwareEnabled: (codec) => SOFTWARE_ALLOWED[codec] && probe.software.has(codec),
    isHardwareDenyListed: (codec) => denyListed.has(codec),
    denyListHardwareCodec(codec) {
      if (denyListed.has(codec)) throw new Error(`hardware ${codec} is already deny-listed`);
      denyListed.add(codec);
      options.onDenyListed?.(codec);
    },
  };
}

/** openscreen_session_host.cc `kSupportedVideoCodecs`, in order of priority. */
export const SUPPORTED_VIDEO_CODECS: readonly VideoCodec[] = ["hevc", "av1", "vp9", "h264", "vp8"];
