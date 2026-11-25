/**
 * ANSWER and the other receiver messages, ported from openscreen `cast/streaming/public/answer_messages.cc`
 * (`Answer::TryParse`, `Constraints`, `AudioConstraints`, `VideoConstraints`, `DisplayDescription`),
 * `public/resolution.cc` (`Dimensions::TryParse`) and `public/receiver_message.cc` (`ReceiverMessage::Parse`,
 * `ReceiverCapability::Parse`, `ReceiverError::Parse`).
 *
 * Parsing is strict where the C++ is: an invalid ANSWER is an error and the session fails with
 * `ANSWER_NOT_OK` (openscreen_session_host.cc `OnError`).
 */
import { DEFAULT_AUDIO_MIN_BIT_RATE, DEFAULT_VIDEO_MIN_BIT_RATE } from "./constants.ts";
import { fractionToNumber, parseFraction, type Fraction } from "./offer.ts";

export interface Dimensions {
  width: number;
  height: number;
  frameRate: Fraction;
}

export interface AudioConstraints {
  maxSampleRate: number;
  maxChannels: number;
  minBitRate: number;
  maxBitRate: number;
  maxDelayMs?: number;
}

export interface VideoConstraints {
  maxPixelsPerSecond?: number;
  minResolution?: Dimensions;
  maxDimensions: Dimensions;
  minBitRate: number;
  maxBitRate: number;
  maxDelayMs?: number;
}

export interface Constraints {
  audio: AudioConstraints;
  video: VideoConstraints;
}

export interface AspectRatio {
  width: number;
  height: number;
}

export type AspectRatioConstraint = "variable" | "fixed";

export interface DisplayDescription {
  dimensions?: Dimensions;
  aspectRatio?: AspectRatio;
  aspectRatioConstraint?: AspectRatioConstraint;
}

export interface Answer {
  udpPort: number;
  sendIndexes: number[];
  ssrcs: number[];
  constraints?: Constraints;
  display?: DisplayDescription;
  receiverRtcpEventLog: number[];
  receiverRtcpDscp: number[];
  rtpExtensions: string[][];
}

export class MessageParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageParseError";
  }
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function tryInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}

function tryIntArray(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const e of v) {
    const n = tryInt(e);
    if (n === undefined) return undefined;
    out.push(n);
  }
  return out;
}

/** Optional arrays: json_helpers.cc sets an empty array when the field is absent. */
function optionalIntArray(v: unknown): number[] {
  return tryIntArray(v) ?? [];
}

/** public/resolution.cc `Dimensions::TryParse`. */
export function parseDimensions(v: unknown): Dimensions {
  if (!isObject(v)) throw new MessageParseError("Dimensions is not a JSON object");
  const width = tryInt(v.width);
  const height = tryInt(v.height);
  if (width === undefined || height === undefined) throw new MessageParseError("Invalid dimensions");
  let frameRate: Fraction = { numerator: 0, denominator: 1 };
  if (v.frameRate !== undefined && v.frameRate !== null) {
    const f = parseFraction(v.frameRate);
    if (f === undefined) throw new MessageParseError("Invalid frame rate");
    frameRate = f;
  }
  if (!(width > 0 && height > 0 && fractionToNumber(frameRate) > 0)) throw new MessageParseError("Invalid dimensions values");
  return { width, height, frameRate };
}

/** answer_messages.cc `AudioConstraints::TryParse`. */
function parseAudioConstraints(v: unknown): AudioConstraints {
  if (!isObject(v)) throw new MessageParseError("Audio constraints is not a JSON object");
  const maxSampleRate = tryInt(v.maxSampleRate);
  const maxChannels = tryInt(v.maxChannels);
  const maxBitRate = tryInt(v.maxBitRate);
  if (maxSampleRate === undefined || maxChannels === undefined || maxBitRate === undefined) {
    throw new MessageParseError("Invalid audio constraints");
  }
  const maxDelayMs = tryInt(v.maxDelay);
  const minBitRate = tryInt(v.minBitRate) ?? DEFAULT_AUDIO_MIN_BIT_RATE;
  if (!(maxSampleRate > 0 && maxChannels > 0 && minBitRate > 0 && maxBitRate >= minBitRate)) {
    throw new MessageParseError("Invalid audio constraints");
  }
  return { maxSampleRate, maxChannels, minBitRate, maxBitRate, ...(maxDelayMs === undefined ? {} : { maxDelayMs }) };
}

/** answer_messages.cc `VideoConstraints::TryParse` and `IsValid`. */
function parseVideoConstraints(v: unknown): VideoConstraints {
  if (!isObject(v)) throw new MessageParseError("Video constraints is not a JSON object");
  const maxDimensions = parseDimensions(v.maxDimensions);
  const maxBitRate = tryInt(v.maxBitRate);
  if (maxBitRate === undefined) throw new MessageParseError("Invalid video constraints: missing maxBitRate");
  const out: VideoConstraints = { maxDimensions, maxBitRate, minBitRate: tryInt(v.minBitRate) ?? DEFAULT_VIDEO_MIN_BIT_RATE };
  if (v.minResolution !== undefined && v.minResolution !== null) out.minResolution = parseDimensions(v.minResolution);
  const maxDelayMs = tryInt(v.maxDelay);
  if (maxDelayMs !== undefined) out.maxDelayMs = maxDelayMs;
  if (typeof v.maxPixelsPerSecond === "number") out.maxPixelsPerSecond = v.maxPixelsPerSecond;
  // IsValid: max_pixels_per_second is only checked when present here (the C++ default is non-zero).
  if (
    !(
      (out.maxPixelsPerSecond === undefined || out.maxPixelsPerSecond > 0) &&
      out.minBitRate > 0 &&
      out.maxBitRate > out.minBitRate &&
      (out.maxDelayMs === undefined || out.maxDelayMs > 0)
    )
  ) {
    throw new MessageParseError("Invalid video constraints");
  }
  return out;
}

function parseConstraints(v: unknown): Constraints {
  if (!isObject(v)) throw new MessageParseError("Constraints is not a JSON object");
  return { audio: parseAudioConstraints(v.audio), video: parseVideoConstraints(v.video) };
}

/** answer_messages.cc `AspectRatio::TryParse`: "A:B". */
function parseAspectRatio(v: unknown): AspectRatio {
  if (typeof v !== "string") throw new MessageParseError("Invalid aspect ratio string");
  const fields = v.split(":");
  if (fields.length !== 2) throw new MessageParseError("Invalid aspect ratio format");
  const width = Number(fields[0]);
  const height = Number(fields[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new MessageParseError("Invalid aspect ratio");
  }
  return { width, height };
}

/** answer_messages.cc `DisplayDescription::TryParse` and `IsValid`. */
function parseDisplay(v: unknown): DisplayDescription {
  if (!isObject(v)) throw new MessageParseError("Display description is not a JSON object");
  const out: DisplayDescription = {};
  if (v.dimensions !== undefined && v.dimensions !== null) out.dimensions = parseDimensions(v.dimensions);
  if (v.aspectRatio !== undefined && v.aspectRatio !== null) out.aspectRatio = parseAspectRatio(v.aspectRatio);
  if (v.scaling === "receiver") out.aspectRatioConstraint = "variable";
  else if (v.scaling === "sender") out.aspectRatioConstraint = "fixed";
  if (out.aspectRatioConstraint === "fixed" && out.dimensions === undefined && out.aspectRatio === undefined) {
    throw new MessageParseError("Invalid display description");
  }
  if (out.aspectRatio === undefined && out.dimensions === undefined && out.aspectRatioConstraint === undefined) {
    throw new MessageParseError("Invalid display description");
  }
  return out;
}

/** answer_messages.cc `Answer::TryParse` and `Answer::IsValid`. */
export function parseAnswer(v: unknown): Answer {
  if (!isObject(v)) throw new MessageParseError("Answer is not a JSON object");
  const udpPort = tryInt(v.udpPort);
  const sendIndexes = tryIntArray(v.sendIndexes);
  const ssrcs = tryIntArray(v.ssrcs);
  if (udpPort === undefined || sendIndexes === undefined || ssrcs === undefined) {
    throw new MessageParseError("Invalid answer: missing or invalid mandatory fields");
  }
  const out: Answer = {
    udpPort,
    sendIndexes,
    ssrcs,
    receiverRtcpEventLog: optionalIntArray(v.receiverRtcpEventLog),
    receiverRtcpDscp: optionalIntArray(v.receiverRtcpDscp),
    rtpExtensions: Array.isArray(v.rtpExtensions)
      ? v.rtpExtensions.map((e) => (Array.isArray(e) ? e.filter((s): s is string => typeof s === "string") : []))
      : [],
  };
  if (v.constraints !== undefined && v.constraints !== null) out.constraints = parseConstraints(v.constraints);
  if (v.display !== undefined && v.display !== null) out.display = parseDisplay(v.display);
  if (ssrcs.length === 0 || sendIndexes.length === 0) throw new MessageParseError("Invalid answer");
  if (sendIndexes.some((i) => i < 0)) throw new MessageParseError("Invalid answer");
  if (!(udpPort >= 1 && udpPort <= 65535)) throw new MessageParseError("Invalid answer");
  return out;
}

/** receiver_message.cc `MediaCapability` names (`kMediaCapabilityNames`). */
export const MEDIA_CAPABILITIES = ["audio", "aac", "opus", "video", "4k", "h264", "vp8", "vp9", "hevc", "av1"] as const;
export type MediaCapability = (typeof MEDIA_CAPABILITIES)[number];

export interface ReceiverCapability {
  /** -1 when absent (`kRemotingVersionUnknown`). */
  remotingVersion: number;
  mediaCapabilities: MediaCapability[];
}

export interface ReceiverError {
  code: number;
  description: string;
}

export type ReceiverMessage =
  | { type: "ANSWER"; seqNum: number; valid: true; answer: Answer }
  | { type: "CAPABILITIES_RESPONSE"; seqNum: number; valid: true; capabilities: ReceiverCapability }
  | { type: "RPC" | "INPUT"; seqNum: -1; valid: true; data: Buffer }
  | { type: "ANSWER" | "CAPABILITIES_RESPONSE" | "UNKNOWN"; seqNum: number; valid: false; error?: ReceiverError };

/** receiver_message.cc `ReceiverCapability::Parse`. */
function parseCapabilities(v: unknown): ReceiverCapability {
  if (!isObject(v)) throw new MessageParseError("Empty JSON in capabilities parsing");
  const remotingVersion = tryInt(v.remoting) ?? -1;
  if (!Array.isArray(v.mediaCaps)) throw new MessageParseError("Failed to parse media capabilities");
  const mediaCapabilities: MediaCapability[] = [];
  for (const c of v.mediaCaps) {
    if (typeof c !== "string" || !(MEDIA_CAPABILITIES as readonly string[]).includes(c)) {
      throw new MessageParseError("Failed to parse media capabilities");
    }
    mediaCapabilities.push(c as MediaCapability);
  }
  return { remotingVersion, mediaCapabilities };
}

/** receiver_message.cc `ReceiverMessage::Parse`. The type is matched case-insensitively (`AsciiStrToUpper`). */
export function parseReceiverMessage(v: unknown): ReceiverMessage {
  if (!isObject(v)) throw new MessageParseError("Invalid message body");
  const rawType = typeof v.type === "string" ? v.type.toUpperCase() : "";
  const type = (["ANSWER", "CAPABILITIES_RESPONSE", "RPC", "INPUT"] as const).find((t) => t === rawType);
  const result = typeof v.result === "string" ? v.result : "error";
  const isPassthrough = type === "RPC" || type === "INPUT";
  let seqNum = -1;
  if (!isPassthrough) seqNum = tryInt(v.seqNum) ?? -1;
  const valid = (result === "ok" || isPassthrough) && (isPassthrough || seqNum >= 0);
  if (!valid) {
    let error: ReceiverError | undefined;
    if (isObject(v.error) && tryInt(v.error.code) !== undefined && typeof v.error.description === "string") {
      error = { code: v.error.code as number, description: v.error.description };
    }
    return { type: type === "ANSWER" || type === "CAPABILITIES_RESPONSE" ? type : "UNKNOWN", seqNum, valid: false, ...(error ? { error } : {}) };
  }
  switch (type) {
    case "ANSWER":
      return { type, seqNum, valid: true, answer: parseAnswer(v.answer) };
    case "CAPABILITIES_RESPONSE":
      return { type, seqNum, valid: true, capabilities: parseCapabilities(v.capabilities) };
    case "RPC":
    case "INPUT": {
      const body = type === "RPC" ? v.rpc : v.input;
      if (typeof body !== "string") return { type: "UNKNOWN", seqNum: -1, valid: false };
      return { type, seqNum: -1, valid: true, data: Buffer.from(body, "base64") };
    }
    default:
      return { type: "UNKNOWN", seqNum, valid: false };
  }
}
