import { test } from "node:test";
import assert from "node:assert/strict";
import { StatisticsAnalyzer, ANALYSIS_INTERVAL_MS } from "../../src/mirroring/stats/statistics-analyzer.ts";
import { StatisticsCollector } from "../../src/mirroring/stats/statistics-collector.ts";
import { OpenscreenStatsClient } from "../../src/mirroring/stats/openscreen-stats-client.ts";
import { StatisticsDispatcher } from "../../src/mirroring/stats/statistics-dispatcher.ts";
import { createClockOffsetEstimator } from "../../src/mirroring/stats/clock-offset-estimator.ts";
import { expandRtpTimestamp, NO_TIME_MIN, type FrameEvent, type PacketEvent, type StatisticsEventType } from "../../src/mirroring/stats/statistics-common.ts";
import { histogramToList, senderStatsToDict, SimpleHistogram, NUM_HISTOGRAM_TYPES, NUM_STATISTIC_TYPES } from "../../src/mirroring/stats/statistics.ts";
import { NtpTimeConverter } from "../../src/mirroring/rtcp/ntp.ts";
import { CompoundRtcpParser, type CompoundRtcpClient } from "../../src/mirroring/rtcp/parser.ts";
import type { RtcpReceiverFrameLogMessage } from "../../src/mirroring/stats/statistics-common.ts";
import { buildReceiverRtcp } from "./receiver-wire.ts";
import { FakeEnvironment } from "./fake-clock.ts";

// Expected numbers are worked out by hand from openscreen cast/streaming/impl/statistics_analyzer.cc (revision aec59dd1).

const frameEvent = (type: StatisticsEventType, mediaType: "audio" | "video", rtp: number, timestamp: number, extra: Partial<FrameEvent> = {}): FrameEvent => ({
  frameId: -1,
  type,
  mediaType,
  rtpTimestamp: rtp,
  size: 0,
  timestamp,
  receivedTimestamp: NO_TIME_MIN,
  delayDelta: 0,
  keyFrame: false,
  ...extra,
});

const packetEvent = (type: StatisticsEventType, rtp: number, timestamp: number, extra: Partial<PacketEvent> = {}): PacketEvent => ({
  frameId: -1,
  type,
  mediaType: "video",
  rtpTimestamp: rtp,
  size: 0,
  timestamp,
  receivedTimestamp: NO_TIME_MIN,
  packetId: 0,
  maxPacketId: 0,
  ...extra,
});

function analyzerSetup(startMs: number) {
  let now = startMs;
  const client = new OpenscreenStatsClient();
  const scheduled: { at: number; cb: () => void }[] = [];
  const analyzer = new StatisticsAnalyzer(client, () => now, (at, cb) => {
    const entry = { at, cb };
    scheduled.push(entry);
    return () => void scheduled.splice(scheduled.indexOf(entry), 1);
  });
  return { analyzer, client, scheduled, setNow: (t: number) => void (now = t), collector: analyzer.statisticsCollector };
}

/**
 * One video frame with the receiver clock 1000 ms ahead of the sender's and 10 ms of network latency each way:
 * captured at `t`, encoded `t+15` (1000 bytes), its one packet (1200 bytes) sent `t+20`, received at `t+30` and the
 * ack sent at `t+40` (receiver clock `+1000`), the ack received `t+50`, played out `t+100`.
 */
function addFrame(c: StatisticsCollector, rtp: number, t: number, playoutDelta: number): void {
  c.collectFrameEvent(frameEvent("frameCaptureBegin", "video", rtp, t));
  c.collectFrameEvent(frameEvent("frameCaptureEnd", "video", rtp, t + 5));
  c.collectFrameEvent(frameEvent("frameEncoded", "video", rtp, t + 15, { size: 1000, frameId: 1 }));
  c.collectFrameEvent(frameEvent("frameAckSent", "video", rtp, t + 1040, { receivedTimestamp: t + 50 }));
  c.collectFrameEvent(frameEvent("frameAckReceived", "video", rtp, t + 50));
  c.collectFrameEvent(frameEvent("frameDecoded", "video", rtp, t + 1045, { receivedTimestamp: t + 50 }));
  c.collectFrameEvent(frameEvent("framePlayedOut", "video", rtp, t + 1100, { receivedTimestamp: t + 50, delayDelta: playoutDelta }));
  c.collectPacketEvent(packetEvent("packetSentToNetwork", rtp, t + 20, { size: 1200 }));
  c.collectPacketEvent(packetEvent("packetReceived", rtp, t + 1030, { receivedTimestamp: t + 50 }));
}

test("the analyzer computes Chrome's statistics from known frame and packet events", () => {
  const { analyzer, client, scheduled, setNow, collector } = analyzerSetup(10_000);
  analyzer.scheduleAnalysis();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.at, 10_000 + ANALYSIS_INTERVAL_MS);

  // The first frame lets the estimator learn the clock offset (1000 ms) and latency (10 ms); the second is fully measured.
  addFrame(collector, 1000, 10_100, 0);
  setNow(10_500);
  analyzer.analyzeStatistics();
  addFrame(collector, 2000, 10_600, 30);
  collector.collectFrameEvent(frameEvent("frameDroppedByEncoder", "video", 3000, 10_700));
  collector.collectPacketEvent(packetEvent("packetRetransmitted", 2000, 10_650, { size: 1200 }));
  setNow(11_000);
  analyzer.analyzeStatistics();

  const video = client.getStats().video!;
  assert.equal(video.NUM_FRAMES_CAPTURED, 2);
  assert.equal(video.NUM_FRAMES_DROPPED_BY_ENCODER, 1);
  assert.equal(video.NUM_PACKETS_SENT, 2);
  assert.equal(video.NUM_PACKETS_RECEIVED, 2);
  // kNumPacketsRetransmitted has no Chromium key and shows up as UNKNOWN_OPEN_SCREEN_STAT.
  assert.equal(video.UNKNOWN_OPEN_SCREEN_STAT, 1);
  // 2 frames over the 1000 ms since the analyzer started.
  assert.equal(video.ENQUEUE_FPS, 2);
  assert.equal(video.ENCODE_KBPS, 16);
  assert.equal(video.TRANSMISSION_KBPS, 19.2);
  assert.equal(video.AVG_CAPTURE_LATENCY_MS, 5);
  assert.equal(video.AVG_ENCODE_TIME_MS, 10);
  assert.equal(video.AVG_QUEUEING_LATENCY_MS, 5);
  assert.equal(video.AVG_NETWORK_LATENCY_MS, 10);
  assert.equal(video.AVG_PACKET_LATENCY_MS, 15);
  // Only the second frame's receiver events could be placed on the sender clock.
  assert.equal(video.AVG_FRAME_LATENCY_MS, 25);
  assert.equal(video.AVG_E2E_LATENCY_MS, 100);
  assert.equal(video.NUM_FRAMES_LATE, 1);
  assert.equal(video.FIRST_EVENT_TIME_MS, 10_100);
  assert.equal(video.LAST_EVENT_TIME_MS, 10_700);
  // The last response was sent 10 ms before the sender learnt of it (10_650 - 10 ms latency): 11_000 - 10_640.
  assert.equal(video.MS_SINCE_LAST_RECEIVER_RESPONSE, 360);
  assert.deepEqual(video.CAPTURE_LATENCY_MS_HISTO, [{ "0-19": 2 }]);
  assert.deepEqual(video.ENCODE_TIME_MS_HISTO, [{ "0-19": 2 }]);
  assert.deepEqual(video.QUEUEING_LATENCY_MS_HISTO, [{ "0-19": 2 }]);
  assert.deepEqual(video.NETWORK_LATENCY_MS_HISTO, [{ "0-19": 2 }]);
  assert.deepEqual(video.PACKET_LATENCY_MS_HISTO, [{ "0-19": 2 }]);
  assert.deepEqual(video.E2E_LATENCY_MS_HISTO, [{ "100-119": 1 }]);
  assert.deepEqual(video.LATE_FRAME_MS_HISTO, [{ "20-39": 1 }]);

  // Audio saw nothing: every statistic is present and zero.
  const audio = client.getStats().audio!;
  assert.equal(audio.NUM_FRAMES_CAPTURED, 0);
  assert.equal(audio.NUM_FRAMES_LATE, 0);
  assert.equal(audio.ENQUEUE_FPS, 0);
  assert.deepEqual(audio.CAPTURE_LATENCY_MS_HISTO, []);

  // The analysis reschedules itself every 500 ms, and dispose stops it.
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0]!.at, 11_500);
  analyzer.dispose();
  assert.equal(scheduled.length, 0);
});

test("the dictionary has Chrome's keys, 'null' for values that are not finite, and histogram lists", () => {
  const statistics = new Array<number>(NUM_STATISTIC_TYPES).fill(0);
  statistics[0] = Infinity;
  statistics[4] = NaN;
  statistics[11] = 7;
  const histograms = Array.from({ length: NUM_HISTOGRAM_TYPES }, () => new SimpleHistogram(0, 800, 20));
  histograms[0]!.add(-1);
  histograms[0]!.add(0);
  histograms[0]!.add(19);
  histograms[0]!.add(20);
  histograms[0]!.add(799);
  histograms[0]!.add(800);
  const dict = senderStatsToDict({ audioStatistics: statistics, audioHistograms: histograms, videoStatistics: statistics, videoHistograms: histograms });
  assert.deepEqual(Object.keys(dict), ["audio", "video"]);
  assert.deepEqual(Object.keys(dict.video!), [
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
    "CAPTURE_LATENCY_MS_HISTO",
    "ENCODE_TIME_MS_HISTO",
    "QUEUEING_LATENCY_MS_HISTO",
    "NETWORK_LATENCY_MS_HISTO",
    "PACKET_LATENCY_MS_HISTO",
    "E2E_LATENCY_MS_HISTO",
    "LATE_FRAME_MS_HISTO",
  ]);
  assert.equal(dict.video!.ENQUEUE_FPS, "null");
  assert.equal(dict.video!.AVG_NETWORK_LATENCY_MS, "null");
  assert.equal(dict.video!.NUM_FRAMES_CAPTURED, 7);
  assert.deepEqual(dict.video!.CAPTURE_LATENCY_MS_HISTO, [{ "<0": 1 }, { "0-19": 2 }, { "20-39": 1 }, { "780-799": 1 }, { ">=800": 1 }]);
  assert.deepEqual(histogramToList(new SimpleHistogram(0, 800, 20)), []);
});

test("a session shorter than a millisecond gives non-finite rates, which the dictionary shows as 'null'", () => {
  const { analyzer, client, setNow, collector } = analyzerSetup(5000);
  collector.collectFrameEvent(frameEvent("frameEncoded", "video", 1, 5000, { size: 500 }));
  setNow(5000.5);
  analyzer.analyzeStatistics();
  assert.equal(client.getStats().video!.ENQUEUE_FPS, "null");
  assert.equal(client.getStats().video!.ENCODE_KBPS, "null");
});

test("the clock offset estimator needs both bounds, then settles on the offset and latency", () => {
  const e = createClockOffsetEstimator();
  assert.equal(e.getEstimatedOffset(), undefined);
  e.onPacketEvent(packetEvent("packetSentToNetwork", 1, 100));
  e.onPacketEvent(packetEvent("packetReceived", 1, 1110));
  assert.equal(e.getEstimatedOffset(), undefined);
  e.onFrameEvent(frameEvent("frameAckSent", "video", 1, 1140));
  e.onFrameEvent(frameEvent("frameAckReceived", "video", 1, 150));
  assert.equal(e.getEstimatedOffset(), 1000);
  assert.equal(e.getEstimatedLatency(), 10);
});

test("the collector parses the packets the router sends (RTP timestamp, packet ids, size) and retransmissions", () => {
  let now = 50;
  const c = new StatisticsCollector(() => now);
  const packet = Buffer.alloc(40);
  packet.writeUInt32BE(0x00000100, 4);
  packet.writeUInt16BE(3, 14);
  packet.writeUInt16BE(9, 16);
  c.collectPacketSentEvent(packet, { streamType: "video", rtpTimestamp: 0x100 });
  now = 60;
  c.collectPacketSentEvent(packet, { streamType: "audio", rtpTimestamp: 0x100, isRetransmission: true });
  c.collectPacketSentEvent(Buffer.alloc(10), { streamType: "audio", rtpTimestamp: 0 });
  const events = c.takeRecentPacketEvents();
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.type, e.mediaType, e.rtpTimestamp, e.size, e.timestamp, e.packetId, e.maxPacketId]),
    [
      ["packetSentToNetwork", "video", 0x100, 40, 50, 3, 9],
      ["packetRetransmitted", "audio", 0x100, 40, 60, 3, 9],
    ],
  );
  assert.deepEqual(c.takeRecentPacketEvents(), []);
});

test("RTP timestamps expand against a reference across a 32-bit wrap", () => {
  assert.equal(expandRtpTimestamp(0, 5), 5);
  assert.equal(expandRtpTimestamp(0xfffffff0, 0x10), 0x100000010);
  assert.equal(expandRtpTimestamp(0x100000010, 0xfffffff0), 0xfffffff0);
});

test("the dispatcher does nothing without a collector and otherwise logs enqueue, ack and receiver events", () => {
  const env = new FakeEnvironment();
  const d = new StatisticsDispatcher(env);
  const frame = { rtpTimestamp: 90, frameId: 4, data: new Uint8Array(30), dependency: "key" } as never;
  d.dispatchEnqueueEvents("video", frame);
  d.dispatchAckEvent("video", 90, 4);
  const collector = new StatisticsCollector(() => env.now());
  const withCollector = { now: () => env.now(), statisticsCollector: collector };
  const on = new StatisticsDispatcher(withCollector);
  on.dispatchEnqueueEvents("video", { ...(frame as object), captureBeginTimeMs: 500_000 } as never);
  on.dispatchAckEvent("video", 90, 4);
  on.dispatchFrameDropEvent("audio", 5, 91, 123);
  const logs: RtcpReceiverFrameLogMessage[] = [
    {
      rtpTimestamp: 90,
      messages: [
        { type: "packetReceived", timestamp: 7, packetId: 2, delay: 0 },
        { type: "framePlayedOut", timestamp: 8, packetId: 0, delay: -4 },
        { type: "frameDecoded", timestamp: 9, packetId: 0, delay: 0 },
        { type: "frameAckSent", timestamp: 10, packetId: 0, delay: 0 },
        { type: "frameCaptureBegin", timestamp: 11, packetId: 0, delay: 0 },
      ],
    },
  ];
  on.dispatchFrameLogMessages("video", logs);
  const frames = collector.takeRecentFrameEvents();
  assert.deepEqual(
    frames.map((e) => [e.type, e.timestamp]),
    [
      ["frameCaptureBegin", 500_000],
      ["frameCaptureEnd", env.now()],
      ["frameEncoded", env.now()],
      ["frameAckReceived", env.now()],
      ["frameDroppedByEncoder", 123],
      ["framePlayedOut", 8],
      ["frameDecoded", 9],
      ["frameAckSent", 10],
    ],
  );
  assert.equal(frames.find((e) => e.type === "frameEncoded")!.size, 30);
  assert.equal(frames.find((e) => e.type === "frameEncoded")!.keyFrame, true);
  assert.equal(frames.find((e) => e.type === "framePlayedOut")!.delayDelta, -4);
  const packets = collector.takeRecentPacketEvents();
  assert.equal(packets.length, 1);
  assert.deepEqual([packets[0]!.type, packets[0]!.packetId, packets[0]!.timestamp, packets[0]!.receivedTimestamp], ["packetReceived", 2, 7, env.now()]);
});

test("E2E latency joins the dispatcher's capture begin time to the receiver's FRAME_PLAYOUT", () => {
  const { analyzer, client, setNow, collector } = analyzerSetup(10_000);
  let now = 10_000;
  const dispatcher = new StatisticsDispatcher({ now: () => now, statisticsCollector: collector });
  const at = (t: number) => { now = t; setNow(t); };
  // The receiver clock is 1000 ms ahead and the network takes 10 ms each way, as in addFrame. The frame is captured at
  // `t` and enqueued 15 ms later, so E2E is counted from its captureBeginTimeMs, not from the enqueue.
  const send = (rtp: number, t: number) => {
    at(t + 15);
    dispatcher.dispatchEnqueueEvents("video", {
      rtpTimestamp: rtp, frameId: 1, data: new Uint8Array(1000), dependency: "key", captureBeginTimeMs: t, captureEndTimeMs: t + 5,
    } as never);
    collector.collectPacketEvent(packetEvent("packetSentToNetwork", rtp, t + 20, { size: 1200 }));
    at(t + 50);
    dispatcher.dispatchAckEvent("video", rtp, 1);
    dispatcher.dispatchFrameLogMessages("video", [{
      rtpTimestamp: rtp,
      messages: [
        { type: "packetReceived", timestamp: t + 1030, packetId: 0, delay: 0 },
        { type: "frameAckSent", timestamp: t + 1040, packetId: 0, delay: 0 },
        { type: "framePlayedOut", timestamp: t + 1100, packetId: 0, delay: 0 },
      ],
    }]);
  };

  // The first frame gives the clock offset estimator its two bounds; the second is placed on the sender clock.
  send(1000, 10_100);
  analyzer.analyzeStatistics();
  assert.deepEqual(client.getStats().video!.E2E_LATENCY_MS_HISTO, []);
  send(2000, 10_600);
  analyzer.analyzeStatistics();
  const video = client.getStats().video!;
  assert.equal(video.AVG_CAPTURE_LATENCY_MS, 5);
  assert.equal(video.AVG_E2E_LATENCY_MS, 100);
  assert.deepEqual(video.E2E_LATENCY_MS_HISTO, [{ "100-119": 1 }]);
  analyzer.dispose();
});

test("the RTCP parser reads the receiver's event log: base time from the session start, signed delays, unknown types skipped", () => {
  const ntp = new NtpTimeConverter(1000, 1_700_000_000);
  const logs: RtcpReceiverFrameLogMessage[][] = [];
  const client: CompoundRtcpClient = { onCastReceiverFrameLogMessages: (m) => logs.push(m) };
  const parser = new CompoundRtcpParser({ senderSsrc: 1, receiverSsrc: 2, ntp, startTimeMs: 5000 }, client);
  const packet = buildReceiverRtcp({
    receiverSsrc: 2,
    senderSsrc: 1,
    ntp,
    sendTimeMs: 1100,
    checkpointFrameId: 0,
    playoutDelayMs: 100,
    eventLog: [
      { rtpTimestamp: 90_000, timestampMs: 300, wireType: 14, value: 6, deltaMs: 4 },
      { rtpTimestamp: 90_000, timestampMs: 300, wireType: 12, value: 0xfffb },
      { rtpTimestamp: 90_000, timestampMs: 300, wireType: 9, value: 1 },
      { rtpTimestamp: 93_000, timestampMs: 400, wireType: 11, value: 0 },
    ],
  });
  assert.equal(parser.parse(packet, 0), true);
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0]!.map((l) => [l.rtpTimestamp, l.messages.map((m) => [m.type, m.timestamp, m.packetId, m.delay])]), [
    [90_000, [["packetReceived", 5304, 6, 0]]],
    [90_000, [["framePlayedOut", 5300, 0, -5]]],
    [90_000, []],
    [93_000, [["frameAckSent", 5400, 0, 0]]],
  ]);
});

test("a truncated event log is rejected as a whole", () => {
  const ntp = new NtpTimeConverter(1000, 1_700_000_000);
  const logs: unknown[] = [];
  const parser = new CompoundRtcpParser({ senderSsrc: 1, receiverSsrc: 2, ntp, startTimeMs: 0 }, { onCastReceiverFrameLogMessages: (m) => logs.push(m) });
  const packet = buildReceiverRtcp({
    receiverSsrc: 2,
    senderSsrc: 1,
    ntp,
    sendTimeMs: 1100,
    checkpointFrameId: 0,
    playoutDelayMs: 100,
    eventLog: [{ rtpTimestamp: 1, timestampMs: 1, wireType: 14, value: 1 }],
  });
  // Claim two events in the frame log while only one follows.
  packet[packet.length - 8] = 1;
  assert.equal(parser.parse(packet, 0), false);
  assert.deepEqual(logs, []);
});
