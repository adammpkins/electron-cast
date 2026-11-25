import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { AGENT_SOURCE } from "../../src/mirroring/electron/agent-source.ts";
import { PortBackend, UNDERRUN_SKIP_THRESHOLD } from "../../src/mirroring/electron/port-backend.ts";
import type { AgentPort, AgentToEngine, EngineToAgent } from "../../src/mirroring/electron/agent-protocol.ts";

/**
 * agent-source.ts runs in a renderer, so it is evaluated here in a vm context with stand-ins for the WebCodecs and
 * capture APIs it uses. The stand-in encoder only emits what the test tells it to, which is how the dropped and
 * reordered outputs a real encoder can produce are simulated.
 */

interface FakeFrame { timestamp: number; displayWidth: number; displayHeight: number; closed: boolean; close(): void; clone(): FakeFrame }
const frame = (timestamp: number): FakeFrame => ({
  timestamp, displayWidth: 640, displayHeight: 360, closed: false,
  close() { this.closed = true; },
  clone() { return frame(this.timestamp); },
});

function startAgent() {
  const sent: AgentToEngine[] = [];
  const port = { postMessage: (m: AgentToEngine) => void sent.push(m), start() {}, onmessage: undefined as ((e: { data: unknown }) => void) | undefined };
  let listener: ((e: { data: unknown; ports: unknown[] }) => void) | undefined;
  let now = 1000;
  const encoders: FakeEncoder[] = [];
  const waiters: ((r: { value?: FakeFrame; done: boolean }) => void)[] = [];
  const queued: FakeFrame[] = [];

  class FakeEncoder {
    static async isConfigSupported() { return { supported: true }; }
    configures: Record<string, unknown>[] = [];
    encodes: { frame: FakeFrame; keyFrame: boolean }[] = [];
    encodeQueueSize = 0;
    state = "unconfigured";
    init: { output(chunk: unknown): void; error(e: unknown): void };
    constructor(init: { output(chunk: unknown): void; error(e: unknown): void }) { this.init = init; encoders.push(this); }
    configure(config: Record<string, unknown>) { this.configures.push(config); this.state = "configured"; }
    encode(f: FakeFrame, options: { keyFrame: boolean }) { this.encodes.push({ frame: f, keyFrame: options.keyFrame }); }
    close() { this.state = "closed"; }
    emit(index: number, key = false) {
      const e = this.encodes[index]!;
      this.init.output({ type: key ? "key" : "delta", timestamp: e.frame.timestamp, byteLength: 4, copyTo: (b: ArrayBuffer) => new Uint8Array(b).set([1, 2, 3, 4]) });
    }
  }

  const track = { stop() {} };
  const context = createContext({
    window: { addEventListener: (_: string, l: typeof listener) => { listener = l; } },
    performance: { timeOrigin: 0, now: () => now },
    navigator: { mediaDevices: { getUserMedia: async () => ({ getVideoTracks: () => [track], getAudioTracks: () => [], getTracks: () => [track] }) } },
    MediaStreamTrackProcessor: class { readable = { getReader: () => ({ read: () => queued.length > 0 ? Promise.resolve({ value: queued.shift(), done: false }) : new Promise((r) => waiters.push(r)) }) }; },
    VideoEncoder: FakeEncoder,
    ArrayBuffer, Uint8Array, Map, String, Math, Promise,
  });
  runInContext(AGENT_SOURCE, context);
  listener!({ data: "electron-cast-mirroring:port", ports: [port] });

  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    sent, encoders, settle,
    advance: (ms: number) => { now += ms; },
    command: async (m: EngineToAgent) => { await (port.onmessage as (e: { data: unknown }) => Promise<void>)({ data: m }); await settle(); },
    capture: async (ts: number) => {
      now += 33;
      const f = frame(ts);
      const w = waiters.shift();
      if (w) w({ value: f, done: false }); else queued.push(f);
      await settle();
    },
    rtps: () => sent.filter((m) => m.t === "frame").map((m) => (m as { rtp: number }).rtp),
  };
}

test("agent: repeated bitrate changes reconfigure in place, force no key frame, and keep chunks paired with their frames", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30 } });
  for (let i = 0; i < 6; i++) {
    await a.capture(i * 33_000);
    await a.command({ t: "encode", rtp: a.rtps()[i]! });
    await a.command({ t: "set-bitrate", bps: 1_000_000 + i * 250_000 });
  }
  const rtps = a.rtps();
  assert.equal(rtps.length, 6);
  assert.equal(a.encoders.length, 1, "one encoder for the whole stream");
  const enc = a.encoders[0]!;
  assert.deepEqual(enc.configures.map((c) => c.bitrate).slice(-3), [1_750_000, 2_000_000, 2_250_000]);
  assert.deepEqual(enc.encodes.map((e) => e.keyFrame), [true, false, false, false, false, false], "only the first frame is a key frame");
  enc.emit(0, true);
  for (let i = 1; i < 6; i++) enc.emit(i);
  const chunks = a.sent.filter((m) => m.t === "video-chunk") as { rtp: number }[];
  assert.deepEqual(chunks.map((c) => c.rtp), rtps);
  assert.equal(a.sent.filter((m) => m.t === "video-drop").length, 0);
});

test("agent: a frame the encoder swallows is reported as dropped and later chunks keep their own timestamps", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30 } });
  for (let i = 0; i < 3; i++) await a.capture(i * 33_000);
  const rtps = a.rtps();
  for (const r of rtps) await a.command({ t: "encode", rtp: r });
  const enc = a.encoders[0]!;
  enc.emit(0, true);
  enc.emit(2);
  assert.deepEqual(a.sent.filter((m) => m.t === "video-drop").map((m) => (m as { rtp: number }).rtp), [rtps[1]]);
  assert.deepEqual((a.sent.filter((m) => m.t === "video-chunk") as { rtp: number }[]).map((c) => c.rtp), [rtps[0], rtps[2]]);
});

test("agent: a full encoder queue, a missing frame and an encoder error each report a drop", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30 } });
  for (let i = 0; i < 3; i++) await a.capture(i * 33_000);
  const rtps = a.rtps();
  await a.command({ t: "encode", rtp: rtps[0]! });
  const enc = a.encoders[0]!;
  enc.encodeQueueSize = 5;
  await a.command({ t: "encode", rtp: rtps[1]! });
  assert.equal(enc.encodes.length, 1, "the full queue took no frame");
  await a.command({ t: "encode", rtp: 999_999 });
  assert.deepEqual(a.sent.filter((m) => m.t === "video-drop").map((m) => (m as { rtp: number }).rtp), [rtps[1], 999_999]);
  enc.init.error(new Error("boom"));
  assert.ok(a.sent.some((m) => m.t === "video-drop" && m.rtp === rtps[0]), "the frame inside a failed encoder is dropped");
  assert.ok(a.sent.some((m) => m.t === "encoder-status" && m.status === "codec_runtime_error"));
});

class FakePort implements AgentPort {
  readonly out: EngineToAgent[] = [];
  private l: ((m: AgentToEngine) => void) | undefined;
  postMessage(m: EngineToAgent) { this.out.push(m); }
  onMessage(l: (m: AgentToEngine) => void) { this.l = l; }
  close() {}
  emit(m: AgentToEngine) { this.l?.(m); }
}

test("port backend: a dropped video frame becomes an encoder drop, which frees its slot in the sender", () => {
  const port = new FakePort();
  const backend = new PortBackend(port, { kind: "tab", mediaSourceId: "x" });
  const got: { ref: number; length: number | undefined }[] = [];
  const encoder = backend.createVideoEncoder(
    { maxFrameRate: 30, startBitrate: 1e6, codecParameter: "vp8", videoCodec: "vp8" } as never,
    { onEncoded: (ref, f) => got.push({ ref, length: f?.data.length }), onStatus() {} },
  );
  assert.equal(encoder.encodeVideoFrame({ rtpTimestamp: 100, visibleRectEmpty: false }, 5000), true);
  assert.equal(encoder.encodeVideoFrame({ rtpTimestamp: 200, visibleRectEmpty: false }, 5033), true);
  port.emit({ t: "video-drop", rtp: 100 });
  port.emit({ t: "video-chunk", rtp: 200, key: true, data: new ArrayBuffer(3), encodeMs: 1 });
  port.emit({ t: "video-drop", rtp: 100 });
  assert.deepEqual(got, [{ ref: 5000, length: 0 }, { ref: 5033, length: 3 }], "each frame is answered exactly once");
});

test("port backend: audio timestamps follow the recorded times, and a lost chunk is reported as skipped samples", () => {
  const port = new FakePort();
  const backend = new PortBackend(port, { kind: "tab", mediaSourceId: "x" });
  const frames: { id: number; rtp: number; ref: number; skipped: number }[] = [];
  const base = performance.timeOrigin;
  const encoder = backend.createAudioEncoder({ rtpTimebase: 48000, maxBitrate: 128000 } as never, {
    onEncoded: (f, skipped) => frames.push({ id: f.frameId, rtp: f.rtpTimestamp, ref: f.referenceTimeMs, skipped }),
    onStatus() {},
  });
  backend.startAudioCapture({ sampleRate: 48000, channels: 2, framesPerBuffer: 480 }, {
    insertAudio: (n, rec) => { encoder.encode(n, rec); return true; },
    onCaptureError() {},
  });
  const buffer = (seq: number, rec: number) => port.emit({ t: "audio-buffer", seq, frames: 480, recMs: base + rec });
  const chunk = (seq: number) => port.emit({ t: "audio-chunk", seq, data: new ArrayBuffer(2) });
  buffer(0, 1000); chunk(0);
  buffer(1, 1010); port.emit({ t: "audio-drop", seq: 1 });
  buffer(2, 1020); chunk(2);
  // 7 frames of silence: more than kUnderrunSkipThreshold, so the RTP timestamp jumps ahead.
  assert.ok(7 > UNDERRUN_SKIP_THRESHOLD);
  buffer(3, 1100); chunk(3);
  assert.deepEqual(frames, [
    { id: 0, rtp: 0, ref: 1000, skipped: 0 },
    { id: 2, rtp: 960, ref: 1020, skipped: 480 },
    { id: 3, rtp: 1440 + 7 * 480, ref: 1100, skipped: 0 },
  ]);
});

test("agent: a refresh frame on a static screen is stamped with the elapsed time, not one tick", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30 } });
  await a.capture(0);
  const first = a.rtps()[0]!;
  a.advance(200);
  await a.command({ t: "refresh" });
  a.advance(50);
  await a.command({ t: "refresh" });
  const [, second, third] = a.rtps();
  // 33 ms passed between the capture's reference time and the first refresh request, then 200, then 50.
  assert.ok(Math.abs(second! - first - 200 * 90) < 90, `second ${second! - first}`);
  assert.ok(Math.abs(third! - second! - 50 * 90) < 90, `third ${third! - second!}`);
});

test("agent: the video encoder is configured like Chrome's MediaVideoEncoderWrapper (constant bitrate, screen content hint, no frame rate for VP8)", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30 } });
  await a.capture(0);
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  const cfg = a.encoders[0]!.configures[0]!;
  assert.equal(cfg.bitrateMode, "constant");
  assert.equal(cfg.contentHint, "text");
  assert.equal("framerate" in cfg, false);
  assert.equal(cfg.latencyMode, "realtime");
});

test("agent: a VP9 encoder keeps its frame rate and gets no screen content hint", async () => {
  const a = startAgent();
  await a.command({ t: "set-codec", codec: "vp9", codecString: "vp09.00.10.08" });
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30 } });
  await a.capture(0);
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  const cfg = a.encoders[0]!.configures[0]!;
  assert.equal(cfg.bitrateMode, "constant");
  assert.equal("contentHint" in cfg, false);
  assert.equal(cfg.framerate, 30);
});
