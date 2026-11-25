/**
 * OFFER message, ported from openscreen `cast/streaming/public/offer_messages.cc` (`Stream::ToJson`,
 * `AudioStream::ToJson`, `VideoStream::ToJson`, `Offer::ToJson`) and `public/sender_session.cc` (`CreateStream`,
 * `GetPayloadType`, `CreateStreamList`). Field order follows the C++ so the JSON reads the same on the wire.
 */
import { randomBytes } from "node:crypto";
import {
  ANDROID_AUDIO_PAYLOAD_TYPE,
  ANDROID_VIDEO_PAYLOAD_TYPE,
  DEFAULT_AUDIO_MIN_BIT_RATE,
  DEFAULT_VIDEO_MAX_BIT_RATE,
  DEFAULT_VIDEO_MIN_BIT_RATE,
  RTP_VIDEO_TIMEBASE,
  RtpPayloadType,
  generateSsrc,
  type AudioCodec,
  type VideoCodec,
} from "./constants.ts";

/** public/resolution.h `Resolution`. */
export interface Resolution {
  width: number;
  height: number;
}

/** util/simple_fraction.h `SimpleFraction`. */
export interface Fraction {
  numerator: number;
  denominator: number;
}

/** util/simple_fraction.cc `SimpleFraction::ToString`: "n/d". */
export function fractionToString(f: Fraction): string {
  return `${f.numerator}/${f.denominator}`;
}

/** util/json/json_helpers.cc `TryParseSimpleFraction`: "n/d" or a plain integer. */
export function parseFraction(value: unknown): Fraction | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return { numerator: value, denominator: 1 };
  if (typeof value !== "string") return undefined;
  const m = /^\s*(-?\d+)\s*(?:\/\s*(-?\d+))?\s*$/.exec(value);
  if (m === null) return undefined;
  const denominator = m[2] === undefined ? 1 : Number(m[2]);
  if (denominator === 0) return undefined;
  return { numerator: Number(m[1]), denominator };
}

export function fractionToNumber(f: Fraction): number {
  return f.numerator / f.denominator;
}

/** public/sender_session.h `AudioCaptureConfig`. */
export interface AudioCaptureConfig {
  codec: AudioCodec;
  channels: number;
  bitRate: number;
  sampleRate: number;
  targetPlayoutDelayMs: number;
  codecParameter?: string;
}

/** public/sender_session.h `VideoCaptureConfig`. */
export interface VideoCaptureConfig {
  codec: VideoCodec;
  maxFrameRate: Fraction;
  maxBitRate: number;
  resolutions: Resolution[];
  targetPlayoutDelayMs: number;
  codecParameter?: string;
}

/** offer_messages.h `Stream`, the fields every stream shares. */
export interface Stream {
  index: number;
  type: "audio_source" | "video_source";
  channels: number;
  rtpPayloadType: number;
  ssrc: number;
  targetDelayMs: number;
  aesKey: Buffer;
  aesIvMask: Buffer;
  receiverRtcpEventLog: boolean;
  receiverRtcpDscp?: number;
  rtpTimebase: number;
  codecParameter: string;
  rtpExtensions: string[];
}

export interface AudioStream {
  stream: Stream;
  codec: AudioCodec;
  bitRate: number;
}

export interface VideoStream {
  stream: Stream;
  codec: VideoCodec;
  maxFrameRate: Fraction;
  maxBitRate: number;
  protection: string;
  profile: string;
  level: string;
  resolutions: Resolution[];
  errorRecoveryMode: string;
}

export interface Offer {
  castMode: "mirroring" | "remoting";
  audioStreams: AudioStream[];
  videoStreams: VideoStream[];
}

/** sender_session.cc `GetPayloadType(AudioCodec, bool use_android_rtp_hack)`. */
export function audioPayloadType(codec: AudioCodec, useAndroidRtpHack: boolean): number {
  if (useAndroidRtpHack) return ANDROID_AUDIO_PAYLOAD_TYPE;
  return codec === "opus" ? RtpPayloadType.audioOpus : RtpPayloadType.audioAac;
}

/**
 * sender_session.cc `GetPayloadType(VideoCodec, bool)`. VP9 shares VP8's type and HEVC shares H264's, as the C++ does;
 * AV1 has its own.
 */
export function videoPayloadType(codec: VideoCodec, useAndroidRtpHack: boolean): number {
  if (useAndroidRtpHack) return ANDROID_VIDEO_PAYLOAD_TYPE;
  switch (codec) {
    case "vp8":
    case "vp9":
      return RtpPayloadType.videoVp8;
    case "h264":
    case "hevc":
      return RtpPayloadType.videoH264;
    case "av1":
      return RtpPayloadType.videoAv1;
  }
}

export interface CreateStreamOptions {
  /** `Configuration::use_android_rtp_hack`, default true (public/sender_session.h). */
  useAndroidRtpHack?: boolean;
  /** `ToWire(dscp_mode)`; only set when the session enables DSCP (off by default). */
  dscp?: number;
  /** Adds the `input_events` extension (message_constants.h `kInputEventsRtpExtension`). */
  supportsInputEvents?: boolean;
  random?: (n: number) => Buffer;
  randomUnit?: () => number;
}

/** sender_session.cc `CreateStream(int, const AudioCaptureConfig&, ...)`. */
export function createAudioStream(index: number, config: AudioCaptureConfig, opts: CreateStreamOptions = {}): AudioStream {
  const rand = opts.random ?? randomBytes;
  return {
    stream: {
      index,
      type: "audio_source",
      channels: config.channels,
      rtpPayloadType: audioPayloadType(config.codec, opts.useAndroidRtpHack ?? true),
      ssrc: generateSsrc(true, opts.randomUnit),
      targetDelayMs: config.targetPlayoutDelayMs,
      aesKey: rand(16),
      aesIvMask: rand(16),
      receiverRtcpEventLog: true,
      ...(opts.dscp === undefined ? {} : { receiverRtcpDscp: opts.dscp }),
      rtpTimebase: config.sampleRate,
      codecParameter: config.codecParameter ?? "",
      rtpExtensions: [],
    },
    codec: config.codec,
    bitRate: Math.max(config.bitRate, DEFAULT_AUDIO_MIN_BIT_RATE),
  };
}

/** sender_session.cc `CreateStream(int, const VideoCaptureConfig&, ...)`. */
export function createVideoStream(index: number, config: VideoCaptureConfig, opts: CreateStreamOptions = {}): VideoStream {
  const rand = opts.random ?? randomBytes;
  return {
    stream: {
      index,
      type: "video_source",
      channels: 1,
      rtpPayloadType: videoPayloadType(config.codec, opts.useAndroidRtpHack ?? true),
      ssrc: generateSsrc(false, opts.randomUnit),
      targetDelayMs: config.targetPlayoutDelayMs,
      aesKey: rand(16),
      aesIvMask: rand(16),
      receiverRtcpEventLog: true,
      ...(opts.dscp === undefined ? {} : { receiverRtcpDscp: opts.dscp }),
      rtpTimebase: RTP_VIDEO_TIMEBASE,
      codecParameter: config.codecParameter ?? "",
      rtpExtensions: opts.supportsInputEvents === true ? ["input_events"] : [],
    },
    codec: config.codec,
    maxFrameRate: config.maxFrameRate,
    maxBitRate: config.maxBitRate >= DEFAULT_VIDEO_MIN_BIT_RATE ? config.maxBitRate : DEFAULT_VIDEO_MAX_BIT_RATE,
    protection: "",
    profile: "",
    level: "",
    resolutions: config.resolutions,
    errorRecoveryMode: "",
  };
}

/** offer_messages.cc `Stream::ToJson`. */
export function streamToJson(s: Stream): Record<string, unknown> {
  const out: Record<string, unknown> = {
    index: s.index,
    type: s.type,
    channels: s.channels,
    rtpPayloadType: s.rtpPayloadType,
    rtpProfile: "cast",
    ssrc: s.ssrc,
    targetDelay: s.targetDelayMs,
    aesKey: s.aesKey.toString("hex"),
    aesIvMask: s.aesIvMask.toString("hex"),
    receiverRtcpEventLog: s.receiverRtcpEventLog,
  };
  if (s.receiverRtcpDscp !== undefined) out.receiverRtcpDscp = s.receiverRtcpDscp;
  out.timeBase = `1/${s.rtpTimebase}`;
  out.codecParameter = s.codecParameter;
  if (s.rtpExtensions.length > 0) out.rtpExtensions = s.rtpExtensions;
  return out;
}

/** offer_messages.cc `AudioStream::ToJson`. */
export function audioStreamToJson(s: AudioStream): Record<string, unknown> {
  return { ...streamToJson(s.stream), codecName: s.codec, bitRate: s.bitRate };
}

/** offer_messages.cc `VideoStream::ToJson`. */
export function videoStreamToJson(s: VideoStream): Record<string, unknown> {
  return {
    ...streamToJson(s.stream),
    codecName: s.codec,
    maxFrameRate: fractionToString(s.maxFrameRate),
    maxBitRate: s.maxBitRate,
    protection: s.protection,
    profile: s.profile,
    level: s.level,
    errorRecoveryMode: s.errorRecoveryMode,
    resolutions: s.resolutions.map((r) => ({ width: r.width, height: r.height })),
  };
}

/** offer_messages.cc `Offer::ToJson`: audio streams first, then video. */
export function offerToJson(offer: Offer): Record<string, unknown> {
  return {
    castMode: offer.castMode,
    supportedStreams: [...offer.audioStreams.map(audioStreamToJson), ...offer.videoStreams.map(videoStreamToJson)],
  };
}

/** sender_message.cc `SenderMessage::ToJson` for OFFER: `{type, seqNum, offer}`. */
export function offerMessage(seqNum: number, offer: Offer): Record<string, unknown> {
  return { type: "OFFER", seqNum, offer: offerToJson(offer) };
}

/** sender_message.cc `SenderMessage::ToJson` for GET_CAPABILITIES. */
export function getCapabilitiesMessage(seqNum: number): Record<string, unknown> {
  return { type: "GET_CAPABILITIES", seqNum };
}

/**
 * Chromium `mirroring_activity.cc` `GetScrubbedLogMessage`: the copy of a message that may be logged; the key and IV
 * mask of every offered stream become "[REDACTED]".
 */
export function scrubOffer(message: Record<string, unknown>): Record<string, unknown> {
  const offer = message.offer as { supportedStreams?: Record<string, unknown>[] } | undefined;
  if (offer?.supportedStreams === undefined) return message;
  return {
    ...message,
    offer: {
      ...offer,
      supportedStreams: offer.supportedStreams.map((s) => ({ ...s, aesKey: "[REDACTED]", aesIvMask: "[REDACTED]" })),
    },
  };
}
