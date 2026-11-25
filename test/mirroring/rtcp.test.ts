import { test } from "node:test";
import assert from "node:assert/strict";
import { NtpTimeConverter, toStatusReportId } from "../../src/mirroring/rtcp/ntp.ts";
import { buildSenderReport } from "../../src/mirroring/rtcp/sender-report.ts";
import { CompoundRtcpParser, type CompoundRtcpClient, type PacketNack } from "../../src/mirroring/rtcp/parser.ts";
import { ALL_PACKETS_LOST } from "../../src/mirroring/protocol/constants.ts";
import { buildReceiverRtcp } from "./receiver-wire.ts";

// Vectors below are from openscreen cast/streaming/impl/{ntp_time,compound_rtcp_parser}_unittest.cc.
const SENDER = 1;
const RECEIVER = 2;

function setup() {
  const ntp = new NtpTimeConverter(1000, 1_700_000_000);
  const events: unknown[][] = [];
  const client: CompoundRtcpClient = {
    onReceiverReferenceTimeAdvanced: (t) => events.push(["time", t]),
    onReceiverReport: (r) => events.push(["report", r]),
    onReceiverCheckpoint: (f, d) => events.push(["checkpoint", f, d]),
    onReceiverHasFrames: (a) => events.push(["acks", a]),
    onReceiverIsMissingPackets: (n) => events.push(["nacks", n]),
    onReceiverIndicatesPictureLoss: () => events.push(["pli"]),
  };
  const parser = new CompoundRtcpParser({ senderSsrc: SENDER, receiverSsrc: RECEIVER, ntp }, client);
  return { ntp, events, parser };
}

const bytes = (...v: (number | string)[]): Buffer =>
  Buffer.from(v.flatMap((x) => (typeof x === "string" ? [...Buffer.from(x, "latin1")] : [x])));

test("NTP timestamps assemble like ntp_time_unittest (10 ms truncates to 0x028f5c28)", () => {
  // converter anchored at the NTP epoch plus zero: start 0 ms, unix = -2208988800 s.
  const c = new NtpTimeConverter(0, -2208988800);
  assert.equal(c.toNtpTimestamp(0), 0n);
  assert.equal(c.toNtpTimestamp(10), 0x028f5c28n);
  assert.equal(c.toNtpTimestamp(3762375950500), 0xe0414d0e80000000n);
});

test("NTP converter round trips within a microsecond over five seconds", () => {
  const c = new NtpTimeConverter(5000.25, 1_700_000_000);
  let last = 0n;
  for (let t = 5000.25; t < 10000; t += 10) {
    const ts = c.toNtpTimestamp(t);
    assert.ok(ts > last);
    last = ts;
    assert.ok(Math.abs(c.toLocalTime(ts) - t) < 0.002, `${t}`);
  }
});

test("status report id is the middle 32 bits and can be turned back into the report time", () => {
  assert.equal(toStatusReportId(0x0192a3b4c5d6e7f8n), 0xa3b4c5d6);
  const c = new NtpTimeConverter(0, 1_700_000_000);
  const { packet, statusReportId } = buildSenderReport(SENDER, c, { referenceTimeMs: 1234.5, rtpTimestamp: 9, sendPacketCount: 3, sendOctetCount: 400 });
  assert.equal(packet.length, 28);
  assert.equal(packet[0], 0x80);
  assert.equal(packet[1], 200);
  assert.equal(packet.readUInt16BE(2), 6);
  assert.equal(packet.readUInt32BE(4), SENDER);
  assert.equal(packet.readUInt32BE(16), 9);
  assert.equal(packet.readUInt32BE(20), 3);
  assert.equal(packet.readUInt32BE(24), 400);
  assert.equal(statusReportId, toStatusReportId(c.toNtpTimestamp(1234.5)));
  const back = c.getRecentReportTime(statusReportId, 1300);
  assert.ok(Math.abs(back - 1234.5) < 0.02, `${back}`);
});

test("an empty packet parses and dispatches nothing; garbage fails", () => {
  const { parser, events } = setup();
  assert.equal(parser.parse(new Uint8Array(0), 0), true);
  assert.equal(events.length, 0);
  assert.equal(parser.parse(Buffer.from("garbage that is not rtcp"), 0), false);
  assert.equal(events.length, 0);
});

test("parses the receiver report block of the openscreen vector", () => {
  const { parser, events } = setup();
  const packet = bytes(0x81, 201, 0x00, 0x07, 0, 0, 0, 2, 0, 0, 0, 1, 0x05, 0x01, 0x02, 0x03, 0x09, 0x09, 0x09, 0x02, 0, 0, 0, 0xaa, 0x0b, 0x0c, 0x8f, 0xed, 0, 1, 0, 0);
  assert.equal(parser.parse(packet, 0), true);
  assert.deepEqual(events, [
    [
      "report",
      { ssrc: 1, packetFractionLostNumerator: 5, cumulativePacketsLost: 0x010203, extendedHighSequenceNumber: 0x09090902, jitter: 0xaa, lastStatusReportId: 0x0b0c8fed, delaySinceLastReport: 0x10000 },
    ],
  ]);
});

test("a report for another sender ssrc or another receiver is ignored", () => {
  const { parser, events } = setup();
  const block = [0, 0, 0, 3, 0x05, 0x01, 0x02, 0x03, 0x09, 0x09, 0x09, 0x02, 0, 0, 0, 0xaa, 0x0b, 0x0c, 0x8f, 0xed, 0, 1, 0, 0];
  assert.equal(parser.parse(bytes(0x81, 201, 0, 7, 0, 0, 0, 2, ...block), 0), true);
  assert.equal(parser.parse(bytes(0x81, 201, 0, 7, 0, 0, 0, 9, ...block.with(3, 1)), 0), true);
  assert.deepEqual(events, []);
});

test("simple feedback expands the checkpoint against the newest frame id", () => {
  const packet = bytes(0x80 | 15, 206, 0, 4, 0, 0, 0, 2, 0, 0, 0, 1, "CAST", 0x0a, 0x00, 0x02, 0x26);
  let { parser, events } = setup();
  assert.equal(parser.parse(packet, 42), true);
  assert.deepEqual(events, [["checkpoint", 10, 550]]);
  ({ parser, events } = setup());
  assert.equal(parser.parse(packet, 0x22a), true);
  assert.deepEqual(events, [["checkpoint", 0x20a, 550]]);
});

test("feedback NACKs are de-duplicated and sorted, with all-lost covering the frame", () => {
  const packet = bytes(
    0x80 | 15, 206, 0, 0x0b, 0, 0, 0, 2, 0, 0, 0, 1, "CAST", 0x0a, 0x07, 0x02, 0x28,
    0x0b, 0x00, 0x03, 0b00000000,
    0x0b, 0x00, 0x07, 0b10001101,
    0x0d, 0xff, 0xff, 0b00000000,
    0x0b, 0x00, 0x0b, 0b00000000,
    0x0c, 0xff, 0xff, 0b00000000,
    0x0d, 0x00, 0x01, 0b00000000,
    0x0e, 0x00, 0x00, 0b01000010,
  );
  const { parser, events } = setup();
  assert.equal(parser.parse(packet, 42), true);
  const expected: PacketNack[] = [
    { frameId: 11, packetId: 3 },
    { frameId: 11, packetId: 7 },
    { frameId: 11, packetId: 8 },
    { frameId: 11, packetId: 10 },
    { frameId: 11, packetId: 11 },
    { frameId: 11, packetId: 15 },
    { frameId: 12, packetId: ALL_PACKETS_LOST },
    { frameId: 13, packetId: ALL_PACKETS_LOST },
    { frameId: 14, packetId: 0 },
    { frameId: 14, packetId: 2 },
    { frameId: 14, packetId: 7 },
  ];
  assert.deepEqual(events, [["checkpoint", 10, 552], ["nacks", expected]]);
});

test("CST2 frame ACKs, small and multi-word", () => {
  const small = bytes(0x80 | 15, 206, 0, 7, 0, 0, 0, 2, 0, 0, 0, 1, "CAST", 0x0a, 0x01, 0x01, 0x26, 0x0b, 0, 3, 0, "CST2", 0x99, 0x02, 0b10, 0);
  let { parser, events } = setup();
  assert.equal(parser.parse(small, 100), true);
  assert.deepEqual(events, [["checkpoint", 10, 294], ["acks", [13]], ["nacks", [{ frameId: 11, packetId: 3 }]]]);

  const large = bytes(
    0x80 | 15, 206, 0, 8, 0, 0, 0, 2, 0, 0, 0, 1, "CAST", 0x0a, 0x00, 0x01, 0x26, "CST2", 0x99, 0x0a,
    0xff, 0xff, 0x00, 0x01, 0, 0, 0, 0, 0, 0x80,
  );
  ({ parser, events } = setup());
  assert.equal(parser.parse(large, 100), true);
  const acks = [...Array.from({ length: 16 }, (_, i) => 12 + i), 36, 91];
  assert.deepEqual(events, [["checkpoint", 10, 294], ["acks", acks]]);
});

test("picture loss is only honored when it names this receiver and sender", () => {
  const { parser, events } = setup();
  assert.equal(parser.parse(bytes(0x80 | 1, 206, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1), 0), true);
  assert.equal(parser.parse(bytes(0x80 | 1, 206, 0, 2, 0, 0, 0, 3, 0, 0, 0, 1), 0), true);
  assert.equal(parser.parse(bytes(0x80 | 1, 206, 0, 2, 0, 0, 0, 2, 0, 0, 0, 3), 0), true);
  assert.deepEqual(events, [["pli"]]);
});

test("a stale compound packet (older receiver reference time) is ignored", () => {
  const xr = (ts: number[]) => bytes(0x80, 207, 0, 4, 0, 0, 0, 2, 0x04, 0, 0, 2, ...ts);
  const pli = bytes(0x80 | 1, 206, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1);
  const { parser, events, ntp } = setup();
  assert.equal(parser.parse(Buffer.concat([xr([0xe0, 0x73, 0x2e, 0x54, 0x80, 0, 0, 0])]), 0), true);
  assert.equal(parser.parse(Buffer.concat([xr([0xe0, 0x73, 0x2e, 0x53, 0x42, 0x31, 0x20, 0]), pli]), 0), true);
  assert.deepEqual(events, [["time", ntp.toLocalTime(0xe0732e5480000000n)]]);
});

test("unknown extended report blocks are skipped; a bad RRTR length fails the packet", () => {
  const { parser, events, ntp } = setup();
  const packet = bytes(0x80, 207, 0, 0x0c, 0, 0, 0, 2, 2, 0, 0, 6, ...new Array(24).fill(1), 4, 0, 0, 2, 0xe0, 0x73, 0x2e, 0x55, 0, 0, 0, 0, 0, 0, 0, 0);
  assert.equal(parser.parse(packet, 0), true);
  assert.deepEqual(events, [["time", ntp.toLocalTime(0xe0732e5500000000n)]]);
  assert.equal(parser.parse(bytes(0x80, 207, 0, 3, 0, 0, 0, 2, 4, 0, 0, 1), 0), false);
});

test("receiver log messages are validated and ignored; truncated ones fail the whole packet", () => {
  const ok = bytes(0x80 | 2, 204, 0, 5, 0, 0, 0, 2, "CAST", 1, 2, 3, 4, 0, 0x10, 0x20, 0x30, 0x1e, 0x15, 0xe1, 0xf9);
  const { parser, events } = setup();
  assert.equal(parser.parse(ok, 0), true);
  assert.equal(parser.parse(ok.subarray(0, ok.length - 4), 0), false);
  assert.deepEqual(events, []);
});

test("the receiver builder and the sender parser agree (checkpoint, nacks across a bit vector, acks, PLI)", () => {
  const { parser, events, ntp } = setup();
  const packet = buildReceiverRtcp({
    receiverSsrc: RECEIVER,
    senderSsrc: SENDER,
    ntp,
    sendTimeMs: 2000,
    pictureLoss: true,
    checkpointFrameId: 5,
    playoutDelayMs: 400,
    nacks: [
      { frameId: 6, packetId: 2 },
      { frameId: 6, packetId: 4 },
      { frameId: 6, packetId: 12 },
      { frameId: 7, packetId: ALL_PACKETS_LOST },
    ],
    acks: [8, 20],
  });
  assert.equal(parser.parse(packet, 30), true);
  assert.deepEqual(events.map((e) => e[0]), ["time", "checkpoint", "acks", "nacks", "pli"]);
  assert.deepEqual(events[2], ["acks", [8, 20]]);
  assert.deepEqual(events[3]![1], [
    { frameId: 6, packetId: 2 },
    { frameId: 6, packetId: 4 },
    { frameId: 6, packetId: 12 },
    { frameId: 7, packetId: ALL_PACKETS_LOST },
  ]);
});
