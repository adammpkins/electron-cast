/**
 * Constants of the Cast Streaming sender, each with its source. openscreen paths are under
 * `third_party/openscreen/src/cast/streaming/`.
 */

/** public/constants.h `kDefaultTargetPlayoutDelay`. */
export const DEFAULT_TARGET_PLAYOUT_DELAY_MS = 400;
/** public/constants.h `kRtcpReportInterval`. */
export const RTCP_REPORT_INTERVAL_MS = 500;
/** public/constants.h `kMaxUnackedFrames`. */
export const MAX_UNACKED_FRAMES = 120;
/** public/constants.h `kRequiredNetworkPacketSize`. */
export const REQUIRED_NETWORK_PACKET_SIZE = 256;
/** public/constants.h `kRtpVideoTimebase`. */
export const RTP_VIDEO_TIMEBASE = 90000;
/** public/constants.h `kMinVideoWidth` / `kMinVideoHeight`. */
export const MIN_VIDEO_WIDTH = 320;
export const MIN_VIDEO_HEIGHT = 240;
/** public/constants.h `kDefaultFrameRate`. */
export const DEFAULT_FRAME_RATE = 30;
/** public/constants.h `kDefaultVideoMinBitRate` / `kDefaultVideoMaxBitRate`. */
export const DEFAULT_VIDEO_MIN_BIT_RATE = 300_000;
export const DEFAULT_VIDEO_MAX_BIT_RATE = 10_000_000;
/** public/constants.h `kDefaultAudioMinBitRate` / `kDefaultAudioMaxBitRate`. */
export const DEFAULT_AUDIO_MIN_BIT_RATE = 32_000;
export const DEFAULT_AUDIO_MAX_BIT_RATE = 256_000;
/** public/constants.h `kDefaultAudioSampleRate` / `kDefaultAudioChannels`. */
export const DEFAULT_AUDIO_SAMPLE_RATE = 48000;
export const DEFAULT_AUDIO_CHANNELS = 2;
/** public/constants.h `kDefaultMaxDelayMs` is 1500; public/capture_recommendations.h `kDefaultMaxDelayMs` is 400. */
export const DEFAULT_RECOMMENDED_MAX_DELAY_MS = 400;
/** public/offer_messages.h `kMinTargetPlayoutDelay` / `kMaxTargetPlayoutDelay`. */
export const MIN_TARGET_PLAYOUT_DELAY_MS = 0;
export const MAX_TARGET_PLAYOUT_DELAY_MS = 5000;

/** message_fields.h `kCastWebrtcNamespace` / `kCastRemotingNamespace`. */
export const CAST_WEBRTC_NAMESPACE = "urn:x-cast:com.google.cast.webrtc";
export const CAST_REMOTING_NAMESPACE = "urn:x-cast:com.google.cast.remoting";

/** impl/rtp_defines.h `kAllPacketsLost`, `kMaxAllowedFramePacketId`. */
export const ALL_PACKETS_LOST = 0xffff;
export const MAX_ALLOWED_FRAME_PACKET_ID = ALL_PACKETS_LOST - 1;
/** impl/rtp_defines.h `kMaxRtpPacketSizeForIpv4UdpOnEthernet` (1500 - 20 - 8) and the IPv6 one (1500 - 40 - 8). */
export const MAX_RTP_PACKET_SIZE_IPV4 = 1500 - 20 - 8;
export const MAX_RTP_PACKET_SIZE_IPV6 = 1500 - 40 - 8;
/** impl/rtp_defines.h `kRtpPacketMinValidSize`. */
export const RTP_PACKET_MIN_VALID_SIZE = 18;

/** impl/rtp_defines.h `RtpPayloadType`; `GetPayloadType` in public/sender_session.cc maps codecs onto these. */
export const RtpPayloadType = {
  audioOpus: 96,
  audioAac: 97,
  audioPcm16: 98,
  audioVarious: 99,
  videoVp8: 100,
  videoH264: 101,
  videoVarious: 102,
  videoVp9: 103,
  videoAv1: 104,
} as const;

/** public/sender_session.h `Configuration::use_android_rtp_hack` (default true) and `GetPayloadType`. */
export const ANDROID_AUDIO_PAYLOAD_TYPE = 127;
export const ANDROID_VIDEO_PAYLOAD_TYPE = 96;

/** public/sender.h `AudioCodec` / `VideoCodec`, with the strings of message_fields.cc `CodecToString`. */
export type AudioCodec = "aac" | "opus";
export type VideoCodec = "h264" | "vp8" | "hevc" | "vp9" | "av1";

/** impl/ssrc.cc `GenerateSsrc`: high priority 1..50000, others 50001..100000. */
export function generateSsrc(highPriority: boolean, random: () => number = Math.random): number {
  const lo = highPriority ? 1 : 50001;
  const hi = highPriority ? 50000 : 100000;
  return lo + Math.floor(random() * (hi - lo + 1));
}
