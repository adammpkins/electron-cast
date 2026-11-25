/**
 * Computes the statistics Chrome reports, ported from openscreen `cast/streaming/impl/statistics_analyzer.{h,cc}`
 * (`StatisticsAnalyzer`): every 500 ms it takes the collector's frame and packet events, folds them into aggregates and
 * latency pairs, and hands a `SenderStats` to the client.
 *
 * Windows, as in openscreen: counts, bitrates and frame rates cover the whole session since the analyzer was created
 * (not a sliding window); latencies are the mean over every data point so far; a frame's or packet's capture/encode/
 * send times are remembered for the most recent 200 frames and 1000 packets, which is what joins them to the
 * receiver's events. Durations are truncated to whole milliseconds where the C++ does (`InMilliseconds`).
 */
import { createClockOffsetEstimator, type ClockOffsetEstimator } from "./clock-offset-estimator.ts";
import { SortedMap } from "./sorted-map.ts";
import { NO_TIME_MAX, NO_TIME_MIN, type FrameEvent, type PacketEvent, type StatisticsEvent, type StatisticsEventType, type StatisticsMediaType } from "./statistics-common.ts";
import { StatisticsCollector } from "./statistics-collector.ts";
import { HistogramType, NUM_HISTOGRAM_TYPES, NUM_STATISTIC_TYPES, SimpleHistogram, StatisticType, type SenderStats, type SenderStatsClient } from "./statistics.ts";

/** `kAnalysisInterval`. */
export const ANALYSIS_INTERVAL_MS = 500;
/** `kMaxRecentPacketInfoMapSize`, `kMaxRecentFrameInfoMapSize`. */
const MAX_RECENT_PACKET_INFO_MAP_SIZE = 1000;
const MAX_RECENT_FRAME_INFO_MAP_SIZE = 200;
/** `kDefaultMaxLatencyBucketMs`, `kDefaultBucketWidthMs`. */
const DEFAULT_MAX_LATENCY_BUCKET_MS = 800;
const DEFAULT_BUCKET_WIDTH_MS = 20;

type Media = "audio" | "video";

interface FrameInfo {
  captureBeginTime: number;
  captureEndTime: number;
  encodeEndTime: number;
}

interface PacketInfo {
  timestamp: number;
  type: StatisticsEventType;
}

interface SessionStats {
  firstEventTime: number;
  lastEventTime: number;
  lastResponseReceivedTime: number;
  lateFrameCounter: number;
}

interface Aggregate {
  eventCounter: number;
  sumSize: number;
}

/** `InMilliseconds`: `to_milliseconds(...).count()`, a truncation to whole milliseconds. */
const inMilliseconds = (duration: number): number => Math.trunc(duration);

/** `IsReceiverEvent`. */
function isReceiverEvent(type: StatisticsEventType): boolean {
  return type === "frameAckSent" || type === "frameDecoded" || type === "framePlayedOut" || type === "packetReceived";
}

/** Per media type state, the `AVPair` of the C++. */
interface PerMedia {
  recentFrameInfos: SortedMap<number, FrameInfo>;
  recentPacketInfos: SortedMap<[number, number], PacketInfo>;
  frameStats: Map<StatisticsEventType, Aggregate>;
  packetStats: Map<StatisticsEventType, Aggregate>;
  latencyStats: Map<number, { dataPointCounter: number; sumLatency: number }>;
  session: SessionStats;
  histograms: SimpleHistogram[];
}

function createPerMedia(): PerMedia {
  return {
    recentFrameInfos: new SortedMap<number, FrameInfo>((a, b) => a - b),
    recentPacketInfos: new SortedMap<[number, number], PacketInfo>(
      (a, b) => a[0] - b[0] || a[1] - b[1],
      (k) => `${k[0]}:${k[1]}`,
    ),
    frameStats: new Map(),
    packetStats: new Map(),
    latencyStats: new Map(),
    session: { firstEventTime: NO_TIME_MAX, lastEventTime: NO_TIME_MIN, lastResponseReceivedTime: NO_TIME_MIN, lateFrameCounter: 0 },
    histograms: Array.from({ length: NUM_HISTOGRAM_TYPES }, () => new SimpleHistogram(0, DEFAULT_MAX_LATENCY_BUCKET_MS, DEFAULT_BUCKET_WIDTH_MS)),
  };
}

export class StatisticsAnalyzer {
  readonly statisticsCollector: StatisticsCollector;
  private readonly statsClient: SenderStatsClient | undefined;
  private readonly now: () => number;
  private readonly schedule: (atMs: number, cb: () => void) => () => void;
  private readonly offsetEstimator: ClockOffsetEstimator;
  private readonly startTime: number;
  private readonly media: Record<Media, PerMedia> = { audio: createPerMedia(), video: createPerMedia() };
  private cancelAlarm: (() => void) | undefined;

  constructor(
    statsClient: SenderStatsClient | undefined,
    now: () => number,
    schedule: (atMs: number, cb: () => void) => () => void,
    offsetEstimator: ClockOffsetEstimator = createClockOffsetEstimator(),
  ) {
    this.statsClient = statsClient;
    this.now = now;
    this.schedule = schedule;
    this.offsetEstimator = offsetEstimator;
    this.startTime = now();
    this.statisticsCollector = new StatisticsCollector(now);
  }

  /** `ScheduleAnalysis`. */
  scheduleAnalysis(): void {
    this.cancelAlarm?.();
    this.cancelAlarm = this.schedule(this.now() + ANALYSIS_INTERVAL_MS, () => this.analyzeStatistics());
  }

  /** Cancels the next analysis (the destructor of the C++ analyzer, with its alarm). */
  dispose(): void {
    this.cancelAlarm?.();
    this.cancelAlarm = undefined;
  }

  /** `AnalyzeStatistics`: process what was collected, send the stats, and schedule the next round. */
  analyzeStatistics(): void {
    this.processFrameEvents(this.statisticsCollector.takeRecentFrameEvents());
    this.processPacketEvents(this.statisticsCollector.takeRecentPacketEvents());
    this.sendStatistics();
    this.scheduleAnalysis();
  }

  /** `SendStatistics`. */
  private sendStatistics(): void {
    if (this.statsClient === undefined) return;
    const endTime = this.now();
    const stats: SenderStats = {
      audioStatistics: this.constructStatisticsList(endTime, "audio"),
      audioHistograms: this.media.audio.histograms.map((h) => h.clone()),
      videoStatistics: this.constructStatisticsList(endTime, "video"),
      videoHistograms: this.media.video.histograms.map((h) => h.clone()),
    };
    this.statsClient.onStatisticsUpdated(stats);
  }

  private processFrameEvents(events: FrameEvent[]): void {
    for (const event of events) {
      const media = this.mediaOf(event.mediaType);
      if (media === undefined) continue;
      this.offsetEstimator.onFrameEvent(event);
      const aggregate = media.frameStats.get(event.type);
      if (aggregate === undefined) media.frameStats.set(event.type, { eventCounter: 1, sumSize: event.size });
      else {
        aggregate.eventCounter++;
        aggregate.sumSize += event.size;
      }
      this.recordEventTimes(event);
      this.recordFrameLatencies(event);
    }
  }

  private processPacketEvents(events: PacketEvent[]): void {
    for (const event of events) {
      const media = this.mediaOf(event.mediaType);
      if (media === undefined) continue;
      this.offsetEstimator.onPacketEvent(event);
      const aggregate = media.packetStats.get(event.type);
      if (aggregate === undefined) media.packetStats.set(event.type, { eventCounter: 1, sumSize: event.size });
      else {
        aggregate.eventCounter++;
        aggregate.sumSize += event.size;
      }
      this.recordEventTimes(event);
      if (event.type === "packetSentToNetwork" || event.type === "packetReceived") this.recordPacketLatencies(event);
      // Network latency is measured only for packets that are not retransmitted.
      else if (event.type === "packetRetransmitted") media.recentPacketInfos.delete([event.rtpTimestamp, event.packetId]);
    }
  }

  private mediaOf(type: StatisticsMediaType): PerMedia | undefined {
    return type === "audio" || type === "video" ? this.media[type] : undefined;
  }

  /** `RecordFrameLatencies`. */
  private recordFrameLatencies(event: FrameEvent): void {
    const media = this.media[event.mediaType as Media];
    const infos = media.recentFrameInfos;
    // An event older than everything in a full map is too old to matter.
    const full = infos.size === MAX_RECENT_FRAME_INFO_MAP_SIZE;
    if (full && event.rtpTimestamp <= infos.firstKey()!) return;
    let info = infos.get(event.rtpTimestamp);
    if (info === undefined) {
      if (full) infos.deleteFirst();
      info = { captureBeginTime: NO_TIME_MIN, captureEndTime: NO_TIME_MIN, encodeEndTime: NO_TIME_MIN };
      infos.set(event.rtpTimestamp, info);
    }

    switch (event.type) {
      case "frameCaptureBegin":
        info.captureBeginTime = event.timestamp;
        break;
      case "frameCaptureEnd":
        info.captureEndTime = event.timestamp;
        if (info.captureBeginTime !== NO_TIME_MIN) {
          const latency = event.timestamp - info.captureBeginTime;
          this.addToLatencyAggregate(StatisticType.AvgCaptureLatencyMs, latency, event.mediaType);
          this.addToHistogram(HistogramType.CaptureLatencyMs, event.mediaType, inMilliseconds(latency));
        }
        break;
      case "frameEncoded":
        info.encodeEndTime = event.timestamp;
        if (info.captureEndTime !== NO_TIME_MIN) {
          const latency = event.timestamp - info.captureEndTime;
          this.addToLatencyAggregate(StatisticType.AvgEncodeTimeMs, latency, event.mediaType);
          this.addToHistogram(HistogramType.EncodeTimeMs, event.mediaType, inMilliseconds(latency));
        }
        break;
      // Frame latency: from the frame being encoded until the receiver's ack for it was sent.
      case "frameAckSent": {
        const adjusted = this.toSenderTimestamp(event.timestamp);
        if (adjusted === undefined) return;
        if (info.encodeEndTime !== NO_TIME_MIN) {
          this.addToLatencyAggregate(StatisticType.AvgFrameLatencyMs, adjusted - info.encodeEndTime, event.mediaType);
        }
        break;
      }
      case "framePlayedOut": {
        const adjusted = this.toSenderTimestamp(event.timestamp);
        if (adjusted === undefined) return;
        if (info.captureBeginTime !== NO_TIME_MIN) {
          const e2e = adjusted - info.captureBeginTime;
          this.addToLatencyAggregate(StatisticType.AvgEndToEndLatencyMs, e2e, event.mediaType);
          this.addToHistogram(HistogramType.EndToEndLatencyMs, event.mediaType, inMilliseconds(e2e));
        }
        // A positive delay means the frame was late.
        if (event.delayDelta > 0) {
          media.session.lateFrameCounter++;
          this.addToHistogram(HistogramType.FrameLatenessMs, event.mediaType, inMilliseconds(event.delayDelta));
        }
        break;
      }
      default:
        break;
    }
  }

  /** `RecordPacketLatencies`. */
  private recordPacketLatencies(event: PacketEvent): void {
    const media = this.media[event.mediaType as Media];
    const frameInfos = media.recentFrameInfos;

    // Queueing latency: from the frame being encoded until its packet is first sent.
    if (event.type === "packetSentToNetwork") {
      const frameInfo = frameInfos.get(event.rtpTimestamp);
      if (frameInfo !== undefined) {
        const queueing = event.timestamp - frameInfo.encodeEndTime;
        this.addToLatencyAggregate(StatisticType.AvgQueueingLatencyMs, queueing, event.mediaType);
        this.addToHistogram(HistogramType.QueueingLatencyMs, event.mediaType, inMilliseconds(queueing));
      }
    }

    const key: [number, number] = [event.rtpTimestamp, event.packetId];
    const packetInfos = media.recentPacketInfos;
    const recorded = packetInfos.get(key);
    if (recorded === undefined) {
      packetInfos.set(key, { timestamp: event.timestamp, type: event.type });
      if (packetInfos.size > MAX_RECENT_PACKET_INFO_MAP_SIZE) packetInfos.deleteFirst();
      return;
    }

    // The packet's send and receive are both known now.
    let sentTime: number;
    let receivedTime: number;
    if (recorded.type === "packetSentToNetwork" && event.type === "packetReceived") {
      sentTime = recorded.timestamp;
      receivedTime = event.timestamp;
    } else if (recorded.type === "packetReceived" && event.type === "packetSentToNetwork") {
      sentTime = event.timestamp;
      receivedTime = recorded.timestamp;
    } else {
      return;
    }
    packetInfos.delete(key);

    // The offset estimator is used directly: the point is the network latency.
    const offset = this.offsetEstimator.getEstimatedOffset();
    if (offset === undefined) return;
    receivedTime -= offset;

    const latency = receivedTime - sentTime;
    this.addToLatencyAggregate(StatisticType.AvgNetworkLatencyMs, latency, event.mediaType);
    this.addToHistogram(HistogramType.NetworkLatencyMs, event.mediaType, inMilliseconds(latency));

    // Packet latency: from the frame being encoded until the packet is received.
    const frameInfo = frameInfos.get(event.rtpTimestamp);
    if (frameInfo !== undefined) {
      const packetLatency = receivedTime - frameInfo.encodeEndTime;
      this.addToLatencyAggregate(StatisticType.AvgPacketLatencyMs, packetLatency, event.mediaType);
      this.addToHistogram(HistogramType.PacketLatencyMs, event.mediaType, inMilliseconds(packetLatency));
    }
  }

  /** `RecordEventTimes`. */
  private recordEventTimes(event: StatisticsEvent): void {
    const session = this.media[event.mediaType as Media].session;
    let senderTimestamp = event.timestamp;
    if (isReceiverEvent(event.type)) {
      const latency = this.offsetEstimator.getEstimatedLatency();
      if (latency !== undefined) {
        const estimatedSentTime = event.receivedTimestamp - latency;
        session.lastResponseReceivedTime = Math.max(session.lastResponseReceivedTime, estimatedSentTime);
      }
      const adjusted = this.toSenderTimestamp(event.timestamp);
      if (adjusted === undefined) return;
      senderTimestamp = adjusted;
    }
    session.firstEventTime = Math.min(session.firstEventTime, senderTimestamp);
    session.lastEventTime = Math.max(session.lastEventTime, senderTimestamp);
  }

  private addToLatencyAggregate(stat: number, latency: number, mediaType: StatisticsMediaType): void {
    const map = this.media[mediaType as Media].latencyStats;
    const aggregate = map.get(stat);
    if (aggregate === undefined) map.set(stat, { dataPointCounter: 1, sumLatency: latency });
    else {
      aggregate.dataPointCounter++;
      aggregate.sumLatency += latency;
    }
  }

  private addToHistogram(histogram: number, mediaType: StatisticsMediaType, sample: number): void {
    this.media[mediaType as Media].histograms[histogram]!.add(sample);
  }

  /** `ConstructStatisticsList`. */
  private constructStatisticsList(endTime: number, mediaType: Media): number[] {
    const list = new Array<number>(NUM_STATISTIC_TYPES).fill(0);
    const media = this.media[mediaType];
    const duration = endTime - this.startTime;

    this.populateCount(media.frameStats, "frameDroppedByEncoder", StatisticType.NumFramesDroppedByEncoder, list);
    this.populateCount(media.frameStats, "frameCaptureEnd", StatisticType.NumFramesCaptured, list);

    // kEnqueueFps. A duration under a millisecond divides by zero and comes out as the string "null".
    const encoded = media.frameStats.get("frameEncoded");
    if (encoded !== undefined) list[StatisticType.EnqueueFps] = (encoded.eventCounter / inMilliseconds(duration)) * 1000;

    for (const stat of [
      StatisticType.AvgEncodeTimeMs,
      StatisticType.AvgCaptureLatencyMs,
      StatisticType.AvgQueueingLatencyMs,
      StatisticType.AvgNetworkLatencyMs,
      StatisticType.AvgPacketLatencyMs,
      StatisticType.AvgFrameLatencyMs,
      StatisticType.AvgEndToEndLatencyMs,
    ]) {
      const aggregate = media.latencyStats.get(stat);
      if (aggregate !== undefined && aggregate.dataPointCounter > 0) list[stat] = inMilliseconds(aggregate.sumLatency) / aggregate.dataPointCounter;
    }

    // kEncodeRateKbps
    if (encoded !== undefined) list[StatisticType.EncodeRateKbps] = (encoded.sumSize / inMilliseconds(duration)) * 8;
    // kPacketTransmissionRateKbps
    const sent = media.packetStats.get("packetSentToNetwork");
    if (sent !== undefined) list[StatisticType.PacketTransmissionRateKbps] = (sent.sumSize / inMilliseconds(duration)) * 8;

    this.populateCount(media.packetStats, "packetSentToNetwork", StatisticType.NumPacketsSent, list);
    this.populateCount(media.packetStats, "packetReceived", StatisticType.NumPacketsReceived, list);
    this.populateCount(media.packetStats, "packetRetransmitted", StatisticType.NumPacketsRetransmitted, list);

    // kFirstEventTimeMs, kLastEventTimeMs, kTimeSinceLastReceiverResponseMs, kNumLateFrames
    const session = media.session;
    if (session.firstEventTime !== NO_TIME_MAX) list[StatisticType.FirstEventTimeMs] = inMilliseconds(session.firstEventTime);
    if (session.lastEventTime !== NO_TIME_MIN) list[StatisticType.LastEventTimeMs] = inMilliseconds(session.lastEventTime);
    if (session.lastResponseReceivedTime !== NO_TIME_MIN) {
      list[StatisticType.TimeSinceLastReceiverResponseMs] = inMilliseconds(endTime - session.lastResponseReceivedTime);
    }
    list[StatisticType.NumLateFrames] = session.lateFrameCounter;
    return list;
  }

  private populateCount(map: Map<StatisticsEventType, Aggregate>, event: StatisticsEventType, stat: number, list: number[]): void {
    const aggregate = map.get(event);
    if (aggregate !== undefined) list[stat] = aggregate.eventCounter;
  }

  /** `ToSenderTimestamp`: a receiver timestamp on the sender's clock, once the offset is known. */
  private toSenderTimestamp(receiverTimestamp: number): number | undefined {
    const offset = this.offsetEstimator.getEstimatedOffset();
    return offset === undefined ? undefined : receiverTimestamp - offset;
  }
}
