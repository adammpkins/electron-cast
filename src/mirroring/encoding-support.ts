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

/** The part of Chrome's `base::CommandLine` this module reads; Electron's `app.commandLine` has exactly these two. */
export interface CommandLineLike {
  hasSwitch(name: string): boolean;
  getSwitchValue(name: string): string;
}

/**
 * What Chrome's command line and feature defaults say about the codecs, as `encoding_support.cc` reads them.
 * `hardwareFeatures` and `softwareFeatures` are the codecs whose `media::kCastStreaming*` feature is enabled
 * (`GetHardwareCodecParameters` and `IsSoftwareEnabled`); the force sets are the
 * `--cast-streaming-force-{enable,disable}-hardware-<codec>` switches.
 */
export interface EncodingPolicy {
  hardwareFeatures: ReadonlySet<VideoCodec>;
  softwareFeatures: ReadonlySet<VideoCodec>;
  forceEnable: ReadonlySet<VideoCodec>;
  forceDisable: ReadonlySet<VideoCodec>;
}

const ALL_CODECS: readonly VideoCodec[] = ["h264", "hevc", "vp8", "vp9", "av1"];

interface Feature {
  name: string | undefined;
  enabledByDefault: boolean;
}

/**
 * media_switches.cc feature names and defaults. Hardware: H.264 is tied to `kCastStreamingMac/WinHardwareH264` (enabled
 * by default; no feature at all elsewhere, which counts as enabled), HEVC to `kCastStreamingHardwareHevc` (disabled),
 * VP8 to `kCastStreamingVp8` and VP9 to `kCastStreamingVp9` (enabled), AV1 to `kCastStreamingAv1` (disabled).
 */
function hardwareFeature(codec: VideoCodec, platform: string): Feature {
  switch (codec) {
    case "h264": return { name: platform === "win32" ? "CastStreamingWinHardwareH264" : platform === "darwin" ? "CastStreamingMacHardwareH264" : undefined, enabledByDefault: true };
    case "hevc": return { name: "CastStreamingHardwareHevc", enabledByDefault: false };
    case "vp8": return { name: "CastStreamingVp8", enabledByDefault: true };
    case "vp9": return { name: "CastStreamingVp9", enabledByDefault: true };
    case "av1": return { name: "CastStreamingAv1", enabledByDefault: false };
  }
}
/** `IsSoftwareEnabled`: VP8 and VP9 by their features, AV1 by `kCastStreamingAv1`, H.264 and HEVC never. */
const SOFTWARE_FEATURES: Partial<Record<VideoCodec, Feature>> = {
  vp8: { name: "CastStreamingVp8", enabledByDefault: true },
  vp9: { name: "CastStreamingVp9", enabledByDefault: true },
  av1: { name: "CastStreamingAv1", enabledByDefault: false },
};

/** `--enable-features=A,B:params` / `--disable-features=...`: the feature names. */
function featureNames(commandLine: CommandLineLike, name: string): Set<string> {
  const names = new Set<string>();
  if (!commandLine.hasSwitch(name)) return names;
  for (const item of commandLine.getSwitchValue(name).split(",")) {
    const feature = item.trim().split(/[:<]/)[0]!.replace(/^[*!]/, "");
    if (feature !== "") names.add(feature);
  }
  return names;
}

/**
 * Chrome's own switches and features, read from the app's command line (`app.commandLine`, which also sees
 * `appendSwitch`). A feature named in both `--enable-features` and `--disable-features` is disabled, as in
 * `base::FeatureList`.
 */
export function encodingPolicyFromCommandLine(commandLine: CommandLineLike | undefined, platform: string = process.platform): EncodingPolicy {
  const enabled = commandLine === undefined ? new Set<string>() : featureNames(commandLine, "enable-features");
  const disabled = commandLine === undefined ? new Set<string>() : featureNames(commandLine, "disable-features");
  const on = (f: Feature): boolean => (f.name !== undefined && disabled.has(f.name) ? false : (f.name !== undefined && enabled.has(f.name)) || f.enabledByDefault);
  const hardwareFeatures = new Set<VideoCodec>(ALL_CODECS.filter((c) => on(hardwareFeature(c, platform))));
  const softwareFeatures = new Set<VideoCodec>(ALL_CODECS.filter((c) => { const f = SOFTWARE_FEATURES[c]; return f !== undefined && on(f); }));
  const forced = (kind: "enable" | "disable"): Set<VideoCodec> =>
    new Set(ALL_CODECS.filter((c) => commandLine?.hasSwitch(`cast-streaming-force-${kind}-hardware-${c}`) === true));
  return { hardwareFeatures, softwareFeatures, forceEnable: forced("enable"), forceDisable: forced("disable") };
}

/** The policy of a command line that says nothing. */
export const DEFAULT_ENCODING_POLICY: EncodingPolicy = encodingPolicyFromCommandLine(undefined);

/** The part of `IsHardwareEnabled` that does not depend on the encoder: the switches, then the feature state. */
export function isHardwareCodecAllowed(codec: VideoCodec, policy: EncodingPolicy): boolean {
  if (policy.forceDisable.has(codec)) return false;
  return policy.hardwareFeatures.has(codec) || policy.forceEnable.has(codec);
}

/** Codecs worth asking the encoder about in hardware. */
export function hardwareCodecsToProbe(policy: EncodingPolicy): VideoCodec[] {
  return ALL_CODECS.filter((c) => isHardwareCodecAllowed(c, policy));
}

/** Codecs worth asking the encoder about in software. */
export function softwareCodecsToProbe(policy: EncodingPolicy): VideoCodec[] {
  return ALL_CODECS.filter((c) => policy.softwareFeatures.has(c));
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
  policy?: EncodingPolicy;
}

export function createEncodingSupport(probe: EncodingProbe, options: EncodingSupportOptions = {}): EncodingSupport {
  const denyListed = options.denyListed ?? new Set<VideoCodec>();
  const policy = options.policy ?? DEFAULT_ENCODING_POLICY;
  return {
    isHardwareEnabled: (codec) => !denyListed.has(codec) && isHardwareCodecAllowed(codec, policy) && probe.hardware.has(codec),
    isSoftwareEnabled: (codec) => policy.softwareFeatures.has(codec) && probe.software.has(codec),
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
