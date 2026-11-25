/**
 * Capture recommendations, ported from openscreen `cast/streaming/public/capture_recommendations.cc`
 * (`GetRecommendations`, `ApplyDisplay`, `ApplyConstraints`, `ClampVideoToWellOrderedRanges`) and the defaults of
 * `capture_recommendations.h`.
 */
import {
  DEFAULT_AUDIO_CHANNELS,
  DEFAULT_AUDIO_MAX_BIT_RATE,
  DEFAULT_AUDIO_MIN_BIT_RATE,
  DEFAULT_AUDIO_SAMPLE_RATE,
  DEFAULT_FRAME_RATE,
  DEFAULT_RECOMMENDED_MAX_DELAY_MS,
  DEFAULT_VIDEO_MIN_BIT_RATE,
  MIN_VIDEO_HEIGHT,
  MIN_VIDEO_WIDTH,
} from "./constants.ts";
import type { Answer, Dimensions } from "./answer.ts";
import { fractionToNumber, type Resolution } from "./offer.ts";

export interface BitRateLimits {
  minimum: number;
  maximum: number;
}

export interface AudioRecommendations {
  bitRateLimits: BitRateLimits;
  maxDelayMs: number;
  maxChannels: number;
  maxSampleRate: number;
}

export interface VideoRecommendations {
  bitRateLimits: BitRateLimits;
  minimum: Resolution;
  maximum: Dimensions;
  supportsScaling: boolean;
  maxDelayMs: number;
  maxPixelsPerSecond: number;
}

export interface Recommendations {
  audio: AudioRecommendations;
  video: VideoRecommendations;
}

/** resolution.h `Dimensions::effective_bit_rate`: width * height * frame rate (truncated to int). */
function effectiveBitRate(d: Dimensions): number {
  return Math.trunc(d.width * d.height * fractionToNumber(d.frameRate));
}

/** capture_recommendations.h defaults (`kDefaultMaxResolution`, `kDefaultVideoBitRateLimits`, ...). */
export function defaultRecommendations(): Recommendations {
  const maximum: Dimensions = { width: 1920, height: 1080, frameRate: { numerator: DEFAULT_FRAME_RATE, denominator: 1 } };
  return {
    audio: {
      bitRateLimits: { minimum: DEFAULT_AUDIO_MIN_BIT_RATE, maximum: DEFAULT_AUDIO_MAX_BIT_RATE },
      maxDelayMs: DEFAULT_RECOMMENDED_MAX_DELAY_MS,
      maxChannels: DEFAULT_AUDIO_CHANNELS,
      maxSampleRate: DEFAULT_AUDIO_SAMPLE_RATE,
    },
    video: {
      bitRateLimits: { minimum: DEFAULT_VIDEO_MIN_BIT_RATE, maximum: effectiveBitRate(maximum) },
      minimum: { width: MIN_VIDEO_WIDTH, height: MIN_VIDEO_HEIGHT },
      maximum,
      supportsScaling: false,
      maxDelayMs: DEFAULT_RECOMMENDED_MAX_DELAY_MS,
      maxPixelsPerSecond: Math.trunc(effectiveBitRate(maximum) / 8),
    },
  };
}

/** capture_recommendations.cc `GetRecommendations(const Answer&)`. */
export function getRecommendations(answer: Answer): Recommendations {
  const r = defaultRecommendations();

  // ApplyDisplay
  const display = answer.display;
  if (display !== undefined) {
    r.video.supportsScaling = display.aspectRatioConstraint === "variable";
    if (display.dimensions !== undefined) {
      r.video.maximum = { ...display.dimensions };
      r.video.bitRateLimits.maximum = effectiveBitRate(r.video.maximum);
      if (r.video.maximum.width < r.video.minimum.width) {
        r.video.minimum = { width: r.video.maximum.width, height: r.video.maximum.height };
      }
    }
    let aspectRatio = 0;
    let haveAspect = true;
    if (display.aspectRatio !== undefined) {
      aspectRatio = display.aspectRatio.width / display.aspectRatio.height;
      r.video.maximum.width = Math.trunc(r.video.maximum.height * aspectRatio);
    } else if (display.dimensions !== undefined) {
      aspectRatio = display.dimensions.width / display.dimensions.height;
    } else {
      haveAspect = false;
    }
    if (haveAspect) r.video.minimum.width = Math.trunc(r.video.minimum.height * aspectRatio);
  }

  // ApplyConstraints
  const c = answer.constraints;
  if (c !== undefined) {
    if (c.audio.maxDelayMs !== undefined) r.audio.maxDelayMs = c.audio.maxDelayMs;
    r.audio.maxChannels = c.audio.maxChannels;
    r.audio.maxSampleRate = c.audio.maxSampleRate;
    r.audio.bitRateLimits = {
      minimum: Math.max(c.audio.minBitRate, DEFAULT_AUDIO_MIN_BIT_RATE),
      maximum: Math.max(c.audio.maxBitRate, DEFAULT_AUDIO_MIN_BIT_RATE),
    };

    if (c.video.maxDelayMs !== undefined) r.video.maxDelayMs = c.video.maxDelayMs;
    if (c.video.maxPixelsPerSecond !== undefined) r.video.maxPixelsPerSecond = c.video.maxPixelsPerSecond;
    r.video.bitRateLimits = {
      minimum: Math.max(c.video.minBitRate, r.video.bitRateLimits.minimum),
      maximum: Math.min(c.video.maxBitRate, r.video.bitRateLimits.maximum),
    };
    const dimensions = c.video.maxDimensions;
    if (dimensions.width <= MIN_VIDEO_WIDTH) {
      r.video.maximum = { width: MIN_VIDEO_WIDTH, height: MIN_VIDEO_HEIGHT, frameRate: { numerator: DEFAULT_FRAME_RATE, denominator: 1 } };
    } else if (dimensions.width < r.video.maximum.width) {
      r.video.maximum = dimensions;
    }
    if (c.video.minResolution !== undefined) {
      if (MIN_VIDEO_WIDTH < c.video.minResolution.width) {
        r.video.minimum = { width: c.video.minResolution.width, height: c.video.minResolution.height };
      }
    }
  }

  // ClampVideoToWellOrderedRanges
  r.video.bitRateLimits.minimum = Math.min(r.video.bitRateLimits.minimum, r.video.bitRateLimits.maximum);
  r.video.minimum.width = Math.min(r.video.minimum.width, r.video.maximum.width);
  r.video.minimum.height = Math.min(r.video.minimum.height, r.video.maximum.height);
  return r;
}
