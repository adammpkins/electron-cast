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

interface FakeFrame {
  timestamp: number; displayWidth: number; displayHeight: number; closed: boolean; close(): void; clone(): FakeFrame;
  format?: string; visibleRect?: { width: number; height: number }; duration?: number | null;
  allocationSize?(): number; copyTo?(destination: Uint8Array): Promise<{ offset: number; stride: number }[]>;
}
interface FrameOptions { width?: number; height?: number; format?: string; duration?: number | null; luma?: (x: number, y: number) => number }
const frame = (timestamp: number, o: FrameOptions = {}): FakeFrame => {
  const width = o.width ?? 640, height = o.height ?? 360;
  const f: FakeFrame = {
    timestamp, displayWidth: width, displayHeight: height, closed: false,
    close() { this.closed = true; },
    clone() { return frame(this.timestamp, o); },
  };
  if (o.luma !== undefined || o.format !== undefined) {
    // A planar 4:2:0 frame: the luma plane first, tightly packed, then the chroma planes.
    f.format = o.format ?? "I420";
    f.visibleRect = { width, height };
    f.duration = o.duration;
    f.allocationSize = () => width * height * 3 / 2;
    f.copyTo = async (destination) => {
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) destination[y * width + x] = o.luma?.(x, y) ?? 0;
      return [{ offset: 0, stride: width }, { offset: width * height, stride: width / 2 }, { offset: width * height * 5 / 4, stride: width / 2 }];
    };
  } else if (o.duration !== undefined) {
    f.duration = o.duration;
  }
  return f;
};

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
    capture: async (ts: number, options?: FrameOptions) => {
      now += 33;
      const f = frame(ts, options);
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

const chunksOf = (sent: AgentToEngine[]) => sent.filter((m) => m.t === "video-chunk") as { rtp: number; complexity?: number; durationMs?: number }[];

test("agent: the frame complexity estimate is the entropy of luma differences over 10% of the rows, as Chrome's", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30 } });
  let seed = 12345;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255;
  const ramp = (x: number) => x % 256;
  // key frame (neighbour differences), then delta frames (differences against the last examined frame)
  const frames: FrameOptions[] = [
    { luma: (x) => ramp(x) },            // key: 637 differences of +1 and 2 of -255 per row
    { luma: (x) => ramp(x + 1) },        // delta: every pixel moved by 1 but the two columns where the ramp wraps
    { luma: () => 128 },                 // delta: a uniform frame after a ramp
    { luma: () => noise() },             // delta: noise against uniform, about 8 bits of entropy
  ];
  for (let i = 0; i < frames.length; i++) {
    await a.capture(i * 33_000, frames[i]);
    await a.command({ t: "encode", rtp: a.rtps()[i]! });
  }
  const enc = a.encoders[0]!;
  for (let i = 0; i < frames.length; i++) enc.emit(i, i === 0);
  const c = chunksOf(a.sent).map((m) => m.complexity);
  const p = 2 / 639;
  const keyEntropy = -((1 - p) * Math.log2(1 - p) + p * Math.log2(p));
  assert.ok(Math.abs(c[0]! - keyEntropy / 7.5) < 1e-9, `key frame ${c[0]} vs ${keyEntropy / 7.5}`);
  // The ramp moved by one except where it wraps: two buckets again, 2 of 640 columns in the wrap bucket.
  assert.ok(c[1]! > 0 && c[1]! < 0.1, `ramp delta ${c[1]}`);
  assert.ok(c[2]! > 0.2, "a ramp against a uniform frame is spread over many differences");
  assert.equal(c[3], 1, "noise is capped at the complexity of 7.5 bits");
});

test("agent: a uniform frame has no complexity, an unexaminable format reports none, and the frame duration follows GetFrameDuration", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 640, height: 360, frameRate: 30 } });
  await a.capture(0, { luma: () => 77, duration: 20_000 });        // own duration 20 ms
  await a.capture(500_000, { format: "BGRA" });                    // RGB frames are not examined; no duration: clamped to 1/24 s
  await a.capture(510_000, { format: "NV12", luma: () => 5 });     // 10 ms since the last, clamped up to 1/60 s
  const r = a.rtps();
  for (const x of r) await a.command({ t: "encode", rtp: x });
  const enc = a.encoders[0]!;
  enc.emit(0, true); enc.emit(1); enc.emit(2);
  const c = chunksOf(a.sent);
  assert.equal(c[0]!.complexity, 0);
  assert.ok(!("complexity" in c[1]!), "BGRA is not planar YUV");
  assert.equal(c[2]!.complexity, 0);
  assert.equal(c[0]!.durationMs, 20);
  assert.ok(Math.abs(c[1]!.durationMs! - 1000 / 24) < 1e-9);
  assert.ok(Math.abs(c[2]!.durationMs! - 1000 / 60) < 1e-9);
});

test("agent: the engine's capture size sets the size the encoder is configured for, and only while the aspect ratio matches", async () => {
  const a = startAgent();
  await a.command({ t: "start", source: { kind: "tab", mediaSourceId: "x" }, video: { width: 1280, height: 720, frameRate: 30 } });
  const sizes = () => a.encoders.flatMap((e) => e.configures.map((c) => `${c.width}x${c.height}`));
  await a.capture(0, { width: 1280, height: 720 });
  await a.command({ t: "encode", rtp: a.rtps()[0]! });
  await a.command({ t: "capture-size", width: 640, height: 360 });
  await a.capture(33_000, { width: 1280, height: 720 });
  await a.command({ t: "encode", rtp: a.rtps()[1]! });
  // The source became portrait before the oracle caught up: its own size wins.
  await a.capture(66_000, { width: 720, height: 1280 });
  await a.command({ t: "encode", rtp: a.rtps()[2]! });
  // A capture size larger than the frame is the frame's size.
  await a.command({ t: "capture-size", width: 1920, height: 1080 });
  await a.capture(99_000, { width: 1280, height: 720 });
  await a.command({ t: "encode", rtp: a.rtps()[3]! });
  assert.deepEqual(sizes(), ["1280x720", "640x360", "720x1280", "1280x720"]);
});
