/**
 * The sender statistics types and their conversion to the dictionary Chrome exposes, ported from openscreen
 * `cast/streaming/public/statistics.{h,cc}` (`StatisticType`, `HistogramType`, `SimpleHistogram`, `SenderStats`,
 * `SenderStatsClient`) and Chromium `components/mirroring/service/openscreen_stats_client.cc`
 * (`OpenscreenStatsClient::ConvertSenderStatsToDict`), whose key names come from
 * `media/cast/logging/stats_event_subscriber.cc` (`CastStatToString`).
 */

/** `StatisticType`, in declaration order (the index is the position in a `StatisticsList`). */
export const StatisticType = {
  EnqueueFps: 0,
  AvgCaptureLatencyMs: 1,
  AvgEncodeTimeMs: 2,
  AvgQueueingLatencyMs: 3,
  AvgNetworkLatencyMs: 4,
  AvgPacketLatencyMs: 5,
  AvgFrameLatencyMs: 6,
  AvgEndToEndLatencyMs: 7,
  EncodeRateKbps: 8,
  PacketTransmissionRateKbps: 9,
  TimeSinceLastReceiverResponseMs: 10,
  NumFramesCaptured: 11,
  NumFramesDroppedByEncoder: 12,
  NumLateFrames: 13,
  NumPacketsSent: 14,
  NumPacketsReceived: 15,
  FirstEventTimeMs: 16,
  LastEventTimeMs: 17,
  NumPacketsRetransmitted: 18,
} as const;
export const NUM_STATISTIC_TYPES = 19;

/** `HistogramType`. */
export const HistogramType = {
  CaptureLatencyMs: 0,
  EncodeTimeMs: 1,
  QueueingLatencyMs: 2,
  NetworkLatencyMs: 3,
  PacketLatencyMs: 4,
  EndToEndLatencyMs: 5,
  FrameLatenessMs: 6,
} as const;
export const NUM_HISTOGRAM_TYPES = 7;

/**
 * `SimpleHistogram`: N + 2 buckets where N = (max - min) / width: an underflow bucket (< min), N buckets of `width`,
 * and an overflow bucket (>= max).
 */
export class SimpleHistogram {
  readonly min: number;
  readonly max: number;
  readonly width: number;
  readonly buckets: number[];

  constructor(min: number, max: number, width: number) {
    if (!((max - min) / width + 2 > 2) || (max - min) % width !== 0) throw new RangeError("invalid histogram bounds");
    this.min = min;
    this.max = max;
    this.width = width;
    this.buckets = new Array<number>((max - min) / width + 2).fill(0);
  }

  add(sample: number): void {
    if (sample < this.min) this.buckets[0]!++;
    else if (sample >= this.max) this.buckets[this.buckets.length - 1]!++;
    else this.buckets[1 + Math.trunc((sample - this.min) / this.width)]!++;
  }

  clone(): SimpleHistogram {
    const copy = new SimpleHistogram(this.min, this.max, this.width);
    copy.buckets.splice(0, copy.buckets.length, ...this.buckets);
    return copy;
  }
}

/** `SenderStats`. */
export interface SenderStats {
  audioStatistics: number[];
  audioHistograms: SimpleHistogram[];
  videoStatistics: number[];
  videoHistograms: SimpleHistogram[];
}

/** `SenderStatsClient`. */
export interface SenderStatsClient {
  onStatisticsUpdated(stats: SenderStats): void;
}

/**
 * A histogram as Chrome lists it: one single-key object per non-empty bucket, keyed "<min", "lower-upper" or ">=max"
 * (`ConvertOpenscreenHistogramToList`).
 */
export type MirroringHistogram = Record<string, number>[];
/** One stream's statistics: numbers, the string "null" for a value that is not finite, and histograms. */
export type MirroringStreamStats = Record<string, number | string | MirroringHistogram>;
/**
 * What Chromium's `OpenscreenSessionHost::GetMirroringStats` returns (a `base::DictValue`): the "audio" and "video"
 * dictionaries. Chrome documents it as a structure for logs only ("no guaranteed structure").
 */
export interface MirroringStats {
  audio?: MirroringStreamStats;
  video?: MirroringStreamStats;
}

/**
 * `StatisticTypeToCastStat` + `CastStatToString`. `kNumPacketsRetransmitted` has no case in Chromium's switch, so it
 * lands on `UNKNOWN_OPEN_SCREEN_STAT`, as it does there.
 */
const STATISTIC_KEYS: readonly string[] = [
  "ENQUEUE_FPS",
  "AVG_CAPTURE_LATENCY_MS",
  "AVG_ENCODE_TIME_MS",
  "AVG_QUEUEING_LATENCY_MS",
  "AVG_NETWORK_LATENCY_MS",
  "AVG_PACKET_LATENCY_MS",
  "AVG_FRAME_LATENCY_MS",
  "AVG_E2E_LATENCY_MS",
  "ENCODE_KBPS",
  "TRANSMISSION_KBPS",
  "MS_SINCE_LAST_RECEIVER_RESPONSE",
  "NUM_FRAMES_CAPTURED",
  "NUM_FRAMES_DROPPED_BY_ENCODER",
  "NUM_FRAMES_LATE",
  "NUM_PACKETS_SENT",
  "NUM_PACKETS_RECEIVED",
  "FIRST_EVENT_TIME_MS",
  "LAST_EVENT_TIME_MS",
  "UNKNOWN_OPEN_SCREEN_STAT",
];

/** `HistogramTypeToCastStat` + `CastStatToString`. */
const HISTOGRAM_KEYS: readonly string[] = [
  "CAPTURE_LATENCY_MS_HISTO",
  "ENCODE_TIME_MS_HISTO",
  "QUEUEING_LATENCY_MS_HISTO",
  "NETWORK_LATENCY_MS_HISTO",
  "PACKET_LATENCY_MS_HISTO",
  "E2E_LATENCY_MS_HISTO",
  "LATE_FRAME_MS_HISTO",
];

/** `ConvertOpenscreenHistogramToList`. */
export function histogramToList(histogram: SimpleHistogram): MirroringHistogram {
  const { buckets, min, max, width } = histogram;
  if (buckets.length === 0) return [];
  const list: MirroringHistogram = [];
  if (buckets[0]) list.push({ [`<${min}`]: buckets[0] });
  for (let i = 1; i < buckets.length - 1; i++) {
    if (!buckets[i]) continue;
    const lower = min + (i - 1) * width;
    list.push({ [`${lower}-${lower + width - 1}`]: buckets[i]! });
  }
  if (buckets[buckets.length - 1]) list.push({ [`>=${max}`]: buckets[buckets.length - 1]! });
  return list;
}

function streamToDict(statistics: number[], histograms: SimpleHistogram[]): MirroringStreamStats {
  const out: MirroringStreamStats = {};
  for (let i = 0; i < statistics.length; i++) out[STATISTIC_KEYS[i]!] = Number.isFinite(statistics[i]!) ? statistics[i]! : "null";
  for (let i = 0; i < histograms.length; i++) out[HISTOGRAM_KEYS[i]!] = histogramToList(histograms[i]!);
  return out;
}

/** `ConvertSenderStatsToDict`. */
export function senderStatsToDict(stats: SenderStats): MirroringStats {
  return {
    audio: streamToDict(stats.audioStatistics, stats.audioHistograms),
    video: streamToDict(stats.videoStatistics, stats.videoHistograms),
  };
}
